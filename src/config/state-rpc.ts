import type {
  EncryptedCredentialRevision,
  ReplaceEncryptedCredentialRevisionInput,
  SettingsPatch,
} from './settings-store.ts';
import type {
  ConfigAgentPatch,
  OAuthReauthorizationTarget,
} from './store.ts';
import type {
  ActivateChickpeaCutoverInput,
  AgentCreateInput,
  AgentChannelGrant,
  AgentChannelGrantInput,
  AgentConnectionBinding,
  AgentConnectionBindingInput,
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
} from './types.ts';
import type { MemoryRpcRequest, MemoryRpcResponse } from '../memory/types.ts';
import type { RoutineRpcRequest, RoutineRpcResponse } from '../routines/types.ts';
import type { UsageRpcRequest, UsageRpcResponse } from '../usage/types.ts';
import type { WorkRpcRequest, WorkRpcResponse } from '../work/types.ts';
import type { IdentityRpcRequest, IdentityRpcResponse } from '../identity/types.ts';
import type { ManagementRpcRequest, ManagementRpcResponse } from '../management/types.ts';
import type {
  SlackCanonicalAdmissionInput,
  SlackCanonicalAdmissionResult,
} from '../slack/claim-store.ts';
import type {
  FlueDispatchEnvelopeV1,
  FlueDispatchReceiptV1,
  FlueObservationTarget,
  FlueSettlementCheckpointV1,
  FlueTurnObservationV1,
  SlackAgentBinding,
  SlackAgentBindingExpectation,
  TurnJob,
} from '../slack/turn-job-types.ts';
import type { SlackInteractionIntent } from '../slack/interaction-intent.ts';
import type {
  SlackAppendReservation,
  SlackPresentationTransitionInput,
  SlackPresentationTransitionResult,
  SlackRunPresentationV1,
  SlackPresentationSummary,
} from '../slack/run-presentations.ts';

export type { TurnJob } from '../slack/turn-job-types.ts';

/**
 * Wire contract between the Cloudflare store proxies and the TagStateStore
 * Durable Object (src/cloudflare.ts). Lives in a target-neutral module so BOTH
 * sides compile against the one definition — the DO implements it, the proxies
 * consume it, and a drift between them is a type error instead of a runtime
 * RPC surprise.
 *
 * Every method returns an explicit `{ok}` envelope rather than throwing across
 * the RPC boundary: workerd serializes thrown errors down to a bare
 * message-only Error, which would force the proxies to re-classify domain
 * errors by matching message text (the exact fragility src/config/errors.ts
 * exists to prevent). The envelope carries a stable machine `code` plus the
 * constructor args, so the proxy re-throws the SAME typed errors the node
 * backend throws and route boundaries stay `instanceof`-based on both targets.
 *
 * Args and returns are JSON-clonable; `undefined` results travel as `null`
 * (structured clone would carry `undefined`, but keeping the wire shape plain
 * JSON keeps it dumpable/loggable and independent of clone semantics).
 */

export type StateRpcErrorCode =
  | 'unknown_agent'
  | 'agent_exists'
  | 'agent_revision_conflict'
  | 'reserved_agent_identity'
  | 'workspace_model_default_revision_conflict'
  | 'agent_still_assigned'
  | 'agent_still_referenced'
  | 'channel_revision_conflict'
  | 'connection_account_revision_conflict'
  | 'identity'
  | 'management'
  | 'memory'
  | 'routine'
  | 'usage'
  | 'work'
  | 'slack_presentation'
  | 'internal';

export interface StateRpcError {
  code: StateRpcErrorCode;
  /** Human-readable failure text (safe to log; never shown to Slack users). */
  message: string;
  /** Typed-error constructor args, keyed per code (e.g. agentId, keys). */
  details?: Record<string, string>;
}

export type StateRpcResult<T> = { ok: true; value: T } | { ok: false; error: StateRpcError };

export interface SlackRuntimeDrainCounts {
  pendingLegacyTurnJobs: number;
  pendingLedgerTurnJobs: number;
  pendingSlackInteractionCleanups: number;
  recoveryRequiredTurnJobs: number;
}

export interface SlackTurnRecoveryItem {
  id: string;
  executionAuthority: 'legacy' | 'ledger';
  reason: string;
  enqueuedAt: number;
}

export type RuntimeDrainCategories = SlackRuntimeDrainCounts & {
  executingRuns: number;
  admittingOrRunningRoutineOccurrences: number;
};

export interface RuntimeDrainStatus {
  drained: boolean;
  categories: RuntimeDrainCategories;
}

export function buildRuntimeDrainStatus(
  categories: RuntimeDrainCategories,
): RuntimeDrainStatus {
  return {
    drained: Object.values(categories).every((count) => count === 0),
    categories,
  };
}

/**
 * A queued Slack turn, handed from the events handler to the state Durable
 * Object so its `alarm()` can run the turn AFTER the events ack — the Cloudflare
 * turn-horizon fix. On Cloudflare a turn driven inside the events invocation's
 * `waitUntil` is cancelled ~30s after the response, killing any longer model
 * turn; a DO alarm handler gets the platform's 15-minute wall-time budget
 * instead, so the alarm relay is what lets a slow keyless turn finish and
 * deliver. Every field is JSON-clonable (the whole job crosses the RPC boundary
 * and is persisted as JSON): `turn` is the normalized turn, `assignment` is the
 * SAME resolved assignment/snapshot the handler already computed (re-resolving
 * in the alarm could drift), and `id` is the idempotency key (the message
 * claim key) so a duplicate enqueue is ignored.
 */
export interface TurnPullRequestProgress {
  number: number;
  url: string;
  repository: string;
  branch?: string;
}

export interface SlackInteractionProgress {
  acknowledgment?: {
    channelId: string;
    messageTs: string;
    name: string;
    created: boolean;
    cleanup: 'pending' | 'done';
  };
  checklist?: {
    channelId: string;
    threadTs: string;
    messageTs: string;
    cleanup: 'pending' | 'done';
    terminal?: 'success' | 'error';
    supersededByNative?: boolean;
  };
}

export type SlackInteractionProgressPatch = Partial<SlackInteractionProgress>;

export interface TurnProgress {
  interactionIntent?: SlackInteractionIntent;
  slackInteraction?: SlackInteractionProgress;
  pullRequest?: TurnPullRequestProgress;
  usageTelemetry?: {
    executionId: string;
    admission?: 'recorded' | 'timed_out' | 'failed';
    terminal?: 'recorded' | 'timed_out' | 'failed';
    repair?: 'recorded' | 'timed_out' | 'failed';
  };
}

/**
 * Flat RPC surface of the state Durable Object stub: all four store domains
 * (config, snapshots, slack claims/threads, settings), one method per
 * operation, promise-returning as seen from the caller side of the stub.
 */
export interface TagStateRpc {
  // -- identity and organization authorization ----------------------------
  identityExecute(request: IdentityRpcRequest): Promise<StateRpcResult<IdentityRpcResponse>>;
  // -- requester-bound workspace management ledger -----------------------
  managementExecute(
    request: ManagementRpcRequest,
  ): Promise<StateRpcResult<ManagementRpcResponse>>;
  // -- config: agents ------------------------------------------------------
  configListAgents(): Promise<StateRpcResult<CustomAgentConfig[]>>;
  configListUserAgents(): Promise<StateRpcResult<CustomAgentConfig[]>>;
  configGetAgent(agentId: string): Promise<StateRpcResult<CustomAgentConfig>>;
  configMaterializeChickpeaAgent(): Promise<StateRpcResult<CustomAgentConfig>>;
  configCreateAgent(agent: AgentCreateInput): Promise<StateRpcResult<CustomAgentConfig>>;
  configUpdateAgent(
    agentId: string,
    patch: ConfigAgentPatch,
    expectedRevision?: number,
  ): Promise<StateRpcResult<CustomAgentConfig>>;
  configMarkOAuthReauthorizationRequired(
    target: OAuthReauthorizationTarget,
  ): Promise<StateRpcResult<boolean>>;
  configDeleteAgent(agentId: string, expectedRevision?: number): Promise<StateRpcResult<boolean>>;
  configArchiveAgent(
    agentId: string,
    options?: { replacementDefaultAgentId?: string; expectedRevision?: number },
  ): Promise<StateRpcResult<CustomAgentConfig>>;
  configRestoreAgent(
    agentId: string,
    expectedRevision?: number,
  ): Promise<StateRpcResult<CustomAgentConfig>>;
  configEnsureWorkspaceInstallation(
    input: EnsureWorkspaceInstallationInput,
  ): Promise<StateRpcResult<WorkspaceInstallation>>;
  configGetWorkspaceInstallation(
    workspaceId: string,
  ): Promise<StateRpcResult<WorkspaceInstallation | null>>;
  configListWorkspaceInstallations(): Promise<StateRpcResult<WorkspaceInstallation[]>>;
  configUpdateWorkspaceInstallation(
    workspaceId: string,
    patch: WorkspaceInstallationPatch,
    expectedRevision?: number,
  ): Promise<StateRpcResult<WorkspaceInstallation>>;
  configSetWorkspaceDefaultAgent(
    workspaceId: string,
    agentId: string,
    expectedRevision?: number,
  ): Promise<StateRpcResult<WorkspaceInstallation>>;
  configGetWorkspaceModelDefault(
    workspaceId: string,
  ): Promise<StateRpcResult<WorkspaceModelDefault | null>>;
  configPutWorkspaceModelDefault(
    input: WorkspaceModelDefaultInput,
    expectedRevision?: number,
  ): Promise<StateRpcResult<WorkspaceModelDefault>>;
  configPrepareChickpeaCutover(
    input: PrepareChickpeaCutoverInput,
  ): Promise<StateRpcResult<ChickpeaCutoverPreflight>>;
  configPreflightChickpeaCutover(
    workspaceId: string,
  ): Promise<StateRpcResult<ChickpeaCutoverPreflight>>;
  configActivateChickpeaCutover(
    input: ActivateChickpeaCutoverInput,
  ): Promise<StateRpcResult<ChickpeaCutoverActivation>>;
  configRollbackChickpeaCutover(
    input: RollbackChickpeaCutoverInput,
  ): Promise<StateRpcResult<ChickpeaCutoverPreflight>>;
  configListAgentChannelGrants(
    workspaceId?: string,
    channelId?: string,
  ): Promise<StateRpcResult<AgentChannelGrant[]>>;
  configPutAgentChannelGrant(
    input: AgentChannelGrantInput,
    expectedRevision?: number,
  ): Promise<StateRpcResult<AgentChannelGrant>>;
  configDeleteAgentChannelGrant(
    workspaceId: string,
    channelId: string,
    agentId: string,
  ): Promise<StateRpcResult<boolean>>;
  configGetAgentThreadRoute(
    workspaceId: string,
    channelId: string,
    threadTs: string,
  ): Promise<StateRpcResult<AgentThreadRoute | null>>;
  configPutAgentThreadRoute(
    input: AgentThreadRouteInput,
    expectedRevision?: number,
  ): Promise<StateRpcResult<AgentThreadRoute>>;
  configDeleteAgentThreadRoute(
    workspaceId: string,
    channelId: string,
    threadTs: string,
  ): Promise<StateRpcResult<boolean>>;
  configListSlackPublicContext(
    workspaceId: string,
    channelId: string,
    rootTs: string,
  ): Promise<StateRpcResult<SlackPublicContextEntry[]>>;
  configPutSlackPublicContext(
    input: SlackPublicContextEntryInput,
  ): Promise<StateRpcResult<SlackPublicContextEntry>>;
  configDeleteSlackPublicContextMessage(
    workspaceId: string,
    channelId: string,
    rootTs: string,
    messageTs: string,
  ): Promise<StateRpcResult<boolean>>;
  configDeleteSlackPublicContextRoot(
    workspaceId: string,
    channelId: string,
    rootTs: string,
  ): Promise<StateRpcResult<number>>;
  configListConnectionAccounts(
    workspaceId: string,
  ): Promise<StateRpcResult<ConnectionAccount[]>>;
  configPutConnectionAccount(
    input: ConnectionAccountInput,
    expectedRevision?: number,
  ): Promise<StateRpcResult<ConnectionAccount>>;
  configListAgentConnectionBindings(
    agentId: string,
  ): Promise<StateRpcResult<AgentConnectionBinding[]>>;
  configPutAgentConnectionBinding(
    input: AgentConnectionBindingInput,
  ): Promise<StateRpcResult<AgentConnectionBinding>>;
  configListAgentScheduleReferences(
    agentId: string,
  ): Promise<StateRpcResult<AgentScheduleReference[]>>;
  configGetAgentScheduleReference(
    scheduleId: string,
  ): Promise<StateRpcResult<AgentScheduleReference | null>>;
  configPutAgentScheduleReference(
    input: AgentScheduleReferenceInput,
    expectedRevision?: number,
  ): Promise<StateRpcResult<AgentScheduleReference>>;
  configListChannels(): Promise<StateRpcResult<ChannelConfig[]>>;
  configGetChannel(
    workspaceId: string,
    channelId: string,
  ): Promise<StateRpcResult<ChannelConfig | null>>;
  configPutChannel(
    channel: ChannelConfig,
    expectedRevision?: number,
  ): Promise<StateRpcResult<ChannelConfig>>;
  configGetAgentReferences(agentId: string): Promise<StateRpcResult<AgentReferenceSummary>>;
  // -- agent snapshots -----------------------------------------------------
  snapshotGet(threadKey: string): Promise<StateRpcResult<AgentSnapshot | null>>;
  snapshotPutIfAbsent(
    threadKey: string,
    snapshot: AgentSnapshot,
  ): Promise<StateRpcResult<AgentSnapshot>>;
  snapshotReplace(
    threadKey: string,
    snapshot: AgentSnapshot,
  ): Promise<StateRpcResult<AgentSnapshot>>;
  snapshotListLiveRootsByAgent(
    agentId: string,
  ): Promise<StateRpcResult<AgentSnapshotRootReference[]>>;
  // -- slack claims + thread registry --------------------------------------
  claim(key: string): Promise<StateRpcResult<boolean>>;
  release(key: string): Promise<StateRpcResult<null>>;
  threadStart(key: string): Promise<StateRpcResult<null>>;
  threadHas(key: string): Promise<StateRpcResult<boolean>>;
  threadActiveWorkGet(key: string): Promise<StateRpcResult<boolean>>;
  threadActiveWorkSet(
    key: string,
    generation: string,
    active: boolean,
  ): Promise<StateRpcResult<null>>;
  admitSlackTurn(
    input: SlackCanonicalAdmissionInput,
  ): Promise<StateRpcResult<SlackCanonicalAdmissionResult>>;
  slackAgentBindingPin(
    input: SlackAgentBinding,
    expected?: SlackAgentBindingExpectation,
  ): Promise<StateRpcResult<SlackAgentBinding>>;
  slackAgentBindingGet(
    continuityKey: string,
  ): Promise<StateRpcResult<SlackAgentBinding | null>>;
  slackFlueDispatchPrepare(
    id: string,
    message: string,
    observation: FlueTurnObservationV1,
  ): Promise<StateRpcResult<FlueDispatchEnvelopeV1>>;
  slackFlueExistingInstanceReconcile(
    id: string,
    uid: string,
  ): Promise<StateRpcResult<FlueDispatchEnvelopeV1>>;
  slackFlueReceiptRecord(
    id: string,
    receipt: FlueDispatchReceiptV1,
  ): Promise<StateRpcResult<FlueDispatchReceiptV1>>;
  slackFlueSettlementRecord(
    id: string,
    settlement: FlueSettlementCheckpointV1,
  ): Promise<StateRpcResult<FlueSettlementCheckpointV1>>;
  slackFlueObservationMatch(
    instanceId: string,
    submissionId?: string,
  ): Promise<StateRpcResult<FlueObservationTarget | null>>;
  slackTurnRecoveryRequired(id: string, reason: string): Promise<StateRpcResult<null>>;
  slackTurnRecoveryList(limit: number): Promise<StateRpcResult<SlackTurnRecoveryItem[]>>;
  slackInstallationRecoveryRetry(workspaceId: string): Promise<StateRpcResult<number>>;
  slackTurnRecoveryResolve(id: string): Promise<StateRpcResult<boolean>>;
  slackInstallationPendingDeliveryCount(workspaceId: string): Promise<StateRpcResult<number>>;
  slackInteractionProgressRecord(
    id: string,
    patch: SlackInteractionProgressPatch,
  ): Promise<StateRpcResult<null>>;
  slackPresentationGet(
    runId: string,
  ): Promise<StateRpcResult<SlackRunPresentationV1 | null>>;
  slackPresentationTransition(
    input: SlackPresentationTransitionInput,
  ): Promise<StateRpcResult<SlackPresentationTransitionResult>>;
  slackPresentationReserveAppend(
    workspaceId: string,
  ): Promise<StateRpcResult<SlackAppendReservation>>;
  slackPresentationApplyCooldown(
    workspaceId: string,
    retryAfterMs: number,
  ): Promise<StateRpcResult<{ cooldownUntil: number; budgetVersion: number }>>;
  slackPresentationRepairList(
    limit: number,
  ): Promise<StateRpcResult<SlackRunPresentationV1[]>>;
  slackPresentationMaintain(
    limit: number,
  ): Promise<StateRpcResult<{ finalizedPurged: number; expiredTombstoned: number }>>;
  slackPresentationSummary(
    workspaceId: string,
  ): Promise<StateRpcResult<SlackPresentationSummary>>;
  // -- operator settings ---------------------------------------------------
  settingGet(key: string): Promise<StateRpcResult<string | null>>;
  settingGetMany(keys: readonly string[]): Promise<StateRpcResult<(string | null)[]>>;
  settingSet(key: string, value: string): Promise<StateRpcResult<null>>;
  settingDelete(key: string): Promise<StateRpcResult<null>>;
  settingApplyPatch(patch: SettingsPatch): Promise<StateRpcResult<boolean>>;
  settingMergeStringSet(
    key: string,
    values: readonly string[],
  ): Promise<StateRpcResult<string[]>>;
  encryptedCredentialGet(
    key: string,
  ): Promise<StateRpcResult<EncryptedCredentialRevision | null>>;
  encryptedCredentialReplace(
    input: ReplaceEncryptedCredentialRevisionInput,
  ): Promise<StateRpcResult<EncryptedCredentialRevision | null>>;
  encryptedCredentialDelete(
    key: string,
    expectedRevision: string,
  ): Promise<StateRpcResult<boolean>>;
  // -- memory + generic audit envelope ------------------------------------
  memoryExecute(request: MemoryRpcRequest): Promise<StateRpcResult<MemoryRpcResponse>>;
  configDeleteAgentWithMemory(
    agentId: string,
    idempotencyKey: string,
  ): Promise<StateRpcResult<boolean>>;
  // -- routines + scheduled-work audit ------------------------------------
  routinesExecute(request: RoutineRpcRequest): Promise<StateRpcResult<RoutineRpcResponse>>;
  // -- usage observability ------------------------------------------------
  usageExecute(request: UsageRpcRequest): Promise<StateRpcResult<UsageRpcResponse>>;
  // -- canonical Work ledger ----------------------------------------------
  workExecute(request: WorkRpcRequest): Promise<StateRpcResult<WorkRpcResponse>>;
  runtimeDrainStatus(): Promise<StateRpcResult<RuntimeDrainStatus>>;
  maintainWork(at: number): Promise<StateRpcResult<null>>;
  // -- turn relay (Cloudflare turn-horizon fix) ----------------------------
  /**
   * Persist a turn job and arm the alarm so `alarm()` runs it past the events
   * ack. Resolves only after the write + `setAlarm` are durable, so the caller
   * can ack Slack knowing the turn survives regardless of the events
   * invocation's fate. Idempotent by `job.id` (a duplicate enqueue is ignored).
   */
  enqueueTurn(job: TurnJob): Promise<StateRpcResult<null>>;
  /** Clone a completed authorization-link turn into one idempotent resume turn. */
  resumeTurnAfterOAuth(
    originalTaskId: string,
    continuationId: string,
  ): Promise<StateRpcResult<boolean>>;
  // -- status relay (Cloudflare cross-isolate activity narration) -----------
  /**
   * Forward safe activity observed inside the agent DO isolate to the status
   * registry living in this DO's isolate (where the alarm runs the turn). The
   * opaque generation fences delayed RPCs from later turns on the same thread.
   * Best-effort: a miss/closed turn or ambiguous concurrent-turn match is a
   * success, never an error. Only sanitized status text crosses this seam.
   */
  observedStatus(
    instanceId: string,
    submissionId: string,
    statusText: string,
  ): Promise<StateRpcResult<null>>;
}

/**
 * Minimal structural view of the `env.TAG_STATE` Durable Object namespace
 * binding — just enough to obtain the singleton stub. Declared here (not via
 * workers-types) so the node lane compiles without Cloudflare's global types.
 */
export interface TagStateNamespace {
  getByName(name: string): TagStateRpc;
}

/**
 * The one state DO instance. ALL app state lives in a single named instance:
 * a singleton is what makes claim dedupe race-free (single-threaded DO) and
 * keeps every domain in one SQLite file, exactly like the node lane's
 * one-file state DB.
 */
export const TAG_STATE_INSTANCE = 'singleton';

export function tagStateInstanceName(env: Record<string, unknown> | undefined): string {
  const configured = env?.TAG_STATE_INSTANCE_NAME;
  if (configured === undefined) return TAG_STATE_INSTANCE;
  if (typeof configured !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(configured)) {
    throw new Error('TAG_STATE_INSTANCE_NAME must be a bounded Durable Object name.');
  }
  return configured;
}

/** Resolve the singleton state-DO stub from the worker/agent platform env. */
export function tagStateStub(env: Record<string, unknown> | undefined): TagStateRpc {
  if (!env) {
    throw new Error(
      'Cloudflare state backend requires the platform env (route handlers pass c.env; ' +
        'the agent passes getCloudflareContext().env)',
    );
  }
  const namespace = (env as { TAG_STATE?: TagStateNamespace }).TAG_STATE;
  if (!namespace || typeof namespace.getByName !== 'function') {
    throw new Error(
      'TAG_STATE Durable Object binding is missing — check wrangler.jsonc durable_objects.bindings',
    );
  }
  return namespace.getByName(tagStateInstanceName(env));
}
