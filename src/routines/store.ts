import { AuditStoreLogic } from '../audit/store.ts';
import type { AuditEvent, AuditEventFilter } from '../audit/types.ts';
import { openStateDb, resolveStateDbPath, type NodeStateDb } from '../state/node-state-db.ts';
import type { SqlParam, StateDb } from '../state/state-db.ts';
import {
  hashRoutineValue,
  isOpaqueRoutineId,
  routineAuditId,
  scheduledOccurrenceKey,
} from './ids.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import { nextRoutineOccurrence } from './schedule.ts';
import {
  RoutineStateError,
  type BeginRoutineOccurrenceInput,
  type ClaimDueRoutinesInput,
  type ConfirmRoutineInput,
  type ControlRoutineInput,
  type CreateRoutineOccurrenceInput,
  type PutRoutineConfirmationInput,
  type RoutineAdmissionAttempt,
  type RoutineConfirmation,
  type RoutineConfirmationDraft,
  type RoutineDefinition,
  type RoutineDefinitionContent,
  type RoutineDueClaimBatch,
  type RoutineRevision,
  type RoutineRpcRequest,
  type RoutineRpcResponse,
  type RoutineRun,
  type RoutineRunFilter,
  type RoutineRunStatus,
  type RoutineScheduleReservation,
  type RoutineStore,
  type ResolveRoutineAdmissionInput,
  type StartRoutineAdmissionInput,
  type TransitionRoutineRunInput,
} from './types.ts';
import {
  validatePublicRoutineError,
  validateRoutineDefinition,
  validateRoutineScope,
} from './validation.ts';

interface RoutineRow {
  id: string;
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
}

interface RunRow {
  id: string;
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
  queued_at: number;
  admitted_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  resolved_access_hash: string | null;
  resolved_agent_id: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_estimate: number | null;
  cost_unit: string | null;
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
  flue_run_id: string | null;
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
  'delivery_unknown',
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

  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    this.audit = new AuditStoreLogic(db);
    this.initializeSchema();
  }

  execute(request: RoutineRpcRequest): RoutineRpcResponse {
    switch (request.kind) {
      case 'put_confirmation':
        return { kind: 'confirmation', confirmation: this.putConfirmation(request.input) };
      case 'get_confirmation':
        return { kind: 'confirmation', confirmation: this.getConfirmation(request.tokenHash) ?? null };
      case 'confirm':
        return { kind: 'routine', routine: this.confirm(request.input) };
      case 'purge_confirmations':
        return { kind: 'purged', count: this.purgeConfirmations() };
      case 'get_routine':
        return { kind: 'routine', routine: this.getRoutine(request.routineId) ?? null };
      case 'list_routines':
        return {
          kind: 'routines',
          routines: this.listRoutines(request.workspaceId, request.channelId),
        };
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
      case 'transition_run':
        return { kind: 'run', run: this.transitionRun(request.input) };
      case 'list_admissions':
        return { kind: 'admissions', admissions: this.listAdmissions(request.occurrenceId) };
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
      if (draft.action === 'create') {
        if (this.getRoutine(draft.routineId)) {
          throw routineError('routine_exists', 'Routine already exists.');
        }
        this.assertCapacity(
          input.workspaceId,
          input.channelId,
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
        });
        this.replaceReservations(draft.routineId, draft.reservations);
        this.insertRevision(
          draft.routineId,
          1,
          definition,
          input.actorId,
          confirmation.actorClass,
          confirmation.id,
          at,
        );
        routine = required(this.getRoutine(draft.routineId), 'Routine was not readable after create.');
        this.appendRoutineAudit(
          input.idempotencyKey,
          'routine.created',
          routine,
          input.actorId,
          confirmation.actorClass,
          null,
          definitionHash(definition),
          at,
        );
      } else if (draft.action === 'edit') {
        const current = this.requiredMutableRoutine(draft.routineId, draft.expectedVersion);
        if (current.workspaceId !== input.workspaceId || current.channelId !== input.channelId) {
          throw confirmationError();
        }
        const definition = validateRoutineDefinition(draft.definition);
        if (current.state === 'active') {
          this.assertCapacity(
            current.workspaceId,
            current.channelId,
            draft.projectedDailyStarts,
            draft.reservations,
            current.id,
          );
        }
        const nextVersion = current.version + 1;
        this.db.run(
          `UPDATE routines SET name = ?, description = ?, task_text = ?, trigger_kind = ?,
             schedule_input = ?, schedule_json = ?, timezone = ?, output_policy = ?,
             authority_mode = ?, version = ?, next_run_at = ?, projected_daily_starts = ?,
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
          nextVersion,
          draft.nextRunAt,
          draft.projectedDailyStarts,
          JSON.stringify(draft.reservations),
          at,
          input.actorId,
          current.id,
          current.version,
        );
        if (current.state === 'active') this.replaceReservations(current.id, draft.reservations);
        this.insertRevision(
          current.id,
          nextVersion,
          definition,
          input.actorId,
          confirmation.actorClass,
          confirmation.id,
          at,
        );
        routine = required(this.getRoutine(current.id), 'Routine was not readable after edit.');
        this.appendRoutineAudit(
          input.idempotencyKey,
          'routine.edited',
          routine,
          input.actorId,
          confirmation.actorClass,
          definitionHash(current),
          definitionHash(definition),
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

  purgeConfirmations(): number {
    const cutoff = this.now() - ROUTINE_LIMITS.confirmationPurgeDelayMs;
    return this.db.run(
      `DELETE FROM routine_confirmations
       WHERE (consumed_at IS NOT NULL AND consumed_at < ?) OR expires_at < ?`,
      cutoff,
      cutoff,
    ).changes;
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

  listRevisions(routineId: string): RoutineRevision[] {
    return this.db
      .all(
        `SELECT * FROM routine_revisions WHERE routine_id = ? ORDER BY version`,
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
        (input.action === 'disable' && routine.state === 'disabled') ||
        (input.action === 'resume' && routine.state === 'active')
      ) {
        throw routineError('routine_transition_invalid', 'Routine state transition is invalid.');
      }
      if (input.action === 'resume') {
        const reservations = reservationRows(routine);
        this.assertCapacity(
          routine.workspaceId,
          routine.channelId,
          routine.projectedDailyStarts,
          reservations,
          routine.id,
        );
        this.replaceReservations(routine.id, reservations);
      } else {
        this.db.run('DELETE FROM routine_schedule_reservations WHERE routine_id = ?', routine.id);
      }
      const at = this.now();
      const nextVersion = routine.version + 1;
      this.db.run(
        `UPDATE routines SET state = ?, version = ?, updated_at = ?, updated_by = ?,
           paused_at = ?, paused_by = ?, paused_reason = ?, disabled_at = ?,
           disabled_by = ?, disabled_reason = ? WHERE id = ? AND version = ?`,
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
        (input.triggerSource === 'schedule' && routine.state !== 'active') ||
        (input.triggerSource === 'run_now' && routine.state === 'disabled')
      ) {
        throw routineError('routine_state_ineligible', 'Routine cannot create this occurrence.');
      }
      const revision = this.getRevision(routine.id, input.routineVersion);
      if (!revision?.definition) {
        throw routineError('routine_revision_not_found', 'Routine revision is unavailable.');
      }
      const status: RoutineRunStatus = input.skipReason ? 'skipped' : 'queued';
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
      return run;
  }

  getRun(occurrenceId: string): RoutineRun | undefined {
    const row = this.db.get('SELECT * FROM routine_runs WHERE id = ?', occurrenceId);
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
        `SELECT * FROM routine_runs ${where}
         ORDER BY scheduled_for DESC, id DESC LIMIT ?`,
        ...params,
        limit,
      )
      .map((row) => rowToRun(row as unknown as RunRow));
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
        else if (age > ROUTINE_LIMITS.admissionGraceMs) skipReason = 'admission_grace_expired';
        else if (activeCount >= ROUTINE_LIMITS.concurrentDeploymentRuns) {
          deferredCount += 1;
          continue;
        }
        const slotKey = scheduledOccurrenceKey(routine.id, due.latest);
        const run = this.insertOccurrence({
          runId: `rrun_${slotKey.slice(0, 32)}`,
          idempotencyKey: `routine:slot:${slotKey}`,
          routineId: routine.id,
          routineVersion: routine.version,
          scheduledFor: due.latest,
          triggerSource: 'schedule',
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
        this.db.run(
          `UPDATE routines SET next_run_at = ?, last_scheduled_at = ? WHERE id = ? AND version = ?`,
          due.next,
          due.latest,
          routine.id,
          routine.version,
        );
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
          occurrence_id, attempt, flue_run_id, invoke_started_at, receipt_at,
          visible_at, status, safe_error
        ) VALUES (?, ?, NULL, ?, NULL, NULL, 'attempting', NULL)`,
        input.occurrenceId,
        attempt,
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
        this.applyRoutineOutcome(run.routineId, 'failed', 'admission_unknown', input.at);
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
      !Number.isSafeInteger(input.startedAt)
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
      try {
        this.db.run(
          `UPDATE routine_runs SET status = 'running', flue_run_id = ?, admitted_at = COALESCE(admitted_at, ?),
             started_at = ?, admission_owner = NULL, admission_lease_until = NULL
           WHERE id = ? AND status = 'admitting'`,
          input.flueRunId,
          input.startedAt,
          input.startedAt,
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
            occurrence_id, attempt, flue_run_id, invoke_started_at, receipt_at,
            visible_at, status, safe_error
          ) VALUES (?, ?, ?, ?, ?, ?, 'attached', NULL)`,
          input.occurrenceId,
          nextAttempt,
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

  transitionRun(input: TransitionRoutineRunInput): RoutineRun {
    if (
      !isOpaqueRoutineId(input.occurrenceId) ||
      !Number.isSafeInteger(input.at) ||
      !Array.isArray(input.from) ||
      input.from.length < 1
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
      const finishedAt = TERMINAL_RUN_STATUSES.has(input.to) ? input.at : null;
      this.db.run(
        `UPDATE routine_runs SET status = ?, failure_class = ?, public_error = ?,
           finished_at = COALESCE(?, finished_at), admission_owner = NULL,
           admission_lease_until = NULL WHERE id = ? AND status = ?`,
        input.to,
        input.failureClass ?? null,
        publicError,
        finishedAt,
        run.id,
        run.status,
      );
      if (finishedAt !== null) this.applyRoutineOutcome(run.routineId, input.to, input.failureClass ?? null, input.at);
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
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL,
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
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, routine_id TEXT NOT NULL,
        routine_version INTEGER NOT NULL, scheduled_for INTEGER NOT NULL,
        trigger_source TEXT NOT NULL, requested_by TEXT, status TEXT NOT NULL,
        failure_class TEXT, public_error TEXT, admission_owner TEXT,
        admission_lease_until INTEGER, flue_run_id TEXT UNIQUE, queued_at INTEGER NOT NULL,
        admitted_at INTEGER, started_at INTEGER, finished_at INTEGER,
        resolved_access_hash TEXT, resolved_agent_id TEXT, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, cost_estimate REAL, cost_unit TEXT,
        deadline_at INTEGER NOT NULL, sandbox_session_id TEXT, tool_call_count INTEGER NOT NULL,
        delivery_status TEXT NOT NULL, delivery_lease_until INTEGER,
        delivery_channel_id TEXT, delivery_message_ts TEXT, change_key_hash TEXT,
        baseline_change_key_hash TEXT, suppressed_as_no_op INTEGER NOT NULL,
        skip_reason TEXT, missed_slot_count INTEGER NOT NULL, first_missed_at INTEGER,
        last_missed_at INTEGER, trace_id TEXT, revision_json TEXT, revision_hash TEXT NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS routine_runs_schedule_slot_unique
       ON routine_runs (routine_id, scheduled_for) WHERE trigger_source = 'schedule'`,
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
      `CREATE TABLE IF NOT EXISTS routine_run_admissions (
        occurrence_id TEXT NOT NULL, attempt INTEGER NOT NULL, flue_run_id TEXT UNIQUE,
        invoke_started_at INTEGER NOT NULL, receipt_at INTEGER, visible_at INTEGER,
        status TEXT NOT NULL, safe_error TEXT,
        PRIMARY KEY (occurrence_id, attempt)
      )`,
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
  }): void {
    const d = input.definition;
    this.db.run(
      `INSERT INTO routines (
        id, workspace_id, channel_id, creator_user_id, name, description, task_text,
        trigger_kind, schedule_input, schedule_json, timezone, output_policy,
        authority_mode, state, version, next_run_at, last_scheduled_at,
        last_finished_at, consecutive_failures, last_change_key_hash,
        projected_daily_starts, reservation_windows_json, created_at, created_by,
        updated_at, updated_by, paused_at, paused_by, paused_reason, disabled_at,
        disabled_by, disabled_reason, deleted_at, deleted_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, NULL,
                NULL, 0, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL,
                NULL, NULL, NULL)`,
      input.id,
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
  ): { first: number; latest: number; next: number; count: number } | null {
    if (routine.nextRunAt === null || routine.nextRunAt > now) return null;
    try {
      const first = routine.nextRunAt;
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
    projectedDailyStarts: number,
    reservations: RoutineScheduleReservation[],
    excludingRoutineId?: string,
  ): void {
    validateReservationInput(projectedDailyStarts, reservations);
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
    for (const reservation of reservations) {
      this.db.run(
        `INSERT INTO routine_schedule_reservations (routine_id, window_start, reserved_count)
         VALUES (?, ?, ?)`,
        routineId,
        reservation.windowStart,
        reservation.count,
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
      }),
      idempotencyKey,
    });
  }

  private applyRoutineOutcome(
    routineId: string,
    status: RoutineRunStatus,
    failureClass: RoutineRun['failureClass'],
    at: number,
  ): void {
    const routine = this.getRoutine(routineId);
    if (!routine || routine.deletedAt !== null) return;
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
      return;
    }
    if (failureClass === 'unknown_external_outcome') {
      this.db.run(
        `UPDATE routines SET state = 'paused', paused_at = ?, paused_by = NULL,
           paused_reason = ?, last_finished_at = ? WHERE id = ?`,
        at,
        failureClass,
        at,
        routineId,
      );
      this.db.run('DELETE FROM routine_schedule_reservations WHERE routine_id = ?', routineId);
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
      if (pause) this.db.run('DELETE FROM routine_schedule_reservations WHERE routine_id = ?', routineId);
      return;
    }
    this.db.run('UPDATE routines SET last_finished_at = ? WHERE id = ?', at, routineId);
  }

  private runByIdempotencyKey(idempotencyKey: string): RoutineRun | undefined {
    const row = this.db.get(
      'SELECT * FROM routine_runs WHERE idempotency_key = ?',
      idempotencyKey,
    );
    return row ? rowToRun(row as unknown as RunRow) : undefined;
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
    this.db.run(
      `INSERT INTO routine_run_admissions (
        occurrence_id, attempt, flue_run_id, invoke_started_at, receipt_at,
        visible_at, status, safe_error
      ) VALUES (?, ?, ?, ?, NULL, ?, 'superseded', NULL)`,
      occurrenceId,
      this.nextAdmissionNumber(occurrenceId),
      flueRunId,
      at,
      at,
    );
  }
}

/** Node backend: target-neutral routine logic over node:sqlite. */
export class SqliteRoutineStore implements RoutineStore {
  private readonly db: NodeStateDb;
  private readonly logic: RoutineStoreLogic;

  constructor(path: string = resolveStateDbPath(), now: () => number = Date.now) {
    this.db = openStateDb(path);
    this.db.exec('PRAGMA secure_delete = ON');
    this.logic = new RoutineStoreLogic(this.db, now);
  }

  close(): void {
    this.db.close();
  }

  async putConfirmation(input: PutRoutineConfirmationInput): Promise<RoutineConfirmation> {
    return this.logic.putConfirmation(input);
  }
  async getConfirmation(tokenHash: string): Promise<RoutineConfirmation | undefined> {
    return this.logic.getConfirmation(tokenHash);
  }
  async confirm(input: ConfirmRoutineInput): Promise<RoutineDefinition> {
    return this.logic.confirm(input);
  }
  async purgeConfirmations(): Promise<number> {
    return this.logic.purgeConfirmations();
  }
  async getRoutine(routineId: string): Promise<RoutineDefinition | undefined> {
    return this.logic.getRoutine(routineId);
  }
  async listRoutines(workspaceId?: string, channelId?: string): Promise<RoutineDefinition[]> {
    return this.logic.listRoutines(workspaceId, channelId);
  }
  async listRevisions(routineId: string): Promise<RoutineRevision[]> {
    return this.logic.listRevisions(routineId);
  }
  async control(input: ControlRoutineInput): Promise<RoutineDefinition> {
    return this.logic.control(input);
  }
  async createOccurrence(input: CreateRoutineOccurrenceInput): Promise<RoutineRun> {
    return this.logic.createOccurrence(input);
  }
  async getRun(occurrenceId: string): Promise<RoutineRun | undefined> {
    return this.logic.getRun(occurrenceId);
  }
  async listRuns(filter: RoutineRunFilter = {}): Promise<RoutineRun[]> {
    return this.logic.listRuns(filter);
  }
  async claimDueSchedules(input: ClaimDueRoutinesInput): Promise<RoutineDueClaimBatch> {
    return this.logic.claimDueSchedules(input);
  }
  async startAdmissionAttempt(input: StartRoutineAdmissionInput): Promise<RoutineAdmissionAttempt> {
    return this.logic.startAdmissionAttempt(input);
  }
  async recordAdmissionReceipt(
    occurrenceId: string,
    attempt: number,
    flueRunId: string,
    receiptAt: number,
  ): Promise<RoutineAdmissionAttempt> {
    return this.logic.recordAdmissionReceipt(occurrenceId, attempt, flueRunId, receiptAt);
  }
  async resolveAdmission(input: ResolveRoutineAdmissionInput): Promise<RoutineRun> {
    return this.logic.resolveAdmission(input);
  }
  async beginOccurrence(input: BeginRoutineOccurrenceInput): Promise<'started' | 'superseded'> {
    return this.logic.beginOccurrence(input);
  }
  async transitionRun(input: TransitionRoutineRunInput): Promise<RoutineRun> {
    return this.logic.transitionRun(input);
  }
  async listAdmissions(occurrenceId: string): Promise<RoutineAdmissionAttempt[]> {
    return this.logic.listAdmissions(occurrenceId);
  }
  async listAuditEvents(filter: AuditEventFilter = {}): Promise<AuditEvent[]> {
    return this.logic.listAuditEvents(filter);
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
  validateReservationInput(draft.projectedDailyStarts, draft.reservations);
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
    (input.triggerSource === 'schedule' && input.requestedBy != null) ||
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
): void {
  if (
    !Number.isSafeInteger(projectedDailyStarts) ||
    projectedDailyStarts < 1 ||
    projectedDailyStarts > ROUTINE_LIMITS.scheduledStartsPerDay ||
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
  return {
    routineId: row.routine_id,
    version: row.version,
    definition: row.definition_json ? JSON.parse(row.definition_json) as RoutineDefinitionContent : null,
    definitionHash: row.definition_hash,
    actorId: row.actor_id,
    actorClass: row.actor_class,
    confirmationId: row.confirmation_id,
    createdAt: row.created_at,
  };
}

function rowToRun(row: RunRow): RoutineRun {
  return {
    id: row.id,
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
    queuedAt: row.queued_at,
    admittedAt: row.admitted_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    resolvedAccessHash: row.resolved_access_hash,
    resolvedAgentId: row.resolved_agent_id,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    costEstimate: row.cost_estimate,
    costUnit: row.cost_unit,
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
    flueRunId: row.flue_run_id,
    invokeStartedAt: row.invoke_started_at,
    receiptAt: row.receipt_at,
    visibleAt: row.visible_at,
    status: row.status,
    safeError: row.safe_error,
  };
}

function reservationRows(routine: RoutineDefinition): RoutineScheduleReservation[] {
  return routine.reservationWindows;
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
    admitting: ['running', 'failed', 'superseded', 'cancelled'],
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
