import type { AuditEvent, AuditEventFilter } from '../audit/types.ts';

export type RoutineState = 'active' | 'paused' | 'disabled';
export type RoutineTriggerKind = 'schedule';
export type RoutineOutputPolicy = 'post' | 'post_on_change';
export type RoutineAuthorityMode = 'live_channel_v1';
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
export type RoutineTriggerSource = 'schedule' | 'run_now';
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
  workspaceId: string;
  channelId: string;
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
  createdAt: number;
}

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
  queuedAt: number;
  admittedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  resolvedAccessHash: string | null;
  resolvedAgentId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costEstimate: number | null;
  costUnit: string | null;
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
  flueRunId: string | null;
  invokeStartedAt: number;
  receiptAt: number | null;
  visibleAt: number | null;
  status: RoutineAdmissionStatus;
  safeError: string | null;
}

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
  traceId?: string;
}

export interface TransitionRoutineRunInput {
  occurrenceId: string;
  from: readonly RoutineRunStatus[];
  to: RoutineRunStatus;
  at: number;
  failureClass?: RoutineFailureClass | null;
  publicError?: string | null;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costEstimate?: number;
  costUnit?: string;
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
  channelId?: string;
  messageTs?: string;
  changeKeyHash?: string | null;
}

export interface RoutineRunFilter {
  routineId?: string;
  statuses?: readonly RoutineRunStatus[];
  limit?: number;
}

export interface RoutineStore {
  putConfirmation(input: PutRoutineConfirmationInput): Promise<RoutineConfirmation>;
  getConfirmation(tokenHash: string): Promise<RoutineConfirmation | undefined>;
  cancelConfirmation(input: CancelRoutineConfirmationInput): Promise<boolean>;
  confirm(input: ConfirmRoutineInput): Promise<RoutineDefinition>;
  purgeConfirmations(): Promise<number>;
  cleanupRetention(): Promise<RoutineMaintenanceResult>;
  getRoutine(routineId: string): Promise<RoutineDefinition | undefined>;
  listRoutines(workspaceId?: string, channelId?: string): Promise<RoutineDefinition[]>;
  listRevisions(routineId: string): Promise<RoutineRevision[]>;
  control(input: ControlRoutineInput): Promise<RoutineDefinition>;
  createOccurrence(input: CreateRoutineOccurrenceInput): Promise<RoutineRun>;
  getRun(occurrenceId: string): Promise<RoutineRun | undefined>;
  listRuns(filter?: RoutineRunFilter): Promise<RoutineRun[]>;
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
  transitionRun(input: TransitionRoutineRunInput): Promise<RoutineRun>;
  claimDelivery(input: ClaimRoutineDeliveryInput): Promise<'claimed' | 'superseded'>;
  recordDelivery(input: RecordRoutineDeliveryInput): Promise<RoutineRun>;
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
  | { kind: 'put_confirmation'; input: PutRoutineConfirmationInput }
  | { kind: 'get_confirmation'; tokenHash: string }
  | { kind: 'cancel_confirmation'; input: CancelRoutineConfirmationInput }
  | { kind: 'confirm'; input: ConfirmRoutineInput }
  | { kind: 'purge_confirmations' }
  | { kind: 'cleanup_retention' }
  | { kind: 'get_routine'; routineId: string }
  | { kind: 'list_routines'; workspaceId?: string; channelId?: string }
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
  | { kind: 'transition_run'; input: TransitionRoutineRunInput }
  | { kind: 'claim_delivery'; input: ClaimRoutineDeliveryInput }
  | { kind: 'record_delivery'; input: RecordRoutineDeliveryInput }
  | { kind: 'list_admissions'; occurrenceId: string }
  | { kind: 'list_audit_events'; filter: AuditEventFilter };

export type RoutineRpcResponse =
  | { kind: 'confirmation'; confirmation: RoutineConfirmation | null }
  | { kind: 'routine'; routine: RoutineDefinition | null }
  | { kind: 'routines'; routines: RoutineDefinition[] }
  | { kind: 'revisions'; revisions: RoutineRevision[] }
  | { kind: 'run'; run: RoutineRun | null }
  | { kind: 'runs'; runs: RoutineRun[] }
  | { kind: 'due_claims'; batch: RoutineDueClaimBatch }
  | { kind: 'admission'; admission: RoutineAdmissionAttempt }
  | { kind: 'admissions'; admissions: RoutineAdmissionAttempt[] }
  | { kind: 'begin'; outcome: 'started' | 'superseded' }
  | { kind: 'delivery_claim'; outcome: 'claimed' | 'superseded' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'purged'; count: number }
  | { kind: 'maintenance'; result: RoutineMaintenanceResult }
  | { kind: 'audit_events'; events: AuditEvent[] };
