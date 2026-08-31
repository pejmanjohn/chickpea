import {
  DurableObject,
  env,
  type DurableObjectState,
  type DurableObjectStorage,
} from 'cloudflare:workers';
import { getSandbox, Sandbox as CloudflareSandbox } from '@cloudflare/sandbox';
import { instrument } from '@flue/runtime';
import { createCloudflareTracing } from '@flue/runtime/cloudflare';

import {
  AgentRevisionConflictError,
  AgentExistsError,
  AgentStillAssignedError,
  AgentStillReferencedError,
  ChannelRevisionConflictError,
  ConnectionAccountAlreadyBoundError,
  ConnectionAccountRevisionConflictError,
  ManagedRemoteAccountAlreadyUsedError,
  ReservedAgentIdentityError,
  UnknownAgentError,
  WorkspaceModelDefaultRevisionConflictError,
} from './config/errors.ts';
import {
  getCachedInstallationToken,
  getGithubConnection,
} from './config/github-app.ts';
import { slackAgentThreadKey } from './slack/thread-key.ts';
import { recordDeliveredSlackAgentMessage } from './slack/public-context.ts';
import {
  cacheSlackInstallationExecutionContexts,
  effectiveTurnSlackInstallationId,
  normalizeSlackInstallationExecutionError,
  resolveSlackInstallationExecutionContext,
  verifySlackInstallationTurnAccess,
  type SlackInstallationExecutionContext,
  type SlackInstallationExecutionResolver,
} from './slack/installation-execution.ts';
import { recordSlackInstallationUnavailable } from './slack/installation-observability.ts';
import {
  parseSandboxAllowedHosts,
  SANDBOX_PACKAGE_REGISTRY_HOSTS,
  SANDBOX_SETTING_KEYS,
} from './config/sandbox-settings.ts';
import type {
  ReplaceEncryptedCredentialRevisionInput,
  SettingsPatch,
  SettingsStore,
} from './config/settings-store.ts';
import { SettingsStoreLogic } from './config/settings-store.ts';
import { SnapshotStoreLogic } from './config/snapshot-store.ts';
import type {
  StateRpcResult,
  StateRpcErrorCode,
  SlackWorkspaceManagementRpcRequest,
  TagStateRpc,
  TurnJob,
  TurnProgress,
  TurnPullRequestProgress,
  RuntimeDrainStatus,
} from './config/state-rpc.ts';
import { buildRuntimeDrainStatus, tagStateStub } from './config/state-rpc.ts';
import { promiseBackedStatePort } from './config/local-state-port.ts';
import { localSlackStateStore } from './slack/local-state-store.ts';
import {
  getIdentityStore,
  getRoutineStore,
  getSettingsStore,
  getSlackStateStore,
  type AppStores,
  type PlatformEnv,
} from './config/state-backend.ts';
import {
  isOAuthContinuationActorActive,
  repairPendingOAuthContinuationResumes,
} from './connections/oauth-continuation.ts';
import {
  ConfigStoreLogic,
  type ConfigAgentPatch,
  type OAuthReauthorizationTarget,
} from './config/store.ts';
import type {
  ActivateChickpeaCutoverInput,
  AgentCreateInput,
  AgentChannelGrant,
  AgentChannelGrantInput,
  AgentConnectionBinding,
  AgentConnectionBindingInput,
  AgentOwnedConnection,
  AgentOwnedConnectionInput,
  AgentScheduleReference,
  AgentScheduleReferenceInput,
  AgentSnapshot,
  AgentSnapshotRootReference,
  AgentReferenceSummary,
  AgentThreadRoute,
  AgentThreadRouteInput,
  ChannelConfig,
  ChickpeaCutoverActivation,
  ChickpeaCutoverPreflight,
  CustomAgentConfig,
  ConnectionAccount,
  ConnectionAccountInput,
  EnsureWorkspaceInstallationInput,
  PrepareChickpeaCutoverInput,
  RollbackChickpeaCutoverInput,
  SlackPublicContextEntry,
  SlackPublicContextEntryInput,
  WorkspaceModelDefault,
  WorkspaceModelDefaultInput,
  WorkspaceInstallation,
  WorkspaceInstallationPatch,
} from './config/types.ts';
import {
  decideSandboxEgress,
  REPOSITORY_PERMISSIONS,
  resolveRepositoryInstallationScope,
} from './sandbox/egress-handler.ts';
import { githubAuthorizationHeader } from './sandbox/github-auth.ts';
import {
  SandboxPolicyState,
  sandboxEgressGrantsForMode,
  type SandboxEgressPolicy,
  type SandboxEgressPolicyInput,
  type SandboxPolicyStorage,
} from './sandbox/cloudflare-policy.ts';
import { cloudflareSandboxOptionVariants } from './sandbox/lifecycle.ts';
import {
  isGithubPullRequestCreateResponse,
  pullRequestProgressFromGithubResponse,
} from './sandbox/progress.ts';
import { SlackStateLogic } from './slack/claim-store.ts';
import type { SlackCanonicalAdmissionInput } from './slack/claim-store.ts';
import {
  SlackPresentationStateError,
  SlackRunPresentationStoreLogic,
} from './slack/run-presentations.ts';
import { createLedgerSlackRunHandler } from './slack/ledger-turn-driver.ts';
import type { SlackPresentationStatePort } from './slack/agent-view-presentation.ts';
import { setObservedSlackStatus } from './slack/status-registry.ts';
import {
  activityStatus,
  isSafeTypedActivityStatus,
  type TypedActivityStatus,
} from './activity/status.ts';
import {
  deliverAgentFailureFinal,
  repairSlackInteractionProgress,
  runTurn,
  sanitizeError,
} from './slack/run-turn.ts';
import { AgentPromptFailure } from './slack/flue-dispatch.ts';
import { DURABLE_RECOVERY_FAILURE_TEXT } from './slack/web-client-presenter.ts';
import {
  drainSlackPresentationRepairs,
  type SlackPresentationRepairDrainResult,
} from './slack/presentation-repair.ts';
import type {
  FlueDispatchReceiptV1,
  FlueSettlementCheckpointV1,
  FlueTurnObservationV1,
} from './slack/turn-job-types.ts';
import {
  MAX_POST_DISPATCH_ATTEMPTS,
  MAX_TURN_ATTEMPTS,
  MAX_TURN_DRAIN_BATCH,
  replayTextForTurnProgress,
  TurnJobStoreLogic,
} from './slack/turn-jobs.ts';
import type { SqlParam, StateDb } from './state/state-db.ts';
import { registerCloudflareBindingProvider } from './cloudflare-provider.ts';
import { MemoryStoreLogic } from './memory/store.ts';
import { MemoryStateError, type MemoryRpcRequest, type MemoryRpcResponse } from './memory/types.ts';
import { RoutineStoreLogic } from './routines/store.ts';
import {
  RoutineStateError,
  type RoutineRpcRequest,
  type RoutineRpcResponse,
} from './routines/types.ts';
import { createRoutineScheduledHandler } from './routines/scheduler-adapter.ts';
import {
  GATEWAY_INBOX_MAX_DRAIN_BATCH,
  GatewayInboxStoreLogic,
} from './slack/gateway/inbox.ts';
import {
  GatewayDeploymentClient,
} from './slack/gateway/client.ts';
import { resolveChickpeaGatewayUrl } from './slack/gateway/runtime.ts';
import { loadCredentialKeyring } from './slack/credential-keyring.ts';
import {
  processGatewayAgentSelection,
  processGatewaySlackEnvelope,
} from './channels/slack.ts';
import {
  SlackGatewaySession,
  wakeCloudflareGatewaySession,
} from './slack/gateway/cloudflare-session.ts';
import { UsageStoreLogic } from './usage/store.ts';
import { UsageStateError } from './usage/store-error.ts';
import type { UsageRpcRequest, UsageRpcResponse, UsageStore } from './usage/types.ts';
import { WorkStoreLogic } from './work/store.ts';
import { IdentityStateError } from './identity/errors.ts';
import { IdentityStoreLogic } from './identity/store.ts';
import type { IdentityStore } from './identity/types.ts';
import type { IdentityRpcRequest, IdentityRpcResponse } from './identity/types.ts';
import { ManagementStoreLogic, type ManagementStore } from './management/store.ts';
import { createLiveWorkspaceManagementService } from './management/live-service.ts';
import {
  invokeSlackWorkspaceManagementTool,
  resolveSlackManagementActor,
} from './management/slack-tools.ts';
import {
  invokeSlackScheduleAction,
  retryDueSlackScheduleActions,
  type SlackScheduleActionOutcome,
  type SlackScheduleActionRpcRequest,
} from './management/slack-schedule-actions.ts';
import type { WorkspaceManagementToolResult } from './management/tool-adapter.ts';
import {
  completeAgentWelcomeDelivery,
  deliverManagementReceiptToSlack,
  drainManagementReceiptOutbox,
  failAgentWelcomeDelivery,
  isAgentCreatedWelcome,
  reconcileScheduleActionReceipts,
} from './management/receipts.ts';
import {
  ManagementError,
  type ManagementRpcRequest,
  type ManagementRpcResponse,
} from './management/types.ts';
import { resolveSlackPublicUrl } from './slack/credentials.ts';
import {
  DurableRunDriver,
  runDriverRetryDelayMs,
  type RunDriverDrainResult,
} from './work/driver.ts';
import {
  WorkStateError,
  type WorkRpcRequest,
  type WorkRpcResponse,
  type WorkStore,
} from './work/types.ts';
import {
  RoutineAdmissionController,
} from './routines/admission.ts';
import { RoutineScheduler } from './routines/scheduler.ts';
import { executeRoutineOccurrence } from './routines/execution.ts';
import { drainRoutinePauseNotices } from './routines/delivery.ts';

// The generated default captures model and tool content. Register the native
// Cloudflare adapter explicitly for this Cloudflare-only entry so Workers
// Traces retain operational Flue spans without prompts, instructions, tool
// definitions, arguments, results, error messages, or stacks.
instrument(createCloudflareTracing({ content: false }));

// This module is imported only by Flue's Cloudflare entry. Register before
// the generated entry's guarded default so `cloudflare/*` remains keyless but
// calls env.AI directly, without the default payload-logging AI Gateway.
// Importable `env` is Cloudflare's ambient binding object; no I/O runs here.
registerCloudflareBindingProvider(env.AI);

export { ContainerProxy } from '@cloudflare/sandbox';

type SandboxOutboundContext = {
  containerId: string;
};

type SandboxOutboundHandler = (
  request: Request,
  env: unknown,
  ctx: SandboxOutboundContext,
) => Promise<Response> | Response;

interface SandboxNamespace {
  idFromString(id: string): unknown;
  get(id: unknown): Pick<
    Sandbox,
    | 'getEgressPolicy'
    | 'getTurnId'
    | 'getTurnProgress'
    | 'prepareTurn'
    | 'recordPullRequestProgress'
  >;
}

type SandboxWorkerEnv = PlatformEnv & {
  SANDBOX: SandboxNamespace;
};

const SANDBOX_BLOCKED_STATUS = 520;

/**
 * Cloudflare's Sandbox SDK routes intercepted container HTTPS through these
 * Worker-side handlers. Profile grants are persisted as policy only; the
 * credential is minted after each request passes the pure policy decision and
 * is attached only to the Worker-side forwarded Request.
 */
export class Sandbox extends CloudflareSandbox<SandboxWorkerEnv> {
  interceptHttps = true;
  // Interception only covers HTTP and HTTPS. The container base class defaults
  // `enableInternet` to true (@cloudflare/containers container.js:325), which
  // leaves a raw, unmediated socket path alongside the intercepted one — a
  // shell in this container could reach any host with `nc`, a raw TCP client,
  // or DNS tunnelling and never touch `Sandbox.outbound`. The SDK's own
  // outbound-interception example pairs `enableInternet = false` with
  // `interceptHttps = true` for exactly this reason. The static catch-all
  // below already forces intercept-all mode, so github.com, api.github.com and
  // the allowlisted package registries keep flowing through the Worker
  // handlers; this only removes the path that bypasses them.
  enableInternet = false;

  async prepareTurn(turnId: string): Promise<void> {
    await this.policyState().prepareTurn(turnId);
  }

  async configureEgress(
    input: SandboxEgressPolicyInput,
    turnId: string,
  ): Promise<void> {
    await this.policyState().configureEgress(input, turnId);
  }

  async getEgressPolicy(): Promise<SandboxEgressPolicy> {
    return this.policyState().getEgressPolicy();
  }

  async getTurnId(): Promise<string | undefined> {
    return this.policyState().getTurnId();
  }

  async getTurnProgress(): Promise<TurnProgress> {
    return this.policyState().getTurnProgress();
  }

  async recordPullRequestProgress(
    pullRequest: TurnPullRequestProgress,
    capturedTurnId: string,
  ): Promise<boolean> {
    return this.policyState().recordPullRequestProgress(pullRequest, capturedTurnId);
  }

  private policyStorage(): SandboxPolicyStorage {
    return this.ctx.storage as unknown as SandboxPolicyStorage;
  }

  private policyState(): SandboxPolicyState {
    return new SandboxPolicyState(this.policyStorage());
  }
}

// Assign through the SDK's inherited static setters so the handler registries
// are populated even when the Worker build preserves native class fields.
Sandbox.outboundByHost = {
  'github.com': githubSandboxOutbound,
  'api.github.com': githubSandboxOutbound,
  ...Object.fromEntries(
    SANDBOX_PACKAGE_REGISTRY_HOSTS.map((host) => [host, packageRegistrySandboxOutbound]),
  ),
} satisfies Record<string, SandboxOutboundHandler>;
Sandbox.outbound = denySandboxOutbound;

async function githubSandboxOutbound(
  request: Request,
  rawEnv: unknown,
  ctx: SandboxOutboundContext,
): Promise<Response> {
  try {
    const workerEnv = sandboxWorkerEnv(rawEnv);
    const stub = sandboxStub(workerEnv, ctx.containerId);
    const capturedTurnId = await stub.getTurnId();
    if (!capturedTurnId) return denySandboxOutbound();
    const policy = await stub.getEgressPolicy();
    if (!policy.mode) return denySandboxOutbound();

    // Credential-free preflight: validate the stored App-bound policy before
    // loading the private key.
    const preflightGrants = sandboxEgressGrantsForMode(policy, policy.mode);
    if (!preflightGrants) return denySandboxOutbound();
    const preflightDecision = decideSandboxEgress({
      url: request.url,
      method: request.method,
      grants: preflightGrants,
      allowedHosts: [],
    });
    if (!preflightDecision.allowed || preflightDecision.kind !== 'github') {
      return denySandboxOutbound();
    }

    // Resolve the credential only after the preflight decision, then bind the
    // stored policy to the current mode. Disconnecting the App invalidates the
    // running container until a fresh turn reconfigures it.
    const settings = getSettingsStore(workerEnv);
    const connection = await getGithubConnection(settings);
    if (connection.mode !== 'app') return denySandboxOutbound();
    const grants = sandboxEgressGrantsForMode(policy, connection.mode);
    if (!grants) return denySandboxOutbound();
    const decision = decideSandboxEgress({
      url: request.url,
      method: request.method,
      grants,
      allowedHosts: [],
    });
    if (!decision.allowed || decision.kind !== 'github') {
      return denySandboxOutbound();
    }

    const installation = resolveRepositoryInstallationScope(grants, decision.repositories);
    if (!installation) return denySandboxOutbound();
    const { token: credential } = await getCachedInstallationToken(
      connection,
      installation.id,
      {
        ...(installation.repositories
          ? { repositories: installation.repositories }
          : {}),
        permissions: REPOSITORY_PERMISSIONS,
      },
    );

    // Bind this request's decision to the turn captured before policy loading.
    // A reconfiguration during credential resolution must be decided again by
    // the next request, never forwarded under this turn's stale policy.
    if ((await stub.getTurnId()) !== capturedTurnId) return denySandboxOutbound();
    const headers = new Headers(request.headers);
    headers.set('Authorization', githubAuthorizationHeader(request.url, credential));
    const response = await fetch(new Request(request, { headers, redirect: 'manual' }));
    await recordPullRequestProgress(request, response, stub, capturedTurnId);
    return response;
  } catch {
    // Authentication/configuration errors are deliberately indistinguishable
    // from policy denials at the container boundary and never log token-bearing
    // request material.
    return denySandboxOutbound();
  }
}

async function packageRegistrySandboxOutbound(
  request: Request,
  rawEnv: unknown,
): Promise<Response> {
  try {
    const workerEnv = sandboxWorkerEnv(rawEnv);
    const rawAllowedHosts = await getSettingsStore(workerEnv).getSetting(
      SANDBOX_SETTING_KEYS.allowedHosts,
    );
    const decision = decideSandboxEgress({
      url: request.url,
      method: request.method,
      grants: [],
      allowedHosts: parseSandboxAllowedHosts(rawAllowedHosts),
    });
    if (!decision.allowed || decision.kind !== 'package-registry') {
      return denySandboxOutbound();
    }
    // Manual redirects force every new origin back through interception,
    // where it is evaluated independently against the host allowlist.
    return fetch(new Request(request, { redirect: 'manual' }));
  } catch {
    return denySandboxOutbound();
  }
}

function sandboxWorkerEnv(value: unknown): SandboxWorkerEnv {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Sandbox Worker environment is unavailable');
  }
  const workerEnv = value as Partial<SandboxWorkerEnv>;
  if (
    !workerEnv.SANDBOX ||
    typeof workerEnv.SANDBOX.idFromString !== 'function' ||
    typeof workerEnv.SANDBOX.get !== 'function'
  ) {
    throw new Error('SANDBOX Durable Object binding is unavailable');
  }
  return workerEnv as SandboxWorkerEnv;
}

function sandboxStub(
  workerEnv: SandboxWorkerEnv,
  containerId: string,
): Pick<
  Sandbox,
  'getEgressPolicy' | 'getTurnId' | 'getTurnProgress' | 'recordPullRequestProgress'
> {
  return workerEnv.SANDBOX.get(workerEnv.SANDBOX.idFromString(containerId));
}

async function recordPullRequestProgress(
  request: Request,
  response: Response,
  stub: Pick<Sandbox, 'recordPullRequestProgress'>,
  capturedTurnId: string,
): Promise<void> {
  if (!isGithubPullRequestCreateResponse(request.url, request.method, response.status)) {
    return;
  }

  try {
    const pullRequest = pullRequestProgressFromGithubResponse({
      requestUrl: request.url,
      requestMethod: request.method,
      responseStatus: response.status,
      responseBody: await response.clone().json(),
    });
    if (!pullRequest) return;
    await stub.recordPullRequestProgress(pullRequest, capturedTurnId);
  } catch {
    // Progress recording is best-effort and must never turn a successful,
    // policy-approved GitHub operation into a failed sandbox request.
  }
}

function denySandboxOutbound(): Response {
  return new Response('Origin is disallowed', { status: SANDBOX_BLOCKED_STATUS });
}

// Backoff before the alarm re-fires for a job whose attempt failed but is not
// yet at the cap. A short delay (matching the DO alarm base retry) is enough:
// the failure that got here is a genuine delivery error, so an immediate retry
// would likely re-fail; a couple of seconds lets a transient Slack blip clear.
const RELAY_RETRY_BACKOFF_MS = 2_000;

// A tiny first-fire window lets Slack events from the same burst land in the
// queue before the alarm snapshots it. The alarm already fans independent
// conversations out concurrently; without this window, the first event can
// start a long turn milliseconds before its neighbors enqueue and serialize
// the whole burst behind it.
const RELAY_BATCH_WINDOW_MS = 250;

/**
 * Cloudflare entrypoint. Named exports of this file become top-level Worker
 * exports on the CF target (the node target never imports it), so this is the
 * ONE module allowed to import 'cloudflare:workers'.
 *
 * TagStateStore is the app-owned state Durable Object: a single named instance
 * (state-rpc.ts TAG_STATE_INSTANCE) hosts all four store domains — config
 * agents/assignments, thread snapshots, Slack claims + thread registry, and
 * operator settings — by running the SAME target-neutral store logic classes
 * the node backend runs, over DO SQLite instead of node:sqlite. Binding and
 * migration live in wrangler.jsonc (TAG_STATE / migrations v2).
 */

/**
 * StateDb over a Durable Object's synchronous SQL storage.
 *
 * `changes` is derived from `SELECT changes()` — NOT the cursor's
 * `rowsWritten`, which counts index writes too (a single INSERT into a table
 * with a PRIMARY KEY reports rowsWritten=2; measured on workerd 2026-07-06).
 * The store logic's write-once semantics (claims, snapshot putIfAbsent,
 * createAgent) depend on exact SQLite changes semantics, which changes()
 * returns (1/0) both standalone and inside transactionSync.
 */
class DoSqlStateDb implements StateDb {
  constructor(private readonly storage: DurableObjectStorage) {}

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    // Drain the write cursor before reading changes(): cursors execute
    // incrementally, and changes() must observe the completed statement.
    this.storage.sql.exec(sql, ...params).toArray();
    const row = this.storage.sql.exec('SELECT changes() AS changes').one();
    return { changes: Number(row.changes) };
  }

  get(sql: string, ...params: SqlParam[]): Record<string, unknown> | undefined {
    return this.storage.sql.exec(sql, ...params).toArray()[0];
  }

  all(sql: string, ...params: SqlParam[]): Record<string, unknown>[] {
    return this.storage.sql.exec(sql, ...params).toArray();
  }

  exec(sql: string): void {
    // Single statements only (the StateDb contract) — DO SQLite rejects
    // multi-statement strings, which is exactly why the contract exists.
    this.storage.sql.exec(sql).toArray();
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}

interface TagStateStores {
  identity: IdentityStoreLogic;
  config: ConfigStoreLogic;
  snapshots: SnapshotStoreLogic;
  slack: SlackStateLogic;
  settings: SettingsStoreLogic;
  turnJobs: TurnJobStoreLogic;
  gatewayInbox: GatewayInboxStoreLogic;
  presentations: SlackRunPresentationStoreLogic;
  memory: MemoryStoreLogic;
  routines: RoutineStoreLogic;
  usage: UsageStoreLogic;
  work: WorkStoreLogic;
  management: ManagementStoreLogic;
}

export class TagStateStore extends DurableObject implements TagStateRpc {
  private stores: TagStateStores | undefined;
  /**
   * Constructor failures are latched instead of thrown: a throwing DO
   * constructor makes EVERY subsequent RPC fail with an opaque platform 500.
   * Latching turns that into a clear `{ok:false}` envelope per call that the
   * proxies surface as a normal store error. The failure is NOT permanent for
   * the isolate: `call()` re-attempts construction (a transient storage error
   * on first boot should not brick every later RPC), so only the calls made
   * before a successful re-init see the envelope.
   */
  private initError: string | undefined;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.stores = this.tryInit();
  }

  /** Execute one requester-bound management tool inside the state owner. The
   * service and policy are identical to MCP/Admin/Node; only the Cloudflare
   * transport changes so a compound Agent turn does not spend its Worker-loop
   * budget on dozens of same-state proxy calls. */
  async workspaceManagementInvoke(
    request: SlackWorkspaceManagementRpcRequest,
  ): Promise<WorkspaceManagementToolResult> {
    console.log('[chickpea:management] state RPC started', JSON.stringify({
      tool: request.name,
    }));
    this.stores ??= this.tryInit();
    const stores = this.stores;
    if (!stores) {
      console.error('[chickpea:management] state RPC unavailable', JSON.stringify({
        tool: request.name,
      }));
      return workspaceManagementRpcFailure();
    }
    try {
      const { local, service } = localManagementRuntime(
        stores,
        this.env as PlatformEnv,
      );
      const result = await invokeSlackWorkspaceManagementTool({
        signal: request.signal,
        identity: local.identity,
        service,
        name: request.name,
        args: request.args,
      });
      try {
        const outboxDueAt = stores.management.nextOutboxDueAt();
        if (outboxDueAt !== undefined) {
          await this.armAlarmNoLaterThan(Math.max(Date.now(), outboxDueAt));
        }
      } catch {
        // The management operation has already reached a terminal service
        // result. Outbox inspection and alarm delivery are retryable follow-up
        // work and must not rewrite a successful mutation into an ambiguous
        // transport error.
        console.error('[chickpea] Workspace management receipt alarm failed');
      }
      console.log('[chickpea:management] state RPC completed', JSON.stringify({
        tool: request.name,
        outcome: result.ok ? 'success' : 'error',
        ...(!result.ok ? { reason: result.error.code } : {}),
      }));
      return result;
    } catch (error) {
      console.error('[chickpea] Workspace management state RPC failed', JSON.stringify({
        tool: request.name,
        errorName: error instanceof Error ? error.name : typeof error,
      }));
      return workspaceManagementRpcFailure();
    }
  }

  async slackScheduleActionInvoke(
    request: SlackScheduleActionRpcRequest,
  ): Promise<SlackScheduleActionOutcome> {
    this.stores ??= this.tryInit();
    const stores = this.stores;
    if (!stores) throw new Error('Schedule action state is unavailable.');
    const { local, service } = localManagementRuntime(
      stores,
      this.env as PlatformEnv,
    );
    const context = await resolveSlackManagementActor(request.signal, local.identity);
    // Arm recovery before the first durable write so a DO interruption after
    // admission cannot strand a pending action without an alarm.
    await this.armAlarmNoLaterThan(Date.now());
    const result = await invokeSlackScheduleAction({
      signal: request.signal,
      context,
      operation: request.operation,
      dependencies: {
        management: local.management,
        routines: local.routines,
        service,
        owner: `rpc:${request.signal.turnJobId}`,
      },
    });
    const nextAction = stores.routines.nextScheduleActionDueAt();
    const nextReceipt = stores.management.nextOutboxDueAt();
    const nextWake = earliestDefined(nextAction, nextReceipt);
    if (nextWake !== undefined) await this.armAlarmNoLaterThan(Math.max(Date.now(), nextWake));
    return result;
  }

  /**
   * Build the store set over the DO's SQL storage, or latch the failure and
   * return undefined. Idempotent by design so `call()` can re-run it to
   * self-heal a failed first construction.
   */
  private tryInit(): TagStateStores | undefined {
    try {
      const db = new DoSqlStateDb(this.ctx.storage);
      // Same construction order as the node backend: each logic class creates
      // its own tables (and the config store runs migrations + seedOnce), so a
      // fresh DO is fully seeded before it answers its first RPC.
      const stores = {
        identity: new IdentityStoreLogic(db),
        config: new ConfigStoreLogic(db),
        snapshots: new SnapshotStoreLogic(db),
        slack: new SlackStateLogic(db),
        settings: new SettingsStoreLogic(db),
        turnJobs: new TurnJobStoreLogic(db),
        gatewayInbox: new GatewayInboxStoreLogic(db),
        presentations: new SlackRunPresentationStoreLogic(db),
        memory: new MemoryStoreLogic(db),
        routines: new RoutineStoreLogic(db),
        usage: new UsageStoreLogic(db),
        management: new ManagementStoreLogic(db),
      } as Omit<TagStateStores, 'work'>;
      const completeStores: TagStateStores = {
        ...stores,
        work: new WorkStoreLogic(db, {
          env: {
            TAG_RUN_BODY_RETENTION_DAYS:
              typeof (this.env as PlatformEnv).TAG_RUN_BODY_RETENTION_DAYS === 'string'
                ? (this.env as PlatformEnv).TAG_RUN_BODY_RETENTION_DAYS as string
                : undefined,
          },
        }),
      };
      this.initError = undefined;
      return completeStores;
    } catch (err) {
      this.initError = err instanceof Error ? err.message : String(err);
      console.error('[chickpea] TagStateStore init failed:', this.initError);
      return undefined;
    }
  }

  // ── config: agents ───────────────────────────────────────────────────────

  async identityExecute(
    request: IdentityRpcRequest,
  ): Promise<StateRpcResult<IdentityRpcResponse>> {
    return this.call((stores) => stores.identity.execute(request));
  }

  async managementExecute(
    request: ManagementRpcRequest,
  ): Promise<StateRpcResult<ManagementRpcResponse>> {
    const result = this.call((stores) => stores.management.execute(request));
    if (result.ok && (
      request.kind === 'complete_setup' ||
      request.kind === 'put_outbox' ||
      request.kind === 'claim_introduction'
    )) {
      const due = this.call((stores) => stores.management.nextOutboxDueAt() ?? null);
      if (due.ok && due.value !== null) {
        await this.armAlarmNoLaterThan(Math.max(Date.now(), due.value));
      }
    }
    return result;
  }

  async configListAgents(): Promise<StateRpcResult<CustomAgentConfig[]>> {
    return this.call((stores) => stores.config.listAgents());
  }

  async configListUserAgents(): Promise<StateRpcResult<CustomAgentConfig[]>> {
    return this.call((stores) => stores.config.listUserAgents());
  }

  async configGetAgent(agentId: string): Promise<StateRpcResult<CustomAgentConfig>> {
    return this.call((stores) => stores.config.getAgent(agentId));
  }

  async configMaterializeChickpeaAgent(): Promise<StateRpcResult<CustomAgentConfig>> {
    return this.call((stores) => stores.config.materializeChickpeaAgent());
  }

  async configCreateAgent(agent: AgentCreateInput): Promise<StateRpcResult<CustomAgentConfig>> {
    return this.call((stores) => stores.config.createAgent(agent));
  }

  async configUpdateAgent(
    agentId: string,
    patch: ConfigAgentPatch,
    expectedRevision?: number,
  ): Promise<StateRpcResult<CustomAgentConfig>> {
    return this.call((stores) => stores.config.updateAgent(agentId, patch, expectedRevision));
  }

  async configMarkOAuthReauthorizationRequired(
    target: OAuthReauthorizationTarget,
  ): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.config.markOAuthReauthorizationRequired(target));
  }

  async configDeleteAgent(
    agentId: string,
    expectedRevision?: number,
  ): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.config.deleteAgent(agentId, expectedRevision));
  }

  async configDeleteAgentWithMemory(
    agentId: string,
    idempotencyKey: string,
  ): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.config.deleteAgentWithMemory(
      agentId,
      idempotencyKey,
      stores.memory,
    ));
  }

  async configArchiveAgent(
    agentId: string,
    options?: { replacementDefaultAgentId?: string; expectedRevision?: number },
  ): Promise<StateRpcResult<CustomAgentConfig>> {
    return this.call((stores) => stores.config.archiveAgent(agentId, options));
  }

  async configRestoreAgent(
    agentId: string,
    expectedRevision?: number,
  ): Promise<StateRpcResult<CustomAgentConfig>> {
    return this.call((stores) => stores.config.restoreAgent(agentId, expectedRevision));
  }

  async configEnsureWorkspaceInstallation(
    input: EnsureWorkspaceInstallationInput,
  ): Promise<StateRpcResult<WorkspaceInstallation>> {
    return this.call((stores) => stores.config.ensureWorkspaceInstallation(input));
  }

  async configGetWorkspaceInstallation(
    workspaceId: string,
  ): Promise<StateRpcResult<WorkspaceInstallation | null>> {
    return this.call((stores) => stores.config.getWorkspaceInstallation(workspaceId) ?? null);
  }

  async configListWorkspaceInstallations(): Promise<StateRpcResult<WorkspaceInstallation[]>> {
    return this.call((stores) => stores.config.listWorkspaceInstallations());
  }

  async configUpdateWorkspaceInstallation(
    workspaceId: string,
    patch: WorkspaceInstallationPatch,
    expectedRevision?: number,
  ): Promise<StateRpcResult<WorkspaceInstallation>> {
    return this.call((stores) =>
      stores.config.updateWorkspaceInstallation(workspaceId, patch, expectedRevision),
    );
  }

  async configSetWorkspaceDefaultAgent(
    workspaceId: string,
    agentId: string,
    expectedRevision?: number,
  ): Promise<StateRpcResult<WorkspaceInstallation>> {
    return this.call((stores) =>
      stores.config.setWorkspaceDefaultAgent(workspaceId, agentId, expectedRevision),
    );
  }

  async configGetWorkspaceModelDefault(
    workspaceId: string,
  ): Promise<StateRpcResult<WorkspaceModelDefault | null>> {
    return this.call((stores) => stores.config.getWorkspaceModelDefault(workspaceId) ?? null);
  }

  async configPutWorkspaceModelDefault(
    input: WorkspaceModelDefaultInput,
    expectedRevision?: number,
  ): Promise<StateRpcResult<WorkspaceModelDefault>> {
    return this.call((stores) => stores.config.putWorkspaceModelDefault(input, expectedRevision));
  }

  async configPrepareChickpeaCutover(
    input: PrepareChickpeaCutoverInput,
  ): Promise<StateRpcResult<ChickpeaCutoverPreflight>> {
    return this.call((stores) => stores.config.prepareChickpeaCutover(input));
  }

  async configPreflightChickpeaCutover(
    workspaceId: string,
  ): Promise<StateRpcResult<ChickpeaCutoverPreflight>> {
    return this.call((stores) => stores.config.preflightChickpeaCutover(workspaceId));
  }

  async configActivateChickpeaCutover(
    input: ActivateChickpeaCutoverInput,
  ): Promise<StateRpcResult<ChickpeaCutoverActivation>> {
    return this.call((stores) => stores.config.activateChickpeaCutover(input));
  }

  async configRollbackChickpeaCutover(
    input: RollbackChickpeaCutoverInput,
  ): Promise<StateRpcResult<ChickpeaCutoverPreflight>> {
    return this.call((stores) => stores.config.rollbackChickpeaCutover(input));
  }

  async configListAgentChannelGrants(
    workspaceId?: string,
    channelId?: string,
  ): Promise<StateRpcResult<AgentChannelGrant[]>> {
    return this.call((stores) => stores.config.listAgentChannelGrants(workspaceId, channelId));
  }

  async configPutAgentChannelGrant(
    input: AgentChannelGrantInput,
    expectedRevision?: number,
  ): Promise<StateRpcResult<AgentChannelGrant>> {
    return this.call((stores) => stores.config.putAgentChannelGrant(input, expectedRevision));
  }

  async configDeleteAgentChannelGrant(
    workspaceId: string,
    channelId: string,
    agentId: string,
  ): Promise<StateRpcResult<boolean>> {
    return this.call((stores) =>
      stores.config.deleteAgentChannelGrant(workspaceId, channelId, agentId),
    );
  }

  async configGetAgentThreadRoute(
    workspaceId: string,
    channelId: string,
    threadTs: string,
  ): Promise<StateRpcResult<AgentThreadRoute | null>> {
    return this.call(
      (stores) => stores.config.getAgentThreadRoute(workspaceId, channelId, threadTs) ?? null,
    );
  }

  async configPutAgentThreadRoute(
    input: AgentThreadRouteInput,
    expectedRevision?: number,
  ): Promise<StateRpcResult<AgentThreadRoute>> {
    return this.call((stores) => stores.config.putAgentThreadRoute(input, expectedRevision));
  }

  async configDeleteAgentThreadRoute(
    workspaceId: string,
    channelId: string,
    threadTs: string,
  ): Promise<StateRpcResult<boolean>> {
    return this.call((stores) =>
      stores.config.deleteAgentThreadRoute(workspaceId, channelId, threadTs)
    );
  }

  async configListSlackPublicContext(
    workspaceId: string,
    channelId: string,
    rootTs: string,
  ): Promise<StateRpcResult<SlackPublicContextEntry[]>> {
    return this.call((stores) =>
      stores.config.listSlackPublicContext(workspaceId, channelId, rootTs)
    );
  }

  async configPutSlackPublicContext(
    input: SlackPublicContextEntryInput,
  ): Promise<StateRpcResult<SlackPublicContextEntry>> {
    return this.call((stores) => stores.config.putSlackPublicContext(input));
  }

  async configDeleteSlackPublicContextMessage(
    workspaceId: string,
    channelId: string,
    rootTs: string,
    messageTs: string,
  ): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.config.deleteSlackPublicContextMessage(
      workspaceId,
      channelId,
      rootTs,
      messageTs,
    ));
  }

  async configDeleteSlackPublicContextRoot(
    workspaceId: string,
    channelId: string,
    rootTs: string,
  ): Promise<StateRpcResult<number>> {
    return this.call((stores) =>
      stores.config.deleteSlackPublicContextRoot(workspaceId, channelId, rootTs)
    );
  }

  async configListConnectionAccounts(
    workspaceId: string,
  ): Promise<StateRpcResult<ConnectionAccount[]>> {
    return this.call((stores) => stores.config.listConnectionAccounts(workspaceId));
  }

  async configPutConnectionAccount(
    input: ConnectionAccountInput,
    expectedRevision?: number,
  ): Promise<StateRpcResult<ConnectionAccount>> {
    return this.call((stores) => stores.config.putConnectionAccount(input, expectedRevision));
  }

  async configCreateAgentOwnedConnection(
    input: AgentOwnedConnectionInput,
  ): Promise<StateRpcResult<AgentOwnedConnection>> {
    return this.call((stores) => stores.config.createAgentOwnedConnection(input));
  }

  async configListAgentConnectionBindings(
    agentId: string,
  ): Promise<StateRpcResult<AgentConnectionBinding[]>> {
    return this.call((stores) => stores.config.listAgentConnectionBindings(agentId));
  }

  async configGetAgentConnectionBindingForAccount(
    connectionAccountId: string,
  ): Promise<StateRpcResult<AgentConnectionBinding | null>> {
    return this.call(
      (stores) => stores.config.getAgentConnectionBindingForAccount(connectionAccountId) ?? null,
    );
  }

  async configPutAgentConnectionBinding(
    input: AgentConnectionBindingInput,
  ): Promise<StateRpcResult<AgentConnectionBinding>> {
    return this.call((stores) => stores.config.putAgentConnectionBinding(input));
  }

  async configListAgentScheduleReferences(
    agentId: string,
  ): Promise<StateRpcResult<AgentScheduleReference[]>> {
    return this.call((stores) => stores.config.listAgentScheduleReferences(agentId));
  }

  async configGetAgentScheduleReference(
    scheduleId: string,
  ): Promise<StateRpcResult<AgentScheduleReference | null>> {
    return this.call((stores) => stores.config.getAgentScheduleReference(scheduleId) ?? null);
  }

  async configPutAgentScheduleReference(
    input: AgentScheduleReferenceInput,
    expectedRevision?: number,
  ): Promise<StateRpcResult<AgentScheduleReference>> {
    return this.call((stores) => stores.config.putAgentScheduleReference(input, expectedRevision));
  }

  async configRetireAgentScheduleReference(
    scheduleId: string,
  ): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.config.retireAgentScheduleReference(scheduleId));
  }

  async configListChannels(): Promise<StateRpcResult<ChannelConfig[]>> {
    return this.call((stores) => stores.config.listChannels());
  }

  async configGetChannel(
    workspaceId: string,
    channelId: string,
  ): Promise<StateRpcResult<ChannelConfig | null>> {
    return this.call((stores) => stores.config.getChannel(workspaceId, channelId) ?? null);
  }

  async configPutChannel(
    channel: ChannelConfig,
    expectedRevision?: number,
  ): Promise<StateRpcResult<ChannelConfig>> {
    return this.call((stores) => stores.config.putChannel(channel, expectedRevision));
  }

  // ── config: assignments ──────────────────────────────────────────────────

  async configGetAgentReferences(
    agentId: string,
  ): Promise<StateRpcResult<AgentReferenceSummary>> {
    return this.call((stores) => stores.config.getAgentReferences(agentId));
  }

  // ── config: Agent thread snapshots ──────────────────────────────────────

  async snapshotGet(threadKey: string): Promise<StateRpcResult<AgentSnapshot | null>> {
    return this.call((stores) => stores.snapshots.get(threadKey) ?? null);
  }

  async snapshotPutIfAbsent(
    threadKey: string,
    snapshot: AgentSnapshot,
  ): Promise<StateRpcResult<AgentSnapshot>> {
    return this.call((stores) => stores.snapshots.putIfAbsent(threadKey, snapshot));
  }

  async snapshotReplace(
    threadKey: string,
    snapshot: AgentSnapshot,
  ): Promise<StateRpcResult<AgentSnapshot>> {
    return this.call((stores) => stores.snapshots.replace(threadKey, snapshot));
  }

  async snapshotListLiveRootsByAgent(
    agentId: string,
  ): Promise<StateRpcResult<AgentSnapshotRootReference[]>> {
    return this.call((stores) => stores.snapshots.listLiveRootsByAgent(agentId));
  }

  // ── slack claims + thread registry ───────────────────────────────────────

  async claim(key: string): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.slack.claim(key));
  }

  async release(key: string): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.slack.release(key);
      return null;
    });
  }

  async threadStart(key: string): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.slack.start(key);
      return null;
    });
  }

  async threadHas(key: string): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.slack.has(key));
  }

  async threadActiveWorkGet(key: string): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.slack.isActiveWork(key));
  }

  async threadActiveWorkSet(
    key: string,
    generation: string,
    active: boolean,
  ): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.slack.setActiveWork(key, generation, active);
      return null;
    });
  }

  async admitSlackTurn(input: SlackCanonicalAdmissionInput) {
    return this.call((stores) =>
      stores.slack.admitCanonical(input, stores.work, stores.turnJobs, stores.presentations),
    );
  }

  async slackAgentBindingPin(
    input: Parameters<TagStateRpc['slackAgentBindingPin']>[0],
    expected?: Parameters<TagStateRpc['slackAgentBindingPin']>[1],
  ) {
    return this.call((stores) => stores.turnJobs.pinAgentBinding(input, expected));
  }

  async slackAgentBindingGet(continuityKey: string) {
    return this.call((stores) =>
      stores.turnJobs.getAgentBinding(continuityKey) ?? null,
    );
  }

  async slackFlueDispatchPrepare(
    id: string,
    message: string,
    observation: Parameters<TagStateRpc['slackFlueDispatchPrepare']>[2],
  ) {
    return this.call((stores) => stores.turnJobs.prepareFlueDispatch(id, message, observation));
  }

  async slackFlueExistingInstanceReconcile(id: string, uid: string) {
    return this.call((stores) => stores.turnJobs.reconcileFlueExistingInstance(id, uid));
  }

  async slackFlueReceiptRecord(
    id: string,
    receipt: Parameters<TagStateRpc['slackFlueReceiptRecord']>[1],
  ) {
    return this.call((stores) => stores.turnJobs.recordFlueReceipt(id, receipt));
  }

  async slackFlueSettlementRecord(
    id: string,
    settlement: Parameters<TagStateRpc['slackFlueSettlementRecord']>[1],
  ) {
    return this.call((stores) => stores.turnJobs.recordFlueSettlement(id, settlement));
  }

  async slackFlueObservationMatch(instanceId: string, submissionId?: string) {
    return this.call((stores) =>
      stores.turnJobs.matchFlueObservation(instanceId, submissionId) ?? null,
    );
  }

  async slackTurnRecoveryRequired(
    id: string,
    reason: string,
  ): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.turnJobs.markRecoveryRequired(id, reason);
      return null;
    });
  }

  async slackTurnRecoveryList(limit: number) {
    return this.call((stores) => stores.turnJobs.listRecoveryRequired(limit));
  }

  async slackInstallationRecoveryRetry(workspaceId: string) {
    const result = this.call((stores) =>
      stores.turnJobs.retrySlackInstallationRecovery(workspaceId),
    );
    if (result.ok && result.value > 0 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + RELAY_BATCH_WINDOW_MS);
    }
    return result;
  }

  async slackTurnRecoveryResolve(id: string) {
    return this.call((stores) => stores.turnJobs.resolveRecoveryRequired(id));
  }

  async slackInstallationPendingDeliveryCount(workspaceId: string) {
    return this.call((stores) =>
      stores.turnJobs.countPendingDeliveriesForWorkspace(workspaceId),
    );
  }

  async slackInteractionProgressRecord(
    id: string,
    patch: Parameters<TagStateRpc['slackInteractionProgressRecord']>[1],
  ): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.turnJobs.recordSlackInteractionProgress(id, patch);
      return null;
    });
  }

  async slackPresentationGet(runId: string) {
    return this.call((stores) => stores.presentations.get(runId) ?? null);
  }

  async slackPresentationLatestThreadGeneration(
    root: Parameters<TagStateRpc['slackPresentationLatestThreadGeneration']>[0],
  ) {
    return this.call((stores) =>
      stores.presentations.getLatestThreadSessionGeneration(root) ?? null,
    );
  }

  async slackPresentationTransition(
    input: Parameters<TagStateRpc['slackPresentationTransition']>[0],
  ) {
    return this.call((stores) => stores.presentations.transition(input));
  }

  async slackPresentationReserveAppend(workspaceId: string) {
    return this.call((stores) => stores.presentations.reserveAppend(workspaceId));
  }

  async slackPresentationApplyCooldown(workspaceId: string, retryAfterMs: number) {
    return this.call((stores) =>
      stores.presentations.applyAppendCooldown(workspaceId, retryAfterMs),
    );
  }

  async slackPresentationReserveActivityStatus(workspaceId: string) {
    return this.call((stores) => stores.presentations.reserveActivityStatus(workspaceId));
  }

  async slackPresentationApplyActivityStatusCooldown(
    workspaceId: string,
    retryAfterMs: number,
  ) {
    return this.call((stores) =>
      stores.presentations.applyActivityStatusCooldown(workspaceId, retryAfterMs),
    );
  }

  async slackPresentationRepairList(limit: number) {
    return this.call((stores) => stores.presentations.listAutoRepairableV3(limit));
  }

  async slackPresentationMaintain(limit: number) {
    return this.call((stores) => stores.presentations.maintain(limit));
  }

  async slackPresentationSummary(workspaceId: string) {
    return this.call((stores) => stores.presentations.summarize(workspaceId));
  }

  // ── operator settings ────────────────────────────────────────────────────

  async settingGet(key: string): Promise<StateRpcResult<string | null>> {
    return this.call((stores) => stores.settings.getSetting(key) ?? null);
  }

  async settingGetMany(keys: readonly string[]): Promise<StateRpcResult<(string | null)[]>> {
    return this.call((stores) => stores.settings.getSettings(keys).map((value) => value ?? null));
  }

  async settingSet(key: string, value: string): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.settings.setSetting(key, value);
      return null;
    });
  }

  async settingDelete(key: string): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.settings.deleteSetting(key);
      return null;
    });
  }

  async settingApplyPatch(patch: SettingsPatch): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.settings.applySettingsPatch(patch));
  }

  async settingMergeStringSet(
    key: string,
    values: readonly string[],
  ): Promise<StateRpcResult<string[]>> {
    return this.call((stores) => stores.settings.mergeSettingStringSet(key, values));
  }

  async encryptedCredentialGet(key: string) {
    return this.call((stores) => stores.settings.getEncryptedCredentialRevision(key) ?? null);
  }

  async encryptedCredentialReplace(input: ReplaceEncryptedCredentialRevisionInput) {
    return this.call((stores) => stores.settings.replaceEncryptedCredentialRevision(input) ?? null);
  }

  async encryptedCredentialDelete(key: string, expectedRevision: string) {
    return this.call((stores) => stores.settings.deleteEncryptedCredentialRevision(
      key,
      expectedRevision,
    ));
  }

  // ── memory + generic audit envelope ─────────────────────────────────────

  async memoryExecute(
    request: MemoryRpcRequest,
  ): Promise<StateRpcResult<MemoryRpcResponse>> {
    return this.call((stores) => stores.memory.execute(request));
  }

  async routinesExecute(
    request: RoutineRpcRequest,
  ): Promise<StateRpcResult<RoutineRpcResponse>> {
    return this.call((stores) => stores.routines.execute(request));
  }

  async usageExecute(
    request: UsageRpcRequest,
  ): Promise<StateRpcResult<UsageRpcResponse>> {
    return this.call((stores) => stores.usage.execute(request));
  }

  async workExecute(
    request: WorkRpcRequest,
  ): Promise<StateRpcResult<WorkRpcResponse>> {
    return this.call((stores) => stores.work.execute(request));
  }

  async runtimeDrainStatus(): Promise<StateRpcResult<RuntimeDrainStatus>> {
    return this.call((stores) => {
      const categories = {
        ...stores.turnJobs.runtimeDrainCounts(),
        ...stores.gatewayInbox.runtimeDrainCounts(),
        executingRuns: stores.work.countExecutingRuns(),
        admittingOrRunningRoutineOccurrences:
          stores.routines.countAdmittingOrRunningOccurrences(),
      };
      return buildRuntimeDrainStatus(categories);
    });
  }

  async maintainWork(at: number): Promise<StateRpcResult<null>> {
    if (!Number.isSafeInteger(at) || at < 0) {
      return rpcError('work', 'Work maintenance time is invalid.', {
        workCode: 'work_maintenance_invalid',
      });
    }
    const result = this.call((stores) => {
      stores.work.purgeContent(at, 100);
      stores.presentations.maintain(100);
      return stores.turnJobs.hasPending('legacy') || stores.turnJobs.hasPending('ledger');
    });
    if (!result.ok) return result;
    if (result.value && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + RELAY_BATCH_WINDOW_MS);
    }
    return { ok: true, value: null };
  }

  // ── turn relay (Cloudflare turn-horizon fix) ─────────────────────────────

  async enqueueTurn(job: TurnJob): Promise<StateRpcResult<null>> {
    const result = this.call((stores) => {
      stores.turnJobs.enqueue(job);
      return null;
    });
    // Arm the alarm only after the row is written, and AWAIT it: the job + the
    // armed alarm must both be durable before this RPC resolves, because the
    // events handler acks Slack the instant it does. A small, non-sliding batch
    // window lets near-simultaneous independent threads reach the existing
    // bounded fan-out. Never move an already-armed alarm later.
    if (result.ok) {
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null) {
        await this.ctx.storage.setAlarm(Date.now() + RELAY_BATCH_WINDOW_MS);
      }
    }
    return result;
  }

  async admitGatewayDelivery(
    delivery: Parameters<TagStateRpc['admitGatewayDelivery']>[0],
  ): ReturnType<TagStateRpc['admitGatewayDelivery']> {
    const result = this.call((stores) => stores.gatewayInbox.admit(delivery));
    if (result.ok) {
      await this.armAlarmNoLaterThan(Date.now() + RELAY_BATCH_WINDOW_MS);
    }
    return result;
  }

  async resumeTurnAfterOAuth(
    originalTaskId: string,
    continuationId: string,
  ): Promise<StateRpcResult<boolean>> {
    const result = this.call((stores) =>
      stores.turnJobs.resumeAfterOAuth(originalTaskId, continuationId)
    );
    if (result.ok && result.value && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + RELAY_BATCH_WINDOW_MS);
    }
    return result;
  }

  /**
   * Cross-isolate activity narration (see src/slack/status-relay.ts): the agent
   * DO observes safe lifecycle/tool summaries and relays them here, where the alarm
   * registered the live turn's status presenter. A registry miss, closed sink,
   * stale generation, or ambiguous duplicate match is intentionally a no-op —
   * still a success by contract.
   */
  async observedStatus(
    instanceId: string,
    submissionId: string,
    status: TypedActivityStatus,
  ): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      if (!isSafeTypedActivityStatus(status)) return null;
      const target = stores.turnJobs.matchFlueObservation(instanceId, submissionId);
      if (target) {
        setObservedSlackStatus(
          instanceId,
          target.generation,
          activityStatus(
            status.kind,
            status.action,
            status.object,
            status.family,
            status.phase,
          ),
        );
      }
      return null;
    });
  }

  /**
   * Drain queued turns past the events ack — the whole point of the relay. Each
   * turn runs with this DO alarm's 15-minute wall-time budget instead of the
   * events invocation's ~30s waitUntil cancellation, so a slow keyless model
   * turn finishes and delivers.
   *
   * The handler NEVER throws for a per-job failure (it catches and either
   * re-arms or gives up), so its attempt-count / delivered writes always commit
   * on a normal return — no dependency on Durable Object throw-rollback
   * semantics. It throws ONLY when the store itself is unavailable, so the
   * platform's at-least-once alarm retry re-drives the queue after a transient
   * storage error rather than dropping every job.
   */
  async alarm(): Promise<void> {
    this.stores ??= this.tryInit();
    if (!this.stores) {
      throw new Error(`state store unavailable in alarm: ${this.initError ?? 'unknown'}`);
    }
    const stores = this.stores;
    stores.management.cleanupRetention(Date.now(), 250);
    const gatewayNeedsRetry = await drainGatewayInbox(
      stores,
      this.env as PlatformEnv,
    );
    const pending = stores.turnJobs.listPending(MAX_TURN_DRAIN_BATCH);
    if (pending.length === 0) {
      const cleanupPending = stores.turnJobs.hasPendingSlackInteractionCleanup();
      const resolveInstallation = this.createAlarmIdentityResolver(stores);
      const ledgerDrain = await drainLedgerRuns(
        stores,
        this.env as PlatformEnv,
        resolveInstallation,
      );
      if (cleanupPending) {
        await drainSlackInteractionCleanups(stores, resolveInstallation);
      }
      const presentationRepairs = await drainTerminalPresentationRepairs(
        stores,
        resolveInstallation,
      );
      const scheduleActions = await drainCloudflareScheduleActions(stores, this.env as PlatformEnv);
      await drainCloudflareManagementReceipts(stores, resolveInstallation);
      const turnRetry = gatewayNeedsRetry || stores.gatewayInbox.hasPending() ||
        stores.turnJobs.hasPending('ledger') || stores.turnJobs.hasPendingSlackInteractionCleanup()
        ? Date.now() + runDriverRetryDelayMs(ledgerDrain, RELAY_RETRY_BACKOFF_MS)
        : undefined;
      const outboxRetry = stores.management.nextOutboxDueAt();
      const nextWake = earliestDefined(
        turnRetry,
        presentationRepairs.nextRetryAt,
        scheduleActions.nextDueAt,
        outboxRetry,
      );
      if (nextWake !== undefined) await this.ctx.storage.setAlarm(nextWake);
      return;
    }
    // Resolve current credentials once per identity referenced by this bounded
    // batch. The map is discarded after the alarm, so the next retry observes
    // credential rotation without ever falling back to another identity.
    const resolveInstallation = this.createAlarmIdentityResolver(stores);
    const usageStore = localUsageStore(stores);
    const appStores = localGatewayAppStores(stores);
    const resolveManagementApproval = () => {
      const managementRuntime = localManagementRuntime(
        stores,
        this.env as PlatformEnv,
        appStores,
      );
      return {
        identity: appStores.identity,
        config: appStores.config,
        management: appStores.management,
        service: managementRuntime.service,
      };
    };
    let needsRetry = gatewayNeedsRetry;
    let identityRetryDelayMs = RELAY_RETRY_BACKOFF_MS;
    const runJob = async (job: (typeof pending)[number]): Promise<boolean> => {
      if (!job.turn.interactionIntent && job.progress.interactionIntent) {
        job.turn.interactionIntent = job.progress.interactionIntent;
      }
      let installationContext: SlackInstallationExecutionContext;
      try {
        installationContext = await resolveInstallation(effectiveTurnSlackInstallationId(job.turn));
        await verifySlackInstallationTurnAccess(installationContext, job.turn);
      } catch (error) {
        const unavailable = normalizeSlackInstallationExecutionError(
          error,
          effectiveTurnSlackInstallationId(job.turn),
        );
        recordSlackInstallationUnavailable(unavailable);
        if (unavailable.retryable) {
          needsRetry = true;
          identityRetryDelayMs = Math.max(
            identityRetryDelayMs,
            unavailable.retryAfterMs ?? 0,
          );
          console.warn(
            `[chickpea] Slack installation preflight will retry (${unavailable.reasonCode})`,
          );
          return false;
        }
        stores.turnJobs.markRecoveryRequired(job.id, 'slack_installation_unavailable');
        if (job.turn.interactionIntent?.disposition === 'work') {
          stores.slack.setActiveWork(
            slackAgentThreadKey(job.turn, job.assignment),
            job.id,
            false,
          );
        }
        return false;
      }
      const client = installationContext.client;
      const attempt = job.attempts + 1;
      let delivered = false;
      let deferredTerminal = false;
      let activeWorkKey = job.turn.interactionIntent?.disposition === 'work'
        ? slackAgentThreadKey(job.turn, job.assignment)
        : undefined;
      // Advance the attempt count before running the turn: a crash mid-turn
      // then re-fires with the count already committed, bounding retries.
      stores.turnJobs.recordAttempt(job.id, attempt);
      const flueDispatch = {
        ...(job.dispatchEnvelope ? { dispatchEnvelope: job.dispatchEnvelope } : {}),
        ...(job.dispatchReceipt ? { dispatchReceipt: job.dispatchReceipt } : {}),
        ...(job.flueSettlement ? { flueSettlement: job.flueSettlement } : {}),
        prepare: (message: string, observation: FlueTurnObservationV1) =>
          stores.turnJobs.prepareFlueDispatch(job.id, message, observation),
        reconcileExistingInstance: (uid: string) =>
          stores.turnJobs.reconcileFlueExistingInstance(job.id, uid),
        recordReceipt: (receipt: FlueDispatchReceiptV1) =>
          stores.turnJobs.recordFlueReceipt(job.id, receipt),
        recordSettlement: (settlement: FlueSettlementCheckpointV1) =>
          stores.turnJobs.recordFlueSettlement(job.id, settlement),
        markRecoveryRequired: (reason: string) =>
          stores.turnJobs.markRecoveryRequired(job.id, reason),
      };
      const presentationState = localSlackPresentationState(stores);
      const deliverRecoveryFailure = async (reasonCode: string): Promise<boolean> => {
        try {
          await runTurn(job.turn, job.assignment, this.env as PlatformEnv, {
            client,
            installationContext,
            turnId: job.id,
            ...(job.runId ? { runId: job.runId, runAttempt: attempt } : {}),
            settingsStore: localSettingsStore(stores),
            presentationState,
            replayText: DURABLE_RECOVERY_FAILURE_TEXT,
            replayTerminalResult: 'failure',
            onPublicMessageDelivered: (delivery) =>
              recordDeliveredSlackAgentMessage(
                stores.config, job.turn, job.assignment, delivery,
              ),
            onDelivered: () => {
              stores.turnJobs.markError(job.id);
              if (activeWorkKey) stores.slack.setActiveWork(activeWorkKey, job.id, false);
              delivered = true;
            },
          });
          return true;
        } catch {
          stores.turnJobs.markRecoveryRequired(job.id, reasonCode);
          if (activeWorkKey) stores.slack.setActiveWork(activeWorkKey, job.id, false);
          return false;
        }
      };
      try {
        const persistSandboxProgress = async (): Promise<string | undefined> => {
          const binding =
            (this.env as PlatformEnv).SANDBOX ?? (this.env as PlatformEnv).Sandbox;
          if (!binding) return undefined;
          const conversationKey = slackAgentThreadKey(job.turn, job.assignment);
          for (const options of cloudflareSandboxOptionVariants(conversationKey)) {
            try {
              const sandbox = getSandbox(
                binding as Parameters<typeof getSandbox>[0],
                conversationKey,
                options,
              ) as ReturnType<typeof getSandbox> & {
                getTurnId(): Promise<string | undefined>;
                getTurnProgress(): Promise<TurnProgress>;
              };
              if ((await sandbox.getTurnId()) !== job.id) continue;
              const progress = await sandbox.getTurnProgress();
              if (progress.pullRequest) {
                stores.turnJobs.recordPullRequest(job.id, progress.pullRequest);
              }
              const replayText = replayTextForTurnProgress(progress);
              if (replayText !== undefined) return replayText;
            } catch {
              // One identity can be unavailable during a rolling deploy. Keep
              // checking the bridge identity before degrading recovery.
            }
          }
          // Retry protection is best-effort on the read path. Either Sandbox
          // identity retains its marker, so a later alarm can try again.
          return undefined;
        };
        const replayText =
          replayTextForTurnProgress(job.progress) ?? (await persistSandboxProgress());
        const runtimePlanDecision = job.runtimePlan && job.agentInstanceId
          ? {
              runtimePlan: job.runtimePlan,
              instanceId: job.agentInstanceId,
            }
          : undefined;
        await runTurn(job.turn, job.assignment, this.env as PlatformEnv, {
          client,
          installationContext,
          turnId: job.id,
          usageExecutionId: `exec:${job.id}:flue`,
          ...(job.runId ? { runId: job.runId, runAttempt: attempt } : {}),
          workStore: stores.work as unknown as WorkStore,
          settingsStore: localSettingsStore(stores),
          usageStore,
          appStores,
          managementApproval: resolveManagementApproval,
          ...(runtimePlanDecision ? { runtimePlanDecision } : {}),
          onRuntimePlan: (candidate) => stores.turnJobs.freezeRuntimePlan(job.id, candidate),
          flueDispatch,
          presentationState,
          progressiveAttributionProven: true,
          onUsagePersistence: (event) => {
            stores.turnJobs.recordUsagePersistence(job.id, event);
          },
          onInteractionIntent: (intent) => {
            stores.turnJobs.recordInteractionIntent(job.id, intent);
            if (intent.disposition !== 'work') return;
            activeWorkKey = slackAgentThreadKey(job.turn, job.assignment);
            stores.slack.setActiveWork(activeWorkKey, job.id, true);
          },
          ...(job.progress.slackInteraction
            ? { interactionProgress: job.progress.slackInteraction }
            : {}),
          onInteractionProgress: (patch) => {
            stores.turnJobs.recordSlackInteractionProgress(job.id, patch);
          },
          onPublicMessageDelivered: (delivery) =>
            recordDeliveredSlackAgentMessage(stores.config, job.turn, job.assignment, delivery),
          ...(replayText === undefined ? {} : { replayText }),
          beforeDelivery: persistSandboxProgress,
          // Record terminal delivery before runTurn's post-delivery Sandbox
          // teardown. A hung control-plane destroy must never leave an
          // already-posted Slack final eligible for relay retry.
          onDelivered: () => {
            stores.turnJobs.markDelivered(job.id);
            if (activeWorkKey) stores.slack.setActiveWork(activeWorkKey, job.id, false);
            delivered = true;
          },
          onDeferredTerminal: () => {
            deferredTerminal = true;
            if (activeWorkKey) stores.slack.setActiveWork(activeWorkKey, job.id, false);
          },
        });
        if (deferredTerminal) return true;
        // Delivery was tombstoned at the exact presentation boundary above.
        // Claims stay held — a completed turn never re-runs.
        return true;
      } catch (err) {
        if (err instanceof AgentPromptFailure && err.recoveryRequired) {
          console.error('[chickpea] Flue turn requires operator reconciliation');
          return deliverRecoveryFailure('flue_dispatch_reconciliation_required');
        }
        // Any failure after the terminal presentation boundary is cleanup,
        // not a failed turn. The durable tombstone prevents a duplicate final;
        // keep the claims held and let a later thread turn start normally.
        if (delivered) {
          console.warn('[chickpea] post-delivery cleanup did not complete');
          return true;
        }
        if (flueDispatch.dispatchEnvelope) {
          // A dispatched turn is never discarded or replaced. A later alarm
          // replays its admission key, receipt read, or terminal settlement.
          if (attempt >= MAX_POST_DISPATCH_ATTEMPTS) {
            console.error('[chickpea] Flue turn exhausted durable reattachment attempts');
            return deliverRecoveryFailure('post_dispatch_attempts_exhausted');
          } else {
            needsRetry = true;
          }
          if (activeWorkKey) stores.slack.setActiveWork(activeWorkKey, job.id, false);
          console.warn('[chickpea] Flue turn retained for durable reattachment');
          return false;
        }
        console.error(
          `[chickpea] relay turn attempt ${attempt} failed:`,
          sanitizeError(err),
        );
        if (attempt >= MAX_TURN_ATTEMPTS) {
          // Terminal: best-effort sanitized final so the thread is not left
          // silent, then release the claims (parity with the node .catch's
          // "failed delivery frees the claim") and tombstone so no further
          // attempt runs.
          await deliverAgentFailureFinal(
            job.turn,
            job.assignment,
            client,
            this.env as PlatformEnv,
            (delivery) =>
              recordDeliveredSlackAgentMessage(
                stores.config,
                job.turn,
                job.assignment,
                delivery,
              ),
          ).catch((finalErr) => {
            console.error('[chickpea] relay terminal final failed:', sanitizeError(finalErr));
          });
          stores.slack.release(job.evtKey);
          stores.slack.release(job.msgKey);
          stores.slack.release(`decision:${job.msgKey}`);
          if (activeWorkKey) stores.slack.setActiveWork(activeWorkKey, job.id, false);
          stores.turnJobs.markError(job.id);
          return true;
        } else {
          needsRetry = true;
          return false;
        }
      }
    };

    // Group by conversation so ordering INSIDE a thread is preserved (a
    // thread's second turn never overtakes its first), then drain groups with
    // bounded fan-out: one slow turn no longer head-of-line-blocks every other
    // conversation in the workspace behind a strictly sequential loop. Turns
    // are I/O-bound (model + Slack calls), so async interleaving inside this
    // single-threaded DO is safe; storage writes stay per-job and atomic.
    const groups = new Map<string, (typeof pending)[number][]>();
    for (const job of pending) {
      const key = slackAgentThreadKey(job.turn, job.assignment);
      const list = groups.get(key);
      if (list) {
        list.push(job);
      } else {
        groups.set(key, [job]);
      }
    }
    const groupLists = [...groups.values()];
    const DRAIN_CONCURRENCY = 4;
    let nextGroup = 0;
    await Promise.all(
      Array.from({ length: Math.min(DRAIN_CONCURRENCY, groupLists.length) }, async () => {
        while (nextGroup < groupLists.length) {
          const mine = groupLists[nextGroup];
          nextGroup += 1;
          if (!mine) break;
          for (const job of mine) {
            if (!(await runJob(job))) break;
          }
        }
      }),
    );
    const ledgerDrain = await drainLedgerRuns(
      stores,
      this.env as PlatformEnv,
      resolveInstallation,
    );
    identityRetryDelayMs = runDriverRetryDelayMs(ledgerDrain, identityRetryDelayMs);
    await drainSlackInteractionCleanups(stores, resolveInstallation);
    const presentationRepairs = await drainTerminalPresentationRepairs(
      stores,
      resolveInstallation,
    );
    const scheduleActions = await drainCloudflareScheduleActions(stores, this.env as PlatformEnv);
    await drainCloudflareManagementReceipts(stores, resolveInstallation);
    needsRetry ||= stores.turnJobs.hasPending('legacy') ||
      stores.turnJobs.hasPending('ledger') ||
      stores.turnJobs.hasPendingSlackInteractionCleanup() ||
      stores.gatewayInbox.hasPending();
    const turnRetry = needsRetry ? Date.now() + identityRetryDelayMs : undefined;
    const outboxRetry = stores.management.nextOutboxDueAt();
    const nextWake = earliestDefined(
      turnRetry,
      presentationRepairs.nextRetryAt,
      scheduleActions.nextDueAt,
      outboxRetry,
    );
    if (nextWake !== undefined) {
      // Re-arm (do NOT throw) so this invocation returns normally and its
      // attempt-count writes commit; the next firing re-drives the leftover
      // pending jobs.
      await this.ctx.storage.setAlarm(nextWake);
    }
  }

  private async armAlarmNoLaterThan(at: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || at < existing) await this.ctx.storage.setAlarm(at);
  }

  private createAlarmIdentityResolver(stores: TagStateStores): SlackInstallationExecutionResolver {
    return cacheSlackInstallationExecutionContexts(
      (workspaceId) => resolveSlackInstallationExecutionContext(
          workspaceId,
          this.env as PlatformEnv,
          {
            config: {
              getWorkspaceInstallation: async (workspaceId) =>
                stores.config.getWorkspaceInstallation(workspaceId),
            },
            settings: {
              getSetting: async (key) => stores.settings.getSetting(key),
              getSettings: async (keys) => stores.settings.getSettings(keys),
              setSetting: async (key, value) => stores.settings.setSetting(key, value),
              deleteSetting: async (key) => stores.settings.deleteSetting(key),
              applySettingsPatch: async (patch) => stores.settings.applySettingsPatch(patch),
              mergeSettingStringSet: async (key, values) =>
                stores.settings.mergeSettingStringSet(key, values),
            },
            credentialDependencies: {
              // The alarm is already executing inside TAG_STATE; using the
              // local logic avoids a self-RPC while retaining durable state.
              state: stores.identity as unknown as IdentityStore,
              env: this.env as PlatformEnv,
            },
          },
        ),
    );
  }

  /**
   * Run one store operation and map the outcome onto the RPC envelope. Typed
   * domain errors become stable codes with their constructor args so the
   * proxies (cf-state-proxies.ts) re-throw the SAME instanceof-able errors the
   * node backend throws; anything else is an internal failure with the message
   * preserved for server-side logs.
   */
  private call<T>(fn: (stores: TagStateStores) => T): StateRpcResult<T> {
    // Self-heal: re-attempt a construction that failed on first boot rather
    // than latching the isolate into permanent failure. A still-broken store
    // returns the {ok:false} envelope only for THIS call.
    this.stores ??= this.tryInit();
    if (!this.stores) {
      return {
        ok: false,
        error: {
          code: 'internal',
          message: `state store unavailable: init failed (${this.initError ?? 'unknown'})`,
        },
      };
    }
    try {
      return { ok: true, value: fn(this.stores) };
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return rpcError('unknown_agent', err.message, { agentId: err.agentId });
      }
      if (err instanceof AgentExistsError) {
        return rpcError('agent_exists', err.message, { agentId: err.agentId });
      }
      if (err instanceof AgentRevisionConflictError) {
        return rpcError('agent_revision_conflict', err.message, {
          agentId: err.agentId,
          expectedRevision: String(err.expectedRevision),
          actualRevision: String(err.actualRevision),
        });
      }
      if (err instanceof ReservedAgentIdentityError) {
        return rpcError('reserved_agent_identity', err.message, { field: err.field });
      }
      if (err instanceof WorkspaceModelDefaultRevisionConflictError) {
        return rpcError('workspace_model_default_revision_conflict', err.message, {
          workspaceId: err.workspaceId,
          expectedRevision: String(err.expectedRevision),
          actualRevision: String(err.actualRevision),
        });
      }
      if (err instanceof AgentStillAssignedError) {
        return rpcError('agent_still_assigned', err.message, {
          agentId: err.agentId,
          keys: err.keys,
        });
      }
      if (err instanceof AgentStillReferencedError) {
        return rpcError('agent_still_referenced', err.message, {
          agentId: err.agentId,
          references: err.references,
        });
      }
      if (err instanceof ChannelRevisionConflictError) {
        return rpcError('channel_revision_conflict', err.message, {
          workspaceId: err.workspaceId,
          channelId: err.channelId,
          expectedRevision: String(err.expectedRevision),
          actualRevision: String(err.actualRevision),
        });
      }
      if (err instanceof ConnectionAccountRevisionConflictError) {
        return rpcError('connection_account_revision_conflict', err.message, {
          accountId: err.accountId,
          expectedRevision: String(err.expectedRevision),
          actualRevision: String(err.actualRevision),
        });
      }
      if (err instanceof ConnectionAccountAlreadyBoundError) {
        return rpcError('connection_account_already_bound', err.message, {
          accountId: err.accountId,
          agentId: err.agentId,
        });
      }
      if (err instanceof ManagedRemoteAccountAlreadyUsedError) {
        return rpcError('managed_remote_account_already_used', err.message, {
          adapterId: err.adapterId,
          accountRef: err.accountRef,
        });
      }
      if (err instanceof IdentityStateError) {
        return rpcError('identity', err.message, {
          identityCode: err.code,
          ...err.details,
        });
      }
      if (err instanceof ManagementError) {
        return rpcError('management', err.message, {
          managementCode: err.code,
        });
      }
      if (err instanceof MemoryStateError) {
        return rpcError('memory', err.message, {
          memoryCode: err.code,
          ...err.details,
        });
      }
      if (err instanceof RoutineStateError) {
        return rpcError('routine', err.message, {
          routineCode: err.code,
          ...err.details,
        });
      }
      if (err instanceof UsageStateError) {
        return rpcError('usage', err.message, {
          usageCode: err.code,
          ...err.details,
        });
      }
      if (err instanceof WorkStateError) {
        return rpcError('work', err.message, {
          workCode: err.code,
          ...err.details,
        });
      }
      if (err instanceof SlackPresentationStateError) {
        return rpcError('slack_presentation', err.message, {
          presentationCode: err.code,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[chickpea] TagStateStore RPC failure:', message);
      return rpcError('internal', message);
    }
  }
}

async function drainSlackInteractionCleanups(
  stores: TagStateStores,
  resolveInstallation: SlackInstallationExecutionResolver,
): Promise<void> {
  for (const job of stores.turnJobs.listPendingSlackInteractionCleanups(MAX_TURN_DRAIN_BATCH)) {
    const progress = job.progress.slackInteraction;
    if (!progress) continue;
    try {
      const installationContext = await resolveInstallation(effectiveTurnSlackInstallationId(job.turn));
      await verifySlackInstallationTurnAccess(installationContext, job.turn);
      await repairSlackInteractionProgress(
        job.turn,
        job.assignment,
        progress,
        installationContext.client,
        (patch) => {
          stores.turnJobs.recordSlackInteractionProgress(job.id, patch);
        },
      );
    } catch (error) {
      console.warn('[chickpea] Slack interaction cleanup retry failed:', sanitizeError(error));
    }
  }
}

async function drainTerminalPresentationRepairs(
  stores: TagStateStores,
  resolveInstallation: SlackInstallationExecutionResolver,
): Promise<SlackPresentationRepairDrainResult> {
  const presentations = stores.presentations.listAutoRepairableV3(MAX_TURN_DRAIN_BATCH);
  return drainSlackPresentationRepairs({
    presentations,
    state: localSlackPresentationState(stores),
    resolveClient: async (workspaceId) => (await resolveInstallation(workspaceId)).client,
    onFailure: (_presentation, error) => {
      console.warn('[chickpea] Slack presentation repair failed:', sanitizeError(error));
    },
  });
}

async function drainCloudflareManagementReceipts(
  stores: TagStateStores,
  resolveInstallation: SlackInstallationExecutionResolver,
): Promise<void> {
  // ManagementStoreLogic is the in-DO synchronous implementation of every
  // ManagementStore operation; the shared drain awaits its return values, so
  // one implementation owns claim, backoff, terminal settling, and logging.
  const presentation = {
    state: localSlackPresentationState(stores),
    resolveClient: async (workspaceId: string) =>
      (await resolveInstallation(workspaceId)).client,
  };
  await drainManagementReceiptOutbox({
    management: stores.management as unknown as ManagementStore,
    onTerminalFailure: async (record) => {
      await failAgentWelcomeDelivery(record, presentation);
      if (isAgentCreatedWelcome(record.receipt) && record.receipt.turnJobId) {
        stores.turnJobs.markError(record.receipt.turnJobId);
      }
    },
    deliver: (record) => deliverManagementReceiptToSlack(record, {
      identity: stores.identity as unknown as IdentityStore,
      resolveInstallation,
      onDelivered: async (deliveredRecord, delivery) => {
        try {
          await completeAgentWelcomeDelivery(
            deliveredRecord,
            delivery,
            stores.config,
            presentation,
          );
        } finally {
          if (isAgentCreatedWelcome(deliveredRecord.receipt) &&
              deliveredRecord.receipt.turnJobId) {
            stores.turnJobs.markDelivered(deliveredRecord.receipt.turnJobId);
          }
        }
      },
    }),
  });
}

async function drainCloudflareScheduleActions(
  stores: TagStateStores,
  platformEnv: PlatformEnv,
): Promise<{ attempted: number; nextDueAt?: number }> {
  const now = Date.now();
  const nextDueAt = stores.routines.nextScheduleActionDueAt();
  if (nextDueAt === undefined || nextDueAt > now) {
    const local = localGatewayAppStores(stores);
    await reconcileScheduleActionReceipts({
      routines: local.routines,
      management: local.management,
      at: now,
    });
    return { attempted: 0, ...(nextDueAt !== undefined ? { nextDueAt } : {}) };
  }
  const { local, service } = localManagementRuntime(stores, platformEnv);
  return retryDueSlackScheduleActions({
    dependencies: {
      management: local.management,
      routines: local.routines,
      service,
      owner: `alarm:schedule:${Date.now()}`,
    },
    resolveContext: async (action, request) => {
      return {
        userId: action.actorUserId,
        membershipId: action.actorMembershipId,
        organizationId: request.organizationId,
        actingAgentId: action.agentId,
        origin: {
          kind: 'slack',
          workspaceId: action.workspaceId,
          channelId: action.channelId,
          threadTs: action.threadTs,
          messageTs: action.messageTs,
          conversationKind: action.conversationKind,
          agentId: action.agentId,
        },
      };
    },
  });
}

async function drainLedgerRuns(
  stores: TagStateStores,
  platformEnv: PlatformEnv,
  resolveInstallation: SlackInstallationExecutionResolver,
): Promise<RunDriverDrainResult> {
  return new DurableRunDriver(stores.work, {
    ownerId: 'cloudflare_ledger_run_driver',
    authorityEpoch: 1,
    leaseDurationMs: 30_000,
    maxClaims: 4,
    concurrency: 4,
    handle: createLedgerSlackRunHandler({
      // WorkStoreLogic is the in-DO synchronous implementation of every
      // WorkStore operation; awaiting its return values preserves the same
      // handler contract without a self-RPC through CfWorkStore.
      work: stores.work as unknown as WorkStore,
      turns: stores.turnJobs,
      resolveInstallation,
      verifyInstallationAccess: verifySlackInstallationTurnAccess,
      platformEnv,
      settingsStore: localSettingsStore(stores),
      usageStore: localUsageStore(stores),
      presentationState: localSlackPresentationState(stores),
      setActiveWork: (key, generation, active) =>
        stores.slack.setActiveWork(key, generation, active),
      onPublicMessageDelivered: (turn, assignment, delivery) =>
        recordDeliveredSlackAgentMessage(stores.config, turn, assignment, delivery),
    }),
  }).drain();
}

async function drainGatewayInbox(
  stores: TagStateStores,
  platformEnv: PlatformEnv,
): Promise<boolean> {
  const pending = stores.gatewayInbox.claimPending(GATEWAY_INBOX_MAX_DRAIN_BATCH);
  if (pending.length === 0) return stores.gatewayInbox.hasPending();
  const appStores = localGatewayAppStores(stores);
  let client: GatewayDeploymentClient;
  try {
    client = new GatewayDeploymentClient({
      settings: appStores.settings,
      config: appStores.config,
      identity: appStores.identity,
      keyring: loadCredentialKeyring(platformEnv),
      gatewayBaseUrl: resolveChickpeaGatewayUrl(platformEnv),
    });
  } catch {
    for (const item of pending) {
      stores.gatewayInbox.retryOrRecover(item.id, 'delivery_dependency_unavailable');
    }
    return stores.gatewayInbox.hasPending();
  }
  let needsRetry = false;
  for (const item of pending) {
    try {
      const outcome = item.delivery.kind === 'event.deliver'
        ? await processGatewaySlackEnvelope(
            item.delivery.envelope,
            platformEnv,
            client,
            {
              stores: appStores,
              enqueueTurn: async (job) => {
                stores.turnJobs.enqueue(job);
                return { ok: true, value: null };
              },
            },
          )
        : await processGatewayAgentSelection(
            item.delivery,
            platformEnv,
            client,
            appStores,
          );
      if (outcome === 'accepted') {
        stores.gatewayInbox.complete(item.id);
      } else {
        stores.gatewayInbox.markRecoveryRequired(item.id, 'binding_revalidation_rejected');
      }
    } catch {
      needsRetry ||= stores.gatewayInbox.retryOrRecover(
        item.id,
        'delivery_processing_failed',
      ) === 'pending';
    }
  }
  return needsRetry || stores.gatewayInbox.hasPending();
}

function localGatewayAppStores(stores: TagStateStores): AppStores {
  // Store logic methods are synchronous inside the owning DO, while every
  // public port is Promise-shaped. Adapt the methods instead of casting them:
  // callers may attach `.catch(...)` directly rather than awaiting first.
  return {
    identity: promiseBackedStatePort(stores.identity),
    config: promiseBackedStatePort(stores.config),
    snapshots: promiseBackedStatePort(stores.snapshots),
    slackState: localSlackStateStore(stores),
    settings: promiseBackedStatePort(stores.settings),
    memory: promiseBackedStatePort(stores.memory),
    routines: promiseBackedStatePort(stores.routines),
    usage: promiseBackedStatePort(stores.usage),
    work: promiseBackedStatePort(stores.work),
    management: promiseBackedStatePort(stores.management),
  } as unknown as AppStores;
}

function localSettingsStore(stores: TagStateStores): SettingsStore {
  return {
    getSetting: async (key) => stores.settings.getSetting(key),
    getSettings: async (keys) => stores.settings.getSettings(keys),
    setSetting: async (key, value) => stores.settings.setSetting(key, value),
    deleteSetting: async (key) => stores.settings.deleteSetting(key),
    applySettingsPatch: async (patch) => stores.settings.applySettingsPatch(patch),
    mergeSettingStringSet: async (key, values) =>
      stores.settings.mergeSettingStringSet(key, values),
  };
}

function localManagementRuntime(
  stores: TagStateStores,
  platformEnv: PlatformEnv,
  local: AppStores = localGatewayAppStores(stores),
) {
  const settings = localSettingsStore(stores);
  return {
    local,
    service: createLiveWorkspaceManagementService(platformEnv, {
      identity: local.identity,
      settings,
      usage: local.usage,
      slackCredentials: {
        state: local.identity,
        keyring: loadCredentialKeyring(platformEnv),
      },
      overrides: {
        identity: local.identity,
        config: local.config,
        management: local.management,
        memory: local.memory,
        routines: local.routines,
        work: local.work,
        setupBaseUrl: () => resolveSlackPublicUrl(platformEnv, settings),
      },
    }),
  };
}

function localSlackPresentationState(stores: TagStateStores): SlackPresentationStatePort {
  return {
    getRunPresentation: (runId) => stores.presentations.get(runId),
    getLatestThreadSessionGeneration: (root) =>
      stores.presentations.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input) => stores.presentations.transition(input),
    reserveSlackAppend: (workspaceId) => stores.presentations.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId, retryAfterMs) =>
      stores.presentations.applyAppendCooldown(workspaceId, retryAfterMs),
    reserveSlackActivityStatus: (workspaceId) =>
      stores.presentations.reserveActivityStatus(workspaceId),
    applySlackActivityStatusCooldown: (workspaceId, retryAfterMs) =>
      stores.presentations.applyActivityStatusCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: (instanceId, submissionId) =>
      stores.turnJobs.matchFlueObservation(instanceId, submissionId),
  };
}

function localUsageStore(stores: TagStateStores): UsageStore {
  return {
    admitOperation: async (input) => stores.usage.admitOperation(input),
    recordTerminal: async (input) => stores.usage.recordTerminal(input),
    recordConnectorUsage: async (input) => stores.usage.recordConnectorUsage(input),
    reserveConnectorQuota: async (input) => stores.usage.reserveConnectorQuota(input),
    releaseConnectorQuota: async (input) => stores.usage.releaseConnectorQuota(input),
    summarizeConnectorUsage: async (query) => stores.usage.summarizeConnectorUsage(query),
    getOperation: async (operationId) => stores.usage.getOperation(operationId),
    getOperationByRunId: async (runId) => stores.usage.getOperationByRunId(runId),
    listOperations: async (query) => stores.usage.listOperations(query),
    summarize: async (query) => stores.usage.summarize(query),
    putCredential: async (input) => stores.usage.putCredential(input),
    retireCredential: async (credentialRefId, version, retiredAt) =>
      stores.usage.retireCredential(credentialRefId, version, retiredAt),
    listCredentials: async (providerId) => stores.usage.listCredentials(providerId),
    cleanupRetention: async (at) => stores.usage.cleanupRetention(at),
    getRetentionStatus: async () => stores.usage.getRetentionStatus(),
    listUsageAuditEvents: async (limit) => stores.usage.listUsageAuditEvents(limit),
  };
}

function earliestDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length ? Math.min(...defined) : undefined;
}

function workspaceManagementRpcFailure(): WorkspaceManagementToolResult {
  return {
    ok: false,
    error: {
      code: 'management_error',
      message: 'The workspace management request failed.',
    },
  };
}

function rpcError(
  code: StateRpcErrorCode,
  message: string,
  details?: Record<string, string>,
): { ok: false; error: { code: typeof code; message: string; details?: Record<string, string> } } {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

export default createRoutineScheduledHandler({
  heartbeat: runRoutineHeartbeat,
  maintenance: runWorkMaintenance,
});

async function runWorkMaintenance(
  scheduledTime: number,
  rawEnv: Record<string, unknown>,
): Promise<void> {
  const result = await tagStateStub(rawEnv).maintainWork(scheduledTime);
  if (!result.ok) {
    throw new Error(`Work maintenance failed: ${result.error.message}`);
  }
  const platformEnv = rawEnv as PlatformEnv;
  try {
    await repairPendingOAuthContinuationResumes({
      settings: getSettingsStore(platformEnv),
      onReady: async (continuation) => {
        if (!(await isOAuthContinuationActorActive({
          continuation,
          identity: getIdentityStore(platformEnv),
        }))) {
          throw new Error('OAuth continuation member is no longer active.');
        }
        const resumed = await getSlackStateStore(platformEnv).resumeTurnAfterOAuth?.(
          continuation.taskId,
          continuation.id,
        );
        if (!resumed) throw new Error('OAuth continuation task is unavailable.');
      },
    });
  } finally {
    // The gateway session is the ingress lifeline for the shared Slack lane.
    // OAuth repair failures must never suppress its periodic wake.
    await wakeCloudflareGatewaySession(rawEnv);
  }
}

export { SlackGatewaySession };

async function runRoutineHeartbeat(
  scheduledTime: number,
  owner: string,
  rawEnv: Record<string, unknown>,
): Promise<void> {
  const store = getRoutineStore(rawEnv);
  const admissions = new RoutineAdmissionController(store, {
    execute: (run, attempt) => executeRoutineOccurrence({
      env: rawEnv,
      store,
      occurrenceId: run.id,
      attempt: attempt.attempt,
    }),
  });
  await new RoutineScheduler(store, admissions).heartbeat(scheduledTime, owner);
  await drainRoutinePauseNotices({ store, env: rawEnv as PlatformEnv });
}
