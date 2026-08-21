import { AuditStoreLogic } from '../audit/store.ts';
import type { AuditEvent, AuditEventFilter } from '../audit/types.ts';
import { ConfigStoreLogic } from '../config/store.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import { promisify } from '../state/async-facade.ts';
import { openStateDb, resolveStateDbPath } from '../state/node-state-db.ts';
import { installLedgerLinks } from '../state/schema-links.ts';
import type { SqlParam, StateDb } from '../state/state-db.ts';
import {
  hashRoutineValue,
  isOpaqueRoutineId,
  routineAuditId,
  scheduledOccurrenceKey,
} from './ids.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import {
  assertRoutineTaskBoundToPrevious,
  assertRoutineTaskBoundToSource,
  validateRoutineRequestProvenanceInput,
} from './provenance.ts';
import {
  nextRoutineOccurrence,
  normalizeRoutineSchedule,
  parseRoutineSchedule,
  projectRoutineReservationWindows,
} from './schedule.ts';
import {
  RoutineStateError,
  type BeginRoutineOccurrenceInput,
  type CancelRoutineConfirmationInput,
  type ClaimRoutineDeliveryInput,
  type ClaimDueRoutinesInput,
  type ConfirmRoutineInput,
  type ControlRoutineInput,
  type CreateRoutineOccurrenceInput,
  type PutRoutineConfirmationInput,
  type PrepareRoutineAgentDispatchInput,
  type RecordRoutineAgentReceiptInput,
  type RecordRoutineAgentSettlementInput,
  type RecordRoutineDeliveryInput,
  type RoutineAdmissionAttempt,
  type RoutineAdminPage,
  type RoutineAdminPageInput,
  type RoutineAgentUsageV1,
  type RoutineConfirmation,
  type RoutineConfirmationDraft,
  type RoutineDefinition,
  type RoutineDefinitionContent,
  type RoutineDueClaimBatch,
  type RoutineMaintenanceResult,
  type RoutineRevision,
  type RoutineRequestProvenance,
  type RoutineRequestProvenanceInput,
  type RoutineRpcRequest,
  type RoutineRpcResponse,
  type RoutineRun,
  type RoutineRunFilter,
  type RoutineRunStatus,
  type RoutineScheduleReservation,
  type RoutineStore,
  type SaveRoutineInput,
  type ResolveRoutineAdmissionInput,
  type StartRoutineAdmissionInput,
  type TransitionRoutineRunInput,
} from './types.ts';
import {
  validatePublicRoutineError,
  validateRoutineDefinition,
  validateRoutineScope,
} from './validation.ts';
import { opaqueId, safeConfigForAssignment } from '../work/admission.ts';
import { prepareSubmitRun } from '../work/submit-run.ts';
import { WorkStoreLogic } from '../work/store.ts';
import type {
  BindingId,
  SourceVisibility,
  WorkId,
} from '../work/types.ts';

interface RoutineRow {
  id: string;
  work_id?: string | null;
  binding_id?: string | null;
  source_visibility?: SourceVisibility;
  workspace_id: string;
  channel_id: string;
  creator_user_id: string;
  name: string;
  description: string;
  task_text: string;
  trigger_kind: RoutineDefinition['triggerKind'];
  schedule_input: string;
  schedule_json: string;
  timezone: string;
  output_policy: RoutineDefinition['outputPolicy'];
  authority_mode: RoutineDefinition['authorityMode'];
  state: RoutineDefinition['state'];
  version: number;
  next_run_at: number | null;
  last_scheduled_at: number | null;
  last_finished_at: number | null;
  consecutive_failures: number;
  last_change_key_hash: string | null;
  projected_daily_starts: number;
  reservation_windows_json: string;
  created_at: number;
  created_by: string | null;
  updated_at: number;
  updated_by: string | null;
  paused_at: number | null;
  paused_by: string | null;
  paused_reason: string | null;
  disabled_at: number | null;
  disabled_by: string | null;
  disabled_reason: string | null;
  deleted_at: number | null;
  deleted_by: string | null;
}

interface ConfirmationRow {
  id: string;
  token_hash: string;
  actor_id: string;
  actor_class: RoutineConfirmation['actorClass'];
  workspace_id: string;
  channel_id: string;
  draft_json: string;
  base_version: number | null;
  preview_hash: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

interface RevisionRow {
  routine_id: string;
  version: number;
  definition_json: string | null;
  definition_hash: string;
  actor_id: string | null;
  actor_class: RoutineRevision['actorClass'];
  confirmation_id: string | null;
  created_at: number;
  provenance_source_kind?: RoutineRequestProvenance['sourceKind'] | null;
  provenance_request_text?: string | null;
  provenance_request_hash?: string | null;
  provenance_event_id?: string | null;
  provenance_message_ts?: string | null;
  provenance_thread_ts?: string | null;
  provenance_authority_source?: RoutineRequestProvenance['authoritySource'] | null;
  provenance_source_routine_id?: string | null;
  provenance_source_routine_version?: number | null;
  provenance_definition_hash?: string | null;
}

interface RunRow {
  id: string;
  canonical_run_id?: string | null;
  idempotency_key: string;
  routine_id: string;
  routine_version: number;
  scheduled_for: number;
  trigger_source: RoutineRun['triggerSource'];
  requested_by: string | null;
  status: RoutineRunStatus;
  failure_class: RoutineRun['failureClass'];
  public_error: string | null;
  admission_owner: string | null;
  admission_lease_until: number | null;
  flue_run_id: string | null;
  flue_agent_envelope_json: string | null;
  flue_agent_settlement_json: string | null;
  queued_at: number;
  admitted_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  resolved_access_hash: string | null;
  resolved_agent_id: string | null;
  resolved_authority_receipt_id: string | null;
  resolved_runs_as_membership_id: string | null;
  model: string | null;
  provider_auth_route: RoutineRun['providerAuthRoute'];
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_estimate: number | null;
  cost_unit: string | null;
  usage_ledger_operation_id: string | null;
  usage_provenance: 'usage_ledger' | 'legacy_routine';
  usage_completeness: 'complete' | 'partial' | 'not_reported' | null;
  deadline_at: number;
  sandbox_session_id: string | null;
  tool_call_count: number;
  delivery_status: RoutineRun['deliveryStatus'];
  delivery_lease_until: number | null;
  delivery_channel_id: string | null;
  delivery_message_ts: string | null;
  change_key_hash: string | null;
  baseline_change_key_hash: string | null;
  suppressed_as_no_op: number;
  skip_reason: string | null;
  missed_slot_count: number;
  first_missed_at: number | null;
  last_missed_at: number | null;
  trace_id: string | null;
  revision_json: string | null;
  revision_hash: string;
}

interface AdmissionRow {
  occurrence_id: string;
  attempt: number;
  attempt_id: string;
  flue_run_id: string | null;
  flue_agent_receipt_json: string | null;
  invoke_started_at: number;
  receipt_at: number | null;
  visible_at: number | null;
  status: RoutineAdmissionAttempt['status'];
  safe_error: string | null;
}

const TERMINAL_RUN_STATUSES = new Set<RoutineRunStatus>([
  'succeeded',
  'no_op',
  'failed',
  'skipped',
  'cancelled',
  'superseded',
]);
const ATTRIBUTABLE_FAILURES = new Set<RoutineRun['failureClass']>([
  'credential_unavailable',
  'policy_denied',
  'deadline_exceeded',
  'tool_failed',
  'result_invalid',
]);
const ACCESS_FAILURES = new Set<RoutineRun['failureClass']>([
  'creator_ineligible',
  'channel_ineligible',
  'assignment_missing',
  'access_denied',
]);

/** Target-neutral routine state logic used by Node SQLite and TagStateStore. */
export class RoutineStoreLogic {
  private readonly audit: AuditStoreLogic;
  private readonly work: WorkStoreLogic;
  private readonly config: ConfigStoreLogic;

  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    this.audit = new AuditStoreLogic(db);
    this.initializeSchema();
    this.config = new ConfigStoreLogic(db);
    this.work = new WorkStoreLogic(db, { now });
  }

  execute(request: RoutineRpcRequest): RoutineRpcResponse {
    switch (request.kind) {
      case 'put_confirmation':
        return { kind: 'confirmation', confirmation: this.putConfirmation(request.input) };
      case 'get_confirmation':
        return { kind: 'confirmation', confirmation: this.getConfirmation(request.tokenHash) ?? null };
      case 'cancel_confirmation':
        return { kind: 'boolean', value: this.cancelConfirmation(request.input) };
      case 'confirm':
        return { kind: 'routine', routine: this.confirm(request.input) };
      case 'save':
        return { kind: 'routine', routine: this.save(request.input) };
      case 'purge_confirmations':
        return { kind: 'purged', count: this.purgeConfirmations() };
      case 'cleanup_retention':
        return { kind: 'maintenance', result: this.cleanupRetention() };
      case 'get_routine':
        return { kind: 'routine', routine: this.getRoutine(request.routineId) ?? null };
      case 'list_routines':
        return {
          kind: 'routines',
          routines: this.listRoutines(request.workspaceId, request.channelId),
        };
      case 'list_admin_routine_page':
        return { kind: 'admin_routine_page', page: this.listAdminRoutinePage(request.input) };
      case 'list_revisions':
        return { kind: 'revisions', revisions: this.listRevisions(request.routineId) };
      case 'control':
        return { kind: 'routine', routine: this.control(request.input) };
      case 'create_occurrence':
        return { kind: 'run', run: this.createOccurrence(request.input) };
      case 'get_run':
        return { kind: 'run', run: this.getRun(request.occurrenceId) ?? null };
      case 'list_runs':
        return { kind: 'runs', runs: this.listRuns(request.filter) };
      case 'claim_due_schedules':
        return { kind: 'due_claims', batch: this.claimDueSchedules(request.input) };
      case 'start_admission':
        return { kind: 'admission', admission: this.startAdmissionAttempt(request.input) };
      case 'record_admission_receipt':
        return {
          kind: 'admission',
          admission: this.recordAdmissionReceipt(
            request.occurrenceId,
            request.attempt,
            request.flueRunId,
            request.receiptAt,
          ),
        };
      case 'resolve_admission':
        return { kind: 'run', run: this.resolveAdmission(request.input) };
      case 'begin_occurrence':
        return { kind: 'begin', outcome: this.beginOccurrence(request.input) };
      case 'prepare_agent_dispatch':
        return { kind: 'begin', outcome: this.prepareAgentDispatch(request.input) };
      case 'record_agent_receipt':
        return { kind: 'admission', admission: this.recordAgentReceipt(request.input) };
      case 'record_agent_settlement':
        return { kind: 'run', run: this.recordAgentSettlement(request.input) };
      case 'transition_run':
        return { kind: 'run', run: this.transitionRun(request.input) };
      case 'claim_delivery':
        return { kind: 'delivery_claim', outcome: this.claimDelivery(request.input) };
      case 'record_delivery':
        return { kind: 'run', run: this.recordDelivery(request.input) };
      case 'list_admissions':
        return { kind: 'admissions', admissions: this.listAdmissions(request.occurrenceId) };
      case 'count_admitting_or_running_occurrences':
        return { kind: 'count', count: this.countAdmittingOrRunningOccurrences() };
      case 'list_audit_events':
        return { kind: 'audit_events', events: this.listAuditEvents(request.filter) };
    }
  }

  putConfirmation(input: PutRoutineConfirmationInput): RoutineConfirmation {
    validateRoutineScope(input.workspaceId, input.channelId, input.actorId);
    validateConfirmationInput(input);
    const now = this.now();
    if (input.expiresAt <= now || input.expiresAt > now + ROUTINE_LIMITS.confirmationTtlMs) {
      throw routineError('routine_confirmation_invalid', 'Routine confirmation expiry is invalid.');
    }
    const draft = validateDraft(input.draft);
    this.db.run(
      `INSERT INTO routine_confirmations (
        id, token_hash, actor_id, actor_class, workspace_id, channel_id,
        draft_json, base_version, preview_hash, created_at, expires_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      input.confirmationId,
      input.tokenHash,
      input.actorId,
      input.actorClass,
      input.workspaceId,
      input.channelId,
      JSON.stringify(draft),
      draft.action === 'create' ? null : draft.expectedVersion,
      input.previewHash,
      now,
      input.expiresAt,
    );
    return required(this.getConfirmation(input.tokenHash), 'Routine confirmation was not readable.');
  }

  getConfirmation(tokenHash: string): RoutineConfirmation | undefined {
    const row = this.db.get(
      'SELECT * FROM routine_confirmations WHERE token_hash = ?',
      tokenHash,
    );
    return row ? rowToConfirmation(row as unknown as ConfirmationRow) : undefined;
  }

  cancelConfirmation(input: CancelRoutineConfirmationInput): boolean {
    validateRoutineScope(input.workspaceId, input.channelId, input.actorId);
    if (!/^[a-f0-9]{64}$/.test(input.tokenHash) || !Number.isSafeInteger(input.at)) {
      throw routineError('routine_confirmation_invalid', 'Routine confirmation is invalid.');
    }
    return this.db.transaction(() => {
      const confirmation = this.getConfirmation(input.tokenHash);
      if (
        !confirmation ||
        confirmation.actorId !== input.actorId ||
        confirmation.workspaceId !== input.workspaceId ||
        confirmation.channelId !== input.channelId ||
        confirmation.consumedAt !== null ||
        confirmation.expiresAt < input.at
      ) {
        return false;
      }
      this.db.run(
        'UPDATE routine_confirmations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
        input.at,
        confirmation.id,
      );
      return true;
    });
  }

  save(input: SaveRoutineInput): RoutineDefinition {
    validateRoutineScope(input.workspaceId, input.channelId, input.actorId);
    assertIdempotencyKey(input.idempotencyKey);
    if (!['member', 'operator', 'system'].includes(input.actorClass)) {
      throw routineError('routine_save_invalid', 'Routine save is invalid.');
    }
    if (
      input.sourceVisibility !== undefined &&
      !['public', 'private', 'unknown'].includes(input.sourceVisibility)
    ) {
      throw routineError('routine_save_invalid', 'Routine source visibility is invalid.');
    }
    const draft = validateDraft(input.draft);
    if (draft.action === 'delete') {
      throw routineError('routine_confirmation_required', 'Routine deletion requires confirmation.');
    }
    return this.db.transaction(() => {
      const replay = this.audit.findByIdempotencyKey(input.idempotencyKey);
      if (replay?.subjectId) {
        return required(this.getRoutine(replay.subjectId), 'Saved routine replay was unavailable.');
      }
      return this.applySavedDraft(draft, input, null, this.now());
    });
  }

  confirm(input: ConfirmRoutineInput): RoutineDefinition {
    validateRoutineScope(input.workspaceId, input.channelId, input.actorId);
    assertIdempotencyKey(input.idempotencyKey);
    return this.db.transaction(() => {
      const confirmation = this.getConfirmation(input.tokenHash);
      if (!confirmation) throw confirmationError();
      if (
        confirmation.actorId !== input.actorId ||
        confirmation.workspaceId !== input.workspaceId ||
        confirmation.channelId !== input.channelId ||
        confirmation.previewHash !== input.previewHash
      ) {
        throw confirmationError();
      }
      const replay = this.audit.findByIdempotencyKey(input.idempotencyKey);
      if (replay?.subjectId) {
        return required(this.getRoutine(replay.subjectId), 'Confirmed routine replay was unavailable.');
      }
      if (confirmation.consumedAt !== null) {
        throw routineError('routine_confirmation_consumed', 'Routine confirmation was already used.');
      }
      if (confirmation.expiresAt < this.now()) {
        throw routineError('routine_confirmation_expired', 'Routine confirmation expired.');
      }
      const at = this.now();
      const draft = confirmation.draft;
      let routine: RoutineDefinition;
      if (draft.action !== 'delete') {
        routine = this.applySavedDraft(
          draft,
          {
            actorId: input.actorId,
            actorClass: confirmation.actorClass,
            workspaceId: input.workspaceId,
            channelId: input.channelId,
            idempotencyKey: input.idempotencyKey,
          },
          confirmation.id,
          at,
        );
      } else {
        const current = this.requiredMutableRoutine(draft.routineId, draft.expectedVersion);
        if (current.workspaceId !== input.workspaceId || current.channelId !== input.channelId) {
          throw confirmationError();
        }
        const nextVersion = current.version + 1;
        const beforeHash = definitionHash(current);
        this.db.run(
          `UPDATE routines SET name = '', description = '', task_text = '', schedule_input = '',
             schedule_json = '{}', timezone = '', reservation_windows_json = '[]',
             next_run_at = NULL, projected_daily_starts = 0, version = ?, updated_at = ?,
             updated_by = ?, deleted_at = ?, deleted_by = ? WHERE id = ?`,
          nextVersion,
          at,
          input.actorId,
          at,
          input.actorId,
          current.id,
        );
        this.db.run('DELETE FROM routine_schedule_reservations WHERE routine_id = ?', current.id);
        this.db.run(
          `UPDATE routine_revisions SET definition_json = NULL WHERE routine_id = ?`,
          current.id,
        );
        this.db.run(
          `UPDATE routine_request_provenance SET request_text = NULL WHERE routine_id = ?`,
          current.id,
        );
        this.db.run(`UPDATE routine_runs SET revision_json = NULL WHERE routine_id = ?`, current.id);
        this.db.run(
          `DELETE FROM routine_confirmations
           WHERE json_extract(draft_json, '$.routineId') = ? AND id <> ?`,
          current.id,
          confirmation.id,
        );
        this.db.run(
          `UPDATE routine_confirmations SET draft_json = ? WHERE id = ?`,
          JSON.stringify({ action: 'delete', routineId: current.id, expectedVersion: current.version }),
          confirmation.id,
        );
        this.insertRevision(
          current.id,
          nextVersion,
          null,
          input.actorId,
          confirmation.actorClass,
          confirmation.id,
          at,
          beforeHash,
        );
        routine = required(this.getRoutine(current.id), 'Routine tombstone was not readable.');
        this.appendRoutineAudit(
          input.idempotencyKey,
          'routine.deleted',
          routine,
          input.actorId,
          confirmation.actorClass,
          beforeHash,
          null,
          at,
        );
      }
      this.db.run(
        'UPDATE routine_confirmations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
        at,
        confirmation.id,
      );
      return routine;
    });
  }

  private applySavedDraft(
    draft: Exclude<RoutineConfirmationDraft, { action: 'delete' }>,
    input: Pick<
      SaveRoutineInput,
      | 'actorId'
      | 'actorClass'
      | 'workspaceId'
      | 'channelId'
      | 'idempotencyKey'
      | 'provenance'
      | 'sourceVisibility'
    >,
    confirmationId: string | null,
    at: number,
  ): RoutineDefinition {
    if (draft.action === 'create') {
      if (this.getRoutine(draft.routineId)) {
        throw routineError('routine_exists', 'Routine already exists.');
      }
      this.assertCapacity(
        input.workspaceId,
        input.channelId,
        draft.definition.triggerKind,
        draft.projectedDailyStarts,
        draft.reservations,
      );
      const definition = validateRoutineDefinition(draft.definition);
      this.insertRoutine({
        id: draft.routineId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        creatorUserId: input.actorId,
        definition,
        nextRunAt: draft.nextRunAt,
        projectedDailyStarts: draft.projectedDailyStarts,
        reservations: draft.reservations,
        actorId: input.actorId,
        at,
        sourceVisibility: input.sourceVisibility ?? 'unknown',
      });
      this.ensureRoutineWorkBinding(
        draft.routineId,
        input.workspaceId,
        input.channelId,
        input.sourceVisibility ?? 'unknown',
        at,
      );
      this.replaceReservations(draft.routineId, draft.reservations);
      this.insertRevision(
        draft.routineId,
        1,
        definition,
        input.actorId,
        input.actorClass,
        confirmationId,
        at,
      );
      this.insertRequestProvenance(
        draft.routineId,
        1,
        definition,
        input.provenance ?? null,
        null,
      );
      const routine = required(this.getRoutine(draft.routineId), 'Routine was not readable after create.');
      this.appendRoutineAudit(
        input.idempotencyKey,
        'routine.created',
        routine,
        input.actorId,
        input.actorClass,
        null,
        definitionHash(definition),
        at,
      );
      return routine;
    }

    const current = this.requiredMutableRoutine(draft.routineId, draft.expectedVersion);
    if (current.workspaceId !== input.workspaceId || current.channelId !== input.channelId) {
      throw routineError('routine_not_found', 'Routine was not found.');
    }
    if (
      current.triggerKind === 'once' &&
      Number(
        this.db.get(
          `SELECT COUNT(*) AS count FROM routine_runs
           WHERE routine_id = ? AND status IN ('queued', 'admitting', 'running')`,
          current.id,
        )?.count ?? 0,
      ) > 0
    ) {
      throw routineError(
        'routine_run_conflict',
        'Wait for the active one-time occurrence to finish before editing it.',
      );
    }
    const definition = validateRoutineDefinition(draft.definition);
    if (current.state === 'active' || current.state === 'completed') {
      this.assertCapacity(
        current.workspaceId,
        current.channelId,
        draft.definition.triggerKind,
        draft.projectedDailyStarts,
        draft.reservations,
        current.id,
      );
    }
    const nextVersion = current.version + 1;
    const nextState = current.state === 'completed' ? 'active' : current.state;
    this.db.run(
      `UPDATE routines SET name = ?, description = ?, task_text = ?, trigger_kind = ?,
         schedule_input = ?, schedule_json = ?, timezone = ?, output_policy = ?,
         authority_mode = ?, state = ?, version = ?, next_run_at = ?, projected_daily_starts = ?,
         reservation_windows_json = ?, updated_at = ?, updated_by = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      definition.name,
      definition.description,
      definition.taskText,
      definition.triggerKind,
      definition.scheduleInput,
      definition.scheduleJson,
      definition.timezone,
      definition.outputPolicy,
      definition.authorityMode,
      nextState,
      nextVersion,
      draft.nextRunAt,
      draft.projectedDailyStarts,
      JSON.stringify(draft.reservations),
      at,
      input.actorId,
      current.id,
      current.version,
    );
    if (nextState === 'active') this.replaceReservations(current.id, draft.reservations);
    this.insertRevision(
      current.id,
      nextVersion,
      definition,
      input.actorId,
      input.actorClass,
      confirmationId,
      at,
    );
    this.insertRequestProvenance(
      current.id,
      nextVersion,
      definition,
      input.provenance ?? null,
      current,
    );
    const routine = required(this.getRoutine(current.id), 'Routine was not readable after edit.');
    this.appendRoutineAudit(
      input.idempotencyKey,
      'routine.edited',
      routine,
      input.actorId,
      input.actorClass,
      definitionHash(current),
      definitionHash(definition),
      at,
    );
    return routine;
  }

  purgeConfirmations(): number {
    const cutoff = this.now() - ROUTINE_LIMITS.confirmationPurgeDelayMs;
    return this.db.run(
      `DELETE FROM routine_confirmations
       WHERE (consumed_at IS NOT NULL AND consumed_at < ?) OR expires_at < ?`,
      cutoff,
      cutoff,
    ).changes;
  }

  cleanupRetention(): RoutineMaintenanceResult {
    const at = this.now();
    const retentionCutoff = at - ROUTINE_LIMITS.metadataRetentionMs;
    const confirmationsPurged = this.purgeConfirmations();
    const reservationsPurged = this.db.run(
      'DELETE FROM routine_schedule_reservations WHERE window_start < ?',
      at - 15 * 60 * 1_000,
    ).changes;

    let deliveryLeasesReconciled = 0;
    const staleDeliveries = this.db.all(
      `SELECT id FROM routine_runs
       WHERE delivery_status = 'leased' AND delivery_lease_until IS NOT NULL
         AND delivery_lease_until <= ?`,
      at,
    );
    for (const row of staleDeliveries) {
      const occurrenceId = String(row.id);
      const run = this.getRun(occurrenceId);
      if (!run) continue;
      this.recordDelivery({ occurrenceId, outcome: 'unknown', at });
      if (run.status === 'running') {
        this.transitionRun({
          occurrenceId,
          from: ['running'],
          to: 'failed',
          at,
          failureClass: 'delivery_unknown',
          publicError: 'The Slack delivery lease expired with an unknown outcome; Chickpea did not retry it.',
        });
      } else {
        this.pauseRoutineForUnknownOutcome(run, 'delivery_unknown', at);
      }
      deliveryLeasesReconciled += 1;
    }

    let deadlineRunsReconciled = 0;
    const expiredRuns = this.db.all(
      `SELECT id, status FROM routine_runs
       WHERE (
         status = 'queued' AND deadline_at < ?
       ) OR (
         status = 'admitting' AND deadline_at + ? < ?
           AND (admission_lease_until IS NULL OR admission_lease_until <= ?)
       ) OR (
         status = 'running' AND deadline_at + ? < ?
       )
       ORDER BY deadline_at, id`,
      at,
      ROUTINE_LIMITS.admissionGraceMs,
      at,
      at,
      ROUTINE_LIMITS.deliveryLeaseMs,
      at,
    );
    for (const row of expiredRuns) {
      const occurrenceId = String(row.id);
      const status = String(row.status) as RoutineRunStatus;
      const current = this.getRun(occurrenceId);
      if (!current || current.status !== status) continue;
      if (status === 'queued') {
        this.transitionRun({
          occurrenceId,
          from: ['queued'],
          to: 'skipped',
          at,
          failureClass: 'capacity_limited',
          publicError: 'Routine admission expired before execution began.',
        });
      } else if (status === 'admitting') {
        this.transitionRun({
          occurrenceId,
          from: ['admitting'],
          to: 'failed',
          at,
          failureClass: 'admission_unknown',
          publicError: 'Routine admission did not reach a safely reconcilable state.',
        });
      } else if (status === 'running') {
        this.transitionRun({
          occurrenceId,
          from: ['running'],
          to: 'failed',
          at,
          failureClass: 'unknown_external_outcome',
          publicError: 'The routine exceeded its deadline and may require external-result inspection.',
        });
      }
      deadlineRunsReconciled += 1;
    }

    this.db.run(
      `DELETE FROM routine_run_admissions
       WHERE occurrence_id IN (
         SELECT id FROM routine_runs
         WHERE status IN ('succeeded', 'no_op', 'failed', 'skipped', 'cancelled', 'superseded')
           AND finished_at IS NOT NULL AND finished_at < ?
       )`,
      retentionCutoff,
    );
    const runsDeleted = this.db.run(
      `DELETE FROM routine_runs
       WHERE status IN ('succeeded', 'no_op', 'failed', 'skipped', 'cancelled', 'superseded')
         AND finished_at IS NOT NULL AND finished_at < ?`,
      retentionCutoff,
    ).changes;
    const auditEventsDeleted = this.audit.deleteBefore('scheduled_work', retentionCutoff);
    return {
      confirmationsPurged,
      reservationsPurged,
      deliveryLeasesReconciled,
      deadlineRunsReconciled,
      runsDeleted,
      auditEventsDeleted,
    };
  }

  getRoutine(routineId: string): RoutineDefinition | undefined {
    const row = this.db.get('SELECT * FROM routines WHERE id = ?', routineId);
    return row ? rowToRoutine(row as unknown as RoutineRow) : undefined;
  }

  listRoutines(workspaceId?: string, channelId?: string): RoutineDefinition[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (workspaceId) {
      clauses.push('workspace_id = ?');
      params.push(workspaceId);
    }
    if (channelId) {
      clauses.push('channel_id = ?');
      params.push(channelId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .all(`SELECT * FROM routines ${where} ORDER BY created_at, id`, ...params)
      .map((row) => rowToRoutine(row as unknown as RoutineRow));
  }

  listAdminRoutinePage(input: RoutineAdminPageInput): RoutineAdminPage {
    validateAdminPageInput(input);
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (input.workspaceId) {
      clauses.push('workspace_id = ?');
      params.push(input.workspaceId);
    }
    if (input.channelId) {
      clauses.push('channel_id = ?');
      params.push(input.channelId);
    }
    if (input.state === 'deleted') {
      clauses.push('deleted_at IS NOT NULL');
    } else if (input.state === 'current') {
      clauses.push("deleted_at IS NULL AND state IN ('active', 'paused')");
    } else if (input.state === 'all') {
      clauses.push('deleted_at IS NULL');
    } else if (input.state) {
      clauses.push('deleted_at IS NULL AND state = ?');
      params.push(input.state);
    }
    if (input.runStatus) {
      clauses.push(
        `EXISTS (
          SELECT 1 FROM routine_runs
          WHERE routine_runs.routine_id = routines.id AND routine_runs.status = ?
        )`,
      );
      params.push(input.runStatus);
    }
    const cursor = input.cursor ?? 0;
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.all(
      `SELECT * FROM routines ${where}
       ORDER BY
         CASE
           WHEN deleted_at IS NOT NULL THEN 4
           WHEN state = 'active' THEN 0
           WHEN state = 'paused' THEN 1
           WHEN state = 'completed' THEN 2
           ELSE 3
         END,
         CASE WHEN state = 'active' AND next_run_at IS NULL THEN 1 ELSE 0 END,
         CASE WHEN state = 'active' THEN next_run_at END,
         CASE WHEN state <> 'active' THEN updated_at END DESC,
         id
       LIMIT ? OFFSET ?`,
      ...params,
      input.limit + 1,
      cursor,
    );
    const hasNext = rows.length > input.limit;
    return {
      routines: rows.slice(0, input.limit).map((row) => rowToRoutine(row as unknown as RoutineRow)),
      nextCursor: hasNext ? cursor + input.limit : null,
    };
  }

  listRevisions(routineId: string): RoutineRevision[] {
    return this.db
      .all(
        `SELECT r.*,
                p.source_kind AS provenance_source_kind,
                p.request_text AS provenance_request_text,
                p.request_hash AS provenance_request_hash,
                p.event_id AS provenance_event_id,
                p.message_ts AS provenance_message_ts,
                p.thread_ts AS provenance_thread_ts,
                p.authority_source AS provenance_authority_source,
                p.source_routine_id AS provenance_source_routine_id,
                p.source_routine_version AS provenance_source_routine_version,
                p.definition_hash AS provenance_definition_hash
         FROM routine_revisions r
         LEFT JOIN routine_request_provenance p
           ON p.routine_id = r.routine_id AND p.version = r.version
         WHERE r.routine_id = ? ORDER BY r.version`,
        routineId,
      )
      .map((row) => rowToRevision(row as unknown as RevisionRow));
  }

  control(input: ControlRoutineInput): RoutineDefinition {
    if (!isOpaqueRoutineId(input.routineId) || !isOpaqueRoutineId(input.actorId)) {
      throw routineError('routine_control_invalid', 'Routine control is invalid.');
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw routineError('routine_control_invalid', 'Routine control is invalid.');
    }
    assertIdempotencyKey(input.idempotencyKey);
    return this.db.transaction(() => {
      const replay = this.audit.findByIdempotencyKey(input.idempotencyKey);
      if (replay?.subjectId) {
        return required(this.getRoutine(replay.subjectId), 'Routine control replay was unavailable.');
      }
      const routine = this.requiredMutableRoutine(input.routineId, input.expectedVersion);
      const target = targetState(input.action);
      if (routine.state === target) return routine;
      if (
        (input.action === 'pause' && routine.state !== 'active') ||
        (input.action === 'disable' && (routine.state === 'disabled' || routine.state === 'completed')) ||
        (input.action === 'resume' && routine.state === 'active')
      ) {
        throw routineError('routine_transition_invalid', 'Routine state transition is invalid.');
      }
      const at = this.now();
      let nextRunAt = routine.nextRunAt;
      let projectedDailyStarts = routine.projectedDailyStarts;
      let reservationWindows = routine.reservationWindows;
      if (input.action === 'resume') {
        const schedule = parseRoutineSchedule(routine.scheduleJson);
        if (schedule.kind === 'once') {
          if (schedule.at <= at) {
            throw routineError(
              'routine_one_time_elapsed',
              'That one-time schedule has passed. Edit it to a new future time.',
            );
          }
          nextRunAt = schedule.at;
          projectedDailyStarts = 0;
          reservationWindows = [{ windowStart: schedule.at, count: 1 }];
        } else {
          const projection = normalizeRoutineSchedule(schedule.expression, routine.timezone, at);
          nextRunAt = projection.nextRunAt;
          projectedDailyStarts = projection.projectedDailyStarts;
          reservationWindows = projection.reservations;
        }
        this.assertCapacity(
          routine.workspaceId,
          routine.channelId,
          routine.triggerKind,
          projectedDailyStarts,
          reservationWindows,
          routine.id,
        );
        this.replaceReservations(routine.id, reservationWindows);
      } else {
        this.db.run('DELETE FROM routine_schedule_reservations WHERE routine_id = ?', routine.id);
      }
      const nextVersion = routine.version + 1;
      this.db.run(
        `UPDATE routines SET state = ?, version = ?, updated_at = ?, updated_by = ?,
           paused_at = ?, paused_by = ?, paused_reason = ?, disabled_at = ?,
           disabled_by = ?, disabled_reason = ?,
           consecutive_failures = CASE WHEN ? THEN 0 ELSE consecutive_failures END,
           next_run_at = ?, projected_daily_starts = ?, reservation_windows_json = ?
         WHERE id = ? AND version = ?`,
        target,
        nextVersion,
        at,
        input.actorId,
        target === 'paused' ? at : null,
        target === 'paused' ? input.actorId : null,
        target === 'paused' ? (input.reasonCode ?? 'member_pause') : null,
        target === 'disabled' ? at : null,
        target === 'disabled' ? input.actorId : null,
        target === 'disabled' ? (input.reasonCode ?? 'member_disable') : null,
        input.action === 'resume' ? 1 : 0,
        nextRunAt,
        projectedDailyStarts,
        JSON.stringify(reservationWindows),
        routine.id,
        routine.version,
      );
      this.insertRevision(
        routine.id,
        nextVersion,
        definitionContent(routine),
        input.actorId,
        input.actorClass,
        null,
        at,
      );
      this.copyRequestProvenance(routine.id, routine.version, nextVersion, definitionContent(routine));
      if (input.action === 'pause' || input.action === 'disable') {
        this.cancelQueuedScheduledOccurrences(routine.id, input.action, at);
      }
      const updated = required(this.getRoutine(routine.id), 'Routine was not readable after control.');
      this.appendRoutineAudit(
        input.idempotencyKey,
        `routine.${input.action}`,
        updated,
        input.actorId,
        input.actorClass,
        definitionHash(routine),
        definitionHash(updated),
        at,
        input.reasonCode,
      );
      return updated;
    });
  }

  createOccurrence(input: CreateRoutineOccurrenceInput): RoutineRun {
    validateOccurrenceInput(input);
    return this.db.transaction(() => this.insertOccurrence(input));
  }

  private insertOccurrence(input: CreateRoutineOccurrenceInput): RoutineRun {
      const replay = this.runByIdempotencyKey(input.idempotencyKey);
      if (replay) return replay;
      const routine = this.requiredMutableRoutine(input.routineId, input.routineVersion);
      if (
        ((input.triggerSource === 'schedule' || input.triggerSource === 'once') && routine.state !== 'active') ||
        (input.triggerSource === 'schedule' && routine.triggerKind !== 'schedule') ||
        (input.triggerSource === 'once' && routine.triggerKind !== 'once') ||
        (input.triggerSource === 'run_now' && (routine.state === 'disabled' || routine.state === 'completed' || routine.triggerKind === 'once'))
      ) {
        throw routineError('routine_state_ineligible', 'Routine cannot create this occurrence.');
      }
      const revision = this.getRevision(routine.id, input.routineVersion);
      if (!revision?.definition) {
        throw routineError('routine_revision_not_found', 'Routine revision is unavailable.');
      }
      const status: RoutineRunStatus = input.skipReason ? 'skipped' : 'queued';
      if (status === 'queued') this.assertOccurrenceCapacity(input);
      const finishedAt = status === 'skipped' ? input.queuedAt : null;
      try {
        this.db.run(
          `INSERT INTO routine_runs (
            id, idempotency_key, routine_id, routine_version, scheduled_for,
            trigger_source, requested_by, status, failure_class, public_error,
            admission_owner, admission_lease_until, flue_run_id, queued_at,
            admitted_at, started_at, finished_at, resolved_access_hash,
            resolved_agent_id, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost_estimate, cost_unit,
            deadline_at, sandbox_session_id, tool_call_count, delivery_status,
            delivery_lease_until, delivery_channel_id, delivery_message_ts,
            change_key_hash, baseline_change_key_hash, suppressed_as_no_op,
            skip_reason, missed_slot_count, first_missed_at, last_missed_at,
            trace_id, revision_json, revision_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?,
                    NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                    NULL, NULL, ?, NULL, 0, 'none', NULL, NULL, NULL, NULL,
                    ?, 0, ?, ?, ?, ?, NULL, ?, ?)`,
          input.runId,
          input.idempotencyKey,
          input.routineId,
          input.routineVersion,
          input.scheduledFor,
          input.triggerSource,
          input.requestedBy ?? null,
          status,
          input.queuedAt,
          finishedAt,
          input.deadlineAt,
          routine.lastChangeKeyHash,
          input.skipReason ?? null,
          input.missedSlotCount ?? 0,
          input.firstMissedAt ?? null,
          input.lastMissedAt ?? null,
          JSON.stringify(revision.definition),
          revision.definitionHash,
        );
      } catch (error) {
        const afterConflict = this.runByIdempotencyKey(input.idempotencyKey);
        if (afterConflict) return afterConflict;
        if (isConstraintViolation(error)) {
          throw routineError('routine_run_conflict', 'Routine already has an active occurrence.');
        }
        throw error;
      }
      const run = required(this.getRun(input.runId), 'Routine occurrence was not readable.');
      this.appendRunAudit('routine.occurrence_created', run, input.idempotencyKey, input.queuedAt);
      this.tryAdmitCanonicalOccurrence(run, routine);
      return required(this.getRun(input.runId), 'Routine occurrence was not readable after linking.');
  }

  getRun(occurrenceId: string): RoutineRun | undefined {
    const row = this.db.get(
      `${this.routineRunProjection()} WHERE rr.id = ?`,
      occurrenceId,
    );
    return row ? rowToRun(row as unknown as RunRow) : undefined;
  }

  listRuns(filter: RoutineRunFilter = {}): RoutineRun[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filter.routineId) {
      clauses.push('routine_id = ?');
      params.push(filter.routineId);
    }
    if (filter.statuses?.length) {
      clauses.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .all(
        `${this.routineRunProjection()} ${where}
         ORDER BY scheduled_for DESC, id DESC LIMIT ?`,
        ...params,
        limit,
      )
      .map((row) => rowToRun(row as unknown as RunRow));
  }

  countAdmittingOrRunningOccurrences(): number {
    return Number(
      this.db.get(
        "SELECT COUNT(*) AS count FROM routine_runs WHERE status IN ('admitting', 'running')",
      )?.count ?? 0,
    );
  }

  claimDueSchedules(input: ClaimDueRoutinesInput): RoutineDueClaimBatch {
    validateDueClaimInput(input);
    return this.db.transaction(() => {
      const rows = this.db.all(
        `SELECT * FROM routines
         WHERE state = 'active' AND deleted_at IS NULL AND next_run_at <= ?
         ORDER BY next_run_at, id LIMIT ?`,
        input.now,
        Math.min(input.limit, ROUTINE_LIMITS.dueClaimsPerHeartbeat),
      );
      const runs: RoutineRun[] = [];
      let deferredCount = 0;
      let activeCount = Number(
        this.db.get(
          `SELECT COUNT(*) AS count FROM routine_runs
           WHERE status IN ('queued', 'admitting', 'running')`,
        )?.count ?? 0,
      );
      for (const row of rows) {
        const routine = rowToRoutine(row as unknown as RoutineRow);
        const due = this.dueSlots(routine, input.now);
        if (!due) continue;
        const activeForRoutine = Number(
          this.db.get(
            `SELECT COUNT(*) AS count FROM routine_runs
             WHERE routine_id = ? AND status IN ('queued', 'admitting', 'running')`,
            routine.id,
          )?.count ?? 0,
        ) > 0;
        const age = input.now - due.latest;
        let skipReason: string | undefined;
        if (due.count > 1) skipReason = 'missed_schedule';
        else if (activeForRoutine) skipReason = 'overlap';
        else if (age > ROUTINE_LIMITS.admissionGraceMs) {
          skipReason = routine.triggerKind === 'once' ? 'missed_one_time' : 'admission_grace_expired';
        }
        else if (activeCount >= ROUTINE_LIMITS.concurrentDeploymentRuns) {
          deferredCount += 1;
          continue;
        }
        const slotKey = scheduledOccurrenceKey(routine.id, due.latest);
        let run: RoutineRun;
        try {
          run = this.insertOccurrence({
            runId: `rrun_${slotKey.slice(0, 32)}`,
            idempotencyKey: `routine:slot:${slotKey}`,
            routineId: routine.id,
            routineVersion: routine.version,
            scheduledFor: due.latest,
            triggerSource: routine.triggerKind === 'once' ? 'once' : 'schedule',
            queuedAt: input.now,
            deadlineAt: due.latest + ROUTINE_LIMITS.admissionGraceMs,
            ...(skipReason ? { skipReason } : {}),
            ...(due.count > 1
              ? {
                  missedSlotCount: due.count,
                  firstMissedAt: due.first,
                  lastMissedAt: due.latest,
                }
              : {}),
          });
        } catch (error) {
          if (isOccurrenceCapacityError(error)) {
            deferredCount += 1;
            continue;
          }
          throw error;
        }
        const oneTime = routine.triggerKind === 'once';
        const reservationWindows = oneTime
          ? []
          : projectRoutineReservationWindows(routine.scheduleJson, routine.timezone, due.latest);
        this.db.run(
          `UPDATE routines SET next_run_at = ?, last_scheduled_at = ?,
             reservation_windows_json = ? WHERE id = ? AND version = ?`,
          due.next,
          due.latest,
          JSON.stringify(reservationWindows),
          routine.id,
          routine.version,
        );
        this.replaceReservations(routine.id, reservationWindows);
        if (oneTime && run.status === 'skipped') {
          this.completeOneTimeRoutine(run, input.now, 'skipped');
        }
        runs.push(run);
        if (!skipReason) activeCount += 1;
      }
      return { runs, scannedCount: rows.length, deferredCount };
    });
  }

  startAdmissionAttempt(input: StartRoutineAdmissionInput): RoutineAdmissionAttempt {
    if (
      !isOpaqueRoutineId(input.occurrenceId) ||
      typeof input.owner !== 'string' ||
      input.owner.length < 1 ||
      input.owner.length > 200 ||
      !Number.isSafeInteger(input.leaseUntil) ||
      !Number.isSafeInteger(input.invokeStartedAt)
    ) {
      throw routineError('routine_admission_invalid', 'Routine admission is invalid.');
    }
    return this.db.transaction(() => {
      const run = required(this.getRun(input.occurrenceId), 'Routine occurrence was not found.');
      if (run.status !== 'queued' && run.status !== 'admitting') {
        throw routineError('routine_run_transition_invalid', 'Routine occurrence cannot be admitted.');
      }
      if (
        run.status === 'admitting' &&
        (run.flueRunId !== null || (run.admissionLeaseUntil ?? 0) > input.invokeStartedAt)
      ) {
        throw routineError('routine_admission_leased', 'Routine admission is already in progress.');
      }
      const row = this.db.get(
        `SELECT COALESCE(MAX(attempt), 0) AS attempt
         FROM routine_run_admissions WHERE occurrence_id = ?`,
        input.occurrenceId,
      );
      const attempt = Number(row?.attempt ?? 0) + 1;
      this.db.run(
        `UPDATE routine_runs SET status = 'admitting', admission_owner = ?,
           admission_lease_until = ? WHERE id = ?`,
        input.owner,
        input.leaseUntil,
        input.occurrenceId,
      );
      this.db.run(
        `INSERT INTO routine_run_admissions (
          occurrence_id, attempt, attempt_id, flue_run_id, flue_agent_receipt_json,
          invoke_started_at, receipt_at, visible_at, status, safe_error
        ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, 'attempting', NULL)`,
        input.occurrenceId,
        attempt,
        routineAttemptId(input.occurrenceId, attempt),
        input.invokeStartedAt,
      );
      return required(this.getAdmission(input.occurrenceId, attempt), 'Routine admission attempt was not readable.');
    });
  }

  recordAdmissionReceipt(
    occurrenceId: string,
    attempt: number,
    flueRunId: string,
    receiptAt: number,
  ): RoutineAdmissionAttempt {
    if (
      !isOpaqueRoutineId(occurrenceId) ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      !isOpaqueRoutineId(flueRunId) ||
      !Number.isSafeInteger(receiptAt)
    ) {
      throw routineError('routine_admission_invalid', 'Routine admission is invalid.');
    }
    return this.db.transaction(() => {
      const admission = required(this.getAdmission(occurrenceId, attempt), 'Routine admission attempt was not found.');
      if (admission.flueRunId && admission.flueRunId !== flueRunId) {
        throw routineError('routine_admission_conflict', 'Routine admission receipt conflicts.');
      }
      try {
        this.db.run(
          `UPDATE routine_run_admissions SET flue_run_id = ?, receipt_at = ?,
             visible_at = ?, status = 'attached' WHERE occurrence_id = ? AND attempt = ?`,
          flueRunId,
          receiptAt,
          receiptAt,
          occurrenceId,
          attempt,
        );
        this.db.run(
          `UPDATE routine_runs SET flue_run_id = COALESCE(flue_run_id, ?), admitted_at = ?
           WHERE id = ?`,
          flueRunId,
          receiptAt,
          occurrenceId,
        );
      } catch (error) {
        if (isConstraintViolation(error)) {
          throw routineError('routine_flue_run_conflict', 'Flue run is already linked.');
        }
        throw error;
      }
      return required(this.getAdmission(occurrenceId, attempt), 'Routine admission receipt was not readable.');
    });
  }

  resolveAdmission(input: ResolveRoutineAdmissionInput): RoutineRun {
    if (
      !isOpaqueRoutineId(input.occurrenceId) ||
      !Number.isSafeInteger(input.at) ||
      !Number.isSafeInteger(input.attempt) ||
      input.attempt < 1 ||
      !['absent', 'unknown'].includes(input.outcome)
    ) {
      throw routineError('routine_admission_invalid', 'Routine admission is invalid.');
    }
    const safeError = validatePublicRoutineError(input.safeError);
    return this.db.transaction(() => {
      const admission = required(
        this.getAdmission(input.occurrenceId, input.attempt),
        'Routine admission attempt was not found.',
      );
      const run = required(this.getRun(input.occurrenceId), 'Routine occurrence was not found.');
      if (admission.status !== 'attempting' || run.status !== 'admitting') {
        throw routineError('routine_admission_conflict', 'Routine admission already resolved.');
      }
      this.db.run(
        `UPDATE routine_run_admissions SET status = ?, visible_at = ?, safe_error = ?
         WHERE occurrence_id = ? AND attempt = ? AND status = 'attempting'`,
        input.outcome === 'absent' ? 'failed' : 'unknown',
        input.at,
        safeError,
        input.occurrenceId,
        input.attempt,
      );
      if (input.outcome === 'absent') {
        this.db.run(
          `UPDATE routine_runs SET status = 'queued', admission_owner = NULL,
             admission_lease_until = NULL WHERE id = ? AND status = 'admitting'`,
          input.occurrenceId,
        );
      } else {
        this.db.run(
          `UPDATE routine_runs SET status = 'failed', failure_class = 'admission_unknown',
             public_error = ?, finished_at = ?, admission_owner = NULL,
             admission_lease_until = NULL WHERE id = ? AND status = 'admitting'`,
          safeError,
          input.at,
          input.occurrenceId,
        );
        this.applyRoutineOutcome(run, 'failed', 'admission_unknown', input.at);
      }
      const updated = required(this.getRun(input.occurrenceId), 'Routine occurrence was not readable.');
      this.appendRunAudit(
        input.outcome === 'absent'
          ? 'routine.admission_absent'
          : 'routine.occurrence_failed',
        updated,
        `routine:admission:${input.occurrenceId}:${input.attempt}:${input.outcome}`,
        input.at,
        input.outcome === 'unknown' ? 'admission_unknown' : 'proven_absence',
      );
      return updated;
    });
  }

  beginOccurrence(input: BeginRoutineOccurrenceInput): 'started' | 'superseded' {
    if (
      !isOpaqueRoutineId(input.occurrenceId) ||
      !isOpaqueRoutineId(input.flueRunId) ||
      !Number.isSafeInteger(input.startedAt) ||
      (input.resolvedAccessHash !== undefined && !/^[a-f0-9]{64}$/.test(input.resolvedAccessHash)) ||
      (input.resolvedAgentId !== undefined && !isOpaqueRoutineId(input.resolvedAgentId)) ||
      (input.model !== undefined && (!input.model || input.model.length > 500)) ||
      (input.providerAuthRoute !== undefined &&
        !['openai_api_key', 'openai_subscription'].includes(input.providerAuthRoute)) ||
      (input.traceId !== undefined && !isOpaqueRoutineId(input.traceId))
    ) {
      throw routineError('routine_admission_invalid', 'Routine admission is invalid.');
    }
    return this.db.transaction(() => {
      const run = required(this.getRun(input.occurrenceId), 'Routine occurrence was not found.');
      if (run.status === 'running' && run.flueRunId === input.flueRunId) return 'started';
      if (run.status !== 'admitting' || (run.flueRunId && run.flueRunId !== input.flueRunId)) {
        this.markAdmissionSuperseded(input.occurrenceId, input.flueRunId, input.startedAt);
        return 'superseded';
      }
      const routine = this.getRoutine(run.routineId);
      if (
        (run.triggerSource === 'schedule' || run.triggerSource === 'once') &&
        (!routine || routine.deletedAt !== null || routine.state !== 'active')
      ) {
        this.db.run(
          `UPDATE routine_runs SET status = 'superseded', finished_at = COALESCE(finished_at, ?),
             admission_owner = NULL, admission_lease_until = NULL
           WHERE id = ? AND status = 'admitting'`,
          input.startedAt,
          run.id,
        );
        this.markAdmissionSuperseded(input.occurrenceId, input.flueRunId, input.startedAt);
        const superseded = required(this.getRun(run.id), 'Routine occurrence was not readable.');
        this.appendRunAudit(
          'routine.occurrence_superseded',
          superseded,
          `routine:begin-superseded:${input.occurrenceId}:${input.flueRunId}`,
          input.startedAt,
          'routine_ineligible',
        );
        return 'superseded';
      }
      try {
        this.db.run(
          `UPDATE routine_runs SET status = 'running', flue_run_id = ?, admitted_at = COALESCE(admitted_at, ?),
             started_at = ?, resolved_access_hash = ?, resolved_agent_id = ?, model = ?,
             provider_auth_route = ?, trace_id = ?,
             admission_owner = NULL, admission_lease_until = NULL
           WHERE id = ? AND status = 'admitting'`,
          input.flueRunId,
          input.startedAt,
          input.startedAt,
          input.resolvedAccessHash ?? null,
          input.resolvedAgentId ?? null,
          input.model ?? null,
          input.providerAuthRoute ?? null,
          input.traceId ?? null,
          input.occurrenceId,
        );
      } catch (error) {
        if (isConstraintViolation(error)) {
          this.markAdmissionSuperseded(input.occurrenceId, input.flueRunId, input.startedAt);
          return 'superseded';
        }
        throw error;
      }
      const linked = this.db.run(
        `UPDATE routine_run_admissions SET flue_run_id = ?, receipt_at = COALESCE(receipt_at, ?),
           visible_at = COALESCE(visible_at, ?), status = 'attached'
         WHERE occurrence_id = ? AND attempt = (
           SELECT MAX(attempt) FROM routine_run_admissions
           WHERE occurrence_id = ? AND (flue_run_id IS NULL OR flue_run_id = ?)
         )`,
        input.flueRunId,
        input.startedAt,
        input.startedAt,
        input.occurrenceId,
        input.occurrenceId,
        input.flueRunId,
      ).changes;
      if (linked === 0) {
        const nextAttempt = this.nextAdmissionNumber(input.occurrenceId);
        this.db.run(
          `INSERT INTO routine_run_admissions (
            occurrence_id, attempt, attempt_id, flue_run_id, flue_agent_receipt_json,
            invoke_started_at, receipt_at, visible_at, status, safe_error
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'attached', NULL)`,
          input.occurrenceId,
          nextAttempt,
          routineAttemptId(input.occurrenceId, nextAttempt),
          input.flueRunId,
          input.startedAt,
          input.startedAt,
          input.startedAt,
        );
      }
      const started = required(this.getRun(input.occurrenceId), 'Routine occurrence was not readable.');
      this.appendRunAudit(
        'routine.occurrence_started',
        started,
        `routine:begin:${input.occurrenceId}:${input.flueRunId}`,
        input.startedAt,
      );
      return 'started';
    });
  }

  prepareAgentDispatch(input: PrepareRoutineAgentDispatchInput): 'started' | 'superseded' {
    validateAgentDispatchInput(input);
    return this.db.transaction(() => {
      const run = required(this.getRun(input.occurrenceId), 'Routine occurrence was not found.');
      const admission = required(
        this.getAdmission(input.occurrenceId, input.attempt),
        'Routine admission attempt was not found.',
      );
      if (admission.attemptId !== input.envelope.attemptId) {
        throw routineError('routine_admission_conflict', 'Routine attempt identity conflicts.');
      }
      if (run.status === 'running') {
        if (sameJson(run.flueAgentEnvelope, input.envelope)) return 'started';
        throw routineError('routine_admission_conflict', 'Routine agent envelope conflicts.');
      }
      if (run.status !== 'admitting' || run.flueRunId !== null) {
        this.db.run(
          `UPDATE routine_run_admissions SET status = 'superseded', visible_at = COALESCE(visible_at, ?)
           WHERE occurrence_id = ? AND attempt = ? AND status = 'attempting'`,
          input.startedAt,
          input.occurrenceId,
          input.attempt,
        );
        return 'superseded';
      }
      const routine = this.getRoutine(run.routineId);
      if (
        (run.triggerSource === 'schedule' || run.triggerSource === 'once') &&
        (!routine || routine.deletedAt !== null || routine.state !== 'active')
      ) {
        this.db.run(
          `UPDATE routine_runs SET status = 'superseded', finished_at = COALESCE(finished_at, ?),
             admission_owner = NULL, admission_lease_until = NULL
           WHERE id = ? AND status = 'admitting'`,
          input.startedAt,
          run.id,
        );
        this.db.run(
          `UPDATE routine_run_admissions SET status = 'superseded', visible_at = ?
           WHERE occurrence_id = ? AND attempt = ?`,
          input.startedAt,
          input.occurrenceId,
          input.attempt,
        );
        return 'superseded';
      }
      this.db.run(
        `UPDATE routine_runs SET status = 'running', started_at = ?,
           resolved_access_hash = ?, resolved_agent_id = ?,
           resolved_authority_receipt_id = ?, resolved_runs_as_membership_id = ?, model = ?,
           provider_auth_route = ?, trace_id = ?, flue_agent_envelope_json = ?,
           admission_owner = NULL, admission_lease_until = NULL
         WHERE id = ? AND status = 'admitting'`,
        input.startedAt,
        input.resolvedAccessHash,
        input.resolvedAgentId,
        input.resolvedAuthorityReceiptId,
        input.resolvedRunsAsMembershipId,
        input.model,
        input.providerAuthRoute ?? null,
        input.traceId,
        JSON.stringify(input.envelope),
        input.occurrenceId,
      );
      const started = required(this.getRun(input.occurrenceId), 'Routine occurrence was not readable.');
      this.appendRunAudit(
        'routine.occurrence_started',
        started,
        `routine:agent-begin:${input.envelope.attemptId}`,
        input.startedAt,
      );
      return 'started';
    });
  }

  recordAgentReceipt(input: RecordRoutineAgentReceiptInput): RoutineAdmissionAttempt {
    validateAgentReceiptInput(input);
    return this.db.transaction(() => {
      const run = required(this.getRun(input.occurrenceId), 'Routine occurrence was not found.');
      const admission = required(
        this.getAdmission(input.occurrenceId, input.attempt),
        'Routine admission attempt was not found.',
      );
      if (run.status !== 'running' || run.flueAgentEnvelope?.attemptId !== admission.attemptId) {
        throw routineError('routine_admission_conflict', 'Routine agent receipt was superseded.');
      }
      if (admission.flueAgentReceipt) {
        if (sameJson(admission.flueAgentReceipt, input.receipt)) return admission;
        throw routineError('routine_admission_conflict', 'Routine agent receipt conflicts.');
      }
      this.db.run(
        `UPDATE routine_run_admissions SET flue_agent_receipt_json = ?, receipt_at = ?,
           visible_at = ?, status = 'attached'
         WHERE occurrence_id = ? AND attempt = ? AND flue_agent_receipt_json IS NULL`,
        JSON.stringify(input.receipt),
        input.at,
        input.at,
        input.occurrenceId,
        input.attempt,
      );
      this.db.run(
        'UPDATE routine_runs SET admitted_at = COALESCE(admitted_at, ?) WHERE id = ?',
        input.at,
        input.occurrenceId,
      );
      return required(
        this.getAdmission(input.occurrenceId, input.attempt),
        'Routine agent receipt was not readable.',
      );
    });
  }

  recordAgentSettlement(input: RecordRoutineAgentSettlementInput): RoutineRun {
    validateAgentSettlement(input.settlement);
    return this.db.transaction(() => {
      const run = required(this.getRun(input.occurrenceId), 'Routine occurrence was not found.');
      if (run.flueAgentSettlement) {
        if (sameJson(run.flueAgentSettlement, input.settlement)) return run;
        throw routineError('routine_run_settlement_conflict', 'Routine agent settlement conflicts.');
      }
      if (run.status !== 'running' || !run.flueAgentEnvelope) {
        throw routineError('routine_run_transition_invalid', 'Routine agent settlement was superseded.');
      }
      this.db.run(
        `UPDATE routine_runs SET flue_agent_settlement_json = ?
         WHERE id = ? AND status = 'running' AND flue_agent_settlement_json IS NULL`,
        JSON.stringify(input.settlement),
        input.occurrenceId,
      );
      return required(this.getRun(input.occurrenceId), 'Routine agent settlement was not readable.');
    });
  }

  transitionRun(input: TransitionRoutineRunInput): RoutineRun {
    if (
      !isOpaqueRoutineId(input.occurrenceId) ||
      !Number.isSafeInteger(input.at) ||
      !Array.isArray(input.from) ||
      input.from.length < 1 ||
      !validResultMetadata(input)
    ) {
      throw routineError('routine_run_transition_invalid', 'Routine occurrence transition is invalid.');
    }
    return this.db.transaction(() => {
      const run = required(this.getRun(input.occurrenceId), 'Routine occurrence was not found.');
      if (run.status === input.to) return run;
      if (!input.from.includes(run.status) || !validTransition(run.status, input.to)) {
        throw routineError('routine_run_transition_invalid', 'Routine occurrence transition is invalid.');
      }
      const publicError = validatePublicRoutineError(input.publicError);
      const skipReason = validateRoutineSkipReason(input.skipReason);
      const finishedAt = TERMINAL_RUN_STATUSES.has(input.to) ? input.at : null;
      this.db.run(
        `UPDATE routine_runs SET status = ?, failure_class = ?, public_error = ?, skip_reason = COALESCE(?, skip_reason),
           finished_at = COALESCE(?, finished_at), admission_owner = NULL,
           admission_lease_until = NULL, model = COALESCE(?, model),
           input_tokens = COALESCE(?, input_tokens), output_tokens = COALESCE(?, output_tokens),
           cache_read_tokens = COALESCE(?, cache_read_tokens),
           cache_write_tokens = COALESCE(?, cache_write_tokens),
           cost_estimate = COALESCE(?, cost_estimate), cost_unit = COALESCE(?, cost_unit),
           usage_ledger_operation_id = COALESCE(?, usage_ledger_operation_id),
           usage_provenance = COALESCE(?, usage_provenance),
           usage_completeness = COALESCE(?, usage_completeness),
           tool_call_count = COALESCE(?, tool_call_count),
           change_key_hash = COALESCE(?, change_key_hash),
           suppressed_as_no_op = COALESCE(?, suppressed_as_no_op)
         WHERE id = ? AND status = ?`,
        input.to,
        input.failureClass ?? null,
        publicError,
        skipReason,
        finishedAt,
        input.model ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.cacheReadTokens ?? null,
        input.cacheWriteTokens ?? null,
        input.costEstimate ?? null,
        input.costUnit ?? null,
        input.usageLedgerOperationId ?? null,
        input.usageProvenance ?? null,
        input.usageCompleteness ?? null,
        input.toolCallCount ?? null,
        input.changeKeyHash ?? null,
        input.suppressedAsNoOp === undefined ? null : (input.suppressedAsNoOp ? 1 : 0),
        run.id,
        run.status,
      );
      if (finishedAt !== null) this.applyRoutineOutcome(run, input.to, input.failureClass ?? null, input.at);
      const updated = required(this.getRun(run.id), 'Routine occurrence was not readable after transition.');
      this.appendRunAudit(
        `routine.occurrence_${input.to}`,
        updated,
        `routine:transition:${run.id}:${input.to}`,
        input.at,
        input.failureClass,
      );
      return updated;
    });
  }

  claimDelivery(input: ClaimRoutineDeliveryInput): 'claimed' | 'superseded' {
    if (
      !isOpaqueRoutineId(input.occurrenceId) ||
      !Number.isSafeInteger(input.at) ||
      !Number.isSafeInteger(input.leaseUntil) ||
      input.leaseUntil <= input.at ||
      input.leaseUntil > input.at + ROUTINE_LIMITS.deliveryLeaseMs
    ) {
      throw routineError('routine_delivery_invalid', 'Routine delivery claim is invalid.');
    }
    return this.db.transaction(() => {
      const run = required(this.getRun(input.occurrenceId), 'Routine occurrence was not found.');
      if (!['running', 'failed'].includes(run.status) || run.deliveryStatus !== 'none') return 'superseded';
      this.db.run(
        `UPDATE routine_runs SET delivery_status = 'leased', delivery_lease_until = ?
         WHERE id = ? AND status IN ('running', 'failed') AND delivery_status = 'none'`,
        input.leaseUntil,
        run.id,
      );
      return this.getRun(run.id)?.deliveryStatus === 'leased' ? 'claimed' : 'superseded';
    });
  }

  recordDelivery(input: RecordRoutineDeliveryInput): RoutineRun {
    if (
      !isOpaqueRoutineId(input.occurrenceId) ||
      !Number.isSafeInteger(input.at) ||
      !['delivered', 'unknown', 'failed'].includes(input.outcome) ||
      (input.channelId !== undefined && !isOpaqueRoutineId(input.channelId)) ||
      (input.messageTs !== undefined && !/^\d{1,20}\.\d{1,12}$/.test(input.messageTs)) ||
      (input.changeKeyHash !== undefined &&
        input.changeKeyHash !== null &&
        !/^[a-f0-9]{64}$/.test(input.changeKeyHash)) ||
      (input.outcome === 'delivered' && (!input.channelId || !input.messageTs))
    ) {
      throw routineError('routine_delivery_invalid', 'Routine delivery result is invalid.');
    }
    return this.db.transaction(() => {
      const run = required(this.getRun(input.occurrenceId), 'Routine occurrence was not found.');
      if (!['running', 'failed'].includes(run.status) || run.deliveryStatus !== 'leased') {
        throw routineError('routine_delivery_superseded', 'Routine delivery was superseded.');
      }
      this.db.run(
        `UPDATE routine_runs SET delivery_status = ?, delivery_lease_until = NULL,
           delivery_channel_id = ?, delivery_message_ts = ?,
           change_key_hash = COALESCE(?, change_key_hash) WHERE id = ?`,
        input.outcome,
        input.channelId ?? null,
        input.messageTs ?? null,
        input.changeKeyHash ?? null,
        run.id,
      );
      if (input.outcome === 'delivered' && input.changeKeyHash) {
        this.db.run(
          'UPDATE routines SET last_change_key_hash = ? WHERE id = ? AND deleted_at IS NULL',
          input.changeKeyHash,
          run.routineId,
        );
      }
      const updated = required(this.getRun(run.id), 'Routine occurrence was not readable after delivery.');
      this.appendRunAudit(
        `routine.delivery_${input.outcome}`,
        updated,
        `routine:delivery:${run.id}:${input.outcome}`,
        input.at,
      );
      return updated;
    });
  }

  listAdmissions(occurrenceId: string): RoutineAdmissionAttempt[] {
    return this.db
      .all(
        `SELECT * FROM routine_run_admissions WHERE occurrence_id = ? ORDER BY attempt`,
        occurrenceId,
      )
      .map((row) => rowToAdmission(row as unknown as AdmissionRow));
  }

  private getRevision(routineId: string, version: number): RoutineRevision | undefined {
    const row = this.db.get(
      `SELECT * FROM routine_revisions WHERE routine_id = ? AND version = ?`,
      routineId,
      version,
    );
    return row ? rowToRevision(row as unknown as RevisionRow) : undefined;
  }

  private getAdmission(
    occurrenceId: string,
    attempt: number,
  ): RoutineAdmissionAttempt | undefined {
    const row = this.db.get(
      `SELECT * FROM routine_run_admissions WHERE occurrence_id = ? AND attempt = ?`,
      occurrenceId,
      attempt,
    );
    return row ? rowToAdmission(row as unknown as AdmissionRow) : undefined;
  }

  listAuditEvents(filter: AuditEventFilter = {}): AuditEvent[] {
    return this.audit.list({ ...filter, domain: 'scheduled_work' });
  }

  private initializeSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY, work_id TEXT, binding_id TEXT,
        source_visibility TEXT NOT NULL DEFAULT 'unknown',
        workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        creator_user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
        task_text TEXT NOT NULL, trigger_kind TEXT NOT NULL, schedule_input TEXT NOT NULL,
        schedule_json TEXT NOT NULL, timezone TEXT NOT NULL, output_policy TEXT NOT NULL,
        authority_mode TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
        next_run_at INTEGER, last_scheduled_at INTEGER, last_finished_at INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0, last_change_key_hash TEXT,
        projected_daily_starts INTEGER NOT NULL, reservation_windows_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, created_by TEXT, updated_at INTEGER NOT NULL,
        updated_by TEXT, paused_at INTEGER, paused_by TEXT, paused_reason TEXT,
        disabled_at INTEGER, disabled_by TEXT, disabled_reason TEXT,
        deleted_at INTEGER, deleted_by TEXT
      )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS routines_due_idx
       ON routines (state, next_run_at, id)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS routines_scope_idx
       ON routines (workspace_id, channel_id, state, created_at)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS routine_revisions (
        routine_id TEXT NOT NULL, version INTEGER NOT NULL, definition_json TEXT,
        definition_hash TEXT NOT NULL, actor_id TEXT, actor_class TEXT NOT NULL,
        confirmation_id TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY (routine_id, version)
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS routine_request_provenance (
        routine_id TEXT NOT NULL, version INTEGER NOT NULL, source_kind TEXT NOT NULL,
        request_text TEXT, request_hash TEXT NOT NULL, event_id TEXT NOT NULL,
        message_ts TEXT NOT NULL, thread_ts TEXT NOT NULL, authority_source TEXT NOT NULL,
        source_routine_id TEXT, source_routine_version INTEGER, definition_hash TEXT NOT NULL,
        PRIMARY KEY (routine_id, version)
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS routine_confirmations (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL,
        actor_class TEXT NOT NULL, workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        draft_json TEXT NOT NULL, base_version INTEGER, preview_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
      )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS routine_confirmations_expiry_idx
       ON routine_confirmations (expires_at, consumed_at)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS routine_schedule_reservations (
        routine_id TEXT NOT NULL, window_start INTEGER NOT NULL, reserved_count INTEGER NOT NULL,
        PRIMARY KEY (routine_id, window_start)
      )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS routine_schedule_reservations_window_idx
       ON routine_schedule_reservations (window_start, routine_id)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS routine_runs (
        id TEXT PRIMARY KEY, canonical_run_id TEXT, idempotency_key TEXT NOT NULL UNIQUE, routine_id TEXT NOT NULL,
        routine_version INTEGER NOT NULL, scheduled_for INTEGER NOT NULL,
        trigger_source TEXT NOT NULL, requested_by TEXT, status TEXT NOT NULL,
        failure_class TEXT, public_error TEXT, admission_owner TEXT,
        admission_lease_until INTEGER, flue_run_id TEXT UNIQUE,
        flue_agent_envelope_json TEXT, flue_agent_settlement_json TEXT,
        queued_at INTEGER NOT NULL,
        admitted_at INTEGER, started_at INTEGER, finished_at INTEGER,
        resolved_access_hash TEXT, resolved_agent_id TEXT,
        resolved_authority_receipt_id TEXT, resolved_runs_as_membership_id TEXT, model TEXT,
        provider_auth_route TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, cost_estimate REAL, cost_unit TEXT,
        usage_ledger_operation_id TEXT,
        usage_provenance TEXT NOT NULL DEFAULT 'legacy_routine', usage_completeness TEXT,
        deadline_at INTEGER NOT NULL, sandbox_session_id TEXT, tool_call_count INTEGER NOT NULL,
        delivery_status TEXT NOT NULL, delivery_lease_until INTEGER,
        delivery_channel_id TEXT, delivery_message_ts TEXT, change_key_hash TEXT,
        baseline_change_key_hash TEXT, suppressed_as_no_op INTEGER NOT NULL,
        skip_reason TEXT, missed_slot_count INTEGER NOT NULL, first_missed_at INTEGER,
        last_missed_at INTEGER, trace_id TEXT, revision_json TEXT, revision_hash TEXT NOT NULL
      )`,
    );
    const runColumns = this.db.all('PRAGMA table_info(routine_runs)');
    for (const [name, definition] of [
      ['usage_ledger_operation_id', 'TEXT'],
      ['usage_provenance', "TEXT NOT NULL DEFAULT 'legacy_routine'"],
      ['usage_completeness', 'TEXT'],
      ['flue_agent_envelope_json', 'TEXT'],
      ['flue_agent_settlement_json', 'TEXT'],
      ['resolved_authority_receipt_id', 'TEXT'],
      ['resolved_runs_as_membership_id', 'TEXT'],
    ] as const) {
      if (!runColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE routine_runs ADD COLUMN ${name} ${definition}`);
      }
    }
    if (!runColumns.some((row) => row.name === 'provider_auth_route')) {
      this.db.exec('ALTER TABLE routine_runs ADD COLUMN provider_auth_route TEXT');
    }
    const routineColumns = this.db.all('PRAGMA table_info(routines)');
    if (!routineColumns.some((row) => row.name === 'source_visibility')) {
      this.db.exec(
        "ALTER TABLE routines ADD COLUMN source_visibility TEXT NOT NULL DEFAULT 'unknown'",
      );
    }
    // The pointers into the Work ledger (routines.work_id/binding_id,
    // routine_runs.canonical_run_id) are installed by whichever store gets here
    // first — see installLedgerLinks. The tables above must already exist.
    installLedgerLinks(this.db);
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS routine_runs_schedule_slot_unique
       ON routine_runs (routine_id, scheduled_for) WHERE trigger_source = 'schedule'`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS routine_runs_once_slot_unique
       ON routine_runs (routine_id, scheduled_for) WHERE trigger_source = 'once'`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS routine_runs_one_active
       ON routine_runs (routine_id) WHERE status IN ('queued', 'admitting', 'running')`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS routine_runs_history_idx
       ON routine_runs (routine_id, scheduled_for DESC, id DESC)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS routine_runs_start_capacity_idx
       ON routine_runs (queued_at) WHERE skip_reason IS NULL`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS routine_run_admissions (
        occurrence_id TEXT NOT NULL, attempt INTEGER NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
        flue_run_id TEXT UNIQUE, flue_agent_receipt_json TEXT,
        invoke_started_at INTEGER NOT NULL, receipt_at INTEGER, visible_at INTEGER,
        status TEXT NOT NULL, safe_error TEXT,
        PRIMARY KEY (occurrence_id, attempt)
      )`,
    );
    const admissionColumns = this.db.all('PRAGMA table_info(routine_run_admissions)');
    if (!admissionColumns.some((column) => column.name === 'attempt_id')) {
      this.db.exec('ALTER TABLE routine_run_admissions ADD COLUMN attempt_id TEXT');
      const rows = this.db.all('SELECT occurrence_id, attempt FROM routine_run_admissions');
      for (const row of rows) {
        this.db.run(
          'UPDATE routine_run_admissions SET attempt_id = ? WHERE occurrence_id = ? AND attempt = ?',
          routineAttemptId(String(row.occurrence_id), Number(row.attempt)),
          String(row.occurrence_id),
          Number(row.attempt),
        );
      }
    }
    if (!admissionColumns.some((column) => column.name === 'flue_agent_receipt_json')) {
      this.db.exec('ALTER TABLE routine_run_admissions ADD COLUMN flue_agent_receipt_json TEXT');
    }
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS routine_run_admissions_attempt_id_unique ON routine_run_admissions (attempt_id)',
    );
  }

  private insertRoutine(input: {
    id: string;
    workspaceId: string;
    channelId: string;
    creatorUserId: string;
    definition: RoutineDefinitionContent;
    nextRunAt: number;
    projectedDailyStarts: number;
    reservations: RoutineScheduleReservation[];
    actorId: string;
    at: number;
    sourceVisibility: SourceVisibility;
  }): void {
    const d = input.definition;
    this.db.run(
      `INSERT INTO routines (
        id, source_visibility, workspace_id, channel_id, creator_user_id, name, description, task_text,
        trigger_kind, schedule_input, schedule_json, timezone, output_policy,
        authority_mode, state, version, next_run_at, last_scheduled_at,
        last_finished_at, consecutive_failures, last_change_key_hash,
        projected_daily_starts, reservation_windows_json, created_at, created_by,
        updated_at, updated_by, paused_at, paused_by, paused_reason, disabled_at,
        disabled_by, disabled_reason, deleted_at, deleted_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, NULL,
                NULL, 0, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL,
                NULL, NULL, NULL)`,
      input.id,
      input.sourceVisibility,
      input.workspaceId,
      input.channelId,
      input.creatorUserId,
      d.name,
      d.description,
      d.taskText,
      d.triggerKind,
      d.scheduleInput,
      d.scheduleJson,
      d.timezone,
      d.outputPolicy,
      d.authorityMode,
      input.nextRunAt,
      input.projectedDailyStarts,
      JSON.stringify(input.reservations),
      input.at,
      input.actorId,
      input.at,
      input.actorId,
    );
  }

  private ensureRoutineWorkBinding(
    routineId: string,
    workspaceId: string,
    channelId: string,
    sourceVisibility: SourceVisibility,
    createdAt: number,
  ): void {
    const workId = opaqueId('work', `routine:${routineId}`) as WorkId;
    const bindingId = opaqueId('binding', `routine:${routineId}`) as BindingId;
    this.work.ensureWorkBindingInTransaction({
      work: {
        id: workId,
        kind: 'routine',
        maximumSensitivity: sourceVisibility === 'public' ? 'public' : 'private',
        createdAt,
      },
      binding: {
        id: bindingId,
        workId,
        adapterKind: 'routine',
        externalAccountId: opaqueId('account', `slack:${workspaceId}`),
        externalConversationId: opaqueId(
          'conversation',
          `routine:${workspaceId}:${channelId}:${routineId}`,
        ),
        generation: 1,
        sourceVisibility,
        configMode: 'resolve_each_run',
        orderingKey: opaqueId('ordering', `routine:${routineId}`),
        createdAt,
      },
    });
    this.db.run(
      `UPDATE routines SET work_id = ?, binding_id = ?, source_visibility = ?
       WHERE id = ? AND work_id IS NULL AND binding_id IS NULL`,
      workId,
      bindingId,
      sourceVisibility,
      routineId,
    );
  }

  private tryAdmitCanonicalOccurrence(run: RoutineRun, routine: RoutineDefinition): void {
    if (!routine.workId || !routine.bindingId) return;
    const reference = this.config.getAgentScheduleReference(routine.id);
    if (!reference || reference.workspaceId !== routine.workspaceId ||
        reference.channelId !== routine.channelId || reference.state !== 'active') return;
    const grant = this.config.listAgentChannelGrants(routine.workspaceId, routine.channelId)
      .find((candidate) => candidate.agentId === reference.agentId && candidate.status === 'active');
    if (!grant) return;
    let assignment: ResolvedAssignment;
    try {
      const agent = this.config.getAgent(reference.agentId);
      if (!agent.enabled) return;
      const channel = this.config.getChannel(routine.workspaceId, routine.channelId);
      if (channel?.lifecycle === 'archived') return;
      assignment = {
        workspaceId: routine.workspaceId,
        channelId: routine.channelId,
        agentId: agent.id,
        ...(channel?.label ? { channelLabel: channel.label } : {}),
        agent,
      };
    } catch {
      return;
    }
    const visibility = this.routineSourceVisibility(routine.id);
    let safeConfig;
    try {
      safeConfig = safeConfigForAssignment(
        assignment,
        visibility === 'public' ? 'public' : 'private',
      );
    } catch {
      return;
    }
    const canonicalRunId = opaqueId('run', `routine:${run.id}`);
    const admission = prepareSubmitRun({
      work: {
        id: routine.workId,
        kind: 'routine',
        createdAt: routine.createdAt,
      },
      binding: {
        id: routine.bindingId,
        adapterKind: 'routine',
        externalAccountId: opaqueId('account', `slack:${routine.workspaceId}`),
        externalConversationId: opaqueId(
          'conversation',
          `routine:${routine.workspaceId}:${routine.channelId}:${routine.id}`,
        ),
        generation: 1,
        sourceVisibility: visibility,
        configMode: 'resolve_each_run',
        orderingKey: opaqueId('ordering', `routine:${routine.id}`),
        createdAt: routine.createdAt,
      },
      trigger: {
        runId: canonicalRunId,
        runKind: 'routine',
        kind: `routine_${run.triggerSource}`,
        ref: opaqueId('trigger', `routine:${run.id}`),
        dedupeKey: opaqueId('dedupe', `routine:${run.idempotencyKey}`),
        body: null,
        createdAt: run.queuedAt,
      },
      actor: {
        ref: run.requestedBy
          ? opaqueId('actor', `slack:${routine.workspaceId}:${run.requestedBy}`)
          : opaqueId('actor', `routine:${routine.id}:system`),
        trustTier: run.requestedBy ? 'member' : 'system',
      },
      sourceContextWatermark: opaqueId(
        'watermark',
        `routine:${routine.id}:${run.routineVersion}:${run.scheduledFor}`,
      ),
      safeConfig,
      execution: {
        authority: 'legacy',
        coordinatorKind: 'flue_workflow',
        authorityEpoch: 1,
      },
      audit: {
        eventId: opaqueId('audit', `admit:routine:${run.id}`),
        idempotencyKey: opaqueId('auditkey', `admit:routine:${run.id}`),
      },
    });
    const admitted = this.work.admitShadowRunInTransaction(admission);
    this.db.run(
      `UPDATE routine_runs SET canonical_run_id = ?
       WHERE id = ? AND canonical_run_id IS NULL`,
      admitted.run.id,
      run.id,
    );
  }

  private routineSourceVisibility(routineId: string): SourceVisibility {
    const value = this.db.get('SELECT source_visibility FROM routines WHERE id = ?', routineId)
      ?.source_visibility;
    return value === 'public' || value === 'private' ? value : 'unknown';
  }

  private requiredMutableRoutine(routineId: string, expectedVersion: number): RoutineDefinition {
    const routine = this.getRoutine(routineId);
    if (!routine || routine.deletedAt !== null) {
      throw routineError('routine_not_found', 'Routine was not found.');
    }
    if (routine.version !== expectedVersion) {
      throw routineError('routine_version_conflict', 'Routine changed. Refresh and try again.', {
        routineId,
        currentVersion: String(routine.version),
      });
    }
    return routine;
  }

  private dueSlots(
    routine: RoutineDefinition,
    now: number,
  ): { first: number; latest: number; next: number | null; count: number } | null {
    if (routine.nextRunAt === null || routine.nextRunAt > now) return null;
    try {
      const first = routine.nextRunAt;
      if (routine.triggerKind === 'once') {
        return { first, latest: first, next: null, count: 1 };
      }
      let latest = first;
      let count = 1;
      let next = nextRoutineOccurrence(routine.scheduleJson, routine.timezone, latest);
      while (next <= now) {
        latest = next;
        count += 1;
        next = nextRoutineOccurrence(routine.scheduleJson, routine.timezone, latest);
      }
      return { first, latest, next, count };
    } catch {
      const at = now;
      this.db.run(
        `UPDATE routines SET state = 'paused', paused_at = ?, paused_by = NULL,
           paused_reason = 'schedule_invalid', updated_at = ? WHERE id = ? AND version = ?`,
        at,
        at,
        routine.id,
        routine.version,
      );
      this.db.run('DELETE FROM routine_schedule_reservations WHERE routine_id = ?', routine.id);
      const paused = required(this.getRoutine(routine.id), 'Invalid routine schedule was not paused.');
      this.appendRoutineAudit(
        `routine:schedule-invalid:${routine.id}:${routine.version}`,
        'routine.auto_paused',
        paused,
        null,
        'system',
        definitionHash(routine),
        definitionHash(paused),
        at,
        'schedule_invalid',
      );
      return null;
    }
  }

  private assertCapacity(
    workspaceId: string,
    channelId: string,
    triggerKind: RoutineDefinition['triggerKind'],
    projectedDailyStarts: number,
    reservations: RoutineScheduleReservation[],
    excludingRoutineId?: string,
  ): void {
    validateReservationInput(projectedDailyStarts, reservations, triggerKind);
    const exclusion = excludingRoutineId ? ' AND id <> ?' : '';
    const params: SqlParam[] = excludingRoutineId ? [excludingRoutineId] : [];
    const deployment = Number(
      this.db.get(
        `SELECT COUNT(*) AS count FROM routines
         WHERE state = 'active' AND deleted_at IS NULL${exclusion}`,
        ...params,
      )?.count ?? 0,
    );
    if (deployment >= ROUTINE_LIMITS.activeDeployment) {
      throw routineError('routine_active_limit', 'This deployment has reached its active routine limit.');
    }
    const channelParams: SqlParam[] = [workspaceId, channelId, ...params];
    const channel = Number(
      this.db.get(
        `SELECT COUNT(*) AS count FROM routines
         WHERE workspace_id = ? AND channel_id = ? AND state = 'active'
           AND deleted_at IS NULL${exclusion}`,
        ...channelParams,
      )?.count ?? 0,
    );
    if (channel >= ROUTINE_LIMITS.activeChannel) {
      throw routineError('routine_channel_limit', 'This channel has reached its active routine limit.');
    }
    const projected = Number(
      this.db.get(
        `SELECT COALESCE(SUM(projected_daily_starts), 0) AS count FROM routines
         WHERE state = 'active' AND deleted_at IS NULL${exclusion}`,
        ...params,
      )?.count ?? 0,
    );
    if (projected + projectedDailyStarts > ROUTINE_LIMITS.scheduledStartsPerDay) {
      throw routineError('routine_scheduled_capacity', 'This schedule exceeds deployment capacity.');
    }
    this.assertRollingClusterCapacity(reservations, excludingRoutineId);
  }

  private assertRollingClusterCapacity(
    reservations: readonly RoutineScheduleReservation[],
    excludingRoutineId?: string,
  ): void {
    const width = 15 * 60 * 1_000;
    const first = Math.min(...reservations.map(({ windowStart }) => windowStart));
    const last = Math.max(...reservations.map(({ windowStart }) => windowStart));
    const rows = this.db.all(
      `SELECT window_start, SUM(reserved_count) AS count
       FROM routine_schedule_reservations
       WHERE window_start > ? AND window_start < ?${excludingRoutineId ? ' AND routine_id <> ?' : ''}
       GROUP BY window_start`,
      first - width,
      last + width,
      ...(excludingRoutineId ? [excludingRoutineId] : []),
    );
    const totals = new Map<number, number>();
    for (const row of rows) totals.set(Number(row.window_start), Number(row.count));
    for (const reservation of reservations) {
      totals.set(
        reservation.windowStart,
        (totals.get(reservation.windowStart) ?? 0) + reservation.count,
      );
    }
    const points = [...totals].sort(([left], [right]) => left - right);
    let left = 0;
    let count = 0;
    for (let right = 0; right < points.length; right += 1) {
      count += points[right]![1];
      while (points[right]![0] - points[left]![0] >= width) {
        count -= points[left]![1];
        left += 1;
      }
      if (count > ROUTINE_LIMITS.startsPerRollingFifteenMinutes) {
        throw routineError('routine_cluster_capacity', 'Too many routines run near that time.');
      }
    }
  }

  private replaceReservations(
    routineId: string,
    reservations: RoutineScheduleReservation[],
  ): void {
    this.db.run('DELETE FROM routine_schedule_reservations WHERE routine_id = ?', routineId);
    if (reservations.length === 0) return;
    this.db.run(
      `INSERT INTO routine_schedule_reservations (routine_id, window_start, reserved_count)
       SELECT ?,
              CAST(json_extract(value, '$.windowStart') AS INTEGER),
              CAST(json_extract(value, '$.count') AS INTEGER)
       FROM json_each(?)`,
      routineId,
      JSON.stringify(reservations),
    );
  }

  private assertOccurrenceCapacity(input: CreateRoutineOccurrenceInput): void {
    const rollingDayStart = input.queuedAt - 24 * 60 * 60 * 1_000;
    const rollingClusterStart = input.queuedAt - 15 * 60 * 1_000;
    const active = Number(
      this.db.get(
        `SELECT COUNT(*) AS count FROM routine_runs
         WHERE status IN ('queued', 'admitting', 'running')`,
      )?.count ?? 0,
    );
    if (active >= ROUTINE_LIMITS.concurrentDeploymentRuns) {
      throw routineError(
        'routine_concurrent_capacity',
        'This deployment has reached its active routine run limit.',
      );
    }
    const clusteredStarts = Number(
      this.db.get(
        `SELECT COUNT(*) AS count FROM routine_runs
         WHERE queued_at > ? AND queued_at <= ? AND skip_reason IS NULL`,
        rollingClusterStart,
        input.queuedAt,
      )?.count ?? 0,
    );
    if (clusteredStarts >= ROUTINE_LIMITS.startsPerRollingFifteenMinutes) {
      throw routineError(
        'routine_cluster_capacity',
        'This deployment has reached its rolling routine start-rate limit.',
      );
    }
    const totalStarts = Number(
      this.db.get(
        `SELECT COUNT(*) AS count FROM routine_runs
         WHERE queued_at > ? AND queued_at <= ? AND skip_reason IS NULL`,
        rollingDayStart,
        input.queuedAt,
      )?.count ?? 0,
    );
    if (totalStarts >= ROUTINE_LIMITS.totalStartsRollingDay) {
      throw routineError(
        'routine_total_start_limit',
        'This deployment has reached its rolling routine start limit.',
      );
    }
    if (input.triggerSource !== 'run_now') return;
    const runNowStarts = Number(
      this.db.get(
        `SELECT COUNT(*) AS count FROM routine_runs
         WHERE trigger_source = 'run_now' AND queued_at > ? AND queued_at <= ?`,
        rollingDayStart,
        input.queuedAt,
      )?.count ?? 0,
    );
    if (runNowStarts >= ROUTINE_LIMITS.runNowStartsPerDay) {
      throw routineError(
        'routine_run_now_limit',
        'This deployment has reached its rolling run-now limit.',
      );
    }
  }

  private insertRevision(
    routineId: string,
    version: number,
    definition: RoutineDefinitionContent | null,
    actorId: string | null,
    actorClass: RoutineRevision['actorClass'],
    confirmationId: string | null,
    createdAt: number,
    preservedHash?: string,
  ): void {
    this.db.run(
      `INSERT INTO routine_revisions (
        routine_id, version, definition_json, definition_hash, actor_id,
        actor_class, confirmation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      routineId,
      version,
      definition ? JSON.stringify(definition) : null,
      definition ? definitionHash(definition) : (preservedHash ?? hashRoutineValue('deleted')),
      actorId,
      actorClass,
      confirmationId,
      createdAt,
    );
  }

  private insertRequestProvenance(
    routineId: string,
    version: number,
    definition: RoutineDefinitionContent,
    raw: RoutineRequestProvenanceInput | null,
    previous: RoutineDefinition | null,
  ): void {
    if (!raw) return;
    const provenance = validateRoutineRequestProvenanceInput(raw);
    if (provenance.authoritySource === 'current_request') {
      if (provenance.sourceKind !== 'slack_request' || provenance.sourceRoutineId != null) {
        throw routineError('routine_provenance_invalid', 'Routine request provenance is invalid.');
      }
      assertRoutineTaskBoundToSource(definition.taskText, provenance.requestText);
    } else if (provenance.authoritySource === 'previous_revision') {
      if (
        !previous ||
        provenance.sourceKind !== 'slack_request' ||
        provenance.sourceRoutineId !== previous.id ||
        provenance.sourceRoutineVersion !== previous.version
      ) {
        throw routineError('routine_provenance_invalid', 'Routine request provenance is invalid.');
      }
      assertRoutineTaskBoundToPrevious(
        definition.taskText,
        previous.taskText,
        provenance.requestText,
      );
    } else {
      if (
        previous !== null ||
        provenance.sourceKind !== 'slack_clone' ||
        provenance.sourceRoutineId == null ||
        provenance.sourceRoutineVersion == null
      ) {
        throw routineError('routine_provenance_invalid', 'Routine request provenance is invalid.');
      }
      const source = this.getRevision(
        provenance.sourceRoutineId,
        provenance.sourceRoutineVersion,
      );
      if (!source?.definition || source.definition.taskText !== definition.taskText) {
        throw routineError('routine_provenance_invalid', 'Routine clone provenance is invalid.');
      }
    }
    const definitionDigest = definitionHash(definition);
    this.db.run(
      `INSERT INTO routine_request_provenance (
        routine_id, version, source_kind, request_text, request_hash, event_id,
        message_ts, thread_ts, authority_source, source_routine_id,
        source_routine_version, definition_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      routineId,
      version,
      provenance.sourceKind,
      provenance.requestText,
      hashRoutineValue(provenance.requestText),
      provenance.eventId,
      provenance.messageTs,
      provenance.threadTs,
      provenance.authoritySource,
      provenance.sourceRoutineId ?? null,
      provenance.sourceRoutineVersion ?? null,
      definitionDigest,
    );
  }

  /**
   * Controls do not receive a new Slack request. Keep the prior authority
   * evidence visible on their revision, but bind it to this revision's
   * definition hash so the detail view remains internally consistent.
   */
  private copyRequestProvenance(
    routineId: string,
    fromVersion: number,
    toVersion: number,
    definition: RoutineDefinitionContent,
  ): void {
    this.db.run(
      `INSERT INTO routine_request_provenance (
         routine_id, version, source_kind, request_text, request_hash, event_id,
         message_ts, thread_ts, authority_source, source_routine_id,
         source_routine_version, definition_hash
       )
       SELECT routine_id, ?, source_kind, request_text, request_hash, event_id,
              message_ts, thread_ts, authority_source, source_routine_id,
              source_routine_version, ?
       FROM routine_request_provenance
       WHERE routine_id = ? AND version = ?`,
      toVersion,
      definitionHash(definition),
      routineId,
      fromVersion,
    );
  }

  /** Only unsubmitted scheduled work is safely cancellable by a control transition. */
  private cancelQueuedScheduledOccurrences(
    routineId: string,
    action: 'pause' | 'disable',
    at: number,
  ): void {
    const queued = this.db.all(
      `SELECT * FROM routine_runs
       WHERE routine_id = ? AND status = 'queued' AND trigger_source IN ('schedule', 'once')`,
      routineId,
    ).map((row) => rowToRun(row as unknown as RunRow));
    if (queued.length === 0) return;
    this.db.run(
      `UPDATE routine_runs SET status = 'cancelled', finished_at = ?,
         admission_owner = NULL, admission_lease_until = NULL
       WHERE routine_id = ? AND status = 'queued' AND trigger_source IN ('schedule', 'once')`,
      at,
      routineId,
    );
    for (const run of queued) {
      const cancelled = required(this.getRun(run.id), 'Cancelled routine occurrence was not readable.');
      this.appendRunAudit(
        'routine.occurrence_cancelled',
        cancelled,
        `routine:control-cancel:${action}:${run.id}`,
        at,
        `routine_${action}`,
      );
    }
  }

  private appendRoutineAudit(
    idempotencyKey: string,
    eventType: string,
    routine: RoutineDefinition,
    actorId: string | null,
    actorClass: string,
    beforeHash: string | null,
    afterHash: string | null,
    createdAt: number,
    reasonCode?: string,
  ): void {
    this.audit.append({
      eventId: routineAuditId(idempotencyKey),
      domain: 'scheduled_work',
      eventType,
      outcome: 'success',
      actorClass,
      actorId,
      workspaceId: routine.workspaceId,
      channelId: routine.channelId,
      subjectId: routine.id,
      subjectVersion: routine.version,
      createdAt,
      reasonCode: reasonCode ?? null,
      beforeHash,
      afterHash,
      metadataJson: JSON.stringify({ state: routine.state }),
      idempotencyKey,
    });
  }

  private appendRunAudit(
    eventType: string,
    run: RoutineRun,
    idempotencyKey: string,
    createdAt: number,
    reasonCode?: string | null,
  ): void {
    const routine = required(this.getRoutine(run.routineId), 'Routine for occurrence was not found.');
    this.audit.append({
      eventId: routineAuditId(idempotencyKey),
      domain: 'scheduled_work',
      eventType,
      outcome: run.status === 'failed' ? 'failure' : 'success',
      actorClass: run.triggerSource === 'run_now' ? 'member' : 'system',
      actorId: run.requestedBy,
      workspaceId: routine.workspaceId,
      channelId: routine.channelId,
      subjectId: run.id,
      subjectVersion: run.routineVersion,
      createdAt,
      reasonCode: reasonCode ?? null,
      metadataJson: JSON.stringify({
        routineId: run.routineId,
        status: run.status,
        triggerSource: run.triggerSource,
        ...(run.providerAuthRoute ? { providerAuthRoute: run.providerAuthRoute } : {}),
      }),
      idempotencyKey,
    });
  }

  private applyRoutineOutcome(
    run: RoutineRun,
    status: RoutineRunStatus,
    failureClass: RoutineRun['failureClass'],
    at: number,
  ): void {
    const routineId = run.routineId;
    const routine = this.getRoutine(routineId);
    if (!routine || routine.deletedAt !== null) return;
    if (run.triggerSource === 'once' && routine.triggerKind === 'once') {
      this.completeOneTimeRoutine(run, at, status);
      return;
    }
    if (status === 'succeeded' || status === 'no_op') {
      this.db.run(
        `UPDATE routines SET consecutive_failures = 0, last_finished_at = ? WHERE id = ?`,
        at,
        routineId,
      );
      return;
    }
    if (status !== 'failed' || !failureClass) {
      this.db.run('UPDATE routines SET last_finished_at = ? WHERE id = ?', at, routineId);
      return;
    }
    if (ACCESS_FAILURES.has(failureClass)) {
      this.db.run(
        `UPDATE routines SET state = 'disabled', disabled_at = ?, disabled_by = NULL,
           disabled_reason = ?, last_finished_at = ? WHERE id = ?`,
        at,
        failureClass,
        at,
        routineId,
      );
      this.db.run('DELETE FROM routine_schedule_reservations WHERE routine_id = ?', routineId);
      const disabled = required(this.getRoutine(routineId), 'Auto-disabled routine was not readable.');
      this.appendRoutineAudit(
        `routine:auto-disable:${run.id}:${failureClass}`,
        'routine.auto_disabled',
        disabled,
        null,
        'system',
        definitionHash(routine),
        definitionHash(disabled),
        at,
        failureClass,
      );
      return;
    }
    if (failureClass === 'unknown_external_outcome' || failureClass === 'delivery_unknown') {
      this.pauseRoutineForUnknownOutcome(run, failureClass, at);
      return;
    }
    if (ATTRIBUTABLE_FAILURES.has(failureClass)) {
      const failures = routine.consecutiveFailures + 1;
      const pause = failures >= 3;
      this.db.run(
        `UPDATE routines SET consecutive_failures = ?, last_finished_at = ?,
           state = CASE WHEN ? THEN 'paused' ELSE state END,
           paused_at = CASE WHEN ? THEN ? ELSE paused_at END,
           paused_reason = CASE WHEN ? THEN 'consecutive_failures' ELSE paused_reason END
         WHERE id = ?`,
        failures,
        at,
        pause ? 1 : 0,
        pause ? 1 : 0,
        at,
        pause ? 1 : 0,
        routineId,
      );
      if (pause) {
        this.db.run('DELETE FROM routine_schedule_reservations WHERE routine_id = ?', routineId);
        const paused = required(this.getRoutine(routineId), 'Auto-paused routine was not readable.');
        this.appendRoutineAudit(
          `routine:auto-pause:${run.id}:consecutive_failures`,
          'routine.auto_paused',
          paused,
          null,
          'system',
          definitionHash(routine),
          definitionHash(paused),
          at,
          'consecutive_failures',
        );
      }
      return;
    }
    this.db.run('UPDATE routines SET last_finished_at = ? WHERE id = ?', at, routineId);
  }

  private completeOneTimeRoutine(run: RoutineRun, at: number, outcome: RoutineRunStatus): void {
    const routine = this.getRoutine(run.routineId);
    if (!routine || routine.deletedAt !== null || routine.triggerKind !== 'once') return;
    this.db.run(
      `UPDATE routines SET state = 'completed', next_run_at = NULL,
         reservation_windows_json = '[]', projected_daily_starts = 0,
         last_finished_at = ?, updated_at = ? WHERE id = ?`,
      at,
      at,
      routine.id,
    );
    this.db.run('DELETE FROM routine_schedule_reservations WHERE routine_id = ?', routine.id);
    const completed = required(this.getRoutine(routine.id), 'Completed one-time routine was not readable.');
    this.appendRoutineAudit(
      `routine:completed:${run.id}`,
      'routine.completed',
      completed,
      null,
      'system',
      definitionHash(routine),
      definitionHash(completed),
      at,
      outcome,
    );
  }

  private pauseRoutineForUnknownOutcome(
    run: RoutineRun,
    reason: 'unknown_external_outcome' | 'delivery_unknown',
    at: number,
  ): void {
    const routine = this.getRoutine(run.routineId);
    if (!routine || routine.deletedAt !== null || routine.state === 'disabled') return;
    this.db.run(
      `UPDATE routines SET state = 'paused', paused_at = ?, paused_by = NULL,
         paused_reason = ?, last_finished_at = ? WHERE id = ?`,
      at,
      reason,
      at,
      run.routineId,
    );
    this.db.run('DELETE FROM routine_schedule_reservations WHERE routine_id = ?', run.routineId);
    const paused = required(this.getRoutine(run.routineId), 'Unknown-outcome routine was not readable.');
    if (routine.state !== 'paused' || routine.pausedReason !== reason) {
      this.appendRoutineAudit(
        `routine:auto-pause:${run.id}:${reason}`,
        'routine.auto_paused',
        paused,
        null,
        'system',
        definitionHash(routine),
        definitionHash(paused),
        at,
        reason,
      );
    }
  }

  private runByIdempotencyKey(idempotencyKey: string): RoutineRun | undefined {
    const row = this.db.get(
      `${this.routineRunProjection()} WHERE rr.idempotency_key = ?`,
      idempotencyKey,
    );
    return row ? rowToRun(row as unknown as RunRow) : undefined;
  }

  private routineRunProjection(): string {
    const hasExecutions = Boolean(
      this.db.get(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'run_executions'",
      ),
    );
    if (!hasExecutions) return 'SELECT rr.* FROM routine_runs rr';
    return `SELECT rr.*,
      COALESCE((
        SELECT execution.provider_auth_route
        FROM run_executions execution
        WHERE execution.run_id = rr.canonical_run_id
          AND execution.provider_auth_route IS NOT NULL
        ORDER BY execution.attempt_number DESC
        LIMIT 1
      ), rr.provider_auth_route) AS provider_auth_route
      FROM routine_runs rr`;
  }

  private nextAdmissionNumber(occurrenceId: string): number {
    return Number(
      this.db.get(
        `SELECT COALESCE(MAX(attempt), 0) AS attempt
         FROM routine_run_admissions WHERE occurrence_id = ?`,
        occurrenceId,
      )?.attempt ?? 0,
    ) + 1;
  }

  private markAdmissionSuperseded(
    occurrenceId: string,
    flueRunId: string,
    at: number,
  ): void {
    const existing = this.db.get(
      `SELECT attempt FROM routine_run_admissions
       WHERE occurrence_id = ? AND flue_run_id = ?`,
      occurrenceId,
      flueRunId,
    );
    if (existing) {
      this.db.run(
        `UPDATE routine_run_admissions SET status = 'superseded', visible_at = COALESCE(visible_at, ?)
         WHERE occurrence_id = ? AND flue_run_id = ?`,
        at,
        occurrenceId,
        flueRunId,
      );
      return;
    }
    const attempt = this.nextAdmissionNumber(occurrenceId);
    this.db.run(
      `INSERT INTO routine_run_admissions (
        occurrence_id, attempt, attempt_id, flue_run_id, flue_agent_receipt_json,
        invoke_started_at, receipt_at, visible_at, status, safe_error
      ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, 'superseded', NULL)`,
      occurrenceId,
      attempt,
      routineAttemptId(occurrenceId, attempt),
      flueRunId,
      at,
      at,
    );
  }
}

/** Node backend: target-neutral routine logic over node:sqlite. */
export interface SqliteRoutineStore extends RoutineStore {
  close(): void;
}

export class SqliteRoutineStore {
  constructor(path: string = resolveStateDbPath(), now: () => number = Date.now) {
    const db = openStateDb(path);
    db.exec('PRAGMA secure_delete = ON');
    // The Proxy facade drops the `implements` compile check, so this typed
    // binding is the conformance assertion that keeps it: a logic method that
    // stops matching RoutineStore fails typecheck here.
    const _conforms: RoutineStore = promisify(new RoutineStoreLogic(db, now), {
      close: () => db.close(),
    });
    return _conforms as unknown as SqliteRoutineStore;
  }
}

function validateConfirmationInput(input: PutRoutineConfirmationInput): void {
  if (
    !/^[A-Za-z0-9_-]{1,200}$/.test(input.confirmationId) ||
    !/^[a-f0-9]{64}$/.test(input.tokenHash) ||
    !/^[a-f0-9]{64}$/.test(input.previewHash) ||
    !['member', 'operator'].includes(input.actorClass)
  ) {
    throw routineError('routine_confirmation_invalid', 'Routine confirmation is invalid.');
  }
}

function validateDraft(draft: RoutineConfirmationDraft): RoutineConfirmationDraft {
  if (!isOpaqueRoutineId(draft.routineId)) {
    throw routineError('routine_confirmation_invalid', 'Routine confirmation is invalid.');
  }
  if (draft.action === 'delete') {
    if (!Number.isSafeInteger(draft.expectedVersion) || draft.expectedVersion < 1) {
      throw routineError('routine_confirmation_invalid', 'Routine confirmation is invalid.');
    }
    return draft;
  }
  const definition = validateRoutineDefinition(draft.definition);
  if (!Number.isSafeInteger(draft.nextRunAt) || draft.nextRunAt < 0) {
    throw routineError('routine_confirmation_invalid', 'Routine next occurrence is invalid.');
  }
  validateReservationInput(
    draft.projectedDailyStarts,
    draft.reservations,
    definition.triggerKind,
  );
  if (draft.action === 'edit' && (!Number.isSafeInteger(draft.expectedVersion) || draft.expectedVersion < 1)) {
    throw routineError('routine_confirmation_invalid', 'Routine confirmation is invalid.');
  }
  return { ...draft, definition };
}

function validateOccurrenceInput(input: CreateRoutineOccurrenceInput): void {
  if (
    !isOpaqueRoutineId(input.runId) ||
    !isOpaqueRoutineId(input.routineId) ||
    (input.requestedBy !== undefined &&
      input.requestedBy !== null &&
      !isOpaqueRoutineId(input.requestedBy)) ||
    !Number.isSafeInteger(input.routineVersion) ||
    input.routineVersion < 1 ||
    !Number.isSafeInteger(input.scheduledFor) ||
    !Number.isSafeInteger(input.queuedAt) ||
    !Number.isSafeInteger(input.deadlineAt) ||
    input.deadlineAt <= input.queuedAt
  ) {
    throw routineError('routine_occurrence_invalid', 'Routine occurrence is invalid.');
  }
  assertIdempotencyKey(input.idempotencyKey);
  if (
    ((input.triggerSource === 'schedule' || input.triggerSource === 'once') && input.requestedBy != null) ||
    (input.triggerSource === 'run_now' && !input.requestedBy)
  ) {
    throw routineError('routine_occurrence_invalid', 'Routine occurrence is invalid.');
  }
}

function validateDueClaimInput(input: ClaimDueRoutinesInput): void {
  if (
    !Number.isSafeInteger(input.now) ||
    input.now < 0 ||
    typeof input.owner !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(input.owner) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > ROUTINE_LIMITS.dueClaimsPerHeartbeat
  ) {
    throw routineError('routine_due_claim_invalid', 'Routine heartbeat claim is invalid.');
  }
}

function validateAdminPageInput(input: RoutineAdminPageInput): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.cursor !== undefined && (!Number.isSafeInteger(input.cursor) || input.cursor < 0 || input.cursor > 100_000)) ||
    (input.workspaceId !== undefined && !isOpaqueRoutineId(input.workspaceId)) ||
    (input.channelId !== undefined && !isOpaqueRoutineId(input.channelId)) ||
    (input.state !== undefined && !['active', 'paused', 'disabled', 'completed', 'current', 'all', 'deleted'].includes(input.state)) ||
    (input.runStatus !== undefined && ![
      'queued', 'admitting', 'running', 'succeeded', 'no_op', 'failed', 'skipped', 'cancelled', 'superseded',
    ].includes(input.runStatus))
  ) {
    throw routineError('routine_invalid_filter', 'Routine filter is invalid.');
  }
}

function routineAttemptId(occurrenceId: string, attempt: number): string {
  return opaqueId('routineattempt', `${occurrenceId}:${attempt}`);
}

function validateAgentDispatchInput(input: PrepareRoutineAgentDispatchInput): void {
  const envelope = input.envelope;
  let encoded = '';
  try {
    encoded = JSON.stringify(envelope);
  } catch {
    // Rejected below with the same public state error as any other malformed envelope.
  }
  if (
    !isOpaqueRoutineId(input.occurrenceId) ||
    !Number.isSafeInteger(input.attempt) || input.attempt < 1 ||
    !Number.isSafeInteger(input.startedAt) ||
    !/^[a-f0-9]{64}$/.test(input.resolvedAccessHash) ||
    !isOpaqueRoutineId(input.resolvedAgentId) ||
    !isOpaqueRoutineId(input.resolvedAuthorityReceiptId) ||
    !isOpaqueRoutineId(input.resolvedRunsAsMembershipId) ||
    !input.model || input.model.length > 500 ||
    (input.providerAuthRoute !== undefined &&
      !['openai_api_key', 'openai_subscription'].includes(input.providerAuthRoute)) ||
    !isOpaqueRoutineId(input.traceId) ||
    envelope.schemaVersion !== 1 ||
    !isOpaqueRoutineId(envelope.attemptId) ||
    !isOpaqueRoutineId(envelope.instanceId) ||
    envelope.idempotencyKey !== envelope.attemptId ||
    typeof envelope.message !== 'string' || envelope.message.length < 1 ||
    encoded.length < 1 || encoded.length > 500_000
  ) {
    throw routineError('routine_admission_invalid', 'Routine agent admission is invalid.');
  }
}

function validateAgentReceiptInput(input: RecordRoutineAgentReceiptInput): void {
  const receipt = input.receipt;
  if (
    !isOpaqueRoutineId(input.occurrenceId) ||
    !Number.isSafeInteger(input.attempt) || input.attempt < 1 ||
    !Number.isSafeInteger(input.at) ||
    !boundedReceiptValue(receipt.submissionId) ||
    !boundedReceiptValue(receipt.acceptedAt) ||
    (receipt.uid !== undefined && !boundedReceiptValue(receipt.uid)) ||
    (receipt.deduplicated !== undefined && receipt.deduplicated !== true)
  ) {
    throw routineError('routine_admission_invalid', 'Routine agent receipt is invalid.');
  }
}

function validateAgentSettlement(settlement: RecordRoutineAgentSettlementInput['settlement']): void {
  const result = settlement.outcome === 'completed' ? settlement.result : undefined;
  const usage = settlement.outcome === 'completed' ? settlement.result.usage : settlement.usage;
  if (
    settlement.schemaVersion !== 1 ||
    !Number.isSafeInteger(settlement.settledAt) ||
    (result !== undefined && (
      !['succeeded', 'no_op'].includes(result.status) ||
      typeof result.message !== 'string' || result.message.length > 16_000 ||
      (result.changeKeyHash !== null && !/^[a-f0-9]{64}$/.test(result.changeKeyHash)) ||
      typeof result.suppressedAsNoOp !== 'boolean' ||
      !Number.isSafeInteger(result.toolCallCount) || result.toolCallCount < 0
    )) ||
    (settlement.outcome !== 'completed' && (
      !settlement.failureClass ||
      !validatePublicRoutineError(settlement.publicError) ||
      !Number.isSafeInteger(settlement.toolCallCount) || settlement.toolCallCount < 0
    )) ||
    (usage !== null && usage !== undefined && !validAgentUsage(usage))
  ) {
    throw routineError('routine_run_transition_invalid', 'Routine agent settlement is invalid.');
  }
}

function validAgentUsage(usage: RoutineAgentUsageV1): boolean {
  const tokens = [usage.inputTokens, usage.outputTokens, usage.totalTokens];
  return typeof usage.requestedModel === 'string' && usage.requestedModel.length > 0 &&
    usage.requestedModel.length <= 500 &&
    tokens.every((value) => value === null || (Number.isSafeInteger(value) && value >= 0)) &&
    ['complete', 'partial', 'not_reported'].includes(usage.completeness) &&
    (usage.returnedModel === null || (
      boundedReceiptValue(usage.returnedModel.provider) && boundedReceiptValue(usage.returnedModel.id)
    ));
}

function boundedReceiptValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validResultMetadata(input: TransitionRoutineRunInput): boolean {
  const integerValues = [
    input.inputTokens,
    input.outputTokens,
    input.cacheReadTokens,
    input.cacheWriteTokens,
    input.toolCallCount,
  ];
  if (
    integerValues.some(
      (value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0),
    ) ||
    (input.costEstimate !== undefined &&
      (!Number.isFinite(input.costEstimate) || input.costEstimate < 0)) ||
    (input.model !== undefined && (!input.model || input.model.length > 500)) ||
    (input.costUnit !== undefined && (!input.costUnit || input.costUnit.length > 40)) ||
    (input.usageLedgerOperationId !== undefined && !isOpaqueRoutineId(input.usageLedgerOperationId)) ||
    (input.usageProvenance !== undefined &&
      !['usage_ledger', 'legacy_routine'].includes(input.usageProvenance)) ||
    (input.usageCompleteness !== undefined &&
      !['complete', 'partial', 'not_reported'].includes(input.usageCompleteness)) ||
    (input.changeKeyHash !== undefined &&
      input.changeKeyHash !== null &&
      !/^[a-f0-9]{64}$/.test(input.changeKeyHash))
  ) {
    return false;
  }
  return true;
}

function assertIdempotencyKey(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_.:-]+$/.test(value)
  ) {
    throw routineError('routine_idempotency_invalid', 'Routine idempotency key is invalid.');
  }
}

function validateReservationInput(
  projectedDailyStarts: number,
  reservations: RoutineScheduleReservation[],
  triggerKind: RoutineDefinition['triggerKind'],
): void {
  const validStartProjection = triggerKind === 'once'
    ? projectedDailyStarts === 0
    : projectedDailyStarts >= 1 &&
      projectedDailyStarts <= ROUTINE_LIMITS.scheduledStartsPerRoutinePerDay;
  if (
    !Number.isSafeInteger(projectedDailyStarts) ||
    !validStartProjection ||
    !Array.isArray(reservations) ||
    reservations.length < 1
  ) {
    throw routineError('routine_reservation_invalid', 'Routine capacity reservation is invalid.');
  }
  const seen = new Set<number>();
  for (const reservation of reservations) {
    if (
      !Number.isSafeInteger(reservation.windowStart) ||
      reservation.windowStart < 0 ||
      !Number.isSafeInteger(reservation.count) ||
      reservation.count < 1 ||
      reservation.count > ROUTINE_LIMITS.startsPerRollingFifteenMinutes ||
      seen.has(reservation.windowStart)
    ) {
      throw routineError('routine_reservation_invalid', 'Routine capacity reservation is invalid.');
    }
    seen.add(reservation.windowStart);
  }
}

function rowToRoutine(row: RoutineRow): RoutineDefinition {
  return {
    id: row.id,
    ...(row.work_id ? { workId: row.work_id } : {}),
    ...(row.binding_id ? { bindingId: row.binding_id } : {}),
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    creatorUserId: row.creator_user_id,
    name: row.name,
    description: row.description,
    taskText: row.task_text,
    triggerKind: row.trigger_kind,
    scheduleInput: row.schedule_input,
    scheduleJson: row.schedule_json,
    timezone: row.timezone,
    outputPolicy: row.output_policy,
    authorityMode: row.authority_mode,
    state: row.state,
    version: row.version,
    nextRunAt: row.next_run_at,
    lastScheduledAt: row.last_scheduled_at,
    lastFinishedAt: row.last_finished_at,
    consecutiveFailures: row.consecutive_failures,
    lastChangeKeyHash: row.last_change_key_hash,
    projectedDailyStarts: row.projected_daily_starts,
    reservationWindows: JSON.parse(row.reservation_windows_json) as RoutineScheduleReservation[],
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    pausedAt: row.paused_at,
    pausedBy: row.paused_by,
    pausedReason: row.paused_reason,
    disabledAt: row.disabled_at,
    disabledBy: row.disabled_by,
    disabledReason: row.disabled_reason,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  };
}

function rowToConfirmation(row: ConfirmationRow): RoutineConfirmation {
  const draft = JSON.parse(row.draft_json) as RoutineConfirmationDraft;
  return {
    id: row.id,
    tokenHash: row.token_hash,
    actorId: row.actor_id,
    actorClass: row.actor_class,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    draft,
    baseVersion: row.base_version,
    previewHash: row.preview_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

function rowToRevision(row: RevisionRow): RoutineRevision {
  const provenance = row.provenance_source_kind && row.provenance_request_hash &&
    row.provenance_event_id && row.provenance_message_ts && row.provenance_thread_ts &&
    row.provenance_authority_source && row.provenance_definition_hash
    ? {
        sourceKind: row.provenance_source_kind,
        requestText: row.provenance_request_text ?? null,
        requestHash: row.provenance_request_hash,
        eventId: row.provenance_event_id,
        messageTs: row.provenance_message_ts,
        threadTs: row.provenance_thread_ts,
        authoritySource: row.provenance_authority_source,
        sourceRoutineId: row.provenance_source_routine_id ?? null,
        sourceRoutineVersion: row.provenance_source_routine_version ?? null,
        definitionHash: row.provenance_definition_hash,
      }
    : null;
  return {
    routineId: row.routine_id,
    version: row.version,
    definition: row.definition_json ? JSON.parse(row.definition_json) as RoutineDefinitionContent : null,
    definitionHash: row.definition_hash,
    actorId: row.actor_id,
    actorClass: row.actor_class,
    confirmationId: row.confirmation_id,
    provenance,
    createdAt: row.created_at,
  };
}

function rowToRun(row: RunRow): RoutineRun {
  return {
    id: row.id,
    ...(row.canonical_run_id ? { canonicalRunId: row.canonical_run_id } : {}),
    idempotencyKey: row.idempotency_key,
    routineId: row.routine_id,
    routineVersion: row.routine_version,
    scheduledFor: row.scheduled_for,
    triggerSource: row.trigger_source,
    requestedBy: row.requested_by,
    status: row.status,
    failureClass: row.failure_class,
    publicError: row.public_error,
    admissionOwner: row.admission_owner,
    admissionLeaseUntil: row.admission_lease_until,
    flueRunId: row.flue_run_id,
    flueAgentEnvelope: row.flue_agent_envelope_json
      ? JSON.parse(row.flue_agent_envelope_json) as Exclude<
          RoutineRun['flueAgentEnvelope'], null | undefined
        >
      : null,
    flueAgentSettlement: row.flue_agent_settlement_json
      ? JSON.parse(row.flue_agent_settlement_json) as Exclude<
          RoutineRun['flueAgentSettlement'], null | undefined
        >
      : null,
    queuedAt: row.queued_at,
    admittedAt: row.admitted_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    resolvedAccessHash: row.resolved_access_hash,
    resolvedAgentId: row.resolved_agent_id,
    resolvedAuthorityReceiptId: row.resolved_authority_receipt_id,
    resolvedRunsAsMembershipId: row.resolved_runs_as_membership_id,
    model: row.model,
    providerAuthRoute: row.provider_auth_route,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    costEstimate: row.cost_estimate,
    costUnit: row.cost_unit,
    usageLedgerOperationId: row.usage_ledger_operation_id,
    usageProvenance: row.usage_provenance,
    usageCompleteness: row.usage_completeness,
    deadlineAt: row.deadline_at,
    sandboxSessionId: row.sandbox_session_id,
    toolCallCount: row.tool_call_count,
    deliveryStatus: row.delivery_status,
    deliveryLeaseUntil: row.delivery_lease_until,
    deliveryChannelId: row.delivery_channel_id,
    deliveryMessageTs: row.delivery_message_ts,
    changeKeyHash: row.change_key_hash,
    baselineChangeKeyHash: row.baseline_change_key_hash,
    suppressedAsNoOp: row.suppressed_as_no_op === 1,
    skipReason: row.skip_reason,
    missedSlotCount: row.missed_slot_count,
    firstMissedAt: row.first_missed_at,
    lastMissedAt: row.last_missed_at,
    traceId: row.trace_id,
    revision: row.revision_json ? JSON.parse(row.revision_json) as RoutineDefinitionContent : null,
    revisionHash: row.revision_hash,
  };
}

function rowToAdmission(row: AdmissionRow): RoutineAdmissionAttempt {
  return {
    occurrenceId: row.occurrence_id,
    attempt: row.attempt,
    attemptId: row.attempt_id ?? routineAttemptId(row.occurrence_id, row.attempt),
    flueRunId: row.flue_run_id,
    flueAgentReceipt: row.flue_agent_receipt_json
      ? JSON.parse(row.flue_agent_receipt_json) as RoutineAdmissionAttempt['flueAgentReceipt']
      : null,
    invokeStartedAt: row.invoke_started_at,
    receiptAt: row.receipt_at,
    visibleAt: row.visible_at,
    status: row.status,
    safeError: row.safe_error,
  };
}

function definitionHash(definition: RoutineDefinitionContent): string;
function definitionHash(definition: RoutineDefinition): string;
function definitionHash(definition: RoutineDefinitionContent | RoutineDefinition): string {
  return hashRoutineValue(JSON.stringify(definitionContent(definition)));
}

function definitionContent(
  definition: RoutineDefinitionContent | RoutineDefinition,
): RoutineDefinitionContent {
  return {
    name: definition.name,
    description: definition.description,
    taskText: definition.taskText,
    triggerKind: definition.triggerKind,
    scheduleInput: definition.scheduleInput,
    scheduleJson: definition.scheduleJson,
    timezone: definition.timezone,
    outputPolicy: definition.outputPolicy,
    authorityMode: definition.authorityMode,
  };
}

function targetState(action: ControlRoutineInput['action']): RoutineDefinition['state'] {
  if (action === 'pause') return 'paused';
  if (action === 'disable') return 'disabled';
  return 'active';
}

function validTransition(from: RoutineRunStatus, to: RoutineRunStatus): boolean {
  const allowed: Record<RoutineRunStatus, readonly RoutineRunStatus[]> = {
    queued: ['admitting', 'skipped', 'cancelled'],
    admitting: ['running', 'failed', 'skipped', 'superseded', 'cancelled'],
    running: ['succeeded', 'no_op', 'failed'],
    succeeded: [],
    no_op: [],
    failed: [],
    skipped: [],
    cancelled: [],
    superseded: [],
  };
  return allowed[from].includes(to);
}

function validateRoutineSkipReason(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!/^[a-z0-9_]{1,80}$/.test(value)) {
    throw routineError('routine_run_transition_invalid', 'Routine skip reason is invalid.');
  }
  return value;
}

function confirmationError(): RoutineStateError {
  return routineError('routine_confirmation_invalid', 'Routine confirmation is invalid.');
}

function routineError(
  code: string,
  message: string,
  details: Record<string, string> = {},
): RoutineStateError {
  return new RoutineStateError(code, message, details);
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function isConstraintViolation(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/i.test(error.message);
}

function isOccurrenceCapacityError(error: unknown): boolean {
  return error instanceof RoutineStateError && (
    error.code === 'routine_concurrent_capacity' ||
    error.code === 'routine_total_start_limit' ||
    error.code === 'routine_cluster_capacity'
  );
}
