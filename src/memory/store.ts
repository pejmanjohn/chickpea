import { createHash } from 'node:crypto';

import { AuditStoreLogic } from '../audit/store.ts';
import type { AuditEvent, AuditEventFilter } from '../audit/types.ts';
import { openStateDb, resolveStateDbPath, type NodeStateDb } from '../state/node-state-db.ts';
import type { SqlParam, StateDb } from '../state/state-db.ts';
import {
  MEMORY_RATE_WINDOW_MS,
  MEMORY_RETENTION_MS,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SETTING_KEY,
  MemoryStateError,
  MemoryVersionConflictError,
  type CreateMemoryEntryInput,
  type ForgetMemoryEntryInput,
  type MemoryConversationContext,
  type MemoryEntry,
  type MemoryEntryFilter,
  type MemoryMutationCounts,
  type MemoryRevision,
  type MemoryRpcRequest,
  type MemoryRpcResponse,
  type MemoryStateStore,
  type MemoryStoreDescriptor,
  type ResolveMemoryConversationContextInput,
  type SetMemoryEnabledInput,
  type UpdateMemoryEntryInput,
} from './types.ts';

interface StoreRow {
  store_id: string;
  workspace_id: string;
  visibility: MemoryStoreDescriptor['visibility'];
  channel_id: string | null;
  generation: number | null;
  lifecycle: MemoryStoreDescriptor['lifecycle'];
  created_at: number;
  sealed_at: number | null;
  sealed_reason: string | null;
  schema_version: number;
}

interface EntryRow {
  entry_id: string;
  store_id: string;
  workspace_id: string;
  source_channel_id: string;
  slug: string;
  description: string;
  type: MemoryEntry['type'];
  body: string;
  status: MemoryEntry['status'];
  version: number;
  creator_actor_id: string | null;
  last_editor_actor_id: string | null;
  actor_class: MemoryEntry['actorClass'];
  source_event_id: string | null;
  source_thread_ts: string | null;
  source_message_ts: string | null;
  created_at: number;
  modified_at: number;
  expires_at: number | null;
  content_hash: string | null;
  superseding_entry_id: string | null;
}

interface RevisionRow {
  entry_id: string;
  version: number;
  operation: MemoryRevision['operation'];
  description: string | null;
  body: string | null;
  type: MemoryRevision['type'];
  actor_id: string | null;
  actor_class: MemoryRevision['actorClass'];
  source_event_id: string | null;
  source_thread_ts: string | null;
  source_message_ts: string | null;
  created_at: number;
  before_hash: string | null;
  after_hash: string | null;
  reason_code: string | null;
  idempotency_key: string;
}

interface ContextRow {
  base_conversation_key: string;
  epoch: number;
  scope_signature: string;
  selection_fingerprint: string;
  selected_json: string;
  visibility_barrier_at: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

interface CountRow {
  count: number;
}

const CHANNEL_RATE_ACTOR = '*channel*';

/**
 * Synchronous, target-neutral memory state logic. Every mutation that changes
 * canonical memory writes its revision and generic audit envelope inside the
 * same StateDb transaction, so the Node and Durable Object targets share the
 * same atomicity and idempotency contract.
 */
export class MemoryStoreLogic {
  private readonly audit: AuditStoreLogic;

  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    this.audit = new AuditStoreLogic(db);
    this.initializeSchema();
  }

  execute(request: MemoryRpcRequest): MemoryRpcResponse {
    switch (request.kind) {
      case 'ensure_public_store':
        return { kind: 'store', store: this.ensurePublicStore(request.workspaceId) };
      case 'ensure_private_store':
        return {
          kind: 'store',
          store: this.ensurePrivateStore(
            request.workspaceId,
            request.channelId,
            request.generation,
          ),
        };
      case 'get_store':
        return { kind: 'store', store: this.getStore(request.storeId) ?? null };
      case 'create_entry':
        return { kind: 'entry', entry: this.createEntry(request.input) };
      case 'get_entry':
        return { kind: 'entry', entry: this.getEntry(request.entryId) ?? null };
      case 'list_entries':
        return { kind: 'entries', entries: this.listEntries(request.filter) };
      case 'update_entry':
        return { kind: 'entry', entry: this.updateEntry(request.input) };
      case 'forget_entry':
        return { kind: 'entry', entry: this.forgetEntry(request.input) };
      case 'list_revisions':
        return { kind: 'revisions', revisions: this.listRevisions(request.entryId) };
      case 'list_audit_events':
        return { kind: 'audit_events', events: this.listAuditEvents(request.filter) };
      case 'get_mutation_counts':
        return {
          kind: 'mutation_counts',
          counts: this.getMutationCounts(
            request.workspaceId,
            request.channelId,
            request.actorId,
          ),
        };
      case 'resolve_conversation_context':
        return {
          kind: 'conversation_context',
          context: this.resolveConversationContext(request.input),
        };
      case 'cleanup_retention':
        return { kind: 'cleanup', ...this.cleanupRetention() };
      case 'get_memory_enabled':
        return { kind: 'memory_enabled', enabled: this.getMemoryEnabled() };
      case 'set_memory_enabled':
        return {
          kind: 'memory_enabled',
          enabled: this.setMemoryEnabled(request.input),
        };
    }
  }

  ensurePublicStore(workspaceId: string): MemoryStoreDescriptor {
    return this.ensureStore({
      storeId: publicStoreId(workspaceId),
      workspaceId,
      visibility: 'public',
      channelId: null,
      generation: null,
    });
  }

  ensurePrivateStore(
    workspaceId: string,
    channelId: string,
    generation: number,
  ): MemoryStoreDescriptor {
    if (!Number.isInteger(generation) || generation < 1) {
      throw new MemoryStateError('memory_invalid_generation', 'Invalid private store generation.');
    }
    return this.ensureStore({
      storeId: privateStoreId(workspaceId, channelId, generation),
      workspaceId,
      visibility: 'private',
      channelId,
      generation,
    });
  }

  getStore(storeId: string): MemoryStoreDescriptor | undefined {
    const row = this.db.get('SELECT * FROM memory_stores WHERE store_id = ?', storeId);
    return row ? rowToStore(row as unknown as StoreRow) : undefined;
  }

  createEntry(input: CreateMemoryEntryInput): MemoryEntry {
    const replay = this.entryForReplay(input.idempotencyKey);
    if (replay) return replay;
    const store = this.getStore(input.storeId);
    if (!store || store.workspaceId !== input.workspaceId) {
      throw new MemoryStateError('memory_store_not_found', 'Memory store is unavailable.');
    }
    if (store.lifecycle !== 'active') {
      throw new MemoryStateError('memory_store_sealed', 'Memory store is sealed.');
    }
    const at = this.now();
    const hash = contentHash(input.description, input.body);

    return this.db.transaction(() => {
      const secondReplay = this.entryForReplay(input.idempotencyKey);
      if (secondReplay) return secondReplay;
      this.incrementMutationCounts(
        input.workspaceId,
        input.sourceChannelId,
        input.actorId,
        at,
      );
      try {
        this.db.run(
          `INSERT INTO memory_entries (
            entry_id, store_id, workspace_id, source_channel_id, slug,
            description, type, body, status, version, creator_actor_id,
            last_editor_actor_id, actor_class, source_event_id,
            source_thread_ts, source_message_ts, created_at, modified_at,
            expires_at, content_hash, superseding_entry_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          input.entryId,
          input.storeId,
          input.workspaceId,
          input.sourceChannelId,
          input.slug,
          input.description,
          input.type,
          input.body,
          input.actorId,
          input.actorId,
          input.actorClass,
          input.sourceEventId ?? null,
          input.sourceThreadTs ?? null,
          input.sourceMessageTs ?? null,
          at,
          at,
          input.expiresAt ?? null,
          hash,
        );
      } catch (error) {
        if (isConstraintViolation(error)) {
          throw new MemoryStateError('memory_slug_conflict', 'Memory name is already in use.');
        }
        throw error;
      }
      this.insertRevision({
        entryId: input.entryId,
        version: 1,
        operation: 'create',
        description: input.description,
        body: input.body,
        type: input.type,
        actorId: input.actorId,
        actorClass: input.actorClass,
        sourceEventId: input.sourceEventId ?? null,
        sourceThreadTs: input.sourceThreadTs ?? null,
        sourceMessageTs: input.sourceMessageTs ?? null,
        createdAt: at,
        beforeHash: null,
        afterHash: hash,
        reasonCode: null,
        idempotencyKey: input.idempotencyKey,
      });
      this.audit.append({
        eventId: auditId(input.idempotencyKey),
        domain: 'memory',
        eventType: 'memory.created',
        outcome: 'success',
        actorClass: input.actorClass,
        actorId: input.actorId,
        workspaceId: input.workspaceId,
        channelId: input.sourceChannelId,
        storeId: input.storeId,
        subjectId: input.entryId,
        subjectVersion: 1,
        createdAt: at,
        afterHash: hash,
        idempotencyKey: input.idempotencyKey,
      });
      return requiredEntry(this.getEntry(input.entryId), input.entryId);
    });
  }

  getEntry(entryId: string): MemoryEntry | undefined {
    const row = this.db.get('SELECT * FROM memory_entries WHERE entry_id = ?', entryId);
    return row ? rowToEntry(row as unknown as EntryRow) : undefined;
  }

  listEntries(filter: MemoryEntryFilter = {}): MemoryEntry[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filter.storeId) {
      clauses.push('store_id = ?');
      params.push(filter.storeId);
    }
    if (filter.workspaceId) {
      clauses.push('workspace_id = ?');
      params.push(filter.workspaceId);
    }
    if (filter.sourceChannelId) {
      clauses.push('source_channel_id = ?');
      params.push(filter.sourceChannelId);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      clauses.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 500, 1), 1_000);
    return this.db
      .all(
        `SELECT * FROM memory_entries ${where}
         ORDER BY source_channel_id, slug, entry_id LIMIT ?`,
        ...params,
        limit,
      )
      .map((row) => rowToEntry(row as unknown as EntryRow));
  }

  updateEntry(input: UpdateMemoryEntryInput): MemoryEntry {
    const replay = this.entryForReplay(input.idempotencyKey);
    if (replay) return replay;
    const at = this.now();
    return this.db.transaction(() => {
      const secondReplay = this.entryForReplay(input.idempotencyKey);
      if (secondReplay) return secondReplay;
      const current = requiredEntry(this.getEntry(input.entryId), input.entryId);
      this.assertMutableVersion(current, input.expectedVersion);
      const nextHash = contentHash(input.description, input.body);
      const nextVersion = current.version + 1;
      this.incrementMutationCounts(
        current.workspaceId,
        current.sourceChannelId,
        input.actorId,
        at,
      );
      this.db.run(
        `UPDATE memory_entries SET
          description = ?, type = ?, body = ?, version = ?,
          last_editor_actor_id = ?, actor_class = ?, source_event_id = ?,
          source_thread_ts = ?, source_message_ts = ?, modified_at = ?,
          expires_at = ?, content_hash = ?
         WHERE entry_id = ?`,
        input.description,
        input.type,
        input.body,
        nextVersion,
        input.actorId,
        input.actorClass,
        input.sourceEventId ?? current.sourceEventId,
        input.sourceThreadTs ?? current.sourceThreadTs,
        input.sourceMessageTs ?? current.sourceMessageTs,
        at,
        input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
        nextHash,
        input.entryId,
      );
      this.insertRevision({
        entryId: input.entryId,
        version: nextVersion,
        operation: 'update',
        description: input.description,
        body: input.body,
        type: input.type,
        actorId: input.actorId,
        actorClass: input.actorClass,
        sourceEventId: input.sourceEventId ?? current.sourceEventId,
        sourceThreadTs: input.sourceThreadTs ?? current.sourceThreadTs,
        sourceMessageTs: input.sourceMessageTs ?? current.sourceMessageTs,
        createdAt: at,
        beforeHash: current.contentHash,
        afterHash: nextHash,
        reasonCode: null,
        idempotencyKey: input.idempotencyKey,
      });
      this.audit.append({
        eventId: auditId(input.idempotencyKey),
        domain: 'memory',
        eventType: 'memory.updated',
        outcome: 'success',
        actorClass: input.actorClass,
        actorId: input.actorId,
        workspaceId: current.workspaceId,
        channelId: current.sourceChannelId,
        storeId: current.storeId,
        subjectId: current.entryId,
        subjectVersion: nextVersion,
        createdAt: at,
        beforeHash: current.contentHash,
        afterHash: nextHash,
        idempotencyKey: input.idempotencyKey,
      });
      this.trimRevisionContent(input.entryId);
      return requiredEntry(this.getEntry(input.entryId), input.entryId);
    });
  }

  forgetEntry(input: ForgetMemoryEntryInput): MemoryEntry {
    const replay = this.entryForReplay(input.idempotencyKey);
    if (replay) return replay;
    const at = this.now();
    return this.db.transaction(() => {
      const secondReplay = this.entryForReplay(input.idempotencyKey);
      if (secondReplay) return secondReplay;
      const current = requiredEntry(this.getEntry(input.entryId), input.entryId);
      this.assertMutableVersion(current, input.expectedVersion);
      const nextVersion = current.version + 1;
      this.incrementMutationCounts(
        current.workspaceId,
        current.sourceChannelId,
        input.actorId,
        at,
      );
      this.db.run(
        `UPDATE memory_entries SET
          description = '', body = '', status = 'forgotten', version = ?,
          last_editor_actor_id = ?, actor_class = ?, source_event_id = ?,
          modified_at = ?, expires_at = NULL, content_hash = NULL,
          superseding_entry_id = NULL
         WHERE entry_id = ?`,
        nextVersion,
        input.actorId,
        input.actorClass,
        input.sourceEventId ?? current.sourceEventId,
        at,
        input.entryId,
      );
      this.insertRevision({
        entryId: input.entryId,
        version: nextVersion,
        operation: 'forget',
        description: null,
        body: null,
        type: null,
        actorId: input.actorId,
        actorClass: input.actorClass,
        sourceEventId: input.sourceEventId ?? current.sourceEventId,
        sourceThreadTs: current.sourceThreadTs,
        sourceMessageTs: current.sourceMessageTs,
        createdAt: at,
        beforeHash: null,
        afterHash: null,
        reasonCode: input.reasonCode ?? 'explicit_forget',
        idempotencyKey: input.idempotencyKey,
      });
      this.db.run(
        `UPDATE memory_revisions SET
          description = NULL, body = NULL, type = NULL,
          before_hash = NULL, after_hash = NULL
         WHERE entry_id = ?`,
        input.entryId,
      );
      this.db.run(
        `UPDATE audit_events SET before_hash = NULL, after_hash = NULL
         WHERE subject_id = ?`,
        input.entryId,
      );
      this.audit.append({
        eventId: auditId(input.idempotencyKey),
        domain: 'memory',
        eventType: 'memory.forgotten',
        outcome: 'success',
        actorClass: input.actorClass,
        actorId: input.actorId,
        workspaceId: current.workspaceId,
        channelId: current.sourceChannelId,
        storeId: current.storeId,
        subjectId: current.entryId,
        subjectVersion: nextVersion,
        createdAt: at,
        reasonCode: input.reasonCode ?? 'explicit_forget',
        idempotencyKey: input.idempotencyKey,
      });
      return requiredEntry(this.getEntry(input.entryId), input.entryId);
    });
  }

  listRevisions(entryId: string): MemoryRevision[] {
    return this.db
      .all(
        `SELECT * FROM memory_revisions WHERE entry_id = ?
         ORDER BY version ASC`,
        entryId,
      )
      .map((row) => rowToRevision(row as unknown as RevisionRow));
  }

  listAuditEvents(filter: AuditEventFilter = {}): AuditEvent[] {
    return this.audit.list(filter);
  }

  getMutationCounts(
    workspaceId: string,
    channelId: string,
    actorId: string,
  ): MemoryMutationCounts {
    const windowStartedAt = rateWindowStart(this.now());
    const actor = this.mutationCount(workspaceId, channelId, actorId, windowStartedAt);
    const channel = this.mutationCount(
      workspaceId,
      channelId,
      CHANNEL_RATE_ACTOR,
      windowStartedAt,
    );
    return { actor, channel, windowStartedAt };
  }

  resolveConversationContext(
    input: ResolveMemoryConversationContextInput,
  ): MemoryConversationContext {
    const at = this.now();
    const selectedJson = JSON.stringify(input.selected);
    const barrier = input.visibilityBarrierAt ?? null;
    return this.db.transaction(() => {
      const row = this.db.get(
        `SELECT * FROM memory_conversation_contexts
         WHERE base_conversation_key = ?`,
        input.baseConversationKey,
      ) as unknown as ContextRow | undefined;
      if (!row) {
        this.db.run(
          `INSERT INTO memory_conversation_contexts (
            base_conversation_key, epoch, scope_signature,
            selection_fingerprint, selected_json, visibility_barrier_at,
            created_at, updated_at, expires_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
          input.baseConversationKey,
          input.scopeSignature,
          input.selectionFingerprint,
          selectedJson,
          barrier,
          at,
          at,
          input.expiresAt,
        );
      } else {
        const unchanged =
          row.scope_signature === input.scopeSignature &&
          row.selection_fingerprint === input.selectionFingerprint &&
          row.selected_json === selectedJson &&
          row.visibility_barrier_at === barrier;
        this.db.run(
          `UPDATE memory_conversation_contexts SET
            epoch = ?, scope_signature = ?, selection_fingerprint = ?,
            selected_json = ?, visibility_barrier_at = ?, created_at = ?,
            updated_at = ?, expires_at = ?
           WHERE base_conversation_key = ?`,
          unchanged ? row.epoch : row.epoch + 1,
          input.scopeSignature,
          input.selectionFingerprint,
          selectedJson,
          barrier,
          unchanged ? row.created_at : at,
          at,
          input.expiresAt,
          input.baseConversationKey,
        );
      }
      return this.getConversationContext(input.baseConversationKey);
    });
  }

  cleanupRetention(): {
    actorIdsCleared: number;
    rateWindowsDeleted: number;
    contextsDeleted: number;
  } {
    const at = this.now();
    return this.db.transaction(() => ({
      actorIdsCleared: this.audit.clearExpiredActorIds(at - MEMORY_RETENTION_MS),
      rateWindowsDeleted: this.db.run(
        'DELETE FROM memory_mutation_windows WHERE updated_at < ?',
        at - 2 * MEMORY_RATE_WINDOW_MS,
      ).changes,
      contextsDeleted: this.db.run(
        'DELETE FROM memory_conversation_contexts WHERE expires_at < ?',
        at,
      ).changes,
    }));
  }

  getMemoryEnabled(): boolean {
    const row = this.db.get('SELECT value FROM app_settings WHERE key = ?', MEMORY_SETTING_KEY);
    return row?.value === 'true';
  }

  setMemoryEnabled(input: SetMemoryEnabledInput): boolean {
    const replay = this.audit.findByIdempotencyKey(input.idempotencyKey);
    if (replay) return this.getMemoryEnabled();
    const at = this.now();
    return this.db.transaction(() => {
      const secondReplay = this.audit.findByIdempotencyKey(input.idempotencyKey);
      if (secondReplay) return this.getMemoryEnabled();
      this.db.run(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        MEMORY_SETTING_KEY,
        input.enabled ? 'true' : 'false',
        at,
      );
      this.audit.append({
        eventId: auditId(input.idempotencyKey),
        domain: 'memory',
        eventType: 'memory.setting_changed',
        outcome: 'success',
        actorClass: 'operator',
        actorId: input.actorId,
        createdAt: at,
        metadataJson: JSON.stringify({ enabled: input.enabled }),
        idempotencyKey: input.idempotencyKey,
      });
      return input.enabled;
    });
  }

  private initializeSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memory_stores (
        store_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        visibility TEXT NOT NULL,
        channel_id TEXT,
        generation INTEGER,
        lifecycle TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        sealed_at INTEGER,
        sealed_reason TEXT,
        schema_version INTEGER NOT NULL,
        UNIQUE (workspace_id, visibility, channel_id, generation)
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memory_entries (
        entry_id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        source_channel_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT NOT NULL,
        type TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        creator_actor_id TEXT,
        last_editor_actor_id TEXT,
        actor_class TEXT NOT NULL,
        source_event_id TEXT,
        source_thread_ts TEXT,
        source_message_ts TEXT,
        created_at INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        expires_at INTEGER,
        content_hash TEXT,
        superseding_entry_id TEXT,
        UNIQUE (store_id, source_channel_id, slug)
      )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS memory_entries_selection_idx
       ON memory_entries (workspace_id, status, source_channel_id, modified_at DESC)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memory_revisions (
        entry_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        operation TEXT NOT NULL,
        description TEXT,
        body TEXT,
        type TEXT,
        actor_id TEXT,
        actor_class TEXT NOT NULL,
        source_event_id TEXT,
        source_thread_ts TEXT,
        source_message_ts TEXT,
        created_at INTEGER NOT NULL,
        before_hash TEXT,
        after_hash TEXT,
        reason_code TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        PRIMARY KEY (entry_id, version)
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memory_mutation_windows (
        workspace_id TEXT NOT NULL,
        source_channel_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        window_started_at INTEGER NOT NULL,
        mutation_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, source_channel_id, actor_id, window_started_at)
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memory_conversation_contexts (
        base_conversation_key TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        scope_signature TEXT NOT NULL,
        selection_fingerprint TEXT NOT NULL,
        selected_json TEXT NOT NULL,
        visibility_barrier_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.db.run(
      `INSERT OR IGNORE INTO memory_meta (key, value) VALUES ('schema_version', ?)`,
      String(MEMORY_SCHEMA_VERSION),
    );
  }

  private ensureStore(input: {
    storeId: string;
    workspaceId: string;
    visibility: MemoryStoreDescriptor['visibility'];
    channelId: string | null;
    generation: number | null;
  }): MemoryStoreDescriptor {
    const at = this.now();
    this.db.run(
      `INSERT OR IGNORE INTO memory_stores (
        store_id, workspace_id, visibility, channel_id, generation,
        lifecycle, created_at, sealed_at, sealed_reason, schema_version
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, NULL, ?)`,
      input.storeId,
      input.workspaceId,
      input.visibility,
      input.channelId,
      input.generation,
      at,
      MEMORY_SCHEMA_VERSION,
    );
    const store = this.getStore(input.storeId);
    if (!store) throw new Error(`Memory store ${input.storeId} was not readable after insert`);
    return store;
  }

  private assertMutableVersion(entry: MemoryEntry, expectedVersion: number): void {
    if (entry.version !== expectedVersion) {
      throw new MemoryVersionConflictError(entry.entryId, entry.version);
    }
    if (entry.status === 'forgotten' || entry.status === 'superseded') {
      throw new MemoryStateError('memory_entry_not_mutable', 'Memory entry is not editable.');
    }
    const store = this.getStore(entry.storeId);
    if (!store || store.lifecycle !== 'active') {
      throw new MemoryStateError('memory_store_sealed', 'Memory store is sealed.');
    }
  }

  private insertRevision(revision: MemoryRevision): void {
    this.db.run(
      `INSERT INTO memory_revisions (
        entry_id, version, operation, description, body, type, actor_id,
        actor_class, source_event_id, source_thread_ts, source_message_ts,
        created_at, before_hash, after_hash, reason_code, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      revision.entryId,
      revision.version,
      revision.operation,
      revision.description,
      revision.body,
      revision.type,
      revision.actorId,
      revision.actorClass,
      revision.sourceEventId,
      revision.sourceThreadTs,
      revision.sourceMessageTs,
      revision.createdAt,
      revision.beforeHash,
      revision.afterHash,
      revision.reasonCode,
      revision.idempotencyKey,
    );
  }

  private entryForReplay(idempotencyKey: string): MemoryEntry | undefined {
    const row = this.db.get(
      `SELECT entry_id FROM memory_revisions WHERE idempotency_key = ?`,
      idempotencyKey,
    );
    return typeof row?.entry_id === 'string' ? this.getEntry(row.entry_id) : undefined;
  }

  private incrementMutationCounts(
    workspaceId: string,
    channelId: string,
    actorId: string,
    at: number,
  ): void {
    const window = rateWindowStart(at);
    for (const subject of [actorId, CHANNEL_RATE_ACTOR]) {
      this.db.run(
        `INSERT INTO memory_mutation_windows (
          workspace_id, source_channel_id, actor_id, window_started_at,
          mutation_count, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(workspace_id, source_channel_id, actor_id, window_started_at)
        DO UPDATE SET mutation_count = mutation_count + 1, updated_at = excluded.updated_at`,
        workspaceId,
        channelId,
        subject,
        window,
        at,
      );
    }
  }

  private mutationCount(
    workspaceId: string,
    channelId: string,
    actorId: string,
    windowStartedAt: number,
  ): number {
    const row = this.db.get(
      `SELECT mutation_count AS count FROM memory_mutation_windows
       WHERE workspace_id = ? AND source_channel_id = ? AND actor_id = ?
         AND window_started_at = ?`,
      workspaceId,
      channelId,
      actorId,
      windowStartedAt,
    ) as unknown as CountRow | undefined;
    return row?.count ?? 0;
  }

  private getConversationContext(baseConversationKey: string): MemoryConversationContext {
    const row = this.db.get(
      `SELECT * FROM memory_conversation_contexts WHERE base_conversation_key = ?`,
      baseConversationKey,
    ) as unknown as ContextRow | undefined;
    if (!row) throw new Error(`Memory conversation ${baseConversationKey} is unavailable`);
    return rowToContext(row);
  }

  private trimRevisionContent(entryId: string): void {
    this.db.run(
      `UPDATE memory_revisions SET description = NULL, body = NULL, type = NULL
       WHERE entry_id = ? AND version <= (
         SELECT MAX(version) - 50 FROM memory_revisions WHERE entry_id = ?
       )`,
      entryId,
      entryId,
    );
  }
}

/** Node backend: the target-neutral logic over node:sqlite, async-wrapped. */
export class SqliteMemoryStateStore implements MemoryStateStore {
  private readonly db: NodeStateDb;
  private readonly logic: MemoryStoreLogic;

  constructor(path: string = resolveStateDbPath(), now: () => number = Date.now) {
    this.db = openStateDb(path);
    this.logic = new MemoryStoreLogic(this.db, now);
  }

  close(): void {
    this.db.close();
  }

  async ensurePublicStore(workspaceId: string): Promise<MemoryStoreDescriptor> {
    return this.logic.ensurePublicStore(workspaceId);
  }

  async ensurePrivateStore(
    workspaceId: string,
    channelId: string,
    generation: number,
  ): Promise<MemoryStoreDescriptor> {
    return this.logic.ensurePrivateStore(workspaceId, channelId, generation);
  }

  async getStore(storeId: string): Promise<MemoryStoreDescriptor | undefined> {
    return this.logic.getStore(storeId);
  }

  async createEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry> {
    return this.logic.createEntry(input);
  }

  async getEntry(entryId: string): Promise<MemoryEntry | undefined> {
    return this.logic.getEntry(entryId);
  }

  async listEntries(filter: MemoryEntryFilter = {}): Promise<MemoryEntry[]> {
    return this.logic.listEntries(filter);
  }

  async updateEntry(input: UpdateMemoryEntryInput): Promise<MemoryEntry> {
    return this.logic.updateEntry(input);
  }

  async forgetEntry(input: ForgetMemoryEntryInput): Promise<MemoryEntry> {
    return this.logic.forgetEntry(input);
  }

  async listRevisions(entryId: string): Promise<MemoryRevision[]> {
    return this.logic.listRevisions(entryId);
  }

  async listAuditEvents(filter: AuditEventFilter = {}): Promise<AuditEvent[]> {
    return this.logic.listAuditEvents(filter);
  }

  async getMutationCounts(
    workspaceId: string,
    channelId: string,
    actorId: string,
  ): Promise<MemoryMutationCounts> {
    return this.logic.getMutationCounts(workspaceId, channelId, actorId);
  }

  async resolveConversationContext(
    input: ResolveMemoryConversationContextInput,
  ): Promise<MemoryConversationContext> {
    return this.logic.resolveConversationContext(input);
  }

  async cleanupRetention(): Promise<{
    actorIdsCleared: number;
    rateWindowsDeleted: number;
    contextsDeleted: number;
  }> {
    return this.logic.cleanupRetention();
  }

  async getMemoryEnabled(): Promise<boolean> {
    return this.logic.getMemoryEnabled();
  }

  async setMemoryEnabled(input: SetMemoryEnabledInput): Promise<boolean> {
    return this.logic.setMemoryEnabled(input);
  }
}

export function publicStoreId(workspaceId: string): string {
  return `store_public_${workspaceId}`;
}

export function privateStoreId(
  workspaceId: string,
  channelId: string,
  generation: number,
): string {
  return `store_private_${workspaceId}_${channelId}_${generation}`;
}

function contentHash(description: string, body: string): string {
  return createHash('sha256').update(`${description}\n\u0000${body}`).digest('hex');
}

function auditId(idempotencyKey: string): string {
  return `audit_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
}

function rateWindowStart(at: number): number {
  return Math.floor(at / MEMORY_RATE_WINDOW_MS) * MEMORY_RATE_WINDOW_MS;
}

function requiredEntry(entry: MemoryEntry | undefined, entryId: string): MemoryEntry {
  if (!entry) {
    throw new MemoryStateError('memory_entry_not_found', 'Memory entry was not found.', {
      entryId,
    });
  }
  return entry;
}

function isConstraintViolation(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/i.test(error.message);
}

function rowToStore(row: StoreRow): MemoryStoreDescriptor {
  return {
    storeId: row.store_id,
    workspaceId: row.workspace_id,
    visibility: row.visibility,
    channelId: row.channel_id,
    generation: row.generation,
    lifecycle: row.lifecycle,
    createdAt: row.created_at,
    sealedAt: row.sealed_at,
    sealedReason: row.sealed_reason,
    schemaVersion: row.schema_version,
  };
}

function rowToEntry(row: EntryRow): MemoryEntry {
  return {
    entryId: row.entry_id,
    storeId: row.store_id,
    workspaceId: row.workspace_id,
    sourceChannelId: row.source_channel_id,
    slug: row.slug,
    description: row.description,
    type: row.type,
    body: row.body,
    status: row.status,
    version: row.version,
    creatorActorId: row.creator_actor_id,
    lastEditorActorId: row.last_editor_actor_id,
    actorClass: row.actor_class,
    sourceEventId: row.source_event_id,
    sourceThreadTs: row.source_thread_ts,
    sourceMessageTs: row.source_message_ts,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    expiresAt: row.expires_at,
    contentHash: row.content_hash,
    supersedingEntryId: row.superseding_entry_id,
  };
}

function rowToRevision(row: RevisionRow): MemoryRevision {
  return {
    entryId: row.entry_id,
    version: row.version,
    operation: row.operation,
    description: row.description,
    body: row.body,
    type: row.type,
    actorId: row.actor_id,
    actorClass: row.actor_class,
    sourceEventId: row.source_event_id,
    sourceThreadTs: row.source_thread_ts,
    sourceMessageTs: row.source_message_ts,
    createdAt: row.created_at,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    reasonCode: row.reason_code,
    idempotencyKey: row.idempotency_key,
  };
}

function rowToContext(row: ContextRow): MemoryConversationContext {
  return {
    baseConversationKey: row.base_conversation_key,
    epoch: row.epoch,
    scopeSignature: row.scope_signature,
    selectionFingerprint: row.selection_fingerprint,
    selected: JSON.parse(row.selected_json) as MemoryConversationContext['selected'],
    visibilityBarrierAt: row.visibility_barrier_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}
