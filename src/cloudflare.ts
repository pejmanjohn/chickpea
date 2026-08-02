import {
  DurableObject,
  env,
  type DurableObjectState,
  type DurableObjectStorage,
} from 'cloudflare:workers';
import { getSandbox, Sandbox as CloudflareSandbox } from '@cloudflare/sandbox';
import type { WebClient } from '@slack/web-api';

import {
  AgentExistsError,
  AgentStillAssignedError,
  NoAssignmentError,
  UnknownAgentError,
} from './config/errors.ts';
import {
  getCachedInstallationToken,
  getGithubConnection,
} from './config/github-app.ts';
import { resolveAssignment, surfaceForChannelId } from './config/resolver.ts';
import { slackThreadKey } from './slack/thread-key.ts';
import type { AssignmentLookupOptions } from './config/resolver.ts';
import {
  parseSandboxAllowedHosts,
  SANDBOX_PACKAGE_REGISTRY_HOSTS,
  SANDBOX_SETTING_KEYS,
} from './config/sandbox-settings.ts';
import type { SettingsPatch, SettingsStore } from './config/settings-store.ts';
import { SettingsStoreLogic } from './config/settings-store.ts';
import { SnapshotStoreLogic } from './config/snapshot-store.ts';
import type {
  StateRpcResult,
  TagStateRpc,
  TurnJob,
  TurnProgress,
  TurnPullRequestProgress,
  RuntimeDrainStatus,
} from './config/state-rpc.ts';
import { buildRuntimeDrainStatus, tagStateStub } from './config/state-rpc.ts';
import type { PlatformEnv } from './config/state-backend.ts';
import { getRoutineStore, getSettingsStore } from './config/state-backend.ts';
import {
  ConfigStoreLogic,
  type ConfigAgentPatch,
  type OAuthReauthorizationTarget,
} from './config/store.ts';
import type {
  AgentSnapshot,
  ChannelAssignment,
  CustomAgentConfig,
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
import { createLedgerSlackRunHandler } from './slack/ledger-turn-driver.ts';
import { resolveSlackCredentials } from './slack/credentials.ts';
import { setObservedSlackStatus } from './slack/status-registry.ts';
import {
  createSlackWebClient,
  deliverAgentFailureFinal,
  repairSlackInteractionProgress,
  runTurn,
  sanitizeError,
} from './slack/run-turn.ts';
import { ContinuityNoticeDeliveryError } from './slack/continuity-notice.ts';
import type {
  FlueDispatchReceiptV1,
  FlueSettlementCheckpointV1,
  FlueTurnObservationV1,
} from './slack/turn-job-types.ts';
import {
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
import { UsageStoreLogic } from './usage/store.ts';
import { UsageStateError } from './usage/store-error.ts';
import type { UsageRpcRequest, UsageRpcResponse, UsageStore } from './usage/types.ts';
import { WorkStoreLogic } from './work/store.ts';
import { DurableRunDriver } from './work/driver.ts';
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
  config: ConfigStoreLogic;
  snapshots: SnapshotStoreLogic;
  slack: SlackStateLogic;
  settings: SettingsStoreLogic;
  turnJobs: TurnJobStoreLogic;
  memory: MemoryStoreLogic;
  routines: RoutineStoreLogic;
  usage: UsageStoreLogic;
  work: WorkStoreLogic;
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
        config: new ConfigStoreLogic(db),
        snapshots: new SnapshotStoreLogic(db),
        slack: new SlackStateLogic(db),
        settings: new SettingsStoreLogic(db),
        turnJobs: new TurnJobStoreLogic(db),
        memory: new MemoryStoreLogic(db),
        routines: new RoutineStoreLogic(db),
        usage: new UsageStoreLogic(db),
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

  async configListAgents(): Promise<StateRpcResult<CustomAgentConfig[]>> {
    return this.call((stores) => stores.config.listAgents());
  }

  async configGetAgent(agentId: string): Promise<StateRpcResult<CustomAgentConfig>> {
    return this.call((stores) => stores.config.getAgent(agentId));
  }

  async configCreateAgent(agent: CustomAgentConfig): Promise<StateRpcResult<CustomAgentConfig>> {
    return this.call((stores) => stores.config.createAgent(agent));
  }

  async configUpdateAgent(
    agentId: string,
    patch: ConfigAgentPatch,
  ): Promise<StateRpcResult<CustomAgentConfig>> {
    return this.call((stores) => stores.config.updateAgent(agentId, patch));
  }

  async configMarkOAuthReauthorizationRequired(
    target: OAuthReauthorizationTarget,
  ): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.config.markOAuthReauthorizationRequired(target));
  }

  async configDeleteAgent(agentId: string): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.config.deleteAgent(agentId));
  }

  // ── config: assignments ──────────────────────────────────────────────────

  async configListAssignments(): Promise<StateRpcResult<ChannelAssignment[]>> {
    return this.call((stores) => stores.config.listAssignments());
  }

  async configGetAssignment(
    workspaceId: string,
    channelId: string,
  ): Promise<StateRpcResult<ChannelAssignment | null>> {
    return this.call((stores) => stores.config.getAssignment(workspaceId, channelId) ?? null);
  }

  async configListAssignmentsForAgent(
    agentId: string,
  ): Promise<StateRpcResult<ChannelAssignment[]>> {
    return this.call((stores) => stores.config.listAssignmentsForAgent(agentId));
  }

  async configPutAssignment(
    assignment: ChannelAssignment,
  ): Promise<StateRpcResult<ChannelAssignment>> {
    return this.call((stores) => stores.config.putAssignment(assignment));
  }

  async configDeleteAssignment(
    workspaceId: string,
    channelId: string,
  ): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.config.deleteAssignment(workspaceId, channelId));
  }

  async configFind(
    workspaceId: string,
    channelId: string,
    options?: AssignmentLookupOptions,
  ): Promise<StateRpcResult<ChannelAssignment | null>> {
    return this.call((stores) => stores.config.find(workspaceId, channelId, options) ?? null);
  }

  // ── agent snapshots ──────────────────────────────────────────────────────

  async snapshotGet(threadKey: string): Promise<StateRpcResult<AgentSnapshot | null>> {
    return this.call((stores) => stores.snapshots.get(threadKey) ?? null);
  }

  async snapshotPutIfAbsent(
    threadKey: string,
    snapshot: AgentSnapshot,
  ): Promise<StateRpcResult<AgentSnapshot>> {
    return this.call((stores) => stores.snapshots.putIfAbsent(threadKey, snapshot));
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

  async threadParticipationGet(
    key: string,
  ): Promise<StateRpcResult<'ambient' | 'mention_only'>> {
    return this.call((stores) => stores.slack.getParticipation(key));
  }

  async threadParticipationSet(
    key: string,
    mode: 'ambient' | 'mention_only',
  ): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.slack.setParticipation(key, mode);
      return null;
    });
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
      stores.slack.admitCanonical(input, stores.work, stores.turnJobs),
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

  async slackContinuityNoticeRecord(
    id: string,
    notice: Parameters<TagStateRpc['slackContinuityNoticeRecord']>[1],
  ): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.turnJobs.recordContinuityNotice(id, notice);
      return null;
    });
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

  async slackInteractionProgressRecord(
    id: string,
    patch: Parameters<TagStateRpc['slackInteractionProgressRecord']>[1],
  ): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.turnJobs.recordSlackInteractionProgress(id, patch);
      return null;
    });
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
    statusText: string,
  ): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      const target = stores.turnJobs.matchFlueObservation(instanceId, submissionId);
      if (target) {
        setObservedSlackStatus(instanceId, target.generation, { text: statusText });
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
    const pending = stores.turnJobs.listPending(MAX_TURN_DRAIN_BATCH);
    if (pending.length === 0) {
      const ledgerPending = stores.turnJobs.hasPending('ledger');
      const cleanupPending = stores.turnJobs.hasPendingSlackInteractionCleanup();
      const client = ledgerPending || cleanupPending
        ? await this.resolveAlarmClient(stores)
        : undefined;
      await drainLedgerRuns(
        stores,
        this.env as PlatformEnv,
        client,
      );
      if (cleanupPending && client) {
        await drainSlackInteractionCleanups(stores, client);
      }
      if (
        stores.turnJobs.hasPending('ledger') ||
        stores.turnJobs.hasPendingSlackInteractionCleanup()
      ) {
        await this.ctx.storage.setAlarm(Date.now() + RELAY_RETRY_BACKOFF_MS);
      }
      return;
    }
    // One client per alarm firing, resolved from THIS DO's LOCAL settings so
    // credential resolution never RPCs into this same object (a self-call while
    // the alarm holds the thread). runTurn takes it as an override.
    const client = await this.resolveAlarmClient(stores);
    const usageStore = localUsageStore(stores);
    let needsRetry = false;
    // The resolver's store contract is async; the DO's logic classes are sync.
    // A tiny async adapter bridges them for the fail-closed re-check below.
    const configReader = {
      getAgent: async (id: string) => stores.config.getAgent(id),
      find: async (workspaceId: string, channelId: string, options?: AssignmentLookupOptions) =>
        stores.config.find(workspaceId, channelId, options),
    };
    const runJob = async (job: (typeof pending)[number]): Promise<void> => {
      if (!job.turn.interactionIntent && job.progress.interactionIntent) {
        job.turn.interactionIntent = job.progress.interactionIntent;
      }
      // DM turns resolve their profile live at agent time, so a profile
      // disabled in the enqueue->alarm gap would otherwise surface as a fake
      // "provider failed" final. Re-check here and fail closed exactly like
      // the admit path: silent, claims released, job tombstoned.
      if (surfaceForChannelId(job.turn.channelId) === 'direct') {
        try {
          await resolveAssignment(
            job.turn.workspaceId,
            job.turn.channelId,
            { agents: configReader, assignments: configReader },
            { surface: 'direct' },
          );
        } catch (err) {
          if (err instanceof NoAssignmentError) {
            stores.slack.release(job.evtKey);
            stores.slack.release(job.msgKey);
            stores.slack.release(`decision:${job.msgKey}`);
            if (job.turn.interactionIntent?.disposition === 'work') {
              stores.slack.setActiveWork(slackThreadKey(job.turn), job.id, false);
            }
            stores.turnJobs.markDelivered(job.id);
            return;
          }
          // Any other resolution error falls through to the normal turn path,
          // which owns retry/terminal semantics.
        }
      }
      const attempt = job.dispatchStartedAt ? Math.max(1, job.attempts) : job.attempts + 1;
      let delivered = false;
      let activeWorkKey = job.turn.interactionIntent?.disposition === 'work'
        ? slackThreadKey(job.turn)
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
        recordReceipt: (receipt: FlueDispatchReceiptV1) =>
          stores.turnJobs.recordFlueReceipt(job.id, receipt),
        recordSettlement: (settlement: FlueSettlementCheckpointV1) =>
          stores.turnJobs.recordFlueSettlement(job.id, settlement),
        markRecoveryRequired: (reason: string) =>
          stores.turnJobs.markRecoveryRequired(job.id, reason),
      };
      try {
        const persistSandboxProgress = async (): Promise<string | undefined> => {
          const binding =
            (this.env as PlatformEnv).SANDBOX ?? (this.env as PlatformEnv).Sandbox;
          if (!binding) return undefined;
          const conversationKey = slackThreadKey(job.turn);
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
        const runtimePlanDecision = job.runtimePlan && job.agentInstanceId &&
            job.continuityNoticeRequired !== undefined
          ? {
              runtimePlan: job.runtimePlan,
              instanceId: job.agentInstanceId,
              continuityNoticeRequired: job.continuityNoticeRequired,
            }
          : undefined;
        await runTurn(job.turn, job.assignment, this.env as PlatformEnv, {
          client,
          turnId: job.id,
          usageExecutionId: `exec:${job.id}:flue`,
          ...(job.runId ? { runId: job.runId, runAttempt: attempt } : {}),
          workStore: stores.work as unknown as WorkStore,
          settingsStore: localSettingsStore(stores),
          usageStore,
          ...(runtimePlanDecision ? { runtimePlanDecision } : {}),
          onRuntimePlan: (candidate) => stores.turnJobs.freezeRuntimePlan(job.id, candidate),
          flueDispatch,
          ...(job.progress.continuityNotice
            ? { continuityNoticeProgress: job.progress.continuityNotice }
            : {}),
          onContinuityNoticeProgress: (notice) => {
            stores.turnJobs.recordContinuityNotice(job.id, notice);
          },
          onUsagePersistence: (event) => {
            stores.turnJobs.recordUsagePersistence(job.id, event);
          },
          onInteractionIntent: (intent) => {
            stores.turnJobs.recordInteractionIntent(job.id, intent);
            if (intent.disposition !== 'work') return;
            activeWorkKey = slackThreadKey(job.turn);
            stores.slack.setActiveWork(activeWorkKey, job.id, true);
          },
          ...(job.progress.slackInteraction
            ? { interactionProgress: job.progress.slackInteraction }
            : {}),
          onInteractionProgress: (patch) => {
            stores.turnJobs.recordSlackInteractionProgress(job.id, patch);
          },
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
        });
        // Delivery was tombstoned at the exact presentation boundary above.
        // Claims stay held — a completed turn never re-runs.
      } catch (err) {
        if (err instanceof ContinuityNoticeDeliveryError) {
          if (err.recoveryRequired) {
            stores.turnJobs.markRecoveryRequired(
              job.id,
              'continuity_notice_delivery_unknown',
            );
            console.error('[chickpea] continuity notice delivery requires reconciliation');
          } else {
            needsRetry = true;
          }
          if (activeWorkKey) stores.slack.setActiveWork(activeWorkKey, job.id, false);
          return;
        }
        // Any failure after the terminal presentation boundary is cleanup,
        // not a failed turn. The durable tombstone prevents a duplicate final;
        // keep the claims held and let a later thread turn start normally.
        if (delivered) {
          console.warn('[chickpea] post-delivery cleanup did not complete');
          return;
        }
        if (flueDispatch.dispatchEnvelope) {
          // A dispatched turn is never discarded or replaced. A later alarm
          // replays its admission key, receipt read, or terminal settlement.
          needsRetry = true;
          if (activeWorkKey) stores.slack.setActiveWork(activeWorkKey, job.id, false);
          console.warn('[chickpea] Flue turn retained for durable reattachment');
          return;
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
          ).catch((finalErr) => {
            console.error('[chickpea] relay terminal final failed:', sanitizeError(finalErr));
          });
          stores.slack.release(job.evtKey);
          stores.slack.release(job.msgKey);
          stores.slack.release(`decision:${job.msgKey}`);
          if (activeWorkKey) stores.slack.setActiveWork(activeWorkKey, job.id, false);
          stores.turnJobs.markError(job.id);
        } else {
          needsRetry = true;
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
      const key = slackThreadKey(job.turn);
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
            await runJob(job);
          }
        }
      }),
    );
    await drainLedgerRuns(stores, this.env as PlatformEnv, client);
    await drainSlackInteractionCleanups(stores, client);
    needsRetry ||= stores.turnJobs.hasPending('legacy') ||
      stores.turnJobs.hasPending('ledger') ||
      stores.turnJobs.hasPendingSlackInteractionCleanup();
    if (needsRetry) {
      // Re-arm (do NOT throw) so this invocation returns normally and its
      // attempt-count writes commit; the next firing re-drives the leftover
      // pending jobs.
      await this.ctx.storage.setAlarm(Date.now() + RELAY_RETRY_BACKOFF_MS);
    }
  }

  /**
   * A Slack WebClient for the alarm, using the bot token resolved from env
   * (process.env) first and this DO's LOCAL settings store second. Passing the
   * local settings as the resolver's store bypasses both the resolver cache AND
   * the Cloudflare settings proxy — so this never opens an RPC back into this
   * same Durable Object while the alarm is executing.
   */
  private async resolveAlarmClient(stores: TagStateStores): Promise<WebClient> {
    const localSettings = localSettingsStore(stores);
    const { botToken } = await resolveSlackCredentials(this.env as PlatformEnv, localSettings);
    return createSlackWebClient(botToken);
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
      if (err instanceof AgentStillAssignedError) {
        return rpcError('agent_still_assigned', err.message, {
          agentId: err.agentId,
          keys: err.keys,
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
      const message = err instanceof Error ? err.message : String(err);
      console.error('[chickpea] TagStateStore RPC failure:', message);
      return rpcError('internal', message);
    }
  }
}

async function drainSlackInteractionCleanups(
  stores: TagStateStores,
  client: WebClient,
): Promise<void> {
  for (const job of stores.turnJobs.listPendingSlackInteractionCleanups(MAX_TURN_DRAIN_BATCH)) {
    const progress = job.progress.slackInteraction;
    if (!progress) continue;
    try {
      await repairSlackInteractionProgress(
        job.turn,
        job.assignment,
        progress,
        client,
        (patch) => {
          stores.turnJobs.recordSlackInteractionProgress(job.id, patch);
        },
      );
    } catch (error) {
      console.warn('[chickpea] Slack interaction cleanup retry failed:', sanitizeError(error));
    }
  }
}

async function drainLedgerRuns(
  stores: TagStateStores,
  platformEnv: PlatformEnv,
  client?: WebClient,
): Promise<void> {
  await new DurableRunDriver(stores.work, {
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
      ...(client ? { client } : {}),
      platformEnv,
      settingsStore: localSettingsStore(stores),
      usageStore: localUsageStore(stores),
      setActiveWork: (key, generation, active) =>
        stores.slack.setActiveWork(key, generation, active),
    }),
  }).drain();
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

function localUsageStore(stores: TagStateStores): UsageStore {
  return {
    admitOperation: async (input) => stores.usage.admitOperation(input),
    recordTerminal: async (input) => stores.usage.recordTerminal(input),
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

function rpcError(
  code: 'unknown_agent' | 'agent_exists' | 'agent_still_assigned' | 'memory' | 'routine' | 'usage' | 'work' | 'internal',
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
}

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
}
