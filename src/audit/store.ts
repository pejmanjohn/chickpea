import type { StateDb } from '../state/state-db.ts';
import type { AppendAuditEvent, AuditEvent, AuditEventFilter } from './types.ts';

interface AuditRow {
  event_id: string;
  domain: AuditEvent['domain'];
  event_type: string;
  outcome: AuditEvent['outcome'];
  actor_class: string;
  actor_id: string | null;
  workspace_id: string | null;
  channel_id: string | null;
  store_id: string | null;
  subject_id: string | null;
  subject_version: number | null;
  created_at: number;
  reason_code: string | null;
  before_hash: string | null;
  after_hash: string | null;
  metadata_json: string;
  idempotency_key: string | null;
}

export class AuditStoreLogic {
  constructor(private readonly db: StateDb) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        actor_class TEXT NOT NULL,
        actor_id TEXT,
        workspace_id TEXT,
        channel_id TEXT,
        store_id TEXT,
        subject_id TEXT,
        subject_version INTEGER,
        created_at INTEGER NOT NULL,
        reason_code TEXT,
        before_hash TEXT,
        after_hash TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        idempotency_key TEXT UNIQUE
      )`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS audit_events_domain_created_idx
       ON audit_events (domain, created_at DESC, event_id DESC)`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS audit_events_subject_idx
       ON audit_events (subject_id, created_at DESC)`,
    );
  }

  append(input: AppendAuditEvent): AuditEvent {
    validateSafeMetadata(input, input.metadataJson ?? '{}');
    this.db.run(
      `INSERT INTO audit_events (
        event_id, domain, event_type, outcome, actor_class, actor_id,
        workspace_id, channel_id, store_id, subject_id, subject_version,
        created_at, reason_code, before_hash, after_hash, metadata_json,
        idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.eventId,
      input.domain,
      input.eventType,
      input.outcome,
      input.actorClass,
      input.actorId ?? null,
      input.workspaceId ?? null,
      input.channelId ?? null,
      input.storeId ?? null,
      input.subjectId ?? null,
      input.subjectVersion ?? null,
      input.createdAt,
      input.reasonCode ?? null,
      input.beforeHash ?? null,
      input.afterHash ?? null,
      input.metadataJson ?? '{}',
      input.idempotencyKey ?? null,
    );
    const created = this.get(input.eventId);
    if (!created) throw new Error(`Audit event ${input.eventId} was not readable after insert`);
    return created;
  }

  /** Replay-safe append for revision-derived administrative operations. */
  appendIdempotent(input: AppendAuditEvent): AuditEvent {
    if (!input.idempotencyKey) {
      throw new Error('Idempotent audit events require an idempotency key');
    }
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
    try {
      return this.append(input);
    } catch (error) {
      const replay = this.findByIdempotencyKey(input.idempotencyKey);
      if (replay) return replay;
      throw error;
    }
  }

  get(eventId: string): AuditEvent | undefined {
    const row = this.db.get('SELECT * FROM audit_events WHERE event_id = ?', eventId);
    return row ? rowToAudit(row as unknown as AuditRow) : undefined;
  }

  findByIdempotencyKey(idempotencyKey: string): AuditEvent | undefined {
    const row = this.db.get(
      'SELECT * FROM audit_events WHERE idempotency_key = ?',
      idempotencyKey,
    );
    return row ? rowToAudit(row as unknown as AuditRow) : undefined;
  }

  list(filter: AuditEventFilter = {}): AuditEvent[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.domain) {
      clauses.push('domain = ?');
      params.push(filter.domain);
    }
    if (filter.eventType) {
      clauses.push('event_type = ?');
      params.push(filter.eventType);
    }
    if (filter.idempotencyKey) {
      clauses.push('idempotency_key = ?');
      params.push(filter.idempotencyKey);
    }
    if (filter.subjectId) {
      clauses.push('subject_id = ?');
      params.push(filter.subjectId);
    }
    if (filter.subjectIds?.length) {
      const subjectIds = [...new Set(filter.subjectIds)].slice(0, 101);
      clauses.push(`subject_id IN (${subjectIds.map(() => '?').join(', ')})`);
      params.push(...subjectIds);
    }
    if (filter.storeId) {
      clauses.push('store_id = ?');
      params.push(filter.storeId);
    }
    if (filter.channelId) {
      clauses.push('channel_id = ?');
      params.push(filter.channelId);
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .all(
        `SELECT * FROM audit_events ${where}
         ORDER BY created_at DESC, event_id DESC LIMIT ?`,
        ...params,
        limit,
      )
      .map((row) => rowToAudit(row as unknown as AuditRow));
  }

  clearExpiredActorIds(before: number): number {
    return this.db.run(
      `UPDATE audit_events SET actor_id = NULL
       WHERE actor_id IS NOT NULL AND created_at < ?`,
      before,
    ).changes;
  }

  clearExpiredActorIdsForDomain(domain: AuditEvent['domain'], before: number): number {
    return this.db.run(
      `UPDATE audit_events SET actor_id = NULL
       WHERE domain = ? AND actor_id IS NOT NULL AND created_at < ?`,
      domain,
      before,
    ).changes;
  }

  deleteBefore(domain: AuditEvent['domain'], before: number): number {
    return this.db.run(
      'DELETE FROM audit_events WHERE domain = ? AND created_at < ?',
      domain,
      before,
    ).changes;
  }
}

function validateSafeMetadata(input: AppendAuditEvent, raw: string): void {
  if (Buffer.byteLength(raw, 'utf8') > 4_096) {
    throw new Error('Audit metadata exceeds 4096 bytes');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Audit metadata must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Audit metadata must be a JSON object');
  }
  if (input.domain === 'work') {
    validateWorkMetadata(input.eventType, parsed as Record<string, unknown>);
  }
  if (input.domain === 'slack_identity') {
    validateSlackIdentityMetadata(input.eventType, parsed as Record<string, unknown>);
  }
  if (input.domain === 'management') {
    validateManagementMetadata(input.eventType, parsed as Record<string, unknown>);
  }
}

const SAFE_AUDIT_METADATA_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

function validateWorkMetadata(eventType: string, metadata: Record<string, unknown>): void {
  const shapes: Record<string, { keys: readonly string[]; status?: string }> = {
    'work.run_admitted': { keys: ['bindingId', 'runId', 'workId'] },
    'work.run_claimed': { keys: ['fencingToken', 'phase', 'runId'] },
    'work.run_lease_renewed': { keys: ['fencingToken', 'runId'] },
    'work.run_requeued': { keys: ['fencingToken', 'runId'] },
    'work.run_recovery_required': { keys: ['runId'] },
    'work.run_quarantined': {
      keys: ['adminCredentialId', 'authOrigin', 'operatorLabel', 'requestId', 'runId'],
    },
    'work.input_prepared': { keys: ['runId'] },
    'work.execution_created': { keys: ['runExecutionId', 'runId'] },
    'work.execution_route_recorded': { keys: ['runExecutionId', 'runId'] },
    'work.execution_invoked': { keys: ['runExecutionId', 'runId'] },
    'work.execution_settled': { keys: ['runExecutionId', 'runId'] },
    'work.response_recorded': { keys: ['runId'] },
    'work.delivery_started': { keys: ['deliveryAttemptId', 'runId'] },
    'work.delivery_delivered': { keys: ['deliveryAttemptId', 'runId'] },
    'work.delivery_failed': { keys: ['deliveryAttemptId', 'runId'] },
    'work.delivery_unknown': { keys: ['deliveryAttemptId', 'runId'] },
    'work.run_settled_without_delivery': { keys: ['runId'] },
    'work.action_denied': {
      keys: actionMetadataKeys(),
      status: 'denied',
    },
    'work.action_started': {
      keys: actionMetadataKeys(),
      status: 'started',
    },
    'work.action_succeeded': {
      keys: actionMetadataKeys(),
      status: 'succeeded',
    },
    'work.action_failed': {
      keys: actionMetadataKeys(),
      status: 'failed',
    },
    'work.action_unknown': {
      keys: actionMetadataKeys(),
      status: 'unknown',
    },
  };
  const shape = shapes[eventType];
  if (!shape) throw new Error('Work audit event type is not allowlisted');
  const keys = Object.keys(metadata).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...shape.keys].sort())) {
    throw new Error('Work audit metadata shape is invalid');
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
      throw new Error(`Work audit metadata ${key} is invalid`);
    }
    if (key === 'operatorLabel') {
      if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error('Work audit operator label is invalid');
      }
      continue;
    }
    if (!SAFE_AUDIT_METADATA_VALUE.test(value)) {
      throw new Error(`Work audit metadata ${key} is invalid`);
    }
  }
  if (shape.status && metadata.status !== shape.status) {
    throw new Error('Work action audit status does not match its event type');
  }
}

function actionMetadataKeys(): readonly string[] {
  return [
    'actionAttemptId',
    'actionClass',
    'flueCorrelation',
    'runExecutionId',
    'runId',
    'status',
    'targetKind',
  ];
}

const SLACK_IDENTITY_EVENT_OPERATIONS: Record<string, string> = {
  'slack_identity.setup_started': 'setup_started',
  'slack_identity.credentials_connected': 'credentials_connected',
  'slack_identity.credentials_rotated': 'credentials_rotated',
  'slack_identity.credentials_disconnected': 'credentials_disconnected',
  'slack_identity.setup_verified': 'setup_verified',
  'slack_identity.refreshed': 'refreshed',
  'slack_identity.profile_attached': 'profile_attached',
  'slack_identity.dm_binding_changed': 'dm_binding_changed',
  'slack_identity.setup_canceled': 'setup_canceled',
  'slack_identity.retired': 'retired',
};

function validateSlackIdentityMetadata(
  eventType: string,
  metadata: Record<string, unknown>,
): void {
  const operation = SLACK_IDENTITY_EVENT_OPERATIONS[eventType];
  if (!operation) throw new Error('Slack identity audit event type is not allowlisted');
  const expectedKeys = ['newLifecycle', 'operation', 'priorLifecycle', 'requestId'];
  if (JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('Slack identity audit metadata shape is invalid');
  }
  if (metadata.operation !== operation) {
    throw new Error('Slack identity audit operation does not match its event type');
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (
      typeof value !== 'string' ||
      !SAFE_AUDIT_METADATA_VALUE.test(value)
    ) {
      throw new Error(`Slack identity audit metadata ${key} is invalid`);
    }
  }
}

function validateManagementMetadata(
  eventType: string,
  metadata: Record<string, unknown>,
): void {
  const expectedKeys = eventType === 'management.request.completed'
    ? ['operationId', 'outcomeCount', 'status']
    : eventType === 'management.proposal.completed'
      ? ['operationKind', 'proposalId', 'status']
      : eventType === 'management.setup.completed'
        ? ['action', 'scopeCount', 'setupOperationId']
      : undefined;
  if (!expectedKeys) throw new Error('Management audit event type is not allowlisted');
  if (JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('Management audit metadata shape is invalid');
  }
  if (eventType !== 'management.setup.completed' &&
      !['completed', 'partial', 'confirmation_required'].includes(String(metadata.status))) {
    throw new Error('Management audit status is invalid');
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== 'string' || !SAFE_AUDIT_METADATA_VALUE.test(value)) {
      throw new Error(`Management audit metadata ${key} is invalid`);
    }
  }
}

function rowToAudit(row: AuditRow): AuditEvent {
  return {
    eventId: row.event_id,
    domain: row.domain,
    eventType: row.event_type,
    outcome: row.outcome,
    actorClass: row.actor_class,
    actorId: row.actor_id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    storeId: row.store_id,
    subjectId: row.subject_id,
    subjectVersion: row.subject_version,
    createdAt: row.created_at,
    reasonCode: row.reason_code,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    metadataJson: row.metadata_json,
    idempotencyKey: row.idempotency_key,
  };
}
