import type { AssignmentLookupOptions } from './resolver.ts';
import type { SettingsPatch } from './settings-store.ts';
import type {
  ConfigAgentPatch,
  OAuthReauthorizationTarget,
  SlackIdentityPatch,
} from './store.ts';
import type {
  AgentCreateInput,
  AgentSnapshot,
  AgentSnapshotRootReference,
  AgentReferenceSummary,
  ChannelAssignment,
  ChannelConfig,
  ChannelPlacementMutation,
  ChannelPlacementResult,
  CustomAgentConfig,
  SlackIdentity,
  SlackIdentityDmState,
  SlackIdentityReferenceSummary,
} from './types.ts';
import type { MemoryRpcRequest, MemoryRpcResponse } from '../memory/types.ts';
import type { RoutineRpcRequest, RoutineRpcResponse } from '../routines/types.ts';
import type { UsageRpcRequest, UsageRpcResponse } from '../usage/types.ts';
import type { WorkRpcRequest, WorkRpcResponse } from '../work/types.ts';
import type { IdentityRpcRequest, IdentityRpcResponse } from '../identity/types.ts';
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
import type { AppendAuditEvent, AuditEvent, AuditEventFilter } from '../audit/types.ts';

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
  | 'agent_still_assigned'
  | 'agent_still_referenced'
  | 'agent_slack_dm_handler'
  | 'agent_slack_identity_conflict'
  | 'channel_assignment_conflict'
  | 'unknown_slack_identity'
  | 'slack_identity_exists'
  | 'slack_identity_still_referenced'
  | 'slack_identity_revision_conflict'
  | 'slack_identity_lifecycle'
  | 'workspace_default_slack_identity_protected'
  | 'identity'
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

export interface SlackContinuityNoticeProgress {
  status: 'retryable' | 'posting' | 'delivered' | 'unknown';
  messageTs?: string;
}

export interface TurnProgress {
  interactionIntent?: SlackInteractionIntent;
  slackInteraction?: SlackInteractionProgress;
  continuityNotice?: SlackContinuityNoticeProgress;
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
  // -- config: agents ------------------------------------------------------
  configListAgents(): Promise<StateRpcResult<CustomAgentConfig[]>>;
  configGetAgent(agentId: string): Promise<StateRpcResult<CustomAgentConfig>>;
  configCreateAgent(agent: AgentCreateInput): Promise<StateRpcResult<CustomAgentConfig>>;
  configUpdateAgent(
    agentId: string,
    patch: ConfigAgentPatch,
    expectedRevision?: number,
  ): Promise<StateRpcResult<CustomAgentConfig>>;
  configMarkOAuthReauthorizationRequired(
    target: OAuthReauthorizationTarget,
  ): Promise<StateRpcResult<boolean>>;
  configDeleteAgent(agentId: string): Promise<StateRpcResult<boolean>>;
  configListChannels(): Promise<StateRpcResult<ChannelConfig[]>>;
  configGetChannel(
    workspaceId: string,
    channelId: string,
  ): Promise<StateRpcResult<ChannelConfig | null>>;
  configPutChannel(channel: ChannelConfig): Promise<StateRpcResult<ChannelConfig>>;
  configPutChannelPlacement(
    input: ChannelPlacementMutation,
  ): Promise<StateRpcResult<ChannelPlacementResult>>;
  // -- config: assignments -------------------------------------------------
  configListAssignments(): Promise<StateRpcResult<ChannelAssignment[]>>;
  configGetAssignment(
    workspaceId: string,
    channelId: string,
  ): Promise<StateRpcResult<ChannelAssignment | null>>;
  configListAssignmentsForAgent(agentId: string): Promise<StateRpcResult<ChannelAssignment[]>>;
  configPutAssignment(assignment: ChannelAssignment): Promise<StateRpcResult<ChannelAssignment>>;
  configDeleteAssignment(
    workspaceId: string,
    channelId: string,
  ): Promise<StateRpcResult<boolean>>;
  configFind(
    workspaceId: string,
    channelId: string,
    options?: AssignmentLookupOptions,
  ): Promise<StateRpcResult<ChannelAssignment | null>>;
  configGetAgentReferences(agentId: string): Promise<StateRpcResult<AgentReferenceSummary>>;
  // -- config: Slack identities -------------------------------------------
  configListSlackIdentities(): Promise<StateRpcResult<SlackIdentity[]>>;
  configGetSlackIdentity(identityId: string): Promise<StateRpcResult<SlackIdentity>>;
  configGetSlackIdentityByIngressKey(
    ingressKey: string,
  ): Promise<StateRpcResult<SlackIdentity | null>>;
  configCreateSlackIdentity(identity: SlackIdentity): Promise<StateRpcResult<SlackIdentity>>;
  configUpdateSlackIdentity(
    identityId: string,
    expectedRevision: number,
    patch: SlackIdentityPatch,
  ): Promise<StateRpcResult<SlackIdentity>>;
  configListSlackIdentitiesForAgent(
    agentId: string,
  ): Promise<StateRpcResult<SlackIdentity[]>>;
  configListAgentsForSlackIdentity(
    identityId: string,
  ): Promise<StateRpcResult<CustomAgentConfig[]>>;
  configResolveSlackIdentityForAgent(agentId: string): Promise<StateRpcResult<SlackIdentity>>;
  configGetSlackIdentityReferences(
    identityId: string,
  ): Promise<StateRpcResult<SlackIdentityReferenceSummary>>;
  configSetSlackIdentityDmBinding(
    identityId: string,
    expectedRevision: number,
    dmState: SlackIdentityDmState,
    dmAgentId?: string,
  ): Promise<StateRpcResult<SlackIdentity>>;
  configCompleteSlackIdentitySetup(
    identityId: string,
    expectedRevision: number,
    agentId?: string,
    expectedAgentIdentityId?: string | null,
  ): Promise<StateRpcResult<SlackIdentity>>;
  configAttachAgentToSlackIdentity(
    agentId: string,
    identityId: string,
    expectedIdentityRevision: number,
    expectedAgentIdentityId: string | null,
  ): Promise<StateRpcResult<CustomAgentConfig>>;
  configRetireSlackIdentity(
    identityId: string,
    expectedRevision: number,
  ): Promise<StateRpcResult<SlackIdentity>>;
  configDeleteIncompleteSlackIdentity(
    identityId: string,
    expectedRevision: number,
    credentialsErased: boolean,
  ): Promise<StateRpcResult<boolean>>;
  configPurgeRetiredSlackIdentity(
    identityId: string,
    expectedRevision: number,
    credentialsErased: boolean,
  ): Promise<StateRpcResult<boolean>>;
  configAppendSlackIdentityAudit(
    input: AppendAuditEvent,
  ): Promise<StateRpcResult<AuditEvent>>;
  configListSlackIdentityAuditEvents(
    filter?: AuditEventFilter,
  ): Promise<StateRpcResult<AuditEvent[]>>;
  // -- agent snapshots -----------------------------------------------------
  snapshotGet(threadKey: string): Promise<StateRpcResult<AgentSnapshot | null>>;
  snapshotPutIfAbsent(
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
  threadParticipationGet(key: string): Promise<StateRpcResult<'ambient' | 'mention_only'>>;
  threadParticipationSet(
    key: string,
    mode: 'ambient' | 'mention_only',
  ): Promise<StateRpcResult<null>>;
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
  slackContinuityNoticeRecord(
    id: string,
    notice: SlackContinuityNoticeProgress,
  ): Promise<StateRpcResult<null>>;
  slackTurnRecoveryRequired(id: string, reason: string): Promise<StateRpcResult<null>>;
  slackTurnRecoveryList(limit: number): Promise<StateRpcResult<SlackTurnRecoveryItem[]>>;
  slackIdentityRecoveryRetry(identityId: string): Promise<StateRpcResult<number>>;
  slackTurnRecoveryResolve(id: string): Promise<StateRpcResult<boolean>>;
  slackIdentityPendingDeliveryCount(identityId: string): Promise<StateRpcResult<number>>;
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
  return namespace.getByName(TAG_STATE_INSTANCE);
}
