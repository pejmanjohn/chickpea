import { GatewayInboxConflictError } from './slack/gateway/inbox.ts';
import { GATEWAY_HTTP_SETTING, parseHttpDeliveryState, verifyHttpDelivery, httpDeliveryReceipt, HttpDeliveryError } from './slack/gateway/http-delivery.ts';
import { GATEWAY_BINDING_SETTING } from './slack/gateway/client.ts';
import type { GatewayAdmissionResult, GatewayInboundDelivery, GatewayWorkspaceBinding } from './slack/gateway/protocol.ts';
import { gatewayUiReceiptNow } from './slack/gateway/ui-receipt.ts';
import { scheduleActionRpcResult } from './management/slack-schedule-rpc.ts';
import {
  DurableObject,
  env,
  type DurableObjectState,
} from 'cloudflare:workers';
import { Sandbox as CloudflareSandbox } from '@cloudflare/sandbox';
import { instrument } from '@flue/runtime';
import { createCloudflareTracing } from '@flue/runtime/cloudflare';
import { emitManagementToolFailure } from './management/telemetry.ts';
import { emitRuntimeCorrelation } from './work/trace-correlation.ts';
import {
  emitGatewayDelivery,
  emitRelayAlarm,
  startRelayAlarmMetrics,
  type RelayAlarmMetrics,
} from './observability/runtime-latency.ts';

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
  ModelRoleRevisionConflictError,
  WorkspaceModelDefaultRevisionConflictError,
} from './config/errors.ts';
import { slackAgentThreadKey } from './slack/thread-key.ts';
import { gitIdentityConfigCommand, resolveWorkspaceGitIdentity } from './sandbox/git-identity.ts';
import { recordDeliveredSlackAgentMessage } from './slack/public-context.ts';
import {
  cacheSlackInstallationExecutionContexts,
  effectiveTurnSlackInstallationId,
  resolveSlackInstallationExecutionContext,
  verifySlackInstallationTurnAccess,
  type SlackInstallationExecutionResolver,
} from './slack/installation-execution.ts';
import { SANDBOX_PACKAGE_REGISTRY_HOSTS } from './config/sandbox-settings.ts';
import type {
  ModelCredentialStore,
  PublishModelCredentialInput,
  ReplaceEncryptedCredentialRevisionInput,
  RewrapModelCredentialInput,
  SettingsPatch,
  SettingsStore,
} from './config/settings-store.ts';
import { purgeExpiredImageOutputs } from './images/output-store.ts';
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
import {
  installationOwnershipOf,
  installationScopeOf,
  objectInstallationEnv,
  requireInstallationScope,
} from './config/installation-scope.ts';
import { promiseBackedStatePort } from './config/local-state-port.ts';
import { localSlackStateStore } from './slack/local-state-store.ts';
import type { UiSurfaceRpcRequest } from './slack/ui/surface-store.ts';
import {
  getConfigStore,
  getIdentityStore,
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
  type AgentModelRolePatch,
  type ConfigAgentPatch,
  type OAuthReauthorizationTarget,
} from './config/store.ts';
import type {
  ActivateChickpeaCutoverInput,
  AgentCreateInput,
  AgentChannelGrant,
  AgentChannelGrantInput,
  AgentModelRole,
  AgentModelRoleInput,
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
  RecentSlackPublicContextInput,
  NonChatModelRole,
  WorkspaceModelDefault,
  WorkspaceModelDefaultInput,
  WorkspaceModelRole,
  WorkspaceModelRoleInput,
  WorkspaceInstallation,
  WorkspaceInstallationPatch,
} from './config/types.ts';
import {
  SandboxPolicyState,
  type SandboxEgressContext,
  type SandboxEgressPolicy,
  type SandboxEgressPolicyInput,
  type SandboxPolicyStorage,
} from './sandbox/cloudflare-policy.ts';
import {
  denySandboxOutbound,
  githubSandboxOutbound,
  packageRegistrySandboxOutbound,
  type SandboxOutboundHandler,
} from './sandbox/egress-outbound.ts';
import { sandboxObjectEnv, sandboxTurnReaders, type SandboxObjectContext } from './sandbox/sandbox-object.ts';
import { containerStopRecorded, sandboxHostFunctions, type SandboxHostRpc } from './sandbox/sandbox-host.ts';
import type { SandboxContainerAdmission } from './sandbox/container-lease.ts';
import {
  admitWorkspaceContainer,
  holdStartedWorkspaceContainer,
  isContainerLeaseSweepMinute,
  maintainWorkspaceContainerLeases,
  meterWorkspaceContainer,
  refuseUnadmittedContainerStart,
  requireWorkspaceTurnAdmitted,
} from './sandbox/hosted-limits.ts';
import type { SandboxContainerLimits } from './config/sandbox-settings.ts';
import { isCheckpointSweepMinute, sweepInstallationCheckpoints } from './sandbox/checkpoint-sweep.ts';
import { isOAuthKeepAliveMinute, runOAuthKeepAliveSweep } from './connections/oauth-keepalive.ts';
import {
  SandboxWorkspaceState,
  WORKSPACE_CHECKPOINT_EXCLUDES,
  WORKSPACE_CHECKPOINT_TTL_SECONDS,
  WORKSPACE_DIR,
  type WorkspaceTurnState,
} from './sandbox/workspace-lifecycle.ts';
import {
  readStoredWorkspaceRoster,
  type WorkspaceRosterState,
} from './sandbox/workspace-limits.ts';
import {
  putStoredCodingTask,
  readStoredCodingTasks,
  settleStoredCodingTask,
  type CodingTaskRecordV1,
} from './sandbox/coding-task-record.ts';
import {
  checkpointWorkspace,
  discardWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  workspaceCheckpointsAvailable,
} from './sandbox/workspace-checkpoints.ts';
import {
  clearWarmWindow,
  holdWarmWindow,
  stopPastWarmWindow,
  type WarmWindowStorage,
  workspaceWarmWindowMs,
} from './sandbox/warm-window.ts';
import type { SlackCanonicalAdmissionInput } from './slack/claim-store.ts';
import {
  SlackPresentationStateError,
} from './slack/run-presentations.ts';
import { createLedgerSlackRunHandler } from './slack/ledger-turn-driver.ts';
import type { SlackPresentationStatePort } from './slack/agent-view-presentation.ts';
import { CfSlackStateStore } from './config/cf-state-proxies.ts';
import type { SlackPresentationTransitionInput, SlackReadMethod } from './slack/run-presentations.ts';
import { defaultSlackStatusRegistry } from './slack/status-registry.ts';
import {
  activityStatus,
  isSafeTypedActivityStatus,
  type TypedActivityStatus,
} from './activity/status.ts';
import {
  repairSlackInteractionProgress,
  runTurn,
  sanitizeError,
} from './slack/run-turn.ts';
import {
  ALARM_ADMISSION_RECHECK_MS,
  ALARM_PENDING_PER_THREAD,
  ALARM_TURN_BUDGET_MS,
  ALARM_TURN_HARD_CAP_MS,
  ALARM_YIELD_REARM_MS,
  drainAlarmTurnJobs,
  type AlarmTurnJobControl,
} from './slack/alarm-turn-drain.ts';
import {
  executeTurnJob,
  type TurnExecutionPorts,
} from './slack/turn-executor.ts';
import { slackTurnExecutor } from './slack/turn-executor-flag.ts';
import {
  boundedStopCall,
  receiveAlarmExecutorStop,
  STOP_NOTICE_DELIVERY_TIMEOUT_MS,
  StopAbortFence,
} from './slack/runner-stops.ts';
import { abortSlackThreadAgent } from './slack/flue-dispatch.ts';
import {
  RUNNER_PREFETCHED_SETTINGS,
  threadRunnerStub,
  type RunnerTurnBegin,
  type SlackThreadRunnerRpc,
  type ThreadRunnerJobPayload,
  type ThreadRunnerTurnKind,
  type ThreadRunnerTurnOp,
  type ThreadRunnerTurnResult,
} from './slack/thread-runner-rpc.ts';
import { localSlackPresentationStatePort } from './slack/presentation-state-port.ts';
import {
  drainSlackPresentationRepairs,
  type SlackPresentationRepairDrainResult,
} from './slack/presentation-repair.ts';
import {
  deliverDueStopNotices,
  MAX_TURN_DRAIN_BATCH,
  oauthResumeTurnJobId,
  type PendingTurnJob,
} from './slack/turn-jobs.ts';
import type { TurnSteeringDecision } from './slack/turn-job-types.ts';
import { DoSqlStateDb } from './state/do-state-db.ts';
import { buildTagStateStores, type TagStateStores } from './state/tag-state-stores.ts';
import type {
  HostObjectStorage,
  ObjectExportRequest,
  ObjectHostRequest,
  ObjectRestoreBookmarksRequest,
  ObjectRestoreRequest,
  ObjectRestoreRestartRequest,
} from './state/object-host.ts';
import type { InstallationWorkspaceObject } from './state/object-inventory.ts';
import { stateStoreHostFunctions, type StateStoreHostRpc } from './state/state-store-host.ts';
import { StateSchemaMarker, stateSchemaFingerprint } from './state/schema-lifecycle.ts';
import { cloudflareWorkerVersionId } from './config/cloudflare-version.ts';
import { applicationIdentity, viteServeLane } from './release/identity.ts';
import { registerCloudflareBindingProvider } from './cloudflare-provider.ts';
import { MemoryStateError, type MemoryRpcRequest, type MemoryRpcResponse } from './memory/types.ts';
import {
  RoutineStateError,
  type RoutineRpcRequest,
  type RoutineRpcResponse,
} from './routines/types.ts';
import {
  createRoutineScheduledHandler,
  runWithGuaranteedFinalizer,
} from './routines/scheduler-adapter.ts';
import {
  GATEWAY_INBOX_MAX_DRAIN_BATCH,
  gatewayDeliveryFailureReason,
  gatewayDeliveryRetryDelayMs,
  recordGatewayDeliveryDeadLetter,
} from './slack/gateway/inbox.ts';
import {
  GatewayDeploymentClient,
} from './slack/gateway/client.ts';
import { resolveChickpeaGatewayUrl } from './slack/gateway/runtime.ts';
import { loadCredentialKeyring } from './slack/credential-keyring.ts';
import {
  processGatewayAgentSelection,
  processGatewayPrivateChannelSetup,
  processGatewayUiAction,
  processGatewayViewSubmission,
  processGatewaySlackEnvelope,
  processSlackAgentAsks,
} from './channels/slack.ts';
import {
  SlackGatewaySession,
  wakeCloudflareGatewaySession,
} from './slack/gateway/cloudflare-session.ts';
import { UsageStateError } from './usage/store-error.ts';
import type { UsageRpcRequest, UsageRpcResponse, UsageStore } from './usage/types.ts';
import { IdentityStateError } from './identity/errors.ts';
import {
  bindStoreInstallation,
  type InstallationIdentity,
} from './identity/installation-binding.ts';
import type { IdentityStore } from './identity/types.ts';
import type { IdentityRpcRequest, IdentityRpcResponse } from './identity/types.ts';
import type { ManagementStore } from './management/store.ts';
import { createLiveWorkspaceManagementService } from './management/live-service.ts';
import { createPlatformProductTelemetry } from './telemetry/platform.ts';
import type { ProductTelemetryCapture } from './telemetry/client.ts';
import type { SlackAgentAskDispatcher } from './slack/agent-asks.ts';
import { createWaitUntilTelemetryLifecycle } from './telemetry/runtime.ts';
import {
  invokeSlackWorkspaceManagementTool,
  resolveSlackManagementActor,
} from './management/slack-tools.ts';
import {
  executeHostSlackManagementApproval,
  type HostSlackManagementApprovalResult,
  type SlackManagementApprovalRpcRequest,
} from './management/slack-approval.ts';
import { agentAvatarInstallationField } from './slack/agent-presence/avatar-assets.ts';
import {
  invokeSlackScheduleAction,
  retryDueSlackScheduleActions,
  type SlackScheduleActionOutcome,
  type SlackScheduleActionRpcRequest,
} from './management/slack-schedule-actions.ts';
import type { WorkspaceManagementToolResult } from './management/tool-adapter.ts';
import {
  completeAgentWelcomeDelivery,
  completeSettledAgentWelcomeHandoff,
  deliverManagementReceiptToSlack,
  drainManagementReceiptOutbox,
  failAgentWelcomeTurn,
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
import { runRoutineHeartbeat as runSharedRoutineHeartbeat } from './routines/heartbeat.ts';

// The generated default captures model and tool content. Register the native
// Cloudflare adapter explicitly for this Cloudflare-only entry so Workers
// Traces retain operational Flue spans without prompts, instructions, tool
// definitions, arguments, results, error messages, or stacks.
const cloudflareTracing = createCloudflareTracing({ content: false });
instrument({
  ...cloudflareTracing,
  async observe(observation, context) {
    emitRuntimeCorrelation(observation);
    await cloudflareTracing.observe(observation, context);
    emitManagementToolFailure(observation);
  },
});

// This module is imported only by Flue's Cloudflare entry. Register before
// the generated entry's guarded default so `cloudflare/*` remains keyless but
// calls env.AI directly, without the default payload-logging AI Gateway.
// Importable `env` is Cloudflare's ambient binding object; no I/O runs here.
registerCloudflareBindingProvider(env.AI);

export { ContainerProxy } from '@cloudflare/sandbox';

/**
 * Cloudflare's Sandbox SDK routes intercepted container HTTPS through
 * Worker-side handlers (sandbox/egress-outbound.ts). Profile grants are
 * persisted as policy only; the credential is minted after each request
 * passes the pure policy decision and is attached only to the Worker-side
 * forwarded Request. On a deployment serving many installations the object
 * is named under one (sandbox/sandbox-object.ts) and serves only it.
 */
export class Sandbox extends CloudflareSandbox<PlatformEnv> {
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

  constructor(ctx: DurableObjectState, env: PlatformEnv) {
    super(ctx, sandboxObjectEnv(ctx as unknown as SandboxObjectContext, env));
  }

  /**
   * Reached only when the Containers SDK constructor succeeded, which requires
   * a linked Container application. Starts nothing.
   */
  async probeContainerRuntime(): Promise<boolean> {
    return (this.ctx as { container?: unknown }).container !== undefined;
  }

  async prepareTurn(turnId: string): Promise<void> {
    await this.policyState().prepareTurn(turnId);
  }

  async configureEgress(
    input: SandboxEgressPolicyInput,
    turnId: string,
  ): Promise<void> {
    await this.policyState().configureEgress(input, turnId);
  }

  /**
   * Decide whether this turn may reuse the running container. The workspace
   * stays warm across turns for the same Agent and grants; any other owner
   * gets a destroyed container rather than the prior checkout. Destroy only
   * clears the SDK's own storage keys, so the prepared turn id survives.
   */
  async beginWorkspaceTurn(input: {
    fingerprint: string;
    turnId: string;
  }): Promise<{ state: WorkspaceTurnState; reservationId: string; restorable: boolean }> {
    // A suspended or ended installation opens no workspace turn.
    await requireWorkspaceTurnAdmitted(this.env);
    await clearWarmWindow(this.warmWindowStorage());
    const decision = await this.workspaceState().beginTurn({
      ...input,
      containerRunning: this.containerRunning(),
      now: Date.now(),
    });
    if (decision.retire) await this.destroy();
    return {
      state: decision.state,
      reservationId: decision.reservationId,
      restorable: decision.restorable && workspaceCheckpointsAvailable(this.env),
    };
  }

  /**
   * Admit this activation's container under the host's running limit and
   * container-hours cap, holding its lease; standalone always admits.
   * Called before the activation starts the container.
   */
  async admitContainer(limits: SandboxContainerLimits): Promise<SandboxContainerAdmission> {
    return admitWorkspaceContainer(this.env, {
      key: this.ctx.id.toString(),
      running: this.containerRunning(),
      limits,
      now: Date.now(),
    });
  }

  /**
   * Renew a running container's lease for its warm window, or release a
   * stopped one's, metering its run: at a turn's end, and when the session
   * cap refused a container admission had let start.
   */
  async settleContainerLease(): Promise<void> {
    await meterWorkspaceContainer(
      this.env,
      this.containerRunning() ? 'hold' : 'release',
      { key: this.ctx.id.toString(), now: Date.now() },
    );
  }

  /** For work maintenance: whether a lease's container still runs. Starts nothing. */
  async isContainerRunning(): Promise<boolean> {
    return this.containerRunning();
  }

  /** The last start's lease hold, which a stop's release waits for. */
  private startHold: Promise<void> | undefined;

  override async onStart(): Promise<void> {
    await super.onStart();
    // The Containers SDK runs this inside blockConcurrencyWhile, so the hold
    // and the admission check run beside the start, bounded, and every start
    // is still metered.
    const hold = holdStartedWorkspaceContainer(this.env, { key: this.ctx.id.toString(), now: Date.now() });
    if (hold) {
      this.startHold = hold;
      this.waitUntil(hold);
    }
    // A session's next operation restarts a container the host stopped,
    // through the SDK and past the activation's admission: a refused
    // installation's start destroys itself.
    const refusal = refuseUnadmittedContainerStart(this.env, () => this.destroy());
    if (refusal) this.waitUntil(refusal);
  }

  /**
   * The SDK's alarm stops an idle container at a deadline it keeps in
   * memory, which every restart of this object pushes a full window out.
   * The window a turn's end stored is the one that counts.
   */
  override async alarm(alarmProps?: Parameters<CloudflareSandbox['alarm']>[0]): Promise<void> {
    await stopPastWarmWindow({
      storage: this.warmWindowStorage(),
      running: this.containerRunning(),
      now: Date.now(),
      stop: () => this.onActivityExpired(),
    });
    await super.alarm(alarmProps);
  }

  override async onStop(params?: Parameters<CloudflareSandbox['onStop']>[0]): Promise<void> {
    await super.onStop(params);
    await this.releaseContainerLease();
  }

  /** Close a stopped container's lease, metering its run: its stop's, or an erasure's. */
  private async releaseContainerLease(): Promise<void> {
    // A start's hold still in flight lands first, so this release closes it.
    await this.startHold;
    await meterWorkspaceContainer(this.env, 'release', { key: this.ctx.id.toString(), now: Date.now() });
  }

  private waitUntil(promise: Promise<unknown>): void {
    // The runtime has waitUntil on DurableObjectState; the module declaration omits it.
    (this.ctx as DurableObjectState & { waitUntil(promise: Promise<unknown>): void }).waitUntil(promise);
  }

  /**
   * Bring back the thread's last checkpoint into a cold container. Best
   * effort: an expired, missing, or failed restore leaves an empty workspace
   * and the Agent clones again.
   */
  async restoreWorkspace(fingerprint: string): Promise<'restored' | 'unavailable'> {
    return restoreWorkspaceCheckpoint({
      env: this.env,
      state: this.workspaceState(),
      fingerprint,
      now: Date.now,
      restore: async (backup) => {
        await this.restoreBackup(backup as Parameters<CloudflareSandbox['restoreBackup']>[0]);
      },
    });
  }

  /**
   * Preset the Git author and committer for this workspace: the GitHub App's
   * bot account, or the neutral Chickpea identity. Runs at each activation,
   * because a cold container or a restored checkpoint has no global config.
   * Identity only; credentials never enter Git configuration.
   */
  async applyGitIdentity(): Promise<void> {
    const identity = await resolveWorkspaceGitIdentity(getSettingsStore(this.env), fetch, this.env);
    const result = await this.exec(gitIdentityConfigCommand(identity));
    if (result.exitCode !== 0) throw new Error('Workspace Git identity was not applied');
  }

  /**
   * End the turn's credential window without stopping the warm container,
   * then checkpoint the workspace so the thread can resume after it sleeps.
   */
  async endTurn(): Promise<void> {
    await this.policyState().revokeEgress();
    // Never start a container just to checkpoint it.
    await checkpointWorkspace({
      env: this.env,
      containerRunning: this.containerRunning(),
      state: this.workspaceState(),
      now: Date.now,
      create: () => this.createBackup({
        dir: WORKSPACE_DIR,
        ttl: WORKSPACE_CHECKPOINT_TTL_SECONDS,
        excludes: [...WORKSPACE_CHECKPOINT_EXCLUDES],
        localBucket: true,
      }),
    });
    if (this.containerRunning()) {
      const windowMs = await workspaceWarmWindowMs(this.env);
      await holdWarmWindow(this.warmWindowStorage(), Date.now(), windowMs);
    }
    await this.settleContainerLease();
  }

  /**
   * What the workspace tools report without a container round trip: whether
   * the container is running and whether this owner has a checkpoint.
   */
  async describeWorkspace(fingerprint: string): Promise<{ running: boolean; hasCheckpoint: boolean }> {
    return {
      running: this.containerRunning(),
      hasCheckpoint:
        workspaceCheckpointsAvailable(this.env) &&
        (await this.workspaceState().hasCheckpoint(fingerprint, Date.now())),
    };
  }

  /**
   * Destroy the container and forget its checkpoint, deleting its objects,
   * so the next turn starts from an empty workspace. The owner record and
   * prepared turn survive.
   */
  async discardWorkspace(): Promise<void> {
    await discardWorkspaceCheckpoint({ env: this.env, state: this.workspaceState() });
    await this.destroy();
  }

  /**
   * The roster copy releases before thread continuity wrote here. Read only,
   * to seed a thread instance once (see WorkspaceRosterSeed).
   */
  async readWorkspaceRoster(key: string): Promise<WorkspaceRosterState> {
    return readStoredWorkspaceRoster(this.policyStorage(), key);
  }

  /**
   * A host turn's active coding-task records, kept on the thread's default
   * workspace so a stop finds every coding job the run waits on.
   */
  async readCodingTasks(turnId: string): Promise<CodingTaskRecordV1[]> {
    return readStoredCodingTasks(this.policyStorage(), turnId);
  }

  async putCodingTask(turnId: string, record: unknown): Promise<void> {
    await putStoredCodingTask(this.policyStorage(), turnId, record, Date.now());
  }

  async settleCodingTask(turnId: string, taskKey: string): Promise<void> {
    await settleStoredCodingTask(this.policyStorage(), turnId, taskKey, Date.now());
  }

  // ── host functions (installation tenancy; see sandbox/sandbox-host.ts) ──
  // An operator job's: each refuses on standalone and for any installation
  // but the one this Sandbox's name scopes.

  async chickpeaHostExportPage(request: ObjectExportRequest) {
    return this.host().chickpeaHostExportPage(request);
  }

  async chickpeaHostErase(request: ObjectHostRequest) {
    return this.host().chickpeaHostErase(request);
  }

  async chickpeaHostCancelPendingWork(request: ObjectHostRequest) {
    return this.host().chickpeaHostCancelPendingWork(request);
  }

  async chickpeaHostStopContainer(request: ObjectHostRequest) {
    return this.host().chickpeaHostStopContainer(request);
  }

  async chickpeaHostRestoreBookmarks(request: ObjectRestoreBookmarksRequest) {
    return this.host().chickpeaHostRestoreBookmarks(request);
  }

  async chickpeaHostRestore(request: ObjectRestoreRequest) {
    return this.host().chickpeaHostRestore(request);
  }

  async chickpeaHostRestoreRestart(request: ObjectRestoreRestartRequest) {
    return this.host().chickpeaHostRestoreRestart(request);
  }

  private host(): SandboxHostRpc {
    return sandboxHostFunctions({
      env: this.env,
      storage: this.ctx.storage as unknown as HostObjectStorage,
      restoreContext: this.ctx,
      running: () => this.containerRunning(),
      destroy: () => this.destroy(),
      stopRecorded: () => containerStopRecorded(() => this.getState()),
      releaseLease: () => this.releaseContainerLease(),
      currentCheckpoint: () => this.workspaceState().currentCheckpoint(),
      containerState: () => this.getState(),
    });
  }

  private containerRunning(): boolean {
    return (this.ctx as { container?: { running?: boolean } }).container?.running === true;
  }

  private workspaceState(): SandboxWorkspaceState {
    return new SandboxWorkspaceState(this.policyStorage());
  }

  private warmWindowStorage(): WarmWindowStorage {
    return this.ctx.storage as unknown as WarmWindowStorage;
  }

  async getEgressPolicy(): Promise<SandboxEgressPolicy> {
    return this.policyState().getEgressPolicy();
  }

  /**
   * Everything an egress handler needs from this Sandbox in one call: the
   * installation it serves (from its scoped env), its turn and the turn's
   * policy.
   */
  async egressContext(): Promise<SandboxEgressContext> {
    const installationId = installationScopeOf(this.env)?.installationId;
    return {
      ...(installationId ? { installationId } : {}),
      ...(await this.policyState().egressContext()),
    };
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

// Pages of MAX_TURN_DRAIN_BATCH threads one alarm hands to thread runners.
// Each hand-off is one short admission RPC; the rest waits for the next alarm.
const RUNNER_DISPATCH_MAX_PAGES = 16;

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

export class TagStateStore extends DurableObject implements TagStateRpc, StateStoreHostRpc {
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
  /** Set while an alarm drains turns: new admissions start without waiting. */
  private alarmAdmissionWake: (() => void) | undefined;
  /**
   * Turn jobs an alarm returned without at its hard cap (job id to thread
   * key), still running in this isolate. Their threads stay closed until they
   * settle so a delivery in flight is never started a second time.
   */
  private readonly carriedAlarmTurns = new Map<string, string>();
  /**
   * Stop aborts this store sends for its own alarm's turns, per thread: the
   * alarm starts no turn of a thread while one is out (see StopAbortFence).
   * Replaced when the store is erased.
   */
  private stopAborts = new StopAbortFence();
  private readonly presentationRunnerOf = (runId: string) => this.presentationRunner(runId);
  /** Set while runner-mode alarm work runs: admission hands new turns over at once. */
  private dispatchWake: (() => void) | undefined;
  /** Slack turns admitted in this isolate (events, deliveries, OAuth resumes). */
  private admissionsSeen = 0;
  /**
   * This instance, as the owner of the gateway inbox leases it takes. Only one
   * instance owns this object's storage at a time; a lease under any other
   * owner was taken by an instance that has been replaced (see
   * GatewayInboxOwnership).
   */
  private readonly instanceId = crypto.randomUUID();
  /** This instance installed the schema: it is the first on this Worker version. */
  private versionChanged = false;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, objectInstallationEnv(ctx, env));
    this.stores = this.tryInit();
    // Work the previous instance was running stopped with it (a code update,
    // a reset). Arm the alarm now rather than wait for the platform's retry.
    void ctx.blockConcurrencyWhile(() => this.resumeAfterRestart());
  }

  /**
   * On a fresh instance, when nothing else will wake it soon: arm the alarm
   * now if an alarm turn's Flue dispatch was in flight, a gateway delivery is
   * leased by the previous instance, or (first instance on a new Worker
   * version) a hand-off to a thread runner is unconfirmed. Each signal is
   * read on its own, so one failing read never hides the others. An alarm
   * already set is kept: it is either due or a deliberate backoff (a rate
   * limit's retry-after), which a restart must not skip. Never throws:
   * blockConcurrencyWhile resets the object on a rejection.
   */
  private async resumeAfterRestart(): Promise<void> {
    const stores = this.stores;
    if (!stores) return;
    const read = (probe: () => boolean): boolean => {
      try {
        return probe();
      } catch {
        return false;
      }
    };
    const alarmTurn = read(() => stores.turnJobs.hasInterruptedAlarmDispatch());
    const inbox = read(() => stores.gatewayInbox.hasOrphanedLease());
    const handoffs = this.versionChanged && read(() => stores.turnJobs.hasHandoffs());
    if (!alarmTurn && !inbox && !handoffs) return;
    try {
      const armed = (await this.ctx.storage.getAlarm()) === null;
      if (armed) await this.ctx.storage.setAlarm(Date.now());
      console.info({
        component: 'runtime',
        event: 'state_store_resume',
        versionChanged: this.versionChanged,
        alarmTurn,
        inbox,
        handoffs,
        armed,
      });
    } catch {
      console.warn('[chickpea] TagStateStore could not arm its resume alarm');
    }
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

  /**
   * Apply one approved management proposal for a Slack turn a thread runner
   * executes. The runner holds no management state, so the approval crosses
   * into the state owner once and runs against its local stores, exactly as
   * the alarm executor's turns do. Non-idempotent: the caller never replays
   * it, and the service's proposal state answers a re-run approval turn.
   */
  async slackManagementApprovalInvoke(
    request: SlackManagementApprovalRpcRequest,
  ): Promise<HostSlackManagementApprovalResult> {
    this.stores ??= this.tryInit();
    const stores = this.stores;
    if (!stores) throw new Error('Management approval state is unavailable.');
    const appStores = localGatewayAppStores(stores);
    const { service } = localManagementRuntime(stores, this.env as PlatformEnv, appStores);
    const result = await executeHostSlackManagementApproval({
      turn: request.turn,
      assignment: request.assignment,
      turnJobId: request.turnJobId,
      proposalId: request.proposalId,
      dependencies: {
        identity: appStores.identity,
        config: appStores.config,
        management: appStores.management,
        service,
        ...(request.publicUrl ? { publicUrl: request.publicUrl } : {}),
        // This store's own installation, never the runner's word for it.
        ...agentAvatarInstallationField(this.env as PlatformEnv),
      },
      ...(request.presentationRunId ? { presentationRunId: request.presentationRunId } : {}),
    });
    try {
      const outboxDueAt = stores.management.nextOutboxDueAt();
      if (outboxDueAt !== undefined) {
        await this.armAlarmNoLaterThan(Math.max(Date.now(), outboxDueAt));
      }
    } catch {
      // The approval is applied; its receipt delivery is retryable follow-up.
      console.error('[chickpea] Slack management approval receipt alarm failed');
    }
    return result;
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
    const result = await scheduleActionRpcResult(() => invokeSlackScheduleAction({
      signal: request.signal,
      context,
      operation: request.operation,
      dependencies: {
        management: local.management,
        routines: local.routines,
        service,
        owner: `rpc:${request.signal.turnJobId}`,
      },
    }));
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
      // An object no installation's name addresses serves nothing.
      requireInstallationScope(this.env as PlatformEnv);
      const fingerprint = stateSchemaFingerprint(
        cloudflareWorkerVersionId(this.env),
        applicationIdentity,
        { localServe: viteServeLane },
      );
      const marker = fingerprint === undefined
        ? undefined
        : new StateSchemaMarker(new DoSqlStateDb(this.ctx.storage), fingerprint);
      if (marker?.isInstalled()) {
        // This exact Worker version already completed and verified the
        // install on this storage. Attach without DDL, migrations, probes or
        // seeds: Durable Objects SQLite meters every row those statements
        // read, and this constructor runs on every cold start.
        this.initError = undefined;
        return this.buildStores(new DoSqlStateDb(this.ctx.storage, 'attach'));
      }
      // The install and its marker commit atomically: constructor
      // transactions (config seedOnce) nest as savepoints inside this one, and
      // an uncaught throw anywhere discards every table, row and the marker,
      // so the next cold start installs again. Any deploy, forward or
      // rollback, carries a new upload id and installs once.
      const db = new DoSqlStateDb(this.ctx.storage);
      const stores = db.transaction(() => {
        const built = this.buildStores(db);
        marker?.record(Date.now());
        return built;
      });
      if (marker) {
        this.versionChanged = true;
        console.info('[chickpea] TagStateStore schema installed', JSON.stringify({ fingerprint }));
      }
      this.initError = undefined;
      return stores;
    } catch (err) {
      this.initError = err instanceof Error ? err.message : String(err);
      console.error('[chickpea] TagStateStore init failed:', this.initError);
      return undefined;
    }
  }

  private buildStores(db: DoSqlStateDb): TagStateStores {
    return buildTagStateStores(db, this.env as PlatformEnv, { gatewayLeaseOwner: this.instanceId });
  }

  /**
   * Provisioning, on a deployment serving many installations: record the
   * globally unique IDs its host assigned to this one. Idempotent; a store is
   * never rebound to other IDs.
   */
  async bindInstallation(
    identity: InstallationIdentity,
  ): Promise<StateRpcResult<InstallationIdentity>> {
    return this.call((stores) =>
      bindStoreInstallation(stores.installationBinding, this.env as PlatformEnv, identity));
  }

  // ── host functions (installation tenancy; see state/installation-objects.ts) ──
  // An operator job's: each refuses on standalone and for any installation
  // but the one this store's name scopes (state/state-store-host.ts).
  // Erasure must be the installation's last contact with this store: any
  // later call, these included, builds an empty, seeded store again.

  async chickpeaHostInventory(request: ObjectHostRequest & { cursor?: string | null; limit?: number }) {
    return this.host().chickpeaHostInventory(request);
  }

  async chickpeaHostRestoreBookmarks(request: ObjectRestoreBookmarksRequest) {
    return this.host().chickpeaHostRestoreBookmarks(request);
  }

  async chickpeaHostRestore(request: ObjectRestoreRequest) {
    return this.host().chickpeaHostRestore(request);
  }

  async chickpeaHostRestoreRestart(request: ObjectRestoreRestartRequest) {
    return this.host().chickpeaHostRestoreRestart(request);
  }

  async chickpeaHostInventoryBackfill(request: ObjectHostRequest) {
    return this.host().chickpeaHostInventoryBackfill(request);
  }

  async chickpeaHostSandboxCensus(request: ObjectHostRequest & { now?: number }) {
    return this.host().chickpeaHostSandboxCensus(request);
  }

  async chickpeaHostExportPage(request: ObjectExportRequest) {
    return this.host().chickpeaHostExportPage(request);
  }

  async chickpeaHostErase(request: ObjectHostRequest) {
    return this.host().chickpeaHostErase(request);
  }

  async chickpeaHostCancelPendingWork(request: ObjectHostRequest) {
    return this.host().chickpeaHostCancelPendingWork(request);
  }

  private host(): StateStoreHostRpc {
    return stateStoreHostFunctions({
      env: this.env as PlatformEnv,
      storage: this.ctx.storage,
      restoreContext: this.ctx,
      stores: () => {
        this.stores ??= this.tryInit();
        if (!this.stores) throw new Error(`state store unavailable: init failed (${this.initError ?? 'unknown'})`);
        return this.stores;
      },
      // Nothing of the erased store stays in memory: its stores, the alarm
      // turns it carried and the stop aborts it fenced. A later call builds
      // an empty store again.
      onErased: () => {
        this.stores = undefined;
        this.carriedAlarmTurns.clear();
        this.stopAborts = new StopAbortFence();
      },
    });
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
    // Every request that can write a receipt outbox row arms the drain. The
    // Agent welcome is claimed from inside the turn, which under the thread
    // runner executes in its SlackThreadRunner, not in this object's alarm:
    // nothing else would drain it until an unrelated wake.
    if (result.ok && (
      request.kind === 'complete_setup' ||
      request.kind === 'put_outbox' ||
      request.kind === 'claim_introduction' ||
      request.kind === 'claim_agent_creation_welcome'
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

  async configRetainGatewayInstallation(
    input: import('./config/store.ts').RetainGatewayInstallationInput,
  ): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.config.retainGatewayInstallation(input));
  }

  async configRefreshGatewayClaimSetup(
    input: import('./config/store.ts').RefreshGatewayClaimSetupInput,
  ): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.config.refreshGatewayClaimSetup(input));
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

  async configGetWorkspaceModelRole(
    workspaceId: string,
    role: NonChatModelRole,
  ): Promise<StateRpcResult<WorkspaceModelRole | null>> {
    return this.call((stores) => stores.config.getWorkspaceModelRole(workspaceId, role) ?? null);
  }

  async configPutWorkspaceModelRole(
    input: WorkspaceModelRoleInput,
    expectedRevision?: number,
  ): Promise<StateRpcResult<WorkspaceModelRole>> {
    return this.call((stores) => stores.config.putWorkspaceModelRole(input, expectedRevision));
  }

  async configGetAgentModelRole(
    agentId: string,
    role: NonChatModelRole,
  ): Promise<StateRpcResult<AgentModelRole | null>> {
    return this.call((stores) => stores.config.getAgentModelRole(agentId, role) ?? null);
  }

  async configPutAgentModelRole(
    input: AgentModelRoleInput,
    expectedRevision?: number,
  ): Promise<StateRpcResult<AgentModelRole>> {
    return this.call((stores) => stores.config.putAgentModelRole(input, expectedRevision));
  }

  async configUpdateAgentWithModelRoles(
    agentId: string,
    patch: ConfigAgentPatch,
    roles: readonly AgentModelRolePatch[],
    expectedRevision?: number,
  ): Promise<StateRpcResult<CustomAgentConfig>> {
    return this.call((stores) =>
      stores.config.updateAgentWithModelRoles(agentId, patch, roles, expectedRevision),
    );
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

  async configListRecentSlackPublicContext(
    input: RecentSlackPublicContextInput,
  ): Promise<StateRpcResult<SlackPublicContextEntry[]>> {
    return this.call((stores) => stores.config.listRecentSlackPublicContext(input));
  }

  async configPutSlackPublicContext(
    input: SlackPublicContextEntryInput,
  ): Promise<StateRpcResult<SlackPublicContextEntry>> {
    return this.call((stores) => stores.config.putSlackPublicContext(input));
  }

  async configSeedSlackPublicContext(
    inputs: SlackPublicContextEntryInput[],
  ): Promise<StateRpcResult<number>> {
    return this.call((stores) => stores.config.seedSlackPublicContext(inputs));
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

  async configSummarizeAdoptionInventory() {
    return this.call((stores) => stores.config.summarizeAdoptionInventory());
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

  async configRefreshChannelLabel(
    workspaceId: string,
    channelId: string,
    label: string,
  ): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.config.refreshChannelLabel(workspaceId, channelId, label));
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
    const result = this.call((stores) =>
      stores.slack.admitCanonical(
        input, stores.work, stores.turnJobs, stores.presentations, stores.uiSurfaces,
      ),
    );
    if (result.ok && result.value.claimed && 'steered' in result.value) {
      await this.offerCreatedStop(result.value.steered);
    }
    return result;
  }

  async uiSurfaceExecute(request: UiSurfaceRpcRequest) {
    return this.call((stores) => stores.uiSurfaces.execute(request));
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
    threadImages?: Parameters<TagStateRpc['slackFlueDispatchPrepare']>[3],
    admittedListIds?: Parameters<TagStateRpc['slackFlueDispatchPrepare']>[4],
    turnEnvelope?: Parameters<TagStateRpc['slackFlueDispatchPrepare']>[5],
  ) {
    return this.call((stores) =>
      stores.turnJobs.prepareFlueDispatch(
        id, message, observation, threadImages, admittedListIds, turnEnvelope,
      ),
    );
  }

  async slackTurnEnvelopeGet(id: string) {
    return this.call((stores) => stores.turnJobs.getTurnEnvelope(id) ?? null);
  }

  async slackWorkspaceObjectRecord(object: InstallationWorkspaceObject) {
    return this.call((stores) => {
      stores.objectInventory.recordWorkspaceObject(object);
      return null;
    });
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
    if (result.ok && result.value > 0) {
      await this.armAlarmNoLaterThan(Date.now() + RELAY_BATCH_WINDOW_MS);
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
    const runner = this.presentationRunner(runId);
    if (runner) return runner.presentationGet(runId);
    return this.call((stores) => stores.presentations.get(runId) ?? null);
  }

  async slackProposalApprovalTurns(input: Parameters<TagStateRpc['slackProposalApprovalTurns']>[0]) {
    return this.call((stores) => stores.turnJobs.listProposalApprovalTurns(input));
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
    const runner = this.presentationRunner(input.runId);
    if (runner) return runner.presentationTransition(input);
    return this.call((stores) => stores.presentations.transition(input));
  }

  /**
   * The thread runner holding the authoritative copy of a run's presentation,
   * when a runner executes its turn. Presentation effects from outside the
   * turn (an Agent welcome settling a deferred terminal) go there, so the
   * runner and this store never advance two copies.
   */
  private presentationRunner(runId: string): SlackThreadRunnerRpc | undefined {
    try {
      this.stores ??= this.tryInit();
      const presentation = this.stores?.presentations.get(runId);
      const threadKey = presentation && this.stores!.turnJobs.runnerThreadKey(
        presentation.turnJobId,
        slackAgentThreadKey,
      );
      return threadKey ? threadRunnerStub(this.env as PlatformEnv, threadKey) : undefined;
    } catch {
      return undefined;
    }
  }

  async slackPresentationReserveAppend(workspaceId: string) {
    return this.call((stores) => stores.presentations.reserveAppend(workspaceId));
  }

  async slackPresentationAppendCooldown(workspaceId: string) {
    return this.call((stores) => stores.presentations.appendCooldownUntil(workspaceId) ?? null);
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

  async slackReserveRead(workspaceId: string, method: SlackReadMethod) {
    return this.call((stores) => stores.presentations.reserveSlackRead(workspaceId, method));
  }

  async slackApplyReadCooldown(
    workspaceId: string,
    method: SlackReadMethod,
    retryAfterMs: number,
  ) {
    return this.call((stores) =>
      stores.presentations.applySlackReadCooldown(workspaceId, method, retryAfterMs),
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

  async encryptedCredentialCensus() {
    return this.call((stores) => stores.settings.censusEncryptedCredentialRevisions());
  }

  async encryptedCredentialDelete(key: string, expectedRevision: string) {
    return this.call((stores) => stores.settings.deleteEncryptedCredentialRevision(
      key,
      expectedRevision,
    ));
  }

  async modelCredentialRead(providerId: string) {
    return this.call((stores) => stores.settings.readModelCredential(providerId) ?? null);
  }

  async modelCredentialPublish(input: PublishModelCredentialInput) {
    return this.call((stores) => stores.settings.publishModelCredential(input));
  }

  async modelCredentialRewrap(input: RewrapModelCredentialInput) {
    return this.call((stores) => stores.settings.rewrapModelCredential(input));
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
    // Maintenance repairs a missing wake; it does not admit new work. Keep an
    // existing rate-limit or delivery backoff instead of restarting it early.
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
    // bounded fan-out. Bring a later receipt/retry alarm forward for new work,
    // but never move an already-armed alarm later.
    if (result.ok) {
      await this.armAlarmNoLaterThan(Date.now() + RELAY_BATCH_WINDOW_MS, true);
    }
    return result;
  }

  async slackTurnSteer(
    request: Parameters<TagStateRpc['slackTurnSteer']>[0],
    enqueue?: Parameters<TagStateRpc['slackTurnSteer']>[1],
  ): ReturnType<TagStateRpc['slackTurnSteer']> {
    const result = this.call((stores) => stores.turnJobs.steer(request, enqueue));
    if (!result.ok) return result;
    const decision = result.value;
    if (decision.outcome === 'enqueue' && decision.enqueued) {
      // As enqueueTurn: the row and its alarm are durable before the reply.
      await this.armAlarmNoLaterThan(Date.now() + RELAY_BATCH_WINDOW_MS, true);
    } else {
      await this.offerCreatedStop(decision);
    }
    return result;
  }

  /**
   * A stop the RPC just created (a steer, or a typed stop the admission
   * recorded) is offered to its runner before the RPC answers; the outbox
   * retries the rest. Any other decision, and a stop that already existed,
   * offers nothing.
   */
  private async offerCreatedStop(decision: TurnSteeringDecision): Promise<void> {
    if (decision.outcome === 'stopped' && decision.stop.created) await this.deliverStopNotices();
  }

  async slackTurnStopFinish(
    headId: string,
    outcome: 'dropped' | 'released',
  ): ReturnType<TagStateRpc['slackTurnStopFinish']> {
    return this.call((stores) => stores.slack.finishTurnStop(
      headId,
      outcome,
      stores.turnJobs,
      stores.work,
      stores.presentations,
    ) ?? null);
  }

  async slackTurnDirectThreads(
    query: Parameters<TagStateRpc['slackTurnDirectThreads']>[0],
  ): ReturnType<TagStateRpc['slackTurnDirectThreads']> {
    return this.call((stores) => stores.turnJobs.runningDirectThreadKeys(query));
  }

  /** The alarm executor registers its turns in this isolate's status registry. */
  async slackRunFacts(turnJobId: string): ReturnType<TagStateRpc['slackRunFacts']> {
    return this.call(() => {
      if (typeof turnJobId !== 'string' || turnJobId.length === 0 || turnJobId.length > 256) {
        throw new Error('TurnJob id is invalid.');
      }
      return defaultSlackStatusRegistry.runFactsView(turnJobId) ?? null;
    });
  }

  /**
   * The stop outbox (KTD2): offer every due stop to its head row's thread
   * runner, whose acknowledgement clears it, like a runner hand-off admitted
   * again until confirmed. A head no runner owns yet stays owed: the alarm
   * hands it over first, and its dispatch is refused meanwhile. A head this
   * store's own alarm executes (SLACK_TAG_TURN_EXECUTOR=alarm) is aborted
   * here instead (receiveAlarmExecutorStop), inside its thread's abort fence.
   * Every offer is bounded, so a wedged runner or coordinator never holds the
   * steer and admission RPCs or the relay alarm that await this: one not
   * answered in time counts as not acknowledged and is retried. Keeps the
   * alarm armed for notices still owed. Never throws.
   */
  private async deliverStopNotices(): Promise<void> {
    const stores = this.stores;
    if (!stores) return;
    try {
      await deliverDueStopNotices({
        turnJobs: stores.turnJobs,
        receiver: async (notice) => {
          if (notice.executor !== 'runner') {
            return this.stopAborts.run(notice.runnerKey, () => receiveAlarmExecutorStop(
              stores.turnJobs.runnerView(notice.turnJobId),
              (target) => abortSlackThreadAgent(target),
              () => stores.turnJobs.runnerView(notice.turnJobId),
            ));
          }
          // A runner of an older version has no `stop`: the call rejects
          // and the notice stays owed until its successor takes it.
          const runner = threadRunnerStub(this.env as PlatformEnv, notice.runnerKey);
          if (!runner) return false;
          const taken = await boundedStopCall(runner.stop(notice), STOP_NOTICE_DELIVERY_TIMEOUT_MS);
          return taken.acknowledged === true;
        },
      });
      const due = stores.turnJobs.nextStopNoticeDueAt();
      if (due !== undefined) await this.armAlarmNoLaterThan(Math.max(Date.now(), due));
    } catch {
      console.warn('[chickpea] stop notice delivery failed; the alarm retries it');
    }
  }

  async receiveGatewayHttp(input: {body: string; signature: string; url: string}): Promise<{status: number; body: unknown}> {
    const receivedAt = Date.now();
    let observed: {delivery: GatewayInboundDelivery; issuedAt: number} | undefined;
    let outcome: 'accepted' | 'duplicate' | 'failed' = 'failed';
    try {
      const snapshot = this.call(stores => ({
        binding: stores.settings.getSetting(GATEWAY_BINDING_SETTING),
        delivery: stores.settings.getSetting(GATEWAY_HTTP_SETTING),
      }));
      if (!snapshot.ok || !snapshot.value.binding || !snapshot.value.delivery) throw new HttpDeliveryError(503, 'delivery_not_configured');
      const binding = JSON.parse(snapshot.value.binding) as GatewayWorkspaceBinding;
      const state = parseHttpDeliveryState(snapshot.value.delivery)!;
      const value = await verifyHttpDelivery({...input, binding, state, keyring:loadCredentialKeyring(this.env as PlatformEnv)});
      if (value.kind === 'gateway.delivery') observed = {delivery:value.delivery!, issuedAt:value.issuedAt};
      // Crypto yields. Recheck the exact settings and installation in the owning
      // state turn, with no await between authorization and insertion.
      let admissionError: unknown;
      const admitted = this.call(stores => {
        try {
        if (stores.settings.getSetting(GATEWAY_BINDING_SETTING) !== snapshot.value.binding ||
            stores.settings.getSetting(GATEWAY_HTTP_SETTING) !== snapshot.value.delivery) throw new HttpDeliveryError(409, 'delivery_state_changed');
        const installation = stores.config.getWorkspaceInstallation(binding.workspaceId);
        if (stores.identity.getAuthControl()?.healthGate === 'recovery_only' || !installation ||
            installation.transportMode !== 'gateway' || installation.health === 'revoked' ||
            installation.gatewayBindingId !== binding.bindingId || installation.appId !== binding.appId ||
            installation.botUserId !== binding.botUserId) throw new HttpDeliveryError(409, 'delivery_binding_rejected');
        if (value.kind === 'gateway.challenge') return 'verified' as const;
        // A modal click or submission is answered in the receipt from its stored card.
        const receipt = gatewayUiReceiptNow(value.delivery!, stores.uiSurfaces);
        const outcome = receipt ?? stores.gatewayInbox.admit(value.delivery!);
        // Only a real delivery proves gateway activation. A challenge must not
        // retire the old route before the gateway commits its compare-and-swap.
        if (state.pending?.keyId === value.keyId && state.pending.routeRevision === value.routeRevision) {
          stores.settings.setSetting(GATEWAY_HTTP_SETTING, JSON.stringify({version:1,bindingId:binding.bindingId,deploymentId:binding.deploymentId,installedAt:binding.installedAt,
            mode:'http',revision:value.routeRevision,active:state.pending}));
        }
        return outcome;
        } catch (error) { admissionError = error; throw error; }
      });
      if (!admitted.ok) {
        if (admissionError instanceof HttpDeliveryError) throw admissionError;
        if (admissionError instanceof GatewayInboxConflictError) throw new HttpDeliveryError(409,'delivery_identity_conflict');
        throw new HttpDeliveryError(503,'delivery_unavailable');
      }
      if (typeof admitted.value !== 'string') {
        outcome = admitted.value.outcome;
        return {status:200, body:{...httpDeliveryReceipt(value, admitted.value.outcome), interaction:admitted.value.interaction}};
      }
      if (admitted.value !== 'verified') outcome = admitted.value;
      // A duplicate also arms recovery: a previous insert may have survived an
      // alarm-write failure or loss of the HTTP response.
      if (admitted.value !== 'verified') await this.armAlarmNoLaterThan(Date.now() + RELAY_BATCH_WINDOW_MS, true);
      return {status:200, body:httpDeliveryReceipt(value, admitted.value)};
    } catch (error) {
      return {status:error instanceof HttpDeliveryError ? error.status : 503,
        body:{error:error instanceof HttpDeliveryError ? error.code : 'delivery_unavailable'}};
    } finally {
      // Only authenticated deliveries are measured; a forged request logs nothing.
      if (observed) emitGatewayDelivery({transport:'http', receivedAt, ...observed, outcome});
    }
  }

  async admitGatewayDelivery(
    delivery: Parameters<TagStateRpc['admitGatewayDelivery']>[0],
  ): ReturnType<TagStateRpc['admitGatewayDelivery']> {
    const result = this.call((stores): GatewayAdmissionResult => {
      if (parseHttpDeliveryState(stores.settings.getSetting(GATEWAY_HTTP_SETTING))?.mode === 'http') throw new Error('Socket delivery is disabled.');
      return gatewayUiReceiptNow(delivery, stores.uiSurfaces) ?? stores.gatewayInbox.admit(delivery);
    });
    if (result.ok && typeof result.value === 'string') {
      await this.armAlarmNoLaterThan(Date.now() + RELAY_BATCH_WINDOW_MS, true);
    }
    return result;
  }

  async resumeTurnAfterOAuth(
    originalTaskId: string,
    continuationId: string,
  ): Promise<StateRpcResult<boolean>> {
    const result = this.call((stores) => {
      const resumed = stores.turnJobs.resumeAfterOAuth(originalTaskId, continuationId);
      const id = oauthResumeTurnJobId(continuationId);
      const view = resumed ? stores.turnJobs.runnerView(id) : undefined;
      return {
        resumed,
        // A replayed callback for a continuation already handed to its
        // thread runner re-admits it there (idempotent) rather than waiting
        // for a sweep; a new continuation is dispatched like any turn.
        runnerJob: view?.status === 'pending' && view.executor === 'runner' ? view.job : undefined,
      };
    });
    if (!result.ok) return result;
    const readmitted = result.value.runnerJob
      ? await this.admitToRunner(result.value.runnerJob)
      : false;
    if (result.value.resumed && !readmitted) {
      await this.armAlarmNoLaterThan(Date.now() + RELAY_BATCH_WINDOW_MS, true);
    }
    return { ok: true, value: result.value.resumed };
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
    let runnerKey: string | undefined;
    const result = this.call((stores) => {
      if (!isSafeTypedActivityStatus(status)) return null;
      const target = stores.turnJobs.matchFlueObservation(instanceId, submissionId);
      if (target?.executor === 'runner') {
        // A thread runner registered this turn's status; an agent without
        // the dispatch's route in context still reaches it through here.
        runnerKey = target.runnerKey;
      } else if (target) {
        defaultSlackStatusRegistry.setObservedStatus(
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
    if (runnerKey) {
      await threadRunnerStub(this.env as PlatformEnv, runnerKey)
        ?.observedStatus(instanceId, submissionId, status)
        .catch(() => undefined);
    }
    return result;
  }

  /** Per-turn writes from the SlackThreadRunner executing that turn. */
  async threadRunnerTurn<K extends ThreadRunnerTurnKind>(
    op: ThreadRunnerTurnOp<K>,
  ): Promise<StateRpcResult<ThreadRunnerTurnResult<K>>> {
    // A runner learns from these that a code update replaced its version
    // (see src/slack/thread-runner-loop.ts); reading it touches no storage.
    const servingVersion = cloudflareWorkerVersionId(this.env);
    if (op.kind === 'servingVersion') {
      return { ok: true, value: (servingVersion ?? null) as ThreadRunnerTurnResult<K> };
    }
    const result = this.call((stores) =>
      applyThreadRunnerTurnOp(stores, op as ThreadRunnerTurnOp) as ThreadRunnerTurnResult<K>);
    if (op.kind === 'begin' && result.ok && servingVersion !== undefined) {
      return { ok: true, value: { ...(result.value as RunnerTurnBegin), servingVersion } as ThreadRunnerTurnResult<K> };
    }
    return result;
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
   *
   * Every invocation emits one content-free `relay_alarm` log (duration, jobs
   * listed/run, groups, re-arm); emission cannot throw or change the result.
   */
  async alarm(): Promise<void> {
    const metrics = startRelayAlarmMetrics();
    try {
      await this.drainRelayAlarm(metrics);
    } catch (error) {
      metrics.outcome = 'threw';
      throw error;
    } finally {
      emitRelayAlarm(metrics);
    }
  }

  private async drainRelayAlarm(metrics: RelayAlarmMetrics): Promise<void> {
    const alarmStartedAt = metrics.startedAt;
    this.stores ??= this.tryInit();
    if (!this.stores) {
      throw new Error(`state store unavailable in alarm: ${this.initError ?? 'unknown'}`);
    }
    const stores = this.stores;
    const productTelemetry = createPlatformProductTelemetry({
      env: this.env as PlatformEnv,
      settings: localSettingsStore(stores),
      config: localGatewayAppStores(stores).config,
    });
    stores.management.cleanupRetention(Date.now(), 250);
    // New turns go to their thread's SlackThreadRunner (the default executor)
    // and this alarm only finishes turns it already dispatched to Flue: rows
    // admitted before the runner became the default. The emergency gate
    // SLACK_TAG_TURN_EXECUTOR=alarm (or a Worker without the runner binding)
    // keeps every new turn on this alarm instead. Rows handed to runners stay
    // theirs either way. The alarm execution path below is kept for those
    // legacy and fallback rows; delete it once a release has drained them.
    const runnerBinding = Boolean((this.env as PlatformEnv).SLACK_THREAD_RUNNER);
    const runnerMode = runnerBinding &&
      slackTurnExecutor(this.env as PlatformEnv) === 'runner';
    const handingOff = new Set<Promise<void>>();
    /**
     * Hand the free turns listed now to their runners. Each admission starts
     * its own hand-off at once, side by side with any in flight: a row is
     * assigned before its admission RPC is awaited, so two hand-offs never
     * take the same row. A failed hand-off stays a hand-off; the alarm
     * re-arms for it.
     */
    const handOff = (readmitHandoffs: boolean): Promise<void> => {
      // Unconfirmed hand-offs are admitted again even after the switch is
      // turned off: those rows already belong to their runners. Only when no
      // hand-off is in flight, so a row mid-admission is not admitted twice.
      if (!runnerMode && !(runnerBinding && stores.turnJobs.hasHandoffs())) return Promise.resolve();
      const readmit = readmitHandoffs && handingOff.size === 0;
      const run: Promise<void> = this.dispatchToRunners(stores, runnerMode, readmit)
        .then((dispatched) => { metrics.jobsDispatched += dispatched; }, () => undefined)
        .finally(() => { handingOff.delete(run); });
      handingOff.add(run);
      return run;
    };
    /** Hand over every free turn and wait for all hand-offs in flight. */
    const dispatchToRunners = async (): Promise<void> => {
      await handOff(true);
      while (handingOff.size > 0) await Promise.all([...handingOff]);
    };
    const onAdmitted = runnerMode ? () => void handOff(false) : undefined;
    /** Admit newly delivered events and hand their turns over at once. */
    const admitAndDispatch = async () => {
      let retry = false;
      // Runner mode: an admission that lands while this pass runs (before any
      // wake is listening) is picked up by another pass, not the next alarm.
      for (let pass = 0; pass < 8; pass += 1) {
        const admissions = this.admissionsSeen;
        retry = (await drainGatewayInbox(stores, this.env as PlatformEnv, onAdmitted)) || retry;
        await dispatchToRunners();
        if (!runnerMode || this.admissionsSeen === admissions) break;
      }
      return retry;
    };
    /**
     * Runner mode: the alarm's other due work (ledger runs, cleanups,
     * repairs, schedule actions, receipts) can take seconds. Keep admitting
     * and handing over turns that arrive meanwhile, on every admission wake
     * and at the admission re-check interval, instead of after it.
     */
    const whileDispatching = <T>(work: () => Promise<T>): Promise<T> =>
      runnerMode ? this.dispatchingWhile(work, admitAndDispatch) : work();
    const gatewayNeedsRetry = await admitAndDispatch();
    // Stops owed to runners, after the hand-offs above gave new rows theirs.
    await this.deliverStopNotices();
    const threadKeyOf = (job: {
      turn: Parameters<typeof slackAgentThreadKey>[0];
      assignment: Parameters<typeof slackAgentThreadKey>[1];
    }) => slackAgentThreadKey(job.turn, job.assignment);
    const listPendingTurns = () => stores.turnJobs.listPendingByThread({
      maxThreads: MAX_TURN_DRAIN_BATCH,
      perThread: ALARM_PENDING_PER_THREAD,
      threadKey: threadKeyOf,
      executor: 'alarm',
      dispatchedOnly: runnerMode,
    });
    const carriedJobIds = () => new Set(this.carriedAlarmTurns.keys());
    const pending = listPendingTurns();
    metrics.jobsListed = pending.length;
    if (pending.length === 0) {
      const cleanupPending = stores.turnJobs.hasPendingSlackInteractionCleanup();
      const resolveInstallation = this.createAlarmIdentityResolver(stores);
      const { ledgerDrain, presentationRepairs, scheduleActions } = await whileDispatching(async () => {
        const ledgerDrain = await drainLedgerRuns(
          stores,
          this.env as PlatformEnv,
          resolveInstallation,
          productTelemetry,
        );
        if (cleanupPending) {
          await drainSlackInteractionCleanups(stores, resolveInstallation, carriedJobIds());
        }
        const presentationRepairs = await drainTerminalPresentationRepairs(
          stores,
          this.env as PlatformEnv,
          resolveInstallation,
          carriedJobIds(),
        );
        const scheduleActions = await drainCloudflareScheduleActions(stores, this.env as PlatformEnv);
        await drainCloudflareManagementReceipts(stores, this.env as PlatformEnv, resolveInstallation, this.presentationRunnerOf);
        return { ledgerDrain, presentationRepairs, scheduleActions };
      });
      const turnRetry = gatewayNeedsRetry || stores.gatewayInbox.hasPending() ||
        stores.turnJobs.hasPending('ledger') || stores.turnJobs.hasPendingSlackInteractionCleanup() ||
        stores.turnJobs.hasHandoffs() ||
        (runnerMode && stores.turnJobs.hasPending('legacy'))
        ? Date.now() + runDriverRetryDelayMs(ledgerDrain, RELAY_RETRY_BACKOFF_MS)
        : undefined;
      const outboxRetry = stores.management.nextOutboxDueAt();
      const nextWake = earliestDefined(
        turnRetry,
        presentationRepairs.nextRetryAt,
        scheduleActions.nextDueAt,
        outboxRetry,
        stores.gatewayInbox.nextPendingDueAt(),
      );
      metrics.needsRetry = turnRetry !== undefined;
      metrics.rearmed = nextWake !== undefined;
      if (nextWake !== undefined) await this.armAlarmNoLaterThan(nextWake);
      return;
    }
    metrics.outcome = 'drained';
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
    // The alarm's own stores are this turn's ports; a thread runner passes
    // its own presentation state (see src/slack/turn-executor.ts).
    const turnPorts: TurnExecutionPorts = {
      env: this.env as PlatformEnv,
      turnJobs: alarmTurnJobsPort(stores),
      slack: stores.slack,
      config: stores.config,
      presentationState: localSlackPresentationState(stores, this.env as PlatformEnv),
      settingsStore: localSettingsStore(stores),
      usageStore,
      workStore: stores.work as unknown as WorkStore,
      appStores,
      managementApproval: resolveManagementApproval,
      telemetry: productTelemetry,
      resolveInstallation,
      sandboxes: sandboxTurnReaders(this.env as PlatformEnv),
      dispatchAgentAsks: localAgentAskDispatcher(stores, this.env as PlatformEnv, productTelemetry),
      runTurn,
    };
    const runJob = (
      job: (typeof pending)[number],
      control?: AlarmTurnJobControl,
    ): Promise<boolean> => executeTurnJob(job, turnPorts, {
      latency: { lane: 'cloudflare', executor: 'alarm' },
      ...(control ? { control } : {}),
      // The alarm executor has no coding cascade; its stop note reads only
      // whether a stop was recorded (R22 versus the stopped ending).
      stopRecorded: () => stores.turnJobs.runnerView(job.id).job?.stop?.role === 'stopped',
      onRetry: (afterMs) => {
        needsRetry = true;
        if (afterMs !== undefined) {
          identityRetryDelayMs = Math.max(identityRetryDelayMs, afterMs);
        }
      },
    });

    // Ordering inside a thread is preserved (a thread's second turn never
    // overtakes its first) while unrelated conversations run side by side.
    // The drain keeps admitting while turns observe, so one long turn never
    // holds new messages until the platform ends this alarm, and it yields
    // every observation before the alarm's wall-time limit (see
    // src/slack/alarm-turn-drain.ts). Only the thread cap bounds it.
    const drainedThreads = new Set<string>();
    const turnsStartedAt = Date.now();
    const turnDrain = await drainAlarmTurnJobs<(typeof pending)[number]>({
      initial: pending,
      jobId: (job) => job.id,
      threadKey: threadKeyOf,
      runJob: async (job, control) => {
        // Never while a stop's abort for an earlier turn of the thread is out.
        await this.stopAborts.clear(threadKeyOf(job));
        const jobStartedAt = Date.now();
        metrics.jobsRun += 1;
        drainedThreads.add(threadKeyOf(job));
        const settled = await runJob(job, control);
        // One attempt: a yielded turn's next attempt is a later alarm's job.
        metrics.longestJobMs = Math.max(metrics.longestJobMs, Date.now() - jobStartedAt);
        if (settled) metrics.jobsSettled += 1;
        else metrics.jobsRetained += 1;
        return settled;
      },
      refresh: async () => {
        needsRetry = (await admitAndDispatch()) || needsRetry;
        return listPendingTurns();
      },
      carried: {
        threadKeys: () => new Set(this.carriedAlarmTurns.values()),
        jobIds: carriedJobIds,
      },
      // Due receipts, schedule actions, repairs, and cleanups keep moving
      // while a long turn observes. Records owned by a running job are its
      // own to finish; the tail picks them up once it returns.
      tick: async (runningJobIds) => {
        await drainSlackInteractionCleanups(stores, resolveInstallation, runningJobIds);
        await drainTerminalPresentationRepairs(stores, this.env as PlatformEnv, resolveInstallation, runningJobIds);
        await drainCloudflareScheduleActions(stores, this.env as PlatformEnv);
        await drainCloudflareManagementReceipts(stores, this.env as PlatformEnv, resolveInstallation, this.presentationRunnerOf);
      },
      startConcurrency: MAX_TURN_DRAIN_BATCH,
      maxActiveThreads: MAX_TURN_DRAIN_BATCH,
      startedAt: alarmStartedAt,
      budgetMs: ALARM_TURN_BUDGET_MS,
      hardCapMs: ALARM_TURN_HARD_CAP_MS,
      recheckMs: ALARM_ADMISSION_RECHECK_MS,
      onWake: (wake) => {
        this.alarmAdmissionWake = wake;
        return () => {
          if (this.alarmAdmissionWake === wake) this.alarmAdmissionWake = undefined;
        };
      },
    });
    metrics.groups = drainedThreads.size;
    metrics.turnsMs = Date.now() - turnsStartedAt;
    metrics.yielded = turnDrain.budgetExhausted;
    metrics.jobsCarried = turnDrain.carried.length;
    for (const carried of turnDrain.carried) {
      console.warn('[chickpea] Turn job still running at the alarm cap; its thread waits for it');
      this.carriedAlarmTurns.set(carried.id, carried.threadKey);
      void carried.settled.finally(() => {
        this.carriedAlarmTurns.delete(carried.id);
        // Its thread may continue now; a running drain picks that up at once.
        this.alarmAdmissionWake?.();
      });
    }
    const { presentationRepairs, scheduleActions } = await whileDispatching(async () => {
      const ledgerDrain = await drainLedgerRuns(
        stores,
        this.env as PlatformEnv,
        resolveInstallation,
        productTelemetry,
      );
      identityRetryDelayMs = runDriverRetryDelayMs(ledgerDrain, identityRetryDelayMs);
      await drainSlackInteractionCleanups(stores, resolveInstallation, carriedJobIds());
      const presentationRepairs = await drainTerminalPresentationRepairs(
        stores,
        this.env as PlatformEnv,
        resolveInstallation,
        carriedJobIds(),
      );
      const scheduleActions = await drainCloudflareScheduleActions(stores, this.env as PlatformEnv);
      await drainCloudflareManagementReceipts(stores, this.env as PlatformEnv, resolveInstallation, this.presentationRunnerOf);
      return { presentationRepairs, scheduleActions };
    });
    needsRetry ||= stores.turnJobs.hasPending('legacy') ||
      stores.turnJobs.hasPending('ledger') ||
      stores.turnJobs.hasPendingSlackInteractionCleanup() ||
      stores.gatewayInbox.hasPending() ||
      stores.turnJobs.hasHandoffs();
    // Yielded turns are still running elsewhere; reattach to them promptly.
    const turnRetry = turnDrain.budgetExhausted
      ? Date.now() + ALARM_YIELD_REARM_MS
      : needsRetry ? Date.now() + identityRetryDelayMs : undefined;
    const outboxRetry = stores.management.nextOutboxDueAt();
    const nextWake = earliestDefined(
      turnRetry,
      presentationRepairs.nextRetryAt,
      scheduleActions.nextDueAt,
      outboxRetry,
      stores.gatewayInbox.nextPendingDueAt(),
    );
    metrics.needsRetry = needsRetry;
    metrics.rearmed = nextWake !== undefined;
    if (nextWake !== undefined) {
      // Re-arm (do NOT throw) so this invocation returns normally and its
      // attempt-count writes commit; the next firing re-drives the leftover
      // pending jobs. Preserve an earlier wake armed by an RPC while this
      // drain was awaiting external I/O.
      await this.armAlarmNoLaterThan(nextWake);
    }
  }

  /**
   * Admit one runner-owned turn to its thread's SlackThreadRunner, with the
   * presentation as this store holds it, and confirm the hand-off. Idempotent:
   * a runner keeps a job it already holds. False leaves the row a hand-off for
   * the next alarm to admit again.
   */
  private async admitToRunner(job: PendingTurnJob): Promise<boolean> {
    const stores = this.stores;
    const threadKey = slackAgentThreadKey(job.turn, job.assignment);
    const runner = threadRunnerStub(this.env as PlatformEnv, threadKey);
    if (!stores || !runner) return false;
    const presentation = job.runId ? stores.presentations.get(job.runId) : undefined;
    const payload: ThreadRunnerJobPayload = presentation ? { presentation } : {};
    const installation = installationOwnershipOf(this.env as PlatformEnv);
    try {
      const result = await runner.admit({
        id: job.id,
        threadKey,
        payload,
        ...(installation ? { installation } : {}),
      });
      if (result.refused) throw new Error(result.refused);
    } catch {
      console.warn('[chickpea] Thread runner admission failed; the hand-off is retried');
      return false;
    }
    stores.turnJobs.confirmRunner(job.id);
    return true;
  }

  /**
   * The default executor: hand every pending turn whose thread is
   * free to its runner, a page at a time, and return without waiting for any
   * turn. Unconfirmed hand-offs are admitted again first, so a hand-off lost
   * to a restart of this object is never overtaken in its thread. A failed
   * admission leaves its row a hand-off, which holds only its own thread
   * (listDispatchable) and re-arms this alarm (hasHandoffs). Returns the
   * turns admitted.
   */
  private async dispatchToRunners(
    stores: TagStateStores,
    newTurns: boolean,
    readmitHandoffs = true,
  ): Promise<number> {
    let dispatched = 0;
    const admitAll = async (jobs: PendingTurnJob[]) => {
      const admitted = await Promise.all(jobs.map((job) => this.admitToRunner(job)));
      dispatched += admitted.filter(Boolean).length;
    };
    if (readmitHandoffs) await admitAll(stores.turnJobs.listHandoffs(MAX_TURN_DRAIN_BATCH));
    for (let page = 0; newTurns && page < RUNNER_DISPATCH_MAX_PAGES; page += 1) {
      const jobs = stores.turnJobs.listDispatchable({
        limit: MAX_TURN_DRAIN_BATCH,
        threadKey: (job) => slackAgentThreadKey(job.turn, job.assignment),
      }).filter((job) => stores.turnJobs.assignRunner(job.id));
      if (jobs.length === 0) break;
      await admitAll(jobs);
    }
    return dispatched;
  }

  /**
   * Run the alarm's other work while admitting and handing over turns that
   * arrive meanwhile: on every admission wake, at the admission re-check
   * interval, and once more after the work if anything was admitted during
   * the last pass.
   */
  private async dispatchingWhile<T>(
    work: () => Promise<T>,
    admitAndDispatch: () => Promise<unknown>,
  ): Promise<T> {
    let done = false;
    let wake: (() => void) | undefined;
    let admittedMeanwhile = false;
    this.dispatchWake = () => {
      admittedMeanwhile = true;
      wake?.();
    };
    const result = work().finally(() => {
      done = true;
      wake?.();
    });
    const loop = (async () => {
      while (!done) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ALARM_ADMISSION_RECHECK_MS);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
        if (done) break;
        admittedMeanwhile = false;
        await admitAndDispatch();
      }
      if (admittedMeanwhile) await admitAndDispatch();
    })();
    try {
      return await result;
    } finally {
      await loop.catch(() => undefined);
      this.dispatchWake = undefined;
    }
  }

  private async armAlarmNoLaterThan(at: number, admission = false): Promise<void> {
    // Every admission arms the alarm after its durable write. A running alarm
    // cannot be re-entered, so let its drain pick the new work up directly.
    this.alarmAdmissionWake?.();
    if (admission) this.admissionsSeen += 1;
    this.dispatchWake?.();
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
      if (err instanceof ModelRoleRevisionConflictError) {
        return rpcError('model_role_revision_conflict', err.message, {
          scope: err.scope,
          targetId: err.targetId,
          role: err.role,
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

/** One per-turn operation of a SlackThreadRunner (see thread-runner-rpc.ts). */
function applyThreadRunnerTurnOp(
  stores: TagStateStores,
  op: ThreadRunnerTurnOp,
): ThreadRunnerTurnResult<ThreadRunnerTurnKind> {
  const turnJobs = stores.turnJobs;
  switch (op.kind) {
    case 'view':
      return turnJobs.runnerView(op.id);
    case 'begin': {
      const view = turnJobs.runnerView(op.id);
      const installation = view.job
        ? stores.config.getWorkspaceInstallation(view.job.turn.workspaceId)
        : undefined;
      const values = stores.settings.getSettings(RUNNER_PREFETCHED_SETTINGS);
      const presentation = view.job?.runId ? stores.presentations.get(view.job.runId) : undefined;
      return {
        view,
        ...(installation ? { installation } : {}),
        ...(presentation?.schemaVersion === 3
          ? {
              latestThreadSessionGeneration:
                stores.presentations.getLatestThreadSessionGeneration(presentation.root) ?? null,
            }
          : {}),
        settings: Object.fromEntries(
          RUNNER_PREFETCHED_SETTINGS.map((key, index) => [key, values[index] ?? null]),
        ),
      };
    }
    case 'recordAttempt':
      turnJobs.recordAttempt(op.id, op.attempts);
      return null;
    case 'recordPullRequest':
      return turnJobs.recordPullRequest(op.id, op.pullRequest) ?? null;
    case 'freezeRuntimePlan':
      return turnJobs.freezeRuntimePlan(op.id, op.candidate);
    case 'getBoundRuntimePlan':
      return turnJobs.getBoundRuntimePlan(
        op.continuityKey,
        op.beforeMessageTs,
        op.actorMembershipId,
        op.agentId,
      ) ?? null;
    case 'getThreadContinuation':
      return turnJobs.getThreadContinuation(op.continuityKey, op.instanceId, op.beforeMessageTs) ?? null;
    case 'recordUsagePersistence':
      return turnJobs.recordUsagePersistence(op.id, op.event) ?? null;
    case 'recordInteractionIntent':
      return turnJobs.recordInteractionIntent(op.id, op.intent) ?? null;
    case 'markDelivered':
      turnJobs.markDelivered(op.id);
      return null;
    case 'markError':
      turnJobs.markError(op.id);
      return null;
    case 'markCodingActiveWork':
      stores.slack.markCodingActiveWork(op.key, op.generation);
      return null;
    case 'isCodingActiveWork':
      return stores.slack.isCodingActiveWork(op.key, op.generation);
    case 'putPresentation':
      return stores.presentations.putSnapshot(op.presentation);
    case 'servingVersion':
      // Answered by TagStateStore.threadRunnerTurn without storage.
      return null;
    default:
      throw new Error('Unknown thread runner operation.');
  }
}

async function drainSlackInteractionCleanups(
  stores: TagStateStores,
  resolveInstallation: SlackInstallationExecutionResolver,
  excludeTurnJobIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const job of stores.turnJobs.listPendingSlackInteractionCleanups(MAX_TURN_DRAIN_BATCH)) {
    if (excludeTurnJobIds.has(job.id)) continue;
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
  env: PlatformEnv,
  resolveInstallation: SlackInstallationExecutionResolver,
  excludeTurnJobIds: ReadonlySet<string> = new Set(),
): Promise<SlackPresentationRepairDrainResult> {
  // A thread runner repairs the presentations of turns it executes.
  const presentations = stores.presentations
    .listAutoRepairableV3(MAX_TURN_DRAIN_BATCH, { skipRunnerOwned: true })
    .filter((presentation) => !excludeTurnJobIds.has(presentation.turnJobId));
  return drainSlackPresentationRepairs({
    presentations,
    state: localSlackPresentationState(stores, env),
    resolveClient: async (workspaceId) => (await resolveInstallation(workspaceId)).client,
    onFailure: (_presentation, error) => {
      console.warn('[chickpea] Slack presentation repair failed:', sanitizeError(error));
    },
  });
}

async function drainCloudflareManagementReceipts(
  stores: TagStateStores,
  env: PlatformEnv,
  resolveInstallation: SlackInstallationExecutionResolver,
  presentationRunner: (runId: string) => SlackThreadRunnerRpc | undefined = () => undefined,
): Promise<void> {
  // ManagementStoreLogic is the in-DO synchronous implementation of every
  // ManagementStore operation; the shared drain awaits its return values, so
  // one implementation owns claim, backoff, terminal settling, and logging.
  const local = localSlackPresentationState(stores, env);
  // A runner-executed turn's presentation lives in its thread runner.
  const runnerCopy = (runId: string) => {
    const runner = presentationRunner(runId);
    return runner
      ? new CfSlackStateStore({
          slackPresentationGet: (id: string) => runner.presentationGet(id),
          slackPresentationTransition: (input: SlackPresentationTransitionInput) =>
            runner.presentationTransition(input),
        } as unknown as TagStateRpc)
      : undefined;
  };
  const presentation = {
    state: {
      ...local,
      getRunPresentation: (runId: string) =>
        (runnerCopy(runId) ?? local).getRunPresentation!(runId),
      transitionRunPresentation: (input: SlackPresentationTransitionInput) =>
        (runnerCopy(input.runId) ?? local).transitionRunPresentation!(input),
    } satisfies SlackPresentationStatePort,
    resolveClient: async (workspaceId: string) =>
      (await resolveInstallation(workspaceId)).client,
  };
  const work = stores.work as unknown as WorkStore;
  await drainManagementReceiptOutbox({
    management: stores.management as unknown as ManagementStore,
    onDeliveredSettled: (record) => completeSettledAgentWelcomeHandoff(
      record,
      stores.config,
      stores.management as unknown as ManagementStore,
    ),
    onTerminalFailure: (record) => failAgentWelcomeTurn(
      record,
      presentation,
      (turnJobId) => stores.turnJobs.markError(turnJobId),
      work,
    ),
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
            work,
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
  productTelemetry: ProductTelemetryCapture,
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
      presentationState: localSlackPresentationState(stores, platformEnv),
      setActiveWork: (key, generation, active) =>
        stores.slack.setActiveWork(key, generation, active),
      markCodingActiveWork: (key, generation) =>
        stores.slack.markCodingActiveWork(key, generation),
      onPublicMessageDelivered: (turn, assignment, delivery) =>
        recordDeliveredSlackAgentMessage(stores.config, turn, assignment, delivery),
      productTelemetry,
    }),
  }).drain();
}

async function drainGatewayInbox(
  stores: TagStateStores,
  platformEnv: PlatformEnv,
  /**
   * Called after each admitted delivery (runner mode: hand its turn over at
   * once). With it, different conversations are admitted side by side.
   */
  onAdmitted?: () => void,
): Promise<boolean> {
  const pending = stores.gatewayInbox.claimPending(GATEWAY_INBOX_MAX_DRAIN_BATCH);
  if (pending.length === 0) return stores.gatewayInbox.hasPending();
  const appStores = localGatewayAppStores(stores);
  let client: GatewayDeploymentClient;
  try {
    client = localGatewayDeploymentClient(appStores, platformEnv, createPlatformProductTelemetry({
      env: platformEnv,
      settings: appStores.settings,
      config: appStores.config,
    }));
  } catch {
    for (const item of pending) {
      stores.gatewayInbox.retryOrRecover(item.id, 'delivery_dependency_unavailable');
    }
    return stores.gatewayInbox.hasPending();
  }
  let needsRetry = false;
  const uiExecution = { stores: appStores, enqueueTurn: localTurnEnqueue(stores) };
  const admit = async (item: (typeof pending)[number]) => {
    // A turn admitted from this delivery measures its latency from receipt:
    // the delivery may have waited here while an earlier alarm ran turns.
    const releaseReceipt = item.delivery.kind === 'event.deliver'
      ? stores.turnJobs.noteReceipt(item.delivery.envelope.eventId, item.acceptedAt)
      : undefined;
    try {
      const outcome = item.delivery.kind === 'event.deliver'
        ? await processGatewaySlackEnvelope(
            item.delivery.envelope,
            platformEnv,
            client,
            uiExecution,
          )
        : item.delivery.kind === 'interaction.agent_selected'
        ? await processGatewayAgentSelection(
            item.delivery,
            platformEnv,
            client,
            appStores,
          )
        : item.delivery.kind === 'interaction.ui_action'
        ? await processGatewayUiAction(item.delivery, platformEnv, client, uiExecution)
        : item.delivery.kind === 'interaction.view_submission'
        ? await processGatewayViewSubmission(item.delivery, platformEnv, client, uiExecution)
        : await processGatewayPrivateChannelSetup(
            item.delivery,
            platformEnv,
            client,
            appStores,
          );
      if (outcome === 'accepted') {
        stores.gatewayInbox.complete(item.id);
        onAdmitted?.();
      } else {
        stores.gatewayInbox.markRecoveryRequired(item.id, 'binding_revalidation_rejected');
      }
    } catch (error) {
      const retryDelayMs = gatewayDeliveryRetryDelayMs(item.attempts, error);
      const retry = stores.gatewayInbox.retryOrRecover(
        item.id,
        gatewayDeliveryFailureReason(error),
        retryDelayMs,
      );
      if (retry === 'recovery_required') {
        recordGatewayDeliveryDeadLetter(item.delivery, item.attempts, error);
      }
      // A row in backoff is not due yet: the alarm arms for its due time
      // (nextPendingDueAt) instead of re-polling every few seconds.
      needsRetry ||= retry === 'pending' && retryDelayMs === 0;
    } finally {
      releaseReceipt?.();
    }
  };
  // Deliveries of one conversation keep their order; different conversations
  // are admitted side by side, so one slow delivery never holds another
  // thread's first status.
  const groups = new Map<string, Array<(typeof pending)[number]>>();
  for (const item of pending) {
    const key = gatewayConversationKey(item.delivery);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const queue = [...groups.values()];
  await Promise.all(Array.from(
    { length: Math.min(onAdmitted ? GATEWAY_INBOX_CONVERSATION_CONCURRENCY : 1, queue.length) },
    async () => {
      for (let group = queue.shift(); group; group = queue.shift()) {
        for (const item of group) await admit(item);
      }
    },
  ));
  return needsRetry || stores.gatewayInbox.hasPending();
}

/** Conversations admitted side by side by one inbox drain. */
const GATEWAY_INBOX_CONVERSATION_CONCURRENCY = 4;

/**
 * The Slack conversation a delivery belongs to: its channel and thread root.
 * Anything without one (installation, profile and interaction events) shares
 * one ordered group.
 */
function gatewayConversationKey(delivery: GatewayInboundDelivery): string {
  if (delivery.kind !== 'event.deliver') return 'other';
  const event = delivery.envelope.event as { channel?: unknown; thread_ts?: unknown; ts?: unknown };
  const root = typeof event.thread_ts === 'string' ? event.thread_ts : event.ts;
  return typeof event.channel === 'string' && typeof root === 'string'
    ? `${event.channel}:${root}`
    : 'other';
}

/**
 * Asks made by a turn this state store runs itself (the legacy alarm
 * executor) are admitted here, against the local stores and queue, the way
 * the gateway inbox admits a Slack event.
 */
function localAgentAskDispatcher(
  stores: TagStateStores,
  platformEnv: PlatformEnv,
  productTelemetry: ProductTelemetryCapture,
): SlackAgentAskDispatcher {
  return async (request) => {
    const appStores = localGatewayAppStores(stores);
    let gatewayClient: GatewayDeploymentClient | undefined;
    try {
      gatewayClient = localGatewayDeploymentClient(appStores, platformEnv, productTelemetry);
    } catch {
      // A direct installation needs no gateway client.
    }
    await processSlackAgentAsks(request, platformEnv, {
      stores: appStores,
      ...(gatewayClient ? { gatewayClient } : {}),
      enqueueTurn: localTurnEnqueue(stores),
    });
  };
}

/** The gateway client of a turn admitted inside this state store, on its own stores. */
function localGatewayDeploymentClient(
  appStores: AppStores,
  platformEnv: PlatformEnv,
  productTelemetry: ProductTelemetryCapture,
): GatewayDeploymentClient {
  return new GatewayDeploymentClient({
    settings: appStores.settings,
    config: appStores.config,
    identity: appStores.identity,
    keyring: loadCredentialKeyring(platformEnv),
    gatewayBaseUrl: resolveChickpeaGatewayUrl(platformEnv),
    productTelemetry,
  });
}

/** Enqueues a turn admitted inside this state store into its own queue. */
function localTurnEnqueue(stores: TagStateStores) {
  return async (job: TurnJob) => {
    stores.turnJobs.enqueue(job);
    return { ok: true as const, value: null };
  };
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

/**
 * This state store's settings for the work it runs itself: management, the
 * alarm's turns and ledger runs. An installation of a deployment serving many
 * reads and writes its saved model keys only through a store's model
 * credential methods, so this port carries them.
 */
function localSettingsStore(stores: TagStateStores): SettingsStore & ModelCredentialStore {
  return {
    getSetting: async (key) => stores.settings.getSetting(key),
    getSettings: async (keys) => stores.settings.getSettings(keys),
    setSetting: async (key, value) => stores.settings.setSetting(key, value),
    deleteSetting: async (key) => stores.settings.deleteSetting(key),
    applySettingsPatch: async (patch) => stores.settings.applySettingsPatch(patch),
    mergeSettingStringSet: async (key, values) =>
      stores.settings.mergeSettingStringSet(key, values),
    readModelCredential: async (providerId) => stores.settings.readModelCredential(providerId),
    publishModelCredential: async (input) => stores.settings.publishModelCredential(input),
    rewrapModelCredential: async (input) => stores.settings.rewrapModelCredential(input),
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

/**
 * The alarm executor's turn-row port: the state store's own rows, except
 * that the stopped ending also settles the dropped turns' Runs and
 * presentations, as slackTurnStopFinish does. Spelled out like
 * runnerTurnJobsPort, so the one method that differs is visible.
 */
function alarmTurnJobsPort(stores: TagStateStores): TurnExecutionPorts['turnJobs'] {
  const rows = stores.turnJobs;
  return {
    recordAttempt: (...args) => rows.recordAttempt(...args),
    markRecoveryRequired: (...args) => rows.markRecoveryRequired(...args),
    prepareFlueDispatch: (...args) => rows.prepareFlueDispatch(...args),
    reconcileFlueExistingInstance: (...args) => rows.reconcileFlueExistingInstance(...args),
    recordFlueReceipt: (...args) => rows.recordFlueReceipt(...args),
    recordFlueSettlement: (...args) => rows.recordFlueSettlement(...args),
    recordPullRequest: (...args) => rows.recordPullRequest(...args),
    freezeRuntimePlan: (...args) => rows.freezeRuntimePlan(...args),
    getBoundRuntimePlan: (...args) => rows.getBoundRuntimePlan(...args),
    getThreadContinuation: (...args) => rows.getThreadContinuation(...args),
    recordUsagePersistence: (...args) => rows.recordUsagePersistence(...args),
    recordInteractionIntent: (...args) => rows.recordInteractionIntent(...args),
    recordSlackInteractionProgress: (...args) => rows.recordSlackInteractionProgress(...args),
    markDelivered: (...args) => rows.markDelivered(...args),
    markError: (...args) => rows.markError(...args),
    finishStop: (headId, outcome) =>
      stores.slack.finishTurnStop(headId, outcome, rows, stores.work, stores.presentations),
  };
}

function localSlackPresentationState(stores: TagStateStores, env: PlatformEnv): SlackPresentationStatePort {
  return localSlackPresentationStatePort({
    presentations: stores.presentations,
    sharedReadsEnv: env,
    matchFlueObservation: (instanceId, submissionId) =>
      stores.turnJobs.matchFlueObservation(instanceId, submissionId),
  });
}

function localUsageStore(stores: TagStateStores): UsageStore {
  return {
    admitOperation: async (input) => stores.usage.admitOperation(input),
    recordTerminal: async (input) => stores.usage.recordTerminal(input),
    recordConnectorUsage: async (input) => stores.usage.recordConnectorUsage(input),
    recordModelRequest: async (record) => stores.usage.recordModelRequest(record),
    getModelRequest: async (requestId) => stores.usage.getModelRequest(requestId),
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
  duties: [keepOAuthCredentialsAlive],
});

/** Its own duty, so renewals never delay maintenance or the gateway wake. */
async function keepOAuthCredentialsAlive(
  scheduledTime: number,
  rawEnv: Record<string, unknown>,
): Promise<void> {
  if (!isOAuthKeepAliveMinute(scheduledTime)) return;
  const platformEnv = rawEnv as PlatformEnv;
  await runOAuthKeepAliveSweep({
    config: getConfigStore(platformEnv),
    settings: getSettingsStore(platformEnv),
  });
}

async function runWorkMaintenance(
  scheduledTime: number,
  rawEnv: Record<string, unknown>,
): Promise<void> {
  await runWithGuaranteedFinalizer(async () => {
    const result = await tagStateStub(rawEnv).maintainWork(scheduledTime);
    if (!result.ok) {
      throw new Error(`Work maintenance failed: ${result.error.message}`);
    }
    const platformEnv = rawEnv as PlatformEnv;
    try { await purgeExpiredImageOutputs(getSettingsStore(platformEnv), scheduledTime); }
    catch { console.warn('[chickpea] Image cache maintenance did not complete'); }
    if (isContainerLeaseSweepMinute(scheduledTime)) {
      try { await maintainWorkspaceContainerLeases(platformEnv, scheduledTime); }
      catch { console.warn('[chickpea] Coding workspace container lease cleanup did not complete'); }
    }
    if (isCheckpointSweepMinute(scheduledTime)) {
      try { await sweepInstallationCheckpoints(platformEnv, scheduledTime); }
      catch { console.warn('[chickpea] Coding workspace checkpoint cleanup did not complete'); }
    }
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
  }, async () => {
    // The gateway session is the ingress lifeline for the shared Slack lane.
    // Work or OAuth repair failures must never suppress its periodic wake.
    await wakeCloudflareGatewaySession(rawEnv);
  });
}

export { SlackGatewaySession };
// Per-thread turn executor (migration v11), the default for Cloudflare turns.
export { SlackThreadRunner } from './slack/thread-runner.ts';

async function runRoutineHeartbeat(
  scheduledTime: number,
  owner: string,
  rawEnv: Record<string, unknown>,
  context: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> {
  const productTelemetry = createPlatformProductTelemetry({
    env: rawEnv,
    settings: getSettingsStore(rawEnv),
    config: getConfigStore(rawEnv),
    lifecycle: createWaitUntilTelemetryLifecycle(context),
  });
  await runSharedRoutineHeartbeat({
    scheduledTime,
    owner,
    env: rawEnv,
    productTelemetry,
  });
}
