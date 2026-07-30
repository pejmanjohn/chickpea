import { createHash, randomUUID } from 'node:crypto';

import { AuditStoreLogic } from '../audit/store.ts';
import type { AuditEvent } from '../audit/types.ts';
import { isCompiledModelProfileId } from '../model-catalog/profiles.ts';
import { openStateDb, resolveStateDbPath, type NodeStateDb } from '../state/node-state-db.ts';
import { inspectStateDbIntegrity, type StateDb } from '../state/state-db.ts';
import { installWorkMigrations } from './migrations.ts';
import { runBodyExpiry } from './retention.ts';
import {
  WorkStateError,
  type AdmitRunInput,
  type BindingRecord,
  type CreateBindingInput,
  type CreateRunExecutionInput,
  type CreateWorkGraphInput,
  type CreateWorkInput,
  type EffectiveConfigRevision,
  type EffectiveConfigRevisionId,
  type LedgerContentRecord,
  type LedgerContentRef,
  type PutLedgerContentInput,
  type QuarantineRunInput,
  type RequireRunRecoveryInput,
  type RunExecutionRecord,
  type RunExecutionRouteInput,
  type RunId,
  type RunRecord,
  type SafeEffectiveConfigInput,
  type WorkId,
  type WorkIntegrityReport,
  type WorkPurgeResult,
  type WorkRecord,
  type WorkRpcRequest,
  type WorkRpcResponse,
  type WorkStore,
  type BindingId,
  type RunExecutionId,
} from './types.ts';

interface WorkStoreOptions {
  now?: () => number;
  env?: Record<string, string | undefined>;
}

const SAFE_DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z][a-z0-9_-]{7,127}$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SAFE_REASON = /^[a-z][a-z0-9_]{2,63}$/;
const MAX_CONTENT_BYTES = 262_144;

export class WorkStoreLogic {
  private readonly audit: AuditStoreLogic;
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;

  constructor(
    private readonly db: StateDb,
    options: WorkStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
    installWorkMigrations(db);
    this.audit = new AuditStoreLogic(db);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS audit_work_action_status_unique
       ON audit_events (json_extract(metadata_json, '$.actionAttemptId'), event_type)
       WHERE domain = 'work' AND event_type IN (
         'work.action_denied', 'work.action_started', 'work.action_succeeded',
         'work.action_failed', 'work.action_unknown'
       )`,
    );
    const integrity = this.verifyIntegrity();
    if (!integrity.foreignKeysEnabled || integrity.foreignKeyViolationCount > 0) {
      throw workError('work_integrity_failed', 'Work ledger foreign-key integrity failed.');
    }
  }

  execute(request: WorkRpcRequest): WorkRpcResponse {
    switch (request.kind) {
      case 'put_config_revision':
        return {
          kind: 'config_revision',
          revision: this.putConfigRevision(request.input, request.createdAt),
        };
      case 'get_config_revision':
        return {
          kind: 'config_revision',
          revision: this.getConfigRevision(request.revisionId) ?? null,
        };
      case 'put_content':
        return { kind: 'content', content: this.putContent(request.input) };
      case 'get_content':
        return { kind: 'content', content: this.getContent(request.ref, request.at) ?? null };
      case 'purge_content':
        return { kind: 'purge', result: this.purgeContent(request.at, request.limit) };
      case 'create_graph': {
        const graph = this.createGraph(request.input);
        return { kind: 'graph', ...graph };
      }
      case 'get_work':
        return { kind: 'work', work: this.getWork(request.workId) ?? null };
      case 'get_binding':
        return { kind: 'binding', binding: this.getBinding(request.bindingId) ?? null };
      case 'get_run':
        return { kind: 'run', run: this.getRun(request.runId) ?? null };
      case 'create_execution':
        return { kind: 'execution', execution: this.createRunExecution(request.input) };
      case 'record_execution_route':
        return {
          kind: 'execution',
          execution: this.recordRunExecutionRoute(request.input),
        };
      case 'get_execution':
        return {
          kind: 'execution',
          execution: this.getRunExecution(request.executionId) ?? null,
        };
      case 'require_recovery':
        return { kind: 'run', run: this.requireRecovery(request.input) };
      case 'quarantine_run':
        return { kind: 'run', run: this.quarantineRun(request.input) };
      case 'list_audit_events':
        return {
          kind: 'audit_events',
          events: this.listAuditEvents(request.runId, request.limit),
        };
      case 'verify_integrity':
        return { kind: 'integrity', report: this.verifyIntegrity() };
    }
  }

  putConfigRevision(
    input: SafeEffectiveConfigInput,
    createdAt = this.now(),
  ): EffectiveConfigRevision {
    const canonicalJson = canonicalSafeConfig(input);
    const digest = sha256(canonicalJson);
    const id = `config_${digest}` as EffectiveConfigRevisionId;
    assertTimestamp(createdAt, 'Config revision creation time');
    return this.db.transaction(() => {
      const byDigest = this.db.get(
        'SELECT * FROM effective_config_revisions WHERE digest = ?',
        digest,
      );
      if (byDigest) {
        const existing = rowToConfig(byDigest);
        if (existing.canonicalJson !== canonicalJson || existing.id !== id) {
          throw workError(
            'work_config_digest_conflict',
            'Safe configuration digest belongs to different canonical bytes.',
          );
        }
        return existing;
      }
      this.db.run(
        `INSERT INTO effective_config_revisions (
          id, canonical_json, digest, schema_version, created_at
        ) VALUES (?, ?, ?, 1, ?)`,
        id,
        canonicalJson,
        digest,
        createdAt,
      );
      return requiredConfig(this.getConfigRevision(id));
    });
  }

  getConfigRevision(id: EffectiveConfigRevisionId): EffectiveConfigRevision | undefined {
    const row = this.db.get('SELECT * FROM effective_config_revisions WHERE id = ?', id);
    return row ? rowToConfig(row) : undefined;
  }

  putContent(input: PutLedgerContentInput): LedgerContentRecord {
    assertExactKeys(input, ['sensitivity', 'body', 'createdAt'], 'Ledger content');
    if (!['public', 'private'].includes(input.sensitivity)) {
      throw workError('work_content_invalid', 'Ledger content sensitivity is invalid.');
    }
    if (typeof input.body !== 'string') {
      throw workError('work_content_invalid', 'Ledger content body is invalid.');
    }
    const byteSize = Buffer.byteLength(input.body, 'utf8');
    if (byteSize < 1 || byteSize > MAX_CONTENT_BYTES) {
      throw workError(
        'work_content_invalid',
        `Ledger content must contain 1 to ${MAX_CONTENT_BYTES} UTF-8 bytes.`,
      );
    }
    const createdAt = input.createdAt ?? this.now();
    assertTimestamp(createdAt, 'Ledger content creation time');
    const ref = `content_${randomUUID()}` as LedgerContentRef;
    const expiresAt = runBodyExpiry(createdAt, this.env);
    this.db.run(
      `INSERT INTO ledger_content (
        ref, schema_version, sensitivity, expires_at, body, byte_size, created_at, purged_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, NULL)`,
      ref,
      input.sensitivity,
      expiresAt,
      input.body,
      byteSize,
      createdAt,
    );
    return requiredContent(this.getContent(ref, createdAt));
  }

  getContent(ref: LedgerContentRef, at = this.now()): LedgerContentRecord | undefined {
    assertTimestamp(at, 'Ledger content read time');
    const row = this.db.get(
      `SELECT * FROM ledger_content
       WHERE ref = ? AND purged_at IS NULL AND expires_at > ?`,
      ref,
      at,
    );
    return row ? rowToContent(row) : undefined;
  }

  purgeContent(at = this.now(), limit = 100): WorkPurgeResult {
    assertTimestamp(at, 'Ledger content purge time');
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    return this.db.transaction(() => {
      const expired = this.db.all(
        `SELECT ref FROM ledger_content
         WHERE purged_at IS NULL AND expires_at <= ?
         ORDER BY expires_at, ref LIMIT ?`,
        at,
        boundedLimit,
      );
      for (const row of expired) {
        this.db.run(
          `UPDATE ledger_content SET body = NULL, byte_size = 0, purged_at = ?
           WHERE ref = ? AND purged_at IS NULL AND expires_at <= ?`,
          at,
          String(row.ref),
          at,
        );
      }
      const remaining = this.db.get(
        `SELECT COUNT(*) AS count FROM ledger_content
         WHERE purged_at IS NULL AND expires_at <= ?`,
        at,
      );
      return {
        purgedCount: expired.length,
        remainingExpiredCount: Number(remaining?.count ?? 0),
      };
    });
  }

  createGraph(input: CreateWorkGraphInput): {
    work: WorkRecord;
    binding: BindingRecord;
    run: RunRecord;
  } {
    validateGraph(input);
    return this.db.transaction(() => {
      const existing = this.getRun(input.run.id);
      if (existing) {
        const work = this.getWork(input.work.id);
        const binding = this.getBinding(input.binding.id);
        const audit = this.audit.findByIdempotencyKey(input.auditIdempotencyKey);
        if (
          work &&
          binding &&
          audit?.eventId === input.auditEventId &&
          sameWork(work, input.work) &&
          sameBinding(binding, input.binding) &&
          sameAdmittedRun(existing, input.run)
        ) {
          return { work, binding, run: existing };
        }
        throw workError('work_admission_conflict', 'Run identity belongs to different work.');
      }
      if (input.run.triggerContentRef) {
        const content = this.getContent(input.run.triggerContentRef, input.run.createdAt);
        if (!content) {
          throw workError('work_reference_invalid', 'Trigger content is unavailable.');
        }
        if (content.sensitivity === 'private' && input.work.maximumSensitivity !== 'private') {
          throw workError(
            'work_sensitivity_invalid',
            'Private content requires a private Work sensitivity ceiling.',
          );
        }
      }
      this.insertWork(input.work);
      this.insertBinding(input.binding);
      this.insertRun(input.run);
      this.audit.append({
        eventId: input.auditEventId,
        domain: 'work',
        eventType: 'work.run_admitted',
        outcome: 'success',
        actorClass: input.run.actorTrustTier,
        actorId: input.run.actorRef ?? null,
        subjectId: input.run.id,
        subjectVersion: 1,
        createdAt: input.run.createdAt,
        metadataJson: JSON.stringify({
          bindingId: input.binding.id,
          runId: input.run.id,
          workId: input.work.id,
        }),
        idempotencyKey: input.auditIdempotencyKey,
      });
      return {
        work: requiredWork(this.getWork(input.work.id)),
        binding: requiredBinding(this.getBinding(input.binding.id)),
        run: requiredRun(this.getRun(input.run.id)),
      };
    });
  }

  getWork(id: WorkId): WorkRecord | undefined {
    const row = this.db.get('SELECT * FROM works WHERE id = ?', id);
    return row ? rowToWork(row) : undefined;
  }

  getBinding(id: BindingId): BindingRecord | undefined {
    const row = this.db.get('SELECT * FROM bindings WHERE id = ?', id);
    return row ? rowToBinding(row) : undefined;
  }

  getRun(id: RunId): RunRecord | undefined {
    const row = this.db.get('SELECT * FROM runs WHERE id = ?', id);
    return row ? rowToRun(row) : undefined;
  }

  createRunExecution(input: CreateRunExecutionInput): RunExecutionRecord {
    validateExecutionInput(input);
    return this.db.transaction(() => {
      const existing = this.getRunExecution(input.id);
      if (existing) {
        if (sameExecution(existing, input)) return existing;
        throw workError(
          'work_execution_conflict',
          'Run execution ID belongs to a different attempt.',
        );
      }
      const run = requiredRun(this.getRun(input.runId));
      if (run.status !== 'input_ready' || !run.preparedInputRef) {
        throw workError(
          'work_execution_not_ready',
          'Run execution requires durable prepared input.',
        );
      }
      if (input.fencingToken <= run.fencingToken) {
        throw workError('work_fence_stale', 'Run execution fencing token is stale.');
      }
      this.db.run(
        `INSERT INTO run_executions (
          id, run_id, attempt_number, fencing_token, executor_kind, agent_name,
          flue_instance_ref, flue_submission_ref, canonical_model,
          provider_auth_route, catalog_source, catalog_revision, catalog_digest,
          compiled_profile, model_credential_ref, model_credential_version,
          model_invocation_status, started_at, finished_at, raw_settlement_ref,
          raw_settlement_status, outcome, safe_disagreement_code, safe_failure_code
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL,
                  NULL, NULL, 'not_invoked', ?, NULL, NULL, NULL, 'pending', NULL, NULL)`,
        input.id,
        input.runId,
        input.attemptNumber,
        input.fencingToken,
        input.executorKind,
        input.agentName,
        input.canonicalModel,
        input.startedAt,
      );
      this.db.run(
        `UPDATE runs SET status = 'executing', fencing_token = ?, updated_at = ?
         WHERE id = ? AND status = 'input_ready' AND fencing_token < ?`,
        input.fencingToken,
        input.startedAt,
        input.runId,
        input.fencingToken,
      );
      return requiredExecution(this.getRunExecution(input.id));
    });
  }

  recordRunExecutionRoute(input: RunExecutionRouteInput): RunExecutionRecord {
    validateRouteInput(input);
    return this.db.transaction(() => {
      const execution = requiredExecution(this.getRunExecution(input.executionId));
      if (execution.modelInvocationStatus !== 'not_invoked') {
        if (sameRoute(execution, input)) return execution;
        throw workError('work_route_conflict', 'Run execution route is already immutable.');
      }
      this.db.run(
        `UPDATE run_executions SET
          provider_auth_route = ?, catalog_source = ?, catalog_revision = ?,
          catalog_digest = ?, compiled_profile = ?, model_credential_ref = ?,
          model_credential_version = ?, model_invocation_status = 'ready'
         WHERE id = ? AND model_invocation_status = 'not_invoked'`,
        input.providerAuthRoute ?? null,
        input.catalogSource ?? null,
        input.catalogRevision ?? null,
        input.catalogDigest ?? null,
        input.compiledProfile ?? null,
        input.modelCredentialRef ?? null,
        input.modelCredentialVersion ?? null,
        input.executionId,
      );
      return requiredExecution(this.getRunExecution(input.executionId));
    });
  }

  getRunExecution(id: RunExecutionId): RunExecutionRecord | undefined {
    const row = this.db.get('SELECT * FROM run_executions WHERE id = ?', id);
    return row ? rowToExecution(row) : undefined;
  }

  requireRecovery(input: RequireRunRecoveryInput): RunRecord {
    validateRecoveryInput(input);
    return this.db.transaction(() => {
      const run = requiredRun(this.getRun(input.runId));
      const existingAudit = this.audit.findByIdempotencyKey(input.auditIdempotencyKey);
      if (existingAudit) {
        if (
          existingAudit.eventId === input.auditEventId &&
          run.status === 'recovery_required' &&
          run.safeFailureCode === input.safeFailureCode
        ) return run;
        throw workError('work_recovery_conflict', 'Recovery identity belongs to another request.');
      }
      if (run.status === 'settled') {
        throw workError('work_transition_invalid', 'A settled Run cannot require recovery.');
      }
      this.db.run(
        `UPDATE runs SET status = 'recovery_required', safe_failure_code = ?,
           lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
        input.safeFailureCode,
        input.at,
        input.runId,
      );
      this.audit.append({
        eventId: input.auditEventId,
        domain: 'work',
        eventType: 'work.run_recovery_required',
        outcome: 'failure',
        actorClass: 'system',
        subjectId: input.runId,
        subjectVersion: 1,
        createdAt: input.at,
        reasonCode: input.safeFailureCode,
        metadataJson: JSON.stringify({ runId: input.runId }),
        idempotencyKey: input.auditIdempotencyKey,
      });
      return requiredRun(this.getRun(input.runId));
    });
  }

  quarantineRun(input: QuarantineRunInput): RunRecord {
    validateQuarantineInput(input);
    return this.db.transaction(() => {
      const run = requiredRun(this.getRun(input.runId));
      const existing = this.audit.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        const metadata = parseObject(existing.metadataJson);
        if (
          existing.eventType === 'work.run_quarantined' &&
          existing.subjectId === input.runId &&
          metadata.requestId === input.requestId &&
          run.terminalDisposition === 'quarantined'
        ) return run;
        throw workError('work_recovery_conflict', 'Quarantine identity belongs to another request.');
      }
      if (run.status !== 'recovery_required') {
        throw workError(
          'work_transition_invalid',
          'Only a recovery-required Run may be quarantined.',
        );
      }
      this.db.run(
        `UPDATE runs SET status = 'settled', terminal_disposition = 'quarantined',
           recovery_resolution_kind = 'quarantine', recovery_admin_credential_id = ?,
           recovery_operator_label = ?, recovery_auth_origin = ?, recovery_reason_code = ?,
           recovery_request_id = ?, recovery_resolved_at = ?, settled_at = ?, updated_at = ?,
           lease_owner = NULL, lease_until = NULL
         WHERE id = ? AND status = 'recovery_required'`,
        input.adminCredentialId,
        input.operatorLabel,
        input.authOrigin,
        input.safeReasonCode,
        input.requestId,
        input.resolvedAt,
        input.resolvedAt,
        input.resolvedAt,
        input.runId,
      );
      this.audit.append({
        eventId: `work:quarantine:${input.requestId}`,
        domain: 'work',
        eventType: 'work.run_quarantined',
        outcome: 'success',
        actorClass: 'operator',
        actorId: null,
        subjectId: input.runId,
        subjectVersion: 1,
        createdAt: input.resolvedAt,
        reasonCode: input.safeReasonCode,
        metadataJson: JSON.stringify({
          adminCredentialId: input.adminCredentialId,
          authOrigin: input.authOrigin,
          operatorLabel: input.operatorLabel,
          requestId: input.requestId,
          runId: input.runId,
        }),
        idempotencyKey: input.idempotencyKey,
      });
      return requiredRun(this.getRun(input.runId));
    });
  }

  listAuditEvents(runId: RunId, limit = 100): AuditEvent[] {
    return this.audit.list({ domain: 'work', subjectId: runId, limit });
  }

  verifyIntegrity(): WorkIntegrityReport {
    const { foreignKeysEnabled, foreignKeyViolationCount } = inspectStateDbIntegrity(this.db);
    let invariantViolationCount = 0;
    for (const query of [
      `SELECT COUNT(*) AS count FROM runs r
       LEFT JOIN bindings b ON b.id = r.binding_id AND b.work_id = r.work_id
       WHERE b.id IS NULL`,
      `SELECT COUNT(*) AS count FROM runs
       WHERE (status = 'settled') <> (terminal_disposition IS NOT NULL)`,
      `SELECT COUNT(*) AS count FROM run_executions e
       LEFT JOIN runs r ON r.id = e.run_id WHERE r.id IS NULL`,
      tableExists(this.db, 'routines')
        ? `SELECT COUNT(*) AS count FROM routines d
           LEFT JOIN works w ON w.id = d.work_id
           LEFT JOIN bindings b ON b.id = d.binding_id
           WHERE (d.work_id IS NOT NULL AND w.id IS NULL) OR
                 (d.binding_id IS NOT NULL AND (b.id IS NULL OR b.work_id <> d.work_id))`
        : 'SELECT 0 AS count',
      tableExists(this.db, 'routine_runs') && tableExists(this.db, 'routines')
        ? `SELECT COUNT(*) AS count FROM routine_runs rr
           LEFT JOIN routines d ON d.id = rr.routine_id
           LEFT JOIN runs r ON r.id = rr.canonical_run_id
           WHERE rr.canonical_run_id IS NOT NULL AND
                 (r.id IS NULL OR d.id IS NULL OR d.work_id IS NULL OR r.work_id <> d.work_id)`
        : 'SELECT 0 AS count',
      tableExists(this.db, 'usage_operations')
        ? `SELECT COUNT(*) AS count FROM usage_operations u
           LEFT JOIN runs r ON r.id = u.run_id
           WHERE u.run_id IS NOT NULL AND r.id IS NULL`
        : 'SELECT 0 AS count',
      tableExists(this.db, 'usage_measurements')
        ? `SELECT COUNT(*) AS count FROM usage_measurements m
           LEFT JOIN run_executions e ON e.id = m.run_execution_id
           WHERE m.run_execution_id IS NOT NULL AND e.id IS NULL`
        : 'SELECT 0 AS count',
      tableExists(this.db, 'usage_measurements') && tableExists(this.db, 'usage_operations')
        ? `SELECT COUNT(*) AS count FROM usage_measurements m
           JOIN usage_operations u ON u.operation_id = m.operation_id
           JOIN run_executions e ON e.id = m.run_execution_id
           WHERE m.run_execution_id IS NOT NULL AND
                 (u.run_id IS NULL OR u.run_id <> e.run_id)`
        : 'SELECT 0 AS count',
      `SELECT COUNT(*) AS count FROM audit_events a
       LEFT JOIN runs r ON r.id = json_extract(a.metadata_json, '$.runId')
       LEFT JOIN run_executions e ON e.id = json_extract(a.metadata_json, '$.runExecutionId')
       WHERE a.domain = 'work' AND a.event_type IN (
         'work.action_denied', 'work.action_started', 'work.action_succeeded',
         'work.action_failed', 'work.action_unknown'
       ) AND (r.id IS NULL OR e.id IS NULL OR a.subject_id <> r.id)`,
      `SELECT COUNT(*) AS count FROM audit_events started
       JOIN runs r ON r.id = json_extract(started.metadata_json, '$.runId')
       WHERE started.domain = 'work' AND started.event_type = 'work.action_started'
         AND r.status IN ('settled', 'recovery_required')
         AND NOT EXISTS (
           SELECT 1 FROM audit_events outcome
           WHERE outcome.domain = 'work'
             AND outcome.event_type IN (
               'work.action_succeeded', 'work.action_failed', 'work.action_unknown'
             )
             AND json_extract(outcome.metadata_json, '$.actionAttemptId') =
                 json_extract(started.metadata_json, '$.actionAttemptId')
         )`,
    ]) {
      invariantViolationCount += Number(this.db.get(query)?.count ?? 0);
    }
    return { foreignKeysEnabled, foreignKeyViolationCount, invariantViolationCount };
  }

  private insertWork(input: CreateWorkInput): void {
    this.db.run(
      `INSERT INTO works (
        id, kind, lifecycle, maximum_sensitivity, created_at, updated_at, closed_at
      ) VALUES (?, ?, 'open', ?, ?, ?, NULL)`,
      input.id,
      input.kind,
      input.maximumSensitivity,
      input.createdAt,
      input.createdAt,
    );
  }

  private insertBinding(input: CreateBindingInput): void {
    this.db.run(
      `INSERT INTO bindings (
        id, work_id, adapter_kind, external_account_id, external_conversation_id,
        generation, lifecycle, source_visibility, config_mode,
        pinned_config_revision_id, ordering_key, created_at, expired_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL)`,
      input.id,
      input.workId,
      input.adapterKind,
      input.externalAccountId,
      input.externalConversationId,
      input.generation,
      input.sourceVisibility,
      input.configMode,
      input.pinnedConfigRevisionId ?? null,
      input.orderingKey,
      input.createdAt,
    );
  }

  private insertRun(input: AdmitRunInput): void {
    this.db.run(
      `INSERT INTO runs (
        id, work_id, binding_id, kind, admission_sequence, trigger_kind, trigger_ref,
        dedupe_key, actor_ref, actor_trust_tier, source_context_watermark,
        trigger_content_ref, prepared_input_ref, config_revision_id,
        effective_capability_digest, execution_authority, coordinator_kind,
        authority_epoch, policy_approved_output_ref, rendered_payload_ref, status,
        terminal_disposition, delivery_status, delivery_method, delivery_attempt_id,
        delivery_ref, delivery_finalized_at, lease_owner, lease_until, fencing_token,
        safe_failure_code, recovery_resolution_kind, recovery_admin_credential_id,
        recovery_operator_label, recovery_auth_origin, recovery_reason_code,
        recovery_request_id, recovery_resolved_at, created_at, updated_at, settled_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL,
        'admitted', NULL, 'not_ready', NULL, NULL, NULL, NULL, NULL, NULL, 0,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
      )`,
      input.id,
      input.workId,
      input.bindingId,
      input.kind,
      input.admissionSequence,
      input.triggerKind,
      input.triggerRef,
      input.dedupeKey,
      input.actorRef ?? null,
      input.actorTrustTier,
      input.sourceContextWatermark ?? null,
      input.triggerContentRef ?? null,
      input.configRevisionId,
      input.effectiveCapabilityDigest,
      input.executionAuthority,
      input.coordinatorKind,
      input.authorityEpoch,
      input.createdAt,
      input.createdAt,
    );
  }
}

export class SqliteWorkStore implements WorkStore {
  private readonly db: NodeStateDb;
  private readonly logic: WorkStoreLogic;

  constructor(
    path: string = resolveStateDbPath(),
    options: WorkStoreOptions = {},
  ) {
    this.db = openStateDb(path);
    this.logic = new WorkStoreLogic(this.db, options);
  }

  close(): void {
    this.db.close();
  }

  async putConfigRevision(input: SafeEffectiveConfigInput, createdAt?: number) {
    return this.logic.putConfigRevision(input, createdAt);
  }
  async getConfigRevision(id: EffectiveConfigRevisionId) {
    return this.logic.getConfigRevision(id);
  }
  async putContent(input: PutLedgerContentInput) {
    return this.logic.putContent(input);
  }
  async getContent(ref: LedgerContentRef, at?: number) {
    return this.logic.getContent(ref, at);
  }
  async purgeContent(at?: number, limit?: number) {
    return this.logic.purgeContent(at, limit);
  }
  async createGraph(input: CreateWorkGraphInput) {
    return this.logic.createGraph(input);
  }
  async getWork(id: WorkId) {
    return this.logic.getWork(id);
  }
  async getBinding(id: BindingId) {
    return this.logic.getBinding(id);
  }
  async getRun(id: RunId) {
    return this.logic.getRun(id);
  }
  async createRunExecution(input: CreateRunExecutionInput) {
    return this.logic.createRunExecution(input);
  }
  async recordRunExecutionRoute(input: RunExecutionRouteInput) {
    return this.logic.recordRunExecutionRoute(input);
  }
  async getRunExecution(id: RunExecutionId) {
    return this.logic.getRunExecution(id);
  }
  async requireRecovery(input: RequireRunRecoveryInput) {
    return this.logic.requireRecovery(input);
  }
  async quarantineRun(input: QuarantineRunInput) {
    return this.logic.quarantineRun(input);
  }
  async listAuditEvents(runId: RunId, limit?: number) {
    return this.logic.listAuditEvents(runId, limit);
  }
  async verifyIntegrity() {
    return this.logic.verifyIntegrity();
  }
}

function canonicalSafeConfig(input: SafeEffectiveConfigInput): string {
  assertExactKeys(
    input,
    [
      'schemaVersion',
      'profileId',
      'configuredModel',
      'snapshotDigest',
      'capabilityDigest',
      'skillNames',
      'connectionIds',
      'repositoryIds',
      'memoryMode',
      'ceilings',
    ],
    'Safe configuration',
  );
  if (input.schemaVersion !== 1) {
    throw workError('work_config_invalid', 'Safe configuration schema version is invalid.');
  }
  assertSafeRef(input.profileId, 'Profile ID');
  assertSafeModel(input.configuredModel);
  assertDigest(input.snapshotDigest, 'Snapshot digest');
  assertDigest(input.capabilityDigest, 'Capability digest');
  if (!['disabled', 'public', 'private', 'mixed'].includes(input.memoryMode)) {
    throw workError('work_config_invalid', 'Safe configuration memory mode is invalid.');
  }
  const ceilings = input.ceilings;
  assertPlainObject(ceilings, 'Capability ceilings');
  assertExactKeys(
    ceilings,
    ['maxModelAttempts', 'maxToolCalls', 'maxActionAttempts', 'timeoutMs'],
    'Capability ceilings',
  );
  const normalizedCeilings = {
    maxModelAttempts: boundedInteger(ceilings.maxModelAttempts, 1, 20, 'maxModelAttempts'),
    maxToolCalls: boundedInteger(ceilings.maxToolCalls, 0, 1_000, 'maxToolCalls'),
    maxActionAttempts: boundedInteger(ceilings.maxActionAttempts, 0, 100, 'maxActionAttempts'),
    timeoutMs: boundedInteger(ceilings.timeoutMs, 1_000, 15 * 60_000, 'timeoutMs'),
  };
  const canonical = {
    schemaVersion: 1,
    profileId: input.profileId,
    configuredModel: input.configuredModel,
    snapshotDigest: input.snapshotDigest,
    capabilityDigest: input.capabilityDigest,
    skillNames: canonicalRefs(input.skillNames, 'Skill names'),
    connectionIds: canonicalRefs(input.connectionIds, 'Connection IDs'),
    repositoryIds: canonicalRefs(input.repositoryIds, 'Repository IDs'),
    memoryMode: input.memoryMode,
    ceilings: normalizedCeilings,
  };
  rejectSecretBearingValue(canonical);
  return JSON.stringify(canonical);
}

function validateGraph(input: CreateWorkGraphInput): void {
  assertExactKeys(
    input,
    ['work', 'binding', 'run', 'auditEventId', 'auditIdempotencyKey'],
    'Work graph',
  );
  validateWorkInput(input.work);
  validateBindingInput(input.binding);
  validateRunInput(input.run);
  if (input.binding.workId !== input.work.id || input.run.workId !== input.work.id) {
    throw workError('work_reference_invalid', 'Work graph IDs do not share one Work.');
  }
  if (input.run.bindingId !== input.binding.id) {
    throw workError('work_reference_invalid', 'Run does not reference the graph Binding.');
  }
  if (
    input.binding.sourceVisibility !== 'public' &&
    input.work.maximumSensitivity !== 'private'
  ) {
    throw workError(
      'work_sensitivity_invalid',
      'Non-public Bindings require a private Work sensitivity ceiling.',
    );
  }
  if (
    (input.binding.sourceVisibility === 'unknown' || input.run.actorTrustTier === 'unknown') &&
    input.run.triggerContentRef
  ) {
    throw workError(
      'work_content_forbidden',
      'Unknown source or actor authority cannot persist trigger content.',
    );
  }
  assertSafeRef(input.auditEventId, 'Audit event ID');
  assertSafeRef(input.auditIdempotencyKey, 'Audit idempotency key');
}

function validateWorkInput(input: CreateWorkInput): void {
  assertExactKeys(input, ['id', 'kind', 'maximumSensitivity', 'createdAt'], 'Work');
  assertOpaqueId(input.id, 'Work ID');
  if (!['conversation', 'routine', 'web_admin'].includes(input.kind)) {
    throw workError('work_input_invalid', 'Work kind is invalid.');
  }
  if (!['public', 'private'].includes(input.maximumSensitivity)) {
    throw workError('work_input_invalid', 'Work sensitivity is invalid.');
  }
  assertTimestamp(input.createdAt, 'Work creation time');
}

function validateBindingInput(input: CreateBindingInput): void {
  assertExactKeys(
    input,
    [
      'id',
      'workId',
      'adapterKind',
      'externalAccountId',
      'externalConversationId',
      'generation',
      'sourceVisibility',
      'configMode',
      'pinnedConfigRevisionId',
      'orderingKey',
      'createdAt',
    ],
    'Binding',
  );
  assertOpaqueId(input.id, 'Binding ID');
  assertOpaqueId(input.workId, 'Binding Work ID');
  if (!['slack', 'routine', 'web_admin', 'conformance'].includes(input.adapterKind)) {
    throw workError('work_input_invalid', 'Binding adapter kind is invalid.');
  }
  assertSafeRef(input.externalAccountId, 'External account ID');
  assertSafeRef(input.externalConversationId, 'External conversation ID');
  boundedInteger(input.generation, 1, Number.MAX_SAFE_INTEGER, 'Binding generation');
  if (!['public', 'private', 'unknown'].includes(input.sourceVisibility)) {
    throw workError('work_input_invalid', 'Binding source visibility is invalid.');
  }
  if (!['frozen_on_open', 'resolve_each_run'].includes(input.configMode)) {
    throw workError('work_input_invalid', 'Binding configuration mode is invalid.');
  }
  if (input.pinnedConfigRevisionId !== undefined && input.pinnedConfigRevisionId !== null) {
    assertOpaqueId(input.pinnedConfigRevisionId, 'Pinned config revision ID');
  }
  assertSafeRef(input.orderingKey, 'Binding ordering key');
  assertTimestamp(input.createdAt, 'Binding creation time');
}

function validateRunInput(input: AdmitRunInput): void {
  assertExactKeys(
    input,
    [
      'id',
      'workId',
      'bindingId',
      'kind',
      'admissionSequence',
      'triggerKind',
      'triggerRef',
      'dedupeKey',
      'actorRef',
      'actorTrustTier',
      'sourceContextWatermark',
      'triggerContentRef',
      'configRevisionId',
      'effectiveCapabilityDigest',
      'executionAuthority',
      'coordinatorKind',
      'authorityEpoch',
      'createdAt',
    ],
    'Run admission',
  );
  assertOpaqueId(input.id, 'Run ID');
  assertOpaqueId(input.workId, 'Run Work ID');
  assertOpaqueId(input.bindingId, 'Run Binding ID');
  if (!['interactive', 'routine', 'operator'].includes(input.kind)) {
    throw workError('work_input_invalid', 'Run kind is invalid.');
  }
  boundedInteger(input.admissionSequence, 1, Number.MAX_SAFE_INTEGER, 'Admission sequence');
  assertSafeRef(input.triggerKind, 'Trigger kind');
  assertSafeRef(input.triggerRef, 'Trigger ref');
  assertSafeRef(input.dedupeKey, 'Run dedupe key');
  if (input.actorRef !== undefined && input.actorRef !== null) {
    assertSafeRef(input.actorRef, 'Actor ref');
  }
  if (!['member', 'operator', 'system', 'unknown'].includes(input.actorTrustTier)) {
    throw workError('work_input_invalid', 'Actor trust tier is invalid.');
  }
  if (input.sourceContextWatermark !== undefined && input.sourceContextWatermark !== null) {
    assertSafeRef(input.sourceContextWatermark, 'Source watermark');
  }
  if (input.triggerContentRef !== undefined && input.triggerContentRef !== null) {
    assertOpaqueId(input.triggerContentRef, 'Trigger content ref');
  }
  assertOpaqueId(input.configRevisionId, 'Config revision ID');
  assertDigest(input.effectiveCapabilityDigest, 'Effective capability digest');
  if (!['legacy', 'ledger'].includes(input.executionAuthority)) {
    throw workError('work_input_invalid', 'Run execution authority is invalid.');
  }
  if (!['interactive', 'flue_workflow'].includes(input.coordinatorKind)) {
    throw workError('work_input_invalid', 'Run coordinator is invalid.');
  }
  boundedInteger(input.authorityEpoch, 1, Number.MAX_SAFE_INTEGER, 'Authority epoch');
  assertTimestamp(input.createdAt, 'Run creation time');
}

function validateExecutionInput(input: CreateRunExecutionInput): void {
  assertExactKeys(
    input,
    [
      'id',
      'runId',
      'attemptNumber',
      'fencingToken',
      'executorKind',
      'agentName',
      'canonicalModel',
      'startedAt',
    ],
    'Run execution',
  );
  assertOpaqueId(input.id, 'Run execution ID');
  assertOpaqueId(input.runId, 'Execution Run ID');
  boundedInteger(input.attemptNumber, 1, Number.MAX_SAFE_INTEGER, 'Execution attempt');
  boundedInteger(input.fencingToken, 1, Number.MAX_SAFE_INTEGER, 'Execution fencing token');
  if (!['agent', 'workflow'].includes(input.executorKind)) {
    throw workError('work_execution_invalid', 'Execution kind is invalid.');
  }
  assertSafeRef(input.agentName, 'Agent name');
  assertSafeModel(input.canonicalModel);
  assertTimestamp(input.startedAt, 'Execution start time');
}

function validateRouteInput(input: RunExecutionRouteInput): void {
  assertExactKeys(
    input,
    [
      'executionId',
      'providerAuthRoute',
      'catalogSource',
      'catalogRevision',
      'catalogDigest',
      'compiledProfile',
      'modelCredentialRef',
      'modelCredentialVersion',
    ],
    'Run execution route',
  );
  assertOpaqueId(input.executionId, 'Run execution ID');
  if (
    input.providerAuthRoute !== undefined &&
    input.providerAuthRoute !== null &&
    !['openai_api_key', 'openai_subscription'].includes(input.providerAuthRoute)
  ) {
    throw workError('work_route_invalid', 'Provider auth route is invalid.');
  }
  const catalogValues = [
    input.catalogSource,
    input.catalogRevision,
    input.catalogDigest,
    input.compiledProfile,
  ];
  const catalogPresent = catalogValues.some((value) => value !== undefined && value !== null);
  if (catalogPresent && catalogValues.some((value) => value === undefined || value === null)) {
    throw workError('work_route_invalid', 'Catalog route evidence must be complete.');
  }
  if (catalogPresent) {
    assertSafeRef(input.catalogSource!, 'Catalog source');
    assertSafeRef(input.catalogRevision!, 'Catalog revision');
    assertDigest(input.catalogDigest!, 'Catalog digest');
    if (!isCompiledModelProfileId(input.compiledProfile)) {
      throw workError('work_route_invalid', 'Compiled model profile is invalid.');
    }
  }
  if (input.providerAuthRoute === 'openai_subscription' && !catalogPresent) {
    throw workError('work_route_invalid', 'Subscription route requires catalog evidence.');
  }
  const credentialPresent = input.modelCredentialRef !== undefined && input.modelCredentialRef !== null;
  if (credentialPresent !== (input.modelCredentialVersion !== undefined && input.modelCredentialVersion !== null)) {
    throw workError('work_route_invalid', 'Credential route evidence must be complete.');
  }
  if (credentialPresent) {
    assertSafeRef(input.modelCredentialRef!, 'Model credential ref');
    boundedInteger(
      input.modelCredentialVersion!,
      1,
      Number.MAX_SAFE_INTEGER,
      'Model credential version',
    );
  }
  for (const [label, value] of [
    ['catalogSource', input.catalogSource],
    ['catalogRevision', input.catalogRevision],
    ['compiledProfile', input.compiledProfile],
    ['modelCredentialRef', input.modelCredentialRef],
  ] as const) {
    if (typeof value === 'string') rejectSecretString(value, label);
  }
}

function validateRecoveryInput(input: RequireRunRecoveryInput): void {
  assertExactKeys(
    input,
    ['runId', 'safeFailureCode', 'at', 'auditEventId', 'auditIdempotencyKey'],
    'Recovery transition',
  );
  assertOpaqueId(input.runId, 'Recovery Run ID');
  if (!SAFE_REASON.test(input.safeFailureCode)) {
    throw workError('work_recovery_invalid', 'Recovery failure code is invalid.');
  }
  assertTimestamp(input.at, 'Recovery transition time');
  assertSafeRef(input.auditEventId, 'Recovery audit event ID');
  assertSafeRef(input.auditIdempotencyKey, 'Recovery audit idempotency key');
}

function validateQuarantineInput(input: QuarantineRunInput): void {
  assertExactKeys(
    input,
    [
      'runId',
      'adminCredentialId',
      'operatorLabel',
      'authOrigin',
      'safeReasonCode',
      'requestId',
      'idempotencyKey',
      'resolvedAt',
    ],
    'Recovery quarantine',
  );
  assertOpaqueId(input.runId, 'Quarantine Run ID');
  assertSafeRef(input.adminCredentialId, 'Admin credential ID');
  assertBoundedLabel(input.operatorLabel, 'Operator label', 80);
  if (!/^(admin_session|access_jwt|local_admin)$/.test(input.authOrigin)) {
    throw workError('work_recovery_invalid', 'Recovery auth origin is invalid.');
  }
  if (
    ![
      'effect_reconciled_externally',
      'delivery_reconciled_externally',
      'accepted_unknown',
    ].includes(input.safeReasonCode)
  ) {
    throw workError('work_recovery_invalid', 'Recovery reason is invalid.');
  }
  assertSafeRef(input.requestId, 'Recovery request ID');
  assertSafeRef(input.idempotencyKey, 'Recovery idempotency key');
  assertTimestamp(input.resolvedAt, 'Recovery resolution time');
}

function assertExactKeys(
  value: object,
  allowed: readonly string[],
  label: string,
): void {
  assertPlainObject(value, label);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw workError(
      'work_input_invalid',
      `${label} contains unsupported field ${unexpected.sort()[0]}.`,
    );
  }
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw workError('work_input_invalid', `${label} must be an object.`);
  }
}

function canonicalRefs(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw workError('work_config_invalid', `${label} must be a bounded array.`);
  }
  const refs = value.map((candidate) => {
    assertSafeRef(candidate, label);
    return candidate;
  });
  return [...new Set(refs)].sort();
}

function rejectSecretBearingValue(value: unknown, path = 'config'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretBearingValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      if (/(secret|token|password|authorization|api[_-]?key|credential|transport)/i.test(key)) {
        throw workError('work_secret_rejected', `Secret-bearing field is not allowed at ${path}.`);
      }
      rejectSecretBearingValue(nested, `${path}.${key}`);
    }
    return;
  }
  if (typeof value !== 'string') return;
  rejectSecretString(value, path);
}

function rejectSecretString(value: string, path: string): void {
  if (
    /(?:https?|wss?):\/\//i.test(value) ||
    /(?:bearer\s+|-----BEGIN |\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{8,})/i.test(value) ||
    /chickpea-openai-subscription|internal.*provider|transport[_-]?marker/i.test(value)
  ) {
    throw workError('work_secret_rejected', `Secret-bearing value is not allowed at ${path}.`);
  }
}

function assertOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw workError('work_input_invalid', `${label} is invalid.`);
  }
}

function assertSafeRef(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_REF.test(value)) {
    throw workError('work_input_invalid', `${label} is invalid.`);
  }
}

function assertSafeModel(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw workError('work_config_invalid', 'Canonical model is invalid.');
  }
  if (/chickpea-openai-subscription|internal/i.test(value)) {
    throw workError('work_secret_rejected', 'Internal model aliases cannot be persisted.');
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_DIGEST.test(value)) {
    throw workError('work_input_invalid', `${label} is invalid.`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw workError('work_input_invalid', `${label} is invalid.`);
  }
}

function assertBoundedLabel(value: unknown, label: string, maxLength: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw workError('work_input_invalid', `${label} is invalid.`);
  }
}

function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw workError('work_input_invalid', `${label} is invalid.`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function tableExists(db: StateDb, table: string): boolean {
  return Boolean(
    db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", table),
  );
}

function sameWork(record: WorkRecord, input: CreateWorkInput): boolean {
  return (
    record.id === input.id &&
    record.kind === input.kind &&
    record.maximumSensitivity === input.maximumSensitivity &&
    record.createdAt === input.createdAt
  );
}

function sameBinding(record: BindingRecord, input: CreateBindingInput): boolean {
  return (
    record.id === input.id &&
    record.workId === input.workId &&
    record.adapterKind === input.adapterKind &&
    record.externalAccountId === input.externalAccountId &&
    record.externalConversationId === input.externalConversationId &&
    record.generation === input.generation &&
    record.sourceVisibility === input.sourceVisibility &&
    record.configMode === input.configMode &&
    record.pinnedConfigRevisionId === (input.pinnedConfigRevisionId ?? null) &&
    record.orderingKey === input.orderingKey &&
    record.createdAt === input.createdAt
  );
}

function sameAdmittedRun(record: RunRecord, input: AdmitRunInput): boolean {
  return (
    record.id === input.id &&
    record.workId === input.workId &&
    record.bindingId === input.bindingId &&
    record.kind === input.kind &&
    record.admissionSequence === input.admissionSequence &&
    record.triggerKind === input.triggerKind &&
    record.triggerRef === input.triggerRef &&
    record.dedupeKey === input.dedupeKey &&
    record.actorRef === (input.actorRef ?? null) &&
    record.actorTrustTier === input.actorTrustTier &&
    record.sourceContextWatermark === (input.sourceContextWatermark ?? null) &&
    record.triggerContentRef === (input.triggerContentRef ?? null) &&
    record.configRevisionId === input.configRevisionId &&
    record.effectiveCapabilityDigest === input.effectiveCapabilityDigest &&
    record.executionAuthority === input.executionAuthority &&
    record.coordinatorKind === input.coordinatorKind &&
    record.authorityEpoch === input.authorityEpoch &&
    record.createdAt === input.createdAt
  );
}

function sameExecution(record: RunExecutionRecord, input: CreateRunExecutionInput): boolean {
  return (
    record.id === input.id &&
    record.runId === input.runId &&
    record.attemptNumber === input.attemptNumber &&
    record.fencingToken === input.fencingToken &&
    record.executorKind === input.executorKind &&
    record.agentName === input.agentName &&
    record.canonicalModel === input.canonicalModel &&
    record.startedAt === input.startedAt
  );
}

function sameRoute(record: RunExecutionRecord, input: RunExecutionRouteInput): boolean {
  return (
    record.providerAuthRoute === (input.providerAuthRoute ?? null) &&
    record.catalogSource === (input.catalogSource ?? null) &&
    record.catalogRevision === (input.catalogRevision ?? null) &&
    record.catalogDigest === (input.catalogDigest ?? null) &&
    record.compiledProfile === (input.compiledProfile ?? null) &&
    record.modelCredentialRef === (input.modelCredentialRef ?? null) &&
    record.modelCredentialVersion === (input.modelCredentialVersion ?? null)
  );
}

function rowToWork(row: Record<string, unknown>): WorkRecord {
  return {
    id: String(row.id) as WorkId,
    kind: row.kind as WorkRecord['kind'],
    lifecycle: row.lifecycle as WorkRecord['lifecycle'],
    maximumSensitivity: row.maximum_sensitivity as WorkRecord['maximumSensitivity'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    closedAt: nullableNumber(row.closed_at),
  };
}

function rowToBinding(row: Record<string, unknown>): BindingRecord {
  return {
    id: String(row.id) as BindingId,
    workId: String(row.work_id) as WorkId,
    adapterKind: row.adapter_kind as BindingRecord['adapterKind'],
    externalAccountId: String(row.external_account_id),
    externalConversationId: String(row.external_conversation_id),
    generation: Number(row.generation),
    lifecycle: row.lifecycle as BindingRecord['lifecycle'],
    sourceVisibility: row.source_visibility as BindingRecord['sourceVisibility'],
    configMode: row.config_mode as BindingRecord['configMode'],
    pinnedConfigRevisionId: nullableString(row.pinned_config_revision_id) as EffectiveConfigRevisionId | null,
    orderingKey: String(row.ordering_key),
    createdAt: Number(row.created_at),
    expiredAt: nullableNumber(row.expired_at),
  };
}

function rowToRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id) as RunId,
    workId: String(row.work_id) as WorkId,
    bindingId: String(row.binding_id) as BindingId,
    kind: row.kind as RunRecord['kind'],
    admissionSequence: Number(row.admission_sequence),
    triggerKind: String(row.trigger_kind),
    triggerRef: String(row.trigger_ref),
    dedupeKey: String(row.dedupe_key),
    actorRef: nullableString(row.actor_ref),
    actorTrustTier: row.actor_trust_tier as RunRecord['actorTrustTier'],
    sourceContextWatermark: nullableString(row.source_context_watermark),
    triggerContentRef: nullableString(row.trigger_content_ref) as LedgerContentRef | null,
    preparedInputRef: nullableString(row.prepared_input_ref) as LedgerContentRef | null,
    configRevisionId: String(row.config_revision_id) as EffectiveConfigRevisionId,
    effectiveCapabilityDigest: String(row.effective_capability_digest),
    executionAuthority: row.execution_authority as RunRecord['executionAuthority'],
    coordinatorKind: row.coordinator_kind as RunRecord['coordinatorKind'],
    authorityEpoch: Number(row.authority_epoch),
    policyApprovedOutputRef: nullableString(row.policy_approved_output_ref) as LedgerContentRef | null,
    renderedPayloadRef: nullableString(row.rendered_payload_ref) as LedgerContentRef | null,
    status: row.status as RunRecord['status'],
    terminalDisposition: row.terminal_disposition as RunRecord['terminalDisposition'],
    deliveryStatus: row.delivery_status as RunRecord['deliveryStatus'],
    deliveryMethod: nullableString(row.delivery_method),
    deliveryAttemptId: nullableString(row.delivery_attempt_id),
    deliveryRef: nullableString(row.delivery_ref),
    deliveryFinalizedAt: nullableNumber(row.delivery_finalized_at),
    leaseOwner: nullableString(row.lease_owner),
    leaseUntil: nullableNumber(row.lease_until),
    fencingToken: Number(row.fencing_token),
    safeFailureCode: nullableString(row.safe_failure_code),
    recoveryResolutionKind: row.recovery_resolution_kind as RunRecord['recoveryResolutionKind'],
    recoveryAdminCredentialId: nullableString(row.recovery_admin_credential_id),
    recoveryOperatorLabel: nullableString(row.recovery_operator_label),
    recoveryAuthOrigin: nullableString(row.recovery_auth_origin),
    recoveryReasonCode: nullableString(row.recovery_reason_code),
    recoveryRequestId: nullableString(row.recovery_request_id),
    recoveryResolvedAt: nullableNumber(row.recovery_resolved_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    settledAt: nullableNumber(row.settled_at),
  };
}

function rowToExecution(row: Record<string, unknown>): RunExecutionRecord {
  return {
    id: String(row.id) as RunExecutionId,
    runId: String(row.run_id) as RunId,
    attemptNumber: Number(row.attempt_number),
    fencingToken: Number(row.fencing_token),
    executorKind: row.executor_kind as RunExecutionRecord['executorKind'],
    agentName: String(row.agent_name),
    flueInstanceRef: nullableString(row.flue_instance_ref),
    flueSubmissionRef: nullableString(row.flue_submission_ref),
    canonicalModel: String(row.canonical_model),
    providerAuthRoute: row.provider_auth_route as RunExecutionRecord['providerAuthRoute'],
    catalogSource: nullableString(row.catalog_source),
    catalogRevision: nullableString(row.catalog_revision),
    catalogDigest: nullableString(row.catalog_digest),
    compiledProfile: nullableString(row.compiled_profile),
    modelCredentialRef: nullableString(row.model_credential_ref),
    modelCredentialVersion: nullableNumber(row.model_credential_version),
    modelInvocationStatus: row.model_invocation_status as RunExecutionRecord['modelInvocationStatus'],
    startedAt: Number(row.started_at),
    finishedAt: nullableNumber(row.finished_at),
    rawSettlementRef: nullableString(row.raw_settlement_ref),
    rawSettlementStatus: nullableString(row.raw_settlement_status),
    outcome: row.outcome as RunExecutionRecord['outcome'],
    safeDisagreementCode: nullableString(row.safe_disagreement_code),
    safeFailureCode: nullableString(row.safe_failure_code),
  };
}

function rowToConfig(row: Record<string, unknown>): EffectiveConfigRevision {
  return {
    id: String(row.id) as EffectiveConfigRevisionId,
    canonicalJson: String(row.canonical_json),
    digest: String(row.digest),
    schemaVersion: 1,
    createdAt: Number(row.created_at),
  };
}

function rowToContent(row: Record<string, unknown>): LedgerContentRecord {
  return {
    ref: String(row.ref) as LedgerContentRef,
    schemaVersion: 1,
    sensitivity: row.sensitivity as LedgerContentRecord['sensitivity'],
    expiresAt: Number(row.expires_at),
    body: nullableString(row.body),
    byteSize: Number(row.byte_size),
    createdAt: Number(row.created_at),
    purgedAt: nullableNumber(row.purged_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function requiredWork(value: WorkRecord | undefined): WorkRecord {
  if (!value) throw workError('work_not_found', 'Work was not found.');
  return value;
}

function requiredBinding(value: BindingRecord | undefined): BindingRecord {
  if (!value) throw workError('work_binding_not_found', 'Binding was not found.');
  return value;
}

function requiredRun(value: RunRecord | undefined): RunRecord {
  if (!value) throw workError('work_run_not_found', 'Run was not found.');
  return value;
}

function requiredExecution(value: RunExecutionRecord | undefined): RunExecutionRecord {
  if (!value) throw workError('work_execution_not_found', 'Run execution was not found.');
  return value;
}

function requiredConfig(value: EffectiveConfigRevision | undefined): EffectiveConfigRevision {
  if (!value) throw workError('work_config_not_found', 'Config revision was not found.');
  return value;
}

function requiredContent(value: LedgerContentRecord | undefined): LedgerContentRecord {
  if (!value) throw workError('work_content_not_found', 'Ledger content was not found.');
  return value;
}

function workError(code: string, message: string, details: Record<string, string> = {}) {
  return new WorkStateError(code, message, details);
}
