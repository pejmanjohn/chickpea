import type { AuditEvent, AuditEventFilter } from '../audit/types.ts';
import type { ProviderAuthRoute } from '../config/runtime-model.ts';
import type { SourceVisibility } from '../work/types.ts';

export type RoutineState = 'pending_authority' | 'active' | 'paused' | 'disabled' | 'completed';
export type RoutineTriggerKind = 'schedule' | 'once';
export type RoutineOutputPolicy = 'post' | 'post_on_change';
export type RoutineAuthorityMode = 'live_channel_v1' | 'live_direct_member_v1';
export type RoutineDestination =
  | { kind: 'channel'; channelId: string }
  | {
      kind: 'direct_thread';
      conversationId: string;
      threadTs: string;
      ownerMembershipId: string;
    };
export type RoutineActorClass = 'member' | 'operator' | 'system';
export type RoutineControlAction = 'pause' | 'resume' | 'disable';
export type RoutineRunStatus =
  | 'queued'
  | 'admitting'
  | 'running'
  | 'succeeded'
  | 'no_op'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'superseded';
export type RoutineTriggerSource = 'schedule' | 'once' | 'run_now';
export type RoutineAdmissionStatus =
  | 'attempting'
  | 'attached'
  | 'superseded'
  | 'unknown'
  | 'failed';

export type RoutineFailureClass =
  | 'creator_ineligible'
  | 'channel_ineligible'
  | 'assignment_missing'
  | 'access_denied'
  | 'credential_unavailable'
  | 'policy_denied'
  | 'capacity_limited'
  | 'spend_limited'
  | 'schedule_invalid'
  | 'admission_unknown'
  | 'workflow_interrupted'
  | 'deadline_exceeded'
  | 'tool_failed'
  | 'unknown_external_outcome'
  | 'result_invalid'
  | 'slack_rate_limited'
  | 'direct_thread_unavailable'
  | 'delivery_unknown'
  | 'internal_error';

export interface RoutineDefinitionContent {
  name: string;
  description: string;
  taskText: string;
  triggerKind: RoutineTriggerKind;
  scheduleInput: string;
  scheduleJson: string;
  timezone: string;
  outputPolicy: RoutineOutputPolicy;
  authorityMode: RoutineAuthorityMode;
}

export interface RoutineScheduleReservation {
  windowStart: number;
  count: number;
}

export interface RoutineDefinition extends RoutineDefinitionContent {
  id: string;
  /** Canonical Work links are present only on dual-written rows. */
  workId?: string | null;
  bindingId?: string | null;
  workspaceId: string;
  channelId: string;
  destination: RoutineDestination;
  creatorUserId: string;
  state: RoutineState;
  version: number;
  nextRunAt: number | null;
  lastScheduledAt: number | null;
  lastFinishedAt: number | null;
  consecutiveFailures: number;
  lastChangeKeyHash: string | null;
  projectedDailyStarts: number;
  reservationWindows: RoutineScheduleReservation[];
  createdAt: number;
  createdBy: string | null;
  updatedAt: number;
  updatedBy: string | null;
  pausedAt: number | null;
  pausedBy: string | null;
  pausedReason: string | null;
  disabledAt: number | null;
  disabledBy: string | null;
  disabledReason: string | null;
  deletedAt: number | null;
  deletedBy: string | null;
}

export interface RoutineRevision {
  routineId: string;
  version: number;
  definition: RoutineDefinitionContent | null;
  definitionHash: string;
  actorId: string | null;
  actorClass: RoutineActorClass;
  confirmationId: string | null;
  provenance: RoutineRequestProvenance | null;
  createdAt: number;
}

export type RoutineRequestSourceKind = 'slack_request' | 'slack_clone';
export type RoutineAuthoritySource = 'current_request' | 'previous_revision' | 'cloned_revision';

export interface RoutineRequestProvenanceInput {
  sourceKind: RoutineRequestSourceKind;
  requestText: string;
  eventId: string;
  messageTs: string;
  threadTs: string;
  authoritySource: RoutineAuthoritySource;
  sourceRoutineId?: string | null;
  sourceRoutineVersion?: number | null;
}

export type RoutineRequestProvenance = Omit<
  RoutineRequestProvenanceInput,
  'requestText' | 'sourceRoutineId' | 'sourceRoutineVersion'
> & {
  requestHash: string;
  sourceRoutineId: string | null;
  sourceRoutineVersion: number | null;
  definitionHash: string;
  requestText: string | null;
};

export type RoutineConfirmationDraft =
  | {
      action: 'create';
      routineId: string;
      definition: RoutineDefinitionContent;
      nextRunAt: number;
      projectedDailyStarts: number;
      reservations: RoutineScheduleReservation[];
    }
  | {
      action: 'edit';
      routineId: string;
      expectedVersion: number;
      definition: RoutineDefinitionContent;
      nextRunAt: number;
      projectedDailyStarts: number;
      reservations: RoutineScheduleReservation[];
    }
  | { action: 'delete'; routineId: string; expectedVersion: number };

export interface RoutineConfirmation {
  id: string;
  tokenHash: string;
  actorId: string;
  actorClass: RoutineActorClass;
  workspaceId: string;
  channelId: string;
  draft: RoutineConfirmationDraft;
  baseVersion: number | null;
  previewHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface PutRoutineConfirmationInput {
  confirmationId: string;
  tokenHash: string;
  actorId: string;
  actorClass: RoutineActorClass;
  workspaceId: string;
  channelId: string;
  draft: RoutineConfirmationDraft;
  previewHash: string;
  expiresAt: number;
}

export interface CancelRoutineConfirmationInput {
  tokenHash: string;
  actorId: string;
  workspaceId: string;
  channelId: string;
  at: number;
}

export interface ConfirmRoutineInput {
  tokenHash: string;
  actorId: string;
  workspaceId: string;
  channelId: string;
  previewHash: string;
  idempotencyKey: string;
}

export interface SaveRoutineInput {
  actorId: string;
  actorClass: RoutineActorClass;
  workspaceId: string;
  channelId: string;
  /** Omitted legacy callers retain the existing Channel destination. */
  destination?: RoutineDestination;
  draft: Exclude<RoutineConfirmationDraft, { action: 'delete' }>;
  provenance?: RoutineRequestProvenanceInput | null;
  idempotencyKey: string;
  /** Resolved at Slack creation time; omitted callers fail closed to unknown. */
  sourceVisibility?: SourceVisibility;
}

export interface ActivateDirectRoutineInput {
  routineId: string;
  expectedVersion: number;
  expectedReferenceRevision: number;
  destinationBindingDigest: string;
}

export type RoutineRecoveryDeliveryStatus =
  | 'pending'
  | 'accepted'
  | 'definitive_failure'
  | 'unknown';

export interface RoutineRecoveryDelivery {
  occurrenceId: string;
  claimedAt: number | null;
  status: RoutineRecoveryDeliveryStatus;
  messageTs: string | null;
  failureClass: 'direct_thread_unavailable';
  updatedAt: number;
}

export interface ClaimRoutineRecoveryDeliveryInput {
  occurrenceId: string;
  at: number;
}

export interface RecordRoutineRecoveryDeliveryInput {
  occurrenceId: string;
  outcome: Exclude<RoutineRecoveryDeliveryStatus, 'pending'>;
  at: number;
  messageTs?: string;
}

export interface ControlRoutineInput {
  routineId: string;
  expectedVersion: number;
  action: RoutineControlAction;
  actorId: string;
  actorClass: RoutineActorClass;
  reasonCode?: string;
  idempotencyKey: string;
}

export interface RoutineRun {
  id: string;
  /** Canonical Run link is absent on historical/legacy occurrences. */
  canonicalRunId?: string | null;
  idempotencyKey: string;
  routineId: string;
  routineVersion: number;
  scheduledFor: number;
  triggerSource: RoutineTriggerSource;
  requestedBy: string | null;
  status: RoutineRunStatus;
  failureClass: RoutineFailureClass | null;
  publicError: string | null;
  admissionOwner: string | null;
  admissionLeaseUntil: number | null;
  flueRunId: string | null;
  /** Historical Flue workflow id above remains read-only for legacy rows. */
  flueAgentEnvelope?: RoutineAgentDispatchEnvelope | null;
  flueAgentSettlement?: RoutineAgentSettlementV1 | null;
  queuedAt: number;
  admittedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  resolvedAccessHash: string | null;
  resolvedAgentId: string | null;
  /** Immutable authority receipt captured for this admitted run. */
  resolvedAuthorityReceiptId: string | null;
  /** Immutable canonical actor captured for this admitted run. */
  resolvedRunsAsMembershipId: string | null;
  model: string | null;
  providerAuthRoute: ProviderAuthRoute | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costEstimate: number | null;
  costUnit: string | null;
  /** Present on dual-written rows; absent on older fixture/consumer shapes. */
  usageLedgerOperationId?: string | null;
  usageProvenance?: 'usage_ledger' | 'legacy_routine';
  usageCompleteness?: 'complete' | 'partial' | 'not_reported' | null;
  deadlineAt: number;
  sandboxSessionId: string | null;
  toolCallCount: number;
  deliveryStatus: 'none' | 'leased' | 'delivered' | 'unknown' | 'failed';
  deliveryLeaseUntil: number | null;
  deliveryChannelId: string | null;
  deliveryMessageTs: string | null;
  changeKeyHash: string | null;
  baselineChangeKeyHash: string | null;
  suppressedAsNoOp: boolean;
  skipReason: string | null;
  missedSlotCount: number;
  firstMissedAt: number | null;
  lastMissedAt: number | null;
  traceId: string | null;
  revision: RoutineDefinitionContent | null;
  revisionHash: string;
}

export interface CreateRoutineOccurrenceInput {
  runId: string;
  idempotencyKey: string;
  routineId: string;
  routineVersion: number;
  scheduledFor: number;
  triggerSource: RoutineTriggerSource;
  requestedBy?: string | null;
  queuedAt: number;
  deadlineAt: number;
  skipReason?: string | null;
  missedSlotCount?: number;
  firstMissedAt?: number | null;
  lastMissedAt?: number | null;
}

export interface RoutineAdmissionAttempt {
  occurrenceId: string;
  attempt: number;
  attemptId: string;
  flueRunId: string | null;
  flueAgentReceipt: RoutineAgentReceiptV1 | null;
  invokeStartedAt: number;
  receiptAt: number | null;
  visibleAt: number | null;
  status: RoutineAdmissionStatus;
  safeError: string | null;
}

export interface RoutineAgentDispatchEnvelopeV1 {
  schemaVersion: 1;
  attemptId: string;
  instanceId: string;
  idempotencyKey: string;
  message: string;
  initialData: unknown;
}

export interface RoutineScheduleSignalV2 {
  kind: 'signal';
  type: 'schedule';
  body: string;
  attributes: {
    routineId: string;
    occurrenceId: string;
    workspaceId: string;
    conversationId: string;
    destinationKind: 'channel' | 'direct_thread';
    ownerAgentId: string;
    ownerMembershipId: string;
    threadTs: string;
    triggerSource: RoutineTriggerSource;
    scheduledFor: string;
  };
}

export interface RoutineAgentDispatchEnvelopeV2 {
  schemaVersion: 2;
  attemptId: string;
  instanceId: string;
  idempotencyKey: string;
  message: RoutineScheduleSignalV2;
  initialData: unknown;
}

export type RoutineAgentDispatchEnvelope =
  | RoutineAgentDispatchEnvelopeV1
  | RoutineAgentDispatchEnvelopeV2;

export interface RoutineAgentReceiptV1 {
  submissionId: string;
  acceptedAt: string;
  uid?: string;
  deduplicated?: true;
}

export interface RoutineAgentUsageV1 {
  requestedModel: string;
  returnedModel: { provider: string; id: string } | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  completeness: 'complete' | 'partial' | 'not_reported';
}

export interface RoutineAgentCompletedResultV1 {
  status: 'succeeded' | 'no_op';
  message: string;
  changeKeyHash: string | null;
  suppressedAsNoOp: boolean;
  toolCallCount: number;
  usage: RoutineAgentUsageV1;
}

export type RoutineAgentSettlementV1 =
  | {
      schemaVersion: 1;
      outcome: 'completed';
      settledAt: number;
      result: RoutineAgentCompletedResultV1;
    }
  | {
      schemaVersion: 1;
      outcome: 'failed' | 'aborted';
      settledAt: number;
      failureClass: RoutineFailureClass;
      publicError: string;
      toolCallCount: number;
      usage: RoutineAgentUsageV1 | null;
    };

export interface StartRoutineAdmissionInput {
  occurrenceId: string;
  owner: string;
  leaseUntil: number;
  invokeStartedAt: number;
}

export interface ClaimDueRoutinesInput {
  now: number;
  owner: string;
  limit: number;
}

export interface RoutineDueClaimBatch {
  runs: RoutineRun[];
  scannedCount: number;
  deferredCount: number;
}

export interface RoutineMaintenanceResult {
  confirmationsPurged: number;
  reservationsPurged: number;
  deliveryLeasesReconciled: number;
  deadlineRunsReconciled: number;
  runsDeleted: number;
  auditEventsDeleted: number;
}

export interface ResolveRoutineAdmissionInput {
  occurrenceId: string;
  attempt: number;
  outcome: 'absent' | 'unknown';
  at: number;
  safeError?: string | null;
}

export interface BeginRoutineOccurrenceInput {
  occurrenceId: string;
  flueRunId: string;
  startedAt: number;
  resolvedAccessHash?: string;
  resolvedAgentId?: string;
  model?: string;
  providerAuthRoute?: ProviderAuthRoute;
  traceId?: string;
}

export interface PrepareRoutineAgentDispatchInput {
  occurrenceId: string;
  attempt: number;
  startedAt: number;
  envelope: RoutineAgentDispatchEnvelope;
  resolvedAccessHash: string;
  resolvedAgentId: string;
  resolvedAuthorityReceiptId: string;
  resolvedRunsAsMembershipId: string;
  model: string;
  providerAuthRoute?: ProviderAuthRoute;
  traceId: string;
}

export interface RecordRoutineAgentReceiptInput {
  occurrenceId: string;
  attempt: number;
  receipt: RoutineAgentReceiptV1;
  at: number;
}

export interface RecordRoutineAgentSettlementInput {
  occurrenceId: string;
  settlement: RoutineAgentSettlementV1;
}

export interface TransitionRoutineRunInput {
  occurrenceId: string;
  from: readonly RoutineRunStatus[];
  to: RoutineRunStatus;
  at: number;
  failureClass?: RoutineFailureClass | null;
  publicError?: string | null;
  skipReason?: string | null;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costEstimate?: number;
  costUnit?: string;
  usageLedgerOperationId?: string;
  usageProvenance?: 'usage_ledger' | 'legacy_routine';
  usageCompleteness?: 'complete' | 'partial' | 'not_reported';
  toolCallCount?: number;
  changeKeyHash?: string | null;
  suppressedAsNoOp?: boolean;
}

export interface ClaimRoutineDeliveryInput {
  occurrenceId: string;
  at: number;
  leaseUntil: number;
}

export interface RecordRoutineDeliveryInput {
  occurrenceId: string;
  outcome: 'delivered' | 'unknown' | 'failed';
  at: number;
  failureClass?: Extract<RoutineFailureClass, 'direct_thread_unavailable'>;
  channelId?: string;
  messageTs?: string;
  changeKeyHash?: string | null;
}

export interface RoutineRunFilter {
  routineId?: string;
  statuses?: readonly RoutineRunStatus[];
  limit?: number;
}

/** Bounded operator-facing query. This intentionally differs from Slack's listRoutines. */
export interface RoutineAdminPageInput {
  workspaceId?: string;
  channelId?: string;
  state?: RoutineState | 'current' | 'all' | 'deleted';
  runStatus?: RoutineRunStatus;
  cursor?: number;
  limit: number;
}

export interface RoutineAdminPage {
  routines: RoutineDefinition[];
  nextCursor: number | null;
}

export type RoutineScheduleActionStatus = 'pending' | 'applied' | 'failed';

export type RoutineScheduleActionResult =
  | {
      outcome: 'applied';
      effect: 'saved' | 'controlled' | 'run_queued' | 'confirmation_required';
      routineId: string;
      routineVersion?: number;
      safeState?: 'active' | 'paused' | 'disabled' | 'pending_authority';
    }
  | {
      outcome: 'failed';
      code: string;
      routineId?: string;
      safeState?: 'paused' | 'disabled' | 'pending_authority';
    };

export interface RoutineScheduleAction {
  actionId: string;
  actionDigest: string;
  /** Private management-request ledger entry containing the bounded command payload. */
  requestOperationId: string;
  workspaceId: string;
  actorUserId: string;
  actorMembershipId: string;
  agentId: string;
  conversationKind: 'channel' | 'im';
  channelId: string;
  threadTs: string;
  messageTs: string;
  status: RoutineScheduleActionStatus;
  leaseOwner: string | null;
  leaseUntil: number | null;
  attempts: number;
  nextAttemptAt: number;
  result: RoutineScheduleActionResult | null;
  pendingReceiptQueuedAt: number | null;
  terminalReceiptQueuedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReserveRoutineScheduleActionInput {
  actionId: string;
  actionDigest: string;
  requestOperationId: string;
  workspaceId: string;
  actorUserId: string;
  actorMembershipId: string;
  agentId: string;
  conversationKind: 'channel' | 'im';
  channelId: string;
  threadTs: string;
  messageTs: string;
  at: number;
}

export interface ClaimRoutineScheduleActionInput {
  actionId: string;
  owner: string;
  at: number;
  leaseUntil: number;
}

export type ClaimRoutineScheduleActionResult =
  | { outcome: 'claimed'; action: RoutineScheduleAction }
  | { outcome: 'pending'; action: RoutineScheduleAction }
  | { outcome: 'terminal'; action: RoutineScheduleAction };

export interface SettleRoutineScheduleActionInput {
  actionId: string;
  owner: string;
  expectedAttempt: number;
  result: RoutineScheduleActionResult;
  at: number;
}

export interface DeferRoutineScheduleActionInput {
  actionId: string;
  owner: string;
  expectedAttempt: number;
  nextAttemptAt: number;
  at: number;
}

export interface MarkRoutineScheduleActionReceiptQueuedInput {
  actionId: string;
  phase: 'pending' | 'terminal';
  at: number;
}

export interface RoutineStore {
  reserveScheduleAction(input: ReserveRoutineScheduleActionInput): Promise<RoutineScheduleAction>;
  getScheduleAction(actionId: string): Promise<RoutineScheduleAction | undefined>;
  claimScheduleAction(input: ClaimRoutineScheduleActionInput): Promise<ClaimRoutineScheduleActionResult>;
  claimDueScheduleActions(input: {
    owner: string;
    at: number;
    leaseUntil: number;
    limit: number;
  }): Promise<RoutineScheduleAction[]>;
  nextScheduleActionDueAt(): Promise<number | undefined>;
  listScheduleActionsNeedingReceipts(limit: number): Promise<RoutineScheduleAction[]>;
  markScheduleActionReceiptQueued(
    input: MarkRoutineScheduleActionReceiptQueuedInput,
  ): Promise<RoutineScheduleAction>;
  deferScheduleAction(input: DeferRoutineScheduleActionInput): Promise<RoutineScheduleAction>;
  settleScheduleAction(input: SettleRoutineScheduleActionInput): Promise<RoutineScheduleAction>;
  putConfirmation(input: PutRoutineConfirmationInput): Promise<RoutineConfirmation>;
  getConfirmation(tokenHash: string): Promise<RoutineConfirmation | undefined>;
  cancelConfirmation(input: CancelRoutineConfirmationInput): Promise<boolean>;
  confirm(input: ConfirmRoutineInput): Promise<RoutineDefinition>;
  save(input: SaveRoutineInput): Promise<RoutineDefinition>;
  activateDirectRoutine(input: ActivateDirectRoutineInput): Promise<RoutineDefinition>;
  purgeConfirmations(): Promise<number>;
  cleanupRetention(): Promise<RoutineMaintenanceResult>;
  getRoutine(routineId: string): Promise<RoutineDefinition | undefined>;
  getRoutineByWorkId(workId: string): Promise<RoutineDefinition | undefined>;
  listRoutines(workspaceId?: string, channelId?: string): Promise<RoutineDefinition[]>;
  listAdminRoutinePage(input: RoutineAdminPageInput): Promise<RoutineAdminPage>;
  listRevisions(routineId: string): Promise<RoutineRevision[]>;
  control(input: ControlRoutineInput): Promise<RoutineDefinition>;
  createOccurrence(input: CreateRoutineOccurrenceInput): Promise<RoutineRun>;
  getRun(occurrenceId: string): Promise<RoutineRun | undefined>;
  listRuns(filter?: RoutineRunFilter): Promise<RoutineRun[]>;
  countAdmittingOrRunningOccurrences(): Promise<number>;
  claimDueSchedules(input: ClaimDueRoutinesInput): Promise<RoutineDueClaimBatch>;
  startAdmissionAttempt(input: StartRoutineAdmissionInput): Promise<RoutineAdmissionAttempt>;
  recordAdmissionReceipt(
    occurrenceId: string,
    attempt: number,
    flueRunId: string,
    receiptAt: number,
  ): Promise<RoutineAdmissionAttempt>;
  resolveAdmission(input: ResolveRoutineAdmissionInput): Promise<RoutineRun>;
  beginOccurrence(input: BeginRoutineOccurrenceInput): Promise<'started' | 'superseded'>;
  prepareAgentDispatch(input: PrepareRoutineAgentDispatchInput): Promise<'started' | 'superseded'>;
  recordAgentReceipt(input: RecordRoutineAgentReceiptInput): Promise<RoutineAdmissionAttempt>;
  recordAgentSettlement(input: RecordRoutineAgentSettlementInput): Promise<RoutineRun>;
  transitionRun(input: TransitionRoutineRunInput): Promise<RoutineRun>;
  claimDelivery(input: ClaimRoutineDeliveryInput): Promise<'claimed' | 'superseded'>;
  recordDelivery(input: RecordRoutineDeliveryInput): Promise<RoutineRun>;
  getRecoveryDelivery(occurrenceId: string): Promise<RoutineRecoveryDelivery | undefined>;
  claimRecoveryDelivery(
    input: ClaimRoutineRecoveryDeliveryInput,
  ): Promise<'claimed' | 'superseded'>;
  recordRecoveryDelivery(
    input: RecordRoutineRecoveryDeliveryInput,
  ): Promise<RoutineRecoveryDelivery>;
  listAdmissions(occurrenceId: string): Promise<RoutineAdmissionAttempt[]>;
  listAuditEvents(filter?: AuditEventFilter): Promise<AuditEvent[]>;
}

export class RoutineStateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'RoutineStateError';
  }
}

export type RoutineRpcRequest =
  | { kind: 'reserve_schedule_action'; input: ReserveRoutineScheduleActionInput }
  | { kind: 'get_schedule_action'; actionId: string }
  | { kind: 'claim_schedule_action'; input: ClaimRoutineScheduleActionInput }
  | {
      kind: 'claim_due_schedule_actions';
      input: { owner: string; at: number; leaseUntil: number; limit: number };
    }
  | { kind: 'next_schedule_action_due_at' }
  | { kind: 'list_schedule_actions_needing_receipts'; limit: number }
  | {
      kind: 'mark_schedule_action_receipt_queued';
      input: MarkRoutineScheduleActionReceiptQueuedInput;
    }
  | { kind: 'defer_schedule_action'; input: DeferRoutineScheduleActionInput }
  | { kind: 'settle_schedule_action'; input: SettleRoutineScheduleActionInput }
  | { kind: 'put_confirmation'; input: PutRoutineConfirmationInput }
  | { kind: 'get_confirmation'; tokenHash: string }
  | { kind: 'cancel_confirmation'; input: CancelRoutineConfirmationInput }
  | { kind: 'confirm'; input: ConfirmRoutineInput }
  | { kind: 'save'; input: SaveRoutineInput }
  | { kind: 'activate_direct_routine'; input: ActivateDirectRoutineInput }
  | { kind: 'purge_confirmations' }
  | { kind: 'cleanup_retention' }
  | { kind: 'get_routine'; routineId: string }
  | { kind: 'get_routine_by_work'; workId: string }
  | { kind: 'list_routines'; workspaceId?: string; channelId?: string }
  | { kind: 'list_admin_routine_page'; input: RoutineAdminPageInput }
  | { kind: 'list_revisions'; routineId: string }
  | { kind: 'control'; input: ControlRoutineInput }
  | { kind: 'create_occurrence'; input: CreateRoutineOccurrenceInput }
  | { kind: 'get_run'; occurrenceId: string }
  | { kind: 'list_runs'; filter: RoutineRunFilter }
  | { kind: 'claim_due_schedules'; input: ClaimDueRoutinesInput }
  | { kind: 'start_admission'; input: StartRoutineAdmissionInput }
  | {
      kind: 'record_admission_receipt';
      occurrenceId: string;
      attempt: number;
      flueRunId: string;
      receiptAt: number;
    }
  | { kind: 'resolve_admission'; input: ResolveRoutineAdmissionInput }
  | { kind: 'begin_occurrence'; input: BeginRoutineOccurrenceInput }
  | { kind: 'prepare_agent_dispatch'; input: PrepareRoutineAgentDispatchInput }
  | { kind: 'record_agent_receipt'; input: RecordRoutineAgentReceiptInput }
  | { kind: 'record_agent_settlement'; input: RecordRoutineAgentSettlementInput }
  | { kind: 'transition_run'; input: TransitionRoutineRunInput }
  | { kind: 'claim_delivery'; input: ClaimRoutineDeliveryInput }
  | { kind: 'record_delivery'; input: RecordRoutineDeliveryInput }
  | { kind: 'get_recovery_delivery'; occurrenceId: string }
  | { kind: 'claim_recovery_delivery'; input: ClaimRoutineRecoveryDeliveryInput }
  | { kind: 'record_recovery_delivery'; input: RecordRoutineRecoveryDeliveryInput }
  | { kind: 'list_admissions'; occurrenceId: string }
  | { kind: 'count_admitting_or_running_occurrences' }
  | { kind: 'list_audit_events'; filter: AuditEventFilter };

export type RoutineRpcResponse =
  | { kind: 'schedule_action'; action: RoutineScheduleAction | null }
  | { kind: 'schedule_action_claim'; claim: ClaimRoutineScheduleActionResult }
  | { kind: 'schedule_actions'; actions: RoutineScheduleAction[] }
  | { kind: 'schedule_action_due_at'; dueAt: number | null }
  | { kind: 'confirmation'; confirmation: RoutineConfirmation | null }
  | { kind: 'routine'; routine: RoutineDefinition | null }
  | { kind: 'routines'; routines: RoutineDefinition[] }
  | { kind: 'admin_routine_page'; page: RoutineAdminPage }
  | { kind: 'revisions'; revisions: RoutineRevision[] }
  | { kind: 'run'; run: RoutineRun | null }
  | { kind: 'runs'; runs: RoutineRun[] }
  | { kind: 'due_claims'; batch: RoutineDueClaimBatch }
  | { kind: 'admission'; admission: RoutineAdmissionAttempt }
  | { kind: 'admissions'; admissions: RoutineAdmissionAttempt[] }
  | { kind: 'begin'; outcome: 'started' | 'superseded' }
  | { kind: 'delivery_claim'; outcome: 'claimed' | 'superseded' }
  | { kind: 'recovery_delivery'; delivery: RoutineRecoveryDelivery | null }
  | { kind: 'recovery_delivery_claim'; outcome: 'claimed' | 'superseded' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'purged'; count: number }
  | { kind: 'count'; count: number }
  | { kind: 'maintenance'; result: RoutineMaintenanceResult }
  | { kind: 'audit_events'; events: AuditEvent[] };
