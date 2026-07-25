import { createHash } from 'node:crypto';

import { AuditStoreLogic } from '../audit/store.ts';
import type { AuditEvent, AuditEventFilter } from '../audit/types.ts';
import { openStateDb, resolveStateDbPath, type NodeStateDb } from '../state/node-state-db.ts';
import type { SqlParam, StateDb } from '../state/state-db.ts';
import {
  MEMORY_RATE_WINDOW_MS,
  MEMORY_ACTOR_RATE_LIMIT,
  MEMORY_CHANNEL_RATE_LIMIT,
  MEMORY_PRIVATE_BYTES_LIMIT,
  MEMORY_PRIVATE_ENTRY_LIMIT,
  MEMORY_PUBLIC_BYTES_LIMIT,
  MEMORY_PUBLIC_ENTRY_LIMIT,
  MEMORY_SOURCE_ENTRY_LIMIT,
  MEMORY_RETENTION_MS,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SETTING_KEY,
  MemoryStateError,
  MemoryRateLimitError,
  MemoryVersionConflictError,
  type CreateMemoryEntryInput,
  type CreateForgetChallengeInput,
  type ForgetMemoryEntryInput,
  type MemoryConversationContext,
  type MemoryChannelScopeState,
  type MemoryEntry,
  type MemoryEntryFilter,
  type MergeMemoryEntriesInput,
  type MemoryMutationCounts,
  type MemoryRevision,
  type MemoryRpcRequest,
  type MemoryRpcResponse,
  type MemoryStateStore,
  type MemoryStoreDescriptor,
  type ObserveMemoryChannelScopeInput,
  type RecordMemoryReviewInput,
  type ResolveMemoryConversationContextInput,
  type SetMemoryEnabledInput,
  type TransitionMemoryEntryInput,
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

interface ScopeRow {
  workspace_id: string;
  channel_id: string;
  privacy: MemoryStoreDescriptor['visibility'];
  lifecycle: MemoryChannelScopeState['lifecycle'];
  private_generation: number;
  current_display_name: string;
  last_public_display_name: string | null;
  first_observed_at: number;
  last_observed_at: number;
  last_verified_at: number;
  visibility_barrier_at: number | null;
  transition_version: number;
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
      case 'transition_entry':
        return { kind: 'entry', entry: this.transitionEntry(request.input) };
      case 'merge_entries':
        return { kind: 'entry', entry: this.mergeEntries(request.input) };
      case 'record_review':
        this.recordReview(request.input);
        return { kind: 'ok' };
      case 'create_forget_challenge':
        this.createForgetChallenge(request.input);
        return { kind: 'ok' };
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
      case 'observe_channel_scope':
        return { kind: 'channel_scope', state: this.observeChannelScope(request.input) };
      case 'get_channel_scope':
        return {
          kind: 'channel_scope',
          state: this.getChannelScope(request.workspaceId, request.channelId) ?? null,
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
      this.enforceCreateQuota(store, input.sourceChannelId, input.description, input.body);
      if (input.actorClass !== 'operator') {
        this.incrementMutationCounts(
          input.workspaceId,
          input.sourceChannelId,
          input.actorId,
          at,
        );
      }
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
        reasonCode: `slug_seed:${input.slugSeed ?? input.slug}`,
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
      this.enforceUpdateQuota(current, input.description, input.body);
      if (input.actorClass !== 'operator') {
        this.incrementMutationCounts(
          current.workspaceId,
          current.sourceChannelId,
          input.actorId,
          at,
        );
      }
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
      if (input.confirmationTokenHash) {
        this.consumeForgetChallenge(current, input, input.confirmationTokenHash, at);
      }
      if (input.actorClass !== 'operator') {
        this.incrementMutationCounts(
          current.workspaceId,
          current.sourceChannelId,
          input.actorId,
          at,
        );
      }
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

  transitionEntry(input: TransitionMemoryEntryInput): MemoryEntry {
    const replay = this.entryForReplay(input.idempotencyKey);
    if (replay) return replay;
    const at = this.now();
    return this.db.transaction(() => {
      const secondReplay = this.entryForReplay(input.idempotencyKey);
      if (secondReplay) return secondReplay;
      const current = requiredEntry(this.getEntry(input.entryId), input.entryId);
      this.assertMutableVersion(current, input.expectedVersion);
      const nextStatus = input.transition === 'expire' ? 'expired' : 'active';
      if (
        (input.transition === 'expire' && current.status === 'expired') ||
        (input.transition === 'restore' && current.status !== 'expired')
      ) {
        throw new MemoryStateError(
          'memory_invalid_transition',
          `Memory entry cannot be ${input.transition}d from its current state.`,
        );
      }
      if (input.transition === 'restore') {
        const store = requiredStore(this.getStore(current.storeId), current.storeId);
        this.enforceCreateQuota(store, current.sourceChannelId, current.description, current.body);
      }
      if (input.actorClass !== 'operator') {
        this.incrementMutationCounts(
          current.workspaceId,
          current.sourceChannelId,
          input.actorId,
          at,
        );
      }
      const nextVersion = current.version + 1;
      this.db.run(
        `UPDATE memory_entries SET status = ?, version = ?, last_editor_actor_id = ?,
           actor_class = ?, source_event_id = ?, modified_at = ?, expires_at = ?
         WHERE entry_id = ?`,
        nextStatus,
        nextVersion,
        input.actorId,
        input.actorClass,
        input.sourceEventId ?? current.sourceEventId,
        at,
        input.transition === 'expire' ? at : null,
        current.entryId,
      );
      this.insertRevision({
        entryId: current.entryId,
        version: nextVersion,
        operation: input.transition,
        description: current.description,
        body: current.body,
        type: current.type,
        actorId: input.actorId,
        actorClass: input.actorClass,
        sourceEventId: input.sourceEventId ?? current.sourceEventId,
        sourceThreadTs: current.sourceThreadTs,
        sourceMessageTs: current.sourceMessageTs,
        createdAt: at,
        beforeHash: current.contentHash,
        afterHash: current.contentHash,
        reasonCode: input.reasonCode ?? `explicit_${input.transition}`,
        idempotencyKey: input.idempotencyKey,
      });
      this.audit.append({
        eventId: auditId(input.idempotencyKey),
        domain: 'memory',
        eventType: `memory.${input.transition}d`,
        outcome: 'success',
        actorClass: input.actorClass,
        actorId: input.actorId,
        workspaceId: current.workspaceId,
        channelId: current.sourceChannelId,
        storeId: current.storeId,
        subjectId: current.entryId,
        subjectVersion: nextVersion,
        createdAt: at,
        reasonCode: input.reasonCode ?? `explicit_${input.transition}`,
        beforeHash: current.contentHash,
        afterHash: current.contentHash,
        idempotencyKey: input.idempotencyKey,
      });
      this.trimRevisionContent(current.entryId);
      return requiredEntry(this.getEntry(current.entryId), current.entryId);
    });
  }

  mergeEntries(input: MergeMemoryEntriesInput): MemoryEntry {
    const replay = this.entryForReplay(input.replacement.idempotencyKey);
    if (replay) return replay;
    if (input.sources.length < 2 || new Set(input.sources.map((source) => source.entryId)).size !== input.sources.length) {
      throw new MemoryStateError(
        'memory_invalid_merge',
        'A merge requires at least two distinct memory entries.',
      );
    }
    const at = this.now();
    return this.db.transaction(() => {
      const secondReplay = this.entryForReplay(input.replacement.idempotencyKey);
      if (secondReplay) return secondReplay;
      const store = requiredStore(
        this.getStore(input.replacement.storeId),
        input.replacement.storeId,
      );
      if (
        store.lifecycle !== 'active' ||
        store.workspaceId !== input.replacement.workspaceId
      ) {
        throw new MemoryStateError('memory_store_sealed', 'Memory store is unavailable.');
      }
      const sources = input.sources.map((source) => {
        const entry = requiredEntry(this.getEntry(source.entryId), source.entryId);
        this.assertMutableVersion(entry, source.expectedVersion);
        if (
          entry.storeId !== input.replacement.storeId ||
          entry.sourceChannelId !== input.replacement.sourceChannelId ||
          (entry.status !== 'active' && entry.status !== 'stale')
        ) {
          throw new MemoryStateError(
            'memory_invalid_merge',
            'Merged memories must be active entries from the same source partition.',
          );
        }
        return entry;
      });
      if (input.replacement.actorClass !== 'operator') {
        this.incrementMutationCounts(
          input.replacement.workspaceId,
          input.replacement.sourceChannelId,
          input.replacement.actorId,
          at,
        );
      }
      for (const source of sources) {
        const nextVersion = source.version + 1;
        this.db.run(
          `UPDATE memory_entries SET status = 'superseded', version = ?,
             last_editor_actor_id = ?, actor_class = ?, source_event_id = ?,
             modified_at = ?, superseding_entry_id = ? WHERE entry_id = ?`,
          nextVersion,
          input.replacement.actorId,
          input.replacement.actorClass,
          input.replacement.sourceEventId ?? source.sourceEventId,
          at,
          input.replacement.entryId,
          source.entryId,
        );
        this.insertRevision({
          entryId: source.entryId,
          version: nextVersion,
          operation: 'merge',
          description: source.description,
          body: source.body,
          type: source.type,
          actorId: input.replacement.actorId,
          actorClass: input.replacement.actorClass,
          sourceEventId: input.replacement.sourceEventId ?? source.sourceEventId,
          sourceThreadTs: input.replacement.sourceThreadTs ?? source.sourceThreadTs,
          sourceMessageTs: input.replacement.sourceMessageTs ?? source.sourceMessageTs,
          createdAt: at,
          beforeHash: source.contentHash,
          afterHash: source.contentHash,
          reasonCode: `superseded_by:${input.replacement.entryId}`,
          idempotencyKey: `${input.replacement.idempotencyKey}:source:${source.entryId}`,
        });
      }
      this.enforceCreateQuota(
        store,
        input.replacement.sourceChannelId,
        input.replacement.description,
        input.replacement.body,
      );
      const hash = contentHash(input.replacement.description, input.replacement.body);
      try {
        this.db.run(
          `INSERT INTO memory_entries (
            entry_id, store_id, workspace_id, source_channel_id, slug,
            description, type, body, status, version, creator_actor_id,
            last_editor_actor_id, actor_class, source_event_id,
            source_thread_ts, source_message_ts, created_at, modified_at,
            expires_at, content_hash, superseding_entry_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          input.replacement.entryId,
          input.replacement.storeId,
          input.replacement.workspaceId,
          input.replacement.sourceChannelId,
          input.replacement.slug,
          input.replacement.description,
          input.replacement.type,
          input.replacement.body,
          input.replacement.actorId,
          input.replacement.actorId,
          input.replacement.actorClass,
          input.replacement.sourceEventId ?? null,
          input.replacement.sourceThreadTs ?? null,
          input.replacement.sourceMessageTs ?? null,
          at,
          at,
          input.replacement.expiresAt ?? null,
          hash,
        );
      } catch (error) {
        if (isConstraintViolation(error)) {
          throw new MemoryStateError('memory_slug_conflict', 'Memory name is already in use.');
        }
        throw error;
      }
      this.insertRevision({
        entryId: input.replacement.entryId,
        version: 1,
        operation: 'merge',
        description: input.replacement.description,
        body: input.replacement.body,
        type: input.replacement.type,
        actorId: input.replacement.actorId,
        actorClass: input.replacement.actorClass,
        sourceEventId: input.replacement.sourceEventId ?? null,
        sourceThreadTs: input.replacement.sourceThreadTs ?? null,
        sourceMessageTs: input.replacement.sourceMessageTs ?? null,
        createdAt: at,
        beforeHash: null,
        afterHash: hash,
        reasonCode: 'merge_replacement',
        idempotencyKey: input.replacement.idempotencyKey,
      });
      this.audit.append({
        eventId: auditId(input.replacement.idempotencyKey),
        domain: 'memory',
        eventType: 'memory.merged',
        outcome: 'success',
        actorClass: input.replacement.actorClass,
        actorId: input.replacement.actorId,
        workspaceId: input.replacement.workspaceId,
        channelId: input.replacement.sourceChannelId,
        storeId: input.replacement.storeId,
        subjectId: input.replacement.entryId,
        subjectVersion: 1,
        createdAt: at,
        afterHash: hash,
        metadataJson: JSON.stringify({ sourceEntryIds: sources.map((source) => source.entryId) }),
        idempotencyKey: input.replacement.idempotencyKey,
      });
      for (const source of sources) this.trimRevisionContent(source.entryId);
      return requiredEntry(
        this.getEntry(input.replacement.entryId),
        input.replacement.entryId,
      );
    });
  }

  recordReview(input: RecordMemoryReviewInput): void {
    if (this.audit.findByIdempotencyKey(input.idempotencyKey)) return;
    const entry = requiredEntry(this.getEntry(input.entryId), input.entryId);
    if (entry.version !== input.expectedVersion) {
      throw new MemoryVersionConflictError(entry.entryId, entry.version);
    }
    if (input.action === 'resolved' && !input.resolution) {
      throw new MemoryStateError(
        'memory_invalid_review',
        'A resolved review requires an outcome.',
      );
    }
    this.audit.append({
      eventId: auditId(input.idempotencyKey),
      domain: 'memory',
      eventType: `memory.review_${input.action}`,
      outcome: input.action === 'requested' ? 'requested' : 'success',
      actorClass: input.actorClass,
      actorId: input.actorId,
      workspaceId: entry.workspaceId,
      channelId: entry.sourceChannelId,
      storeId: entry.storeId,
      subjectId: entry.entryId,
      subjectVersion: entry.version,
      createdAt: this.now(),
      metadataJson: JSON.stringify(input.resolution ? { resolution: input.resolution } : {}),
      idempotencyKey: input.idempotencyKey,
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

  createForgetChallenge(input: CreateForgetChallengeInput): void {
    const entry = requiredEntry(this.getEntry(input.entryId), input.entryId);
    this.assertMutableVersion(entry, input.expectedVersion);
    if (entry.storeId !== input.storeId) {
      throw new MemoryStateError('memory_confirmation_invalid', 'Forget confirmation is invalid.');
    }
    this.db.run(
      `INSERT INTO memory_forget_challenges (
        challenge_id, token_hash, actor_id, store_id, entry_id,
        expected_version, expires_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      input.challengeId,
      input.tokenHash,
      input.actorId,
      input.storeId,
      input.entryId,
      input.expectedVersion,
      input.expiresAt,
    );
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

  observeChannelScope(input: ObserveMemoryChannelScopeInput): MemoryChannelScopeState {
    return this.db.transaction(() => {
      this.ensurePublicStore(input.workspaceId);
      const current = this.getChannelScope(input.workspaceId, input.channelId);
      let privateGeneration = current?.privateGeneration ?? 0;
      let visibilityBarrierAt = current?.visibilityBarrierAt ?? null;
      let lastPublicDisplayName = current?.lastPublicDisplayName ?? null;
      let transitionVersion = current?.transitionVersion ?? 0;

      if (!current) {
        transitionVersion = 1;
        if (input.privacy === 'private') {
          privateGeneration = 1;
          this.ensurePrivateStore(input.workspaceId, input.channelId, privateGeneration);
        } else {
          lastPublicDisplayName = input.displayName;
        }
        this.db.run(
          `INSERT INTO memory_scope_state (
            workspace_id, channel_id, privacy, lifecycle, private_generation,
            current_display_name, last_public_display_name, first_observed_at,
            last_observed_at, last_verified_at, visibility_barrier_at,
            transition_version
          ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.workspaceId,
          input.channelId,
          input.privacy,
          privateGeneration,
          input.displayName,
          lastPublicDisplayName,
          input.observedAt,
          input.observedAt,
          input.observedAt,
          visibilityBarrierAt,
          transitionVersion,
        );
      } else {
        const changed = current.privacy !== input.privacy;
        if (changed) {
          transitionVersion += 1;
          if (current.privacy === 'private' && input.privacy === 'public') {
            const oldStoreId = privateStoreId(
              input.workspaceId,
              input.channelId,
              current.privateGeneration,
            );
            this.db.run(
              `UPDATE memory_stores SET lifecycle = 'sealed', sealed_at = ?,
                 sealed_reason = 'private_to_public'
               WHERE store_id = ?`,
              input.observedAt,
              oldStoreId,
            );
            visibilityBarrierAt = input.observedAt;
            lastPublicDisplayName = input.displayName;
          } else if (current.privacy === 'public' && input.privacy === 'private') {
            privateGeneration = Math.max(current.privateGeneration + 1, 1);
            this.ensurePrivateStore(input.workspaceId, input.channelId, privateGeneration);
          }
        } else if (input.privacy === 'public') {
          lastPublicDisplayName = input.displayName;
        }
        this.db.run(
          `UPDATE memory_scope_state SET
            privacy = ?, lifecycle = 'active', private_generation = ?,
            current_display_name = ?, last_public_display_name = ?,
            last_observed_at = ?, last_verified_at = ?,
            visibility_barrier_at = ?, transition_version = ?
           WHERE workspace_id = ? AND channel_id = ?`,
          input.privacy,
          privateGeneration,
          input.displayName,
          lastPublicDisplayName,
          input.observedAt,
          input.observedAt,
          visibilityBarrierAt,
          transitionVersion,
          input.workspaceId,
          input.channelId,
        );
      }
      const next = this.getChannelScope(input.workspaceId, input.channelId);
      if (!next) throw new Error('Memory channel scope was not readable after observation');
      return next;
    });
  }

  getChannelScope(
    workspaceId: string,
    channelId: string,
  ): MemoryChannelScopeState | undefined {
    const row = this.db.get(
      `SELECT * FROM memory_scope_state WHERE workspace_id = ? AND channel_id = ?`,
      workspaceId,
      channelId,
    );
    return row ? rowToScope(row as unknown as ScopeRow) : undefined;
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
    // SQLite otherwise may retain overwritten memory text on freelist pages.
    // Unsupported targets may ignore this pragma, but both shipped state
    // backends use SQLite semantics and must erase forgotten content eagerly.
    this.db.exec('PRAGMA secure_delete = ON');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memory_scope_state (
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        privacy TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        private_generation INTEGER NOT NULL,
        current_display_name TEXT NOT NULL,
        last_public_display_name TEXT,
        first_observed_at INTEGER NOT NULL,
        last_observed_at INTEGER NOT NULL,
        last_verified_at INTEGER NOT NULL,
        visibility_barrier_at INTEGER,
        transition_version INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, channel_id)
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
      `CREATE TABLE IF NOT EXISTS memory_forget_challenges (
        challenge_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        actor_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        expected_version INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
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
      const count = this.mutationCount(workspaceId, channelId, subject, window);
      const limit = subject === CHANNEL_RATE_ACTOR ? MEMORY_CHANNEL_RATE_LIMIT : MEMORY_ACTOR_RATE_LIMIT;
      if (count > limit) {
        throw new MemoryRateLimitError(window + MEMORY_RATE_WINDOW_MS);
      }
    }
  }

  private consumeForgetChallenge(
    entry: MemoryEntry,
    input: ForgetMemoryEntryInput,
    tokenHash: string,
    at: number,
  ): void {
    const row = this.db.get(
      `SELECT actor_id, store_id, entry_id, expected_version, expires_at, consumed_at
       FROM memory_forget_challenges WHERE token_hash = ?`,
      tokenHash,
    );
    if (!row || row.consumed_at !== null) {
      throw new MemoryStateError('memory_confirmation_invalid', 'Forget confirmation is invalid.');
    }
    if (
      row.actor_id !== input.actorId ||
      row.store_id !== entry.storeId ||
      row.entry_id !== entry.entryId ||
      row.expected_version !== input.expectedVersion
    ) {
      throw new MemoryStateError('memory_confirmation_invalid', 'Forget confirmation is invalid.');
    }
    if (typeof row.expires_at !== 'number' || row.expires_at < at) {
      throw new MemoryStateError('memory_confirmation_expired', 'Forget confirmation expired.');
    }
    this.db.run(
      `UPDATE memory_forget_challenges SET consumed_at = ?
       WHERE token_hash = ? AND consumed_at IS NULL`,
      at,
      tokenHash,
    );
  }

  private enforceCreateQuota(
    store: MemoryStoreDescriptor,
    sourceChannelId: string,
    description: string,
    body: string,
  ): void {
    const sourceCount = Number(
      this.db.get(
        `SELECT COUNT(*) AS count FROM memory_entries
         WHERE store_id = ? AND source_channel_id = ? AND status IN ('active', 'stale')`,
        store.storeId,
        sourceChannelId,
      )?.count ?? 0,
    );
    if (sourceCount >= MEMORY_SOURCE_ENTRY_LIMIT) {
      throw new MemoryStateError('memory_source_quota', 'This channel memory is full.');
    }
    const totals = this.liveStoreTotals(store.storeId);
    const entryLimit = store.visibility === 'public' ? MEMORY_PUBLIC_ENTRY_LIMIT : MEMORY_PRIVATE_ENTRY_LIMIT;
    const byteLimit = store.visibility === 'public' ? MEMORY_PUBLIC_BYTES_LIMIT : MEMORY_PRIVATE_BYTES_LIMIT;
    if (totals.count >= entryLimit || totals.bytes + contentBytes(description, body) > byteLimit) {
      throw new MemoryStateError('memory_store_quota', 'This memory store is full.');
    }
  }

  private enforceUpdateQuota(entry: MemoryEntry, description: string, body: string): void {
    const store = this.getStore(entry.storeId);
    if (!store) throw new MemoryStateError('memory_store_not_found', 'Memory store is unavailable.');
    const totals = this.liveStoreTotals(entry.storeId);
    const byteLimit = store.visibility === 'public' ? MEMORY_PUBLIC_BYTES_LIMIT : MEMORY_PRIVATE_BYTES_LIMIT;
    const nextBytes = totals.bytes - contentBytes(entry.description, entry.body) + contentBytes(description, body);
    if (nextBytes > byteLimit) {
      throw new MemoryStateError('memory_store_quota', 'This memory store is full.');
    }
  }

  private liveStoreTotals(storeId: string): { count: number; bytes: number } {
    const row = this.db.get(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(length(CAST(description AS BLOB)) + length(CAST(body AS BLOB))), 0) AS bytes
       FROM memory_entries WHERE store_id = ? AND status IN ('active', 'stale')`,
      storeId,
    );
    return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
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

  async transitionEntry(input: TransitionMemoryEntryInput): Promise<MemoryEntry> {
    return this.logic.transitionEntry(input);
  }

  async mergeEntries(input: MergeMemoryEntriesInput): Promise<MemoryEntry> {
    return this.logic.mergeEntries(input);
  }

  async recordReview(input: RecordMemoryReviewInput): Promise<void> {
    this.logic.recordReview(input);
  }

  async createForgetChallenge(input: CreateForgetChallengeInput): Promise<void> {
    this.logic.createForgetChallenge(input);
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

  async observeChannelScope(
    input: ObserveMemoryChannelScopeInput,
  ): Promise<MemoryChannelScopeState> {
    return this.logic.observeChannelScope(input);
  }

  async getChannelScope(
    workspaceId: string,
    channelId: string,
  ): Promise<MemoryChannelScopeState | undefined> {
    return this.logic.getChannelScope(workspaceId, channelId);
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

function contentBytes(description: string, body: string): number {
  return Buffer.byteLength(description, 'utf8') + Buffer.byteLength(body, 'utf8');
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

function requiredStore(
  store: MemoryStoreDescriptor | undefined,
  storeId: string,
): MemoryStoreDescriptor {
  if (!store) {
    throw new MemoryStateError('memory_store_not_found', 'Memory store was not found.', {
      storeId,
    });
  }
  return store;
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

function rowToScope(row: ScopeRow): MemoryChannelScopeState {
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    privacy: row.privacy,
    lifecycle: row.lifecycle,
    privateGeneration: row.private_generation,
    privateStoreId:
      row.privacy === 'private'
        ? privateStoreId(row.workspace_id, row.channel_id, row.private_generation)
        : null,
    currentDisplayName: row.current_display_name,
    lastPublicDisplayName: row.last_public_display_name,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    lastVerifiedAt: row.last_verified_at,
    visibilityBarrierAt: row.visibility_barrier_at,
    transitionVersion: row.transition_version,
  };
}
