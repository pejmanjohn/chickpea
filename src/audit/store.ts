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
    validateSafeMetadata(input.metadataJson ?? '{}');
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

  deleteBefore(domain: AuditEvent['domain'], before: number): number {
    return this.db.run(
      'DELETE FROM audit_events WHERE domain = ? AND created_at < ?',
      domain,
      before,
    ).changes;
  }
}

function validateSafeMetadata(raw: string): void {
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
