import type { AuditEvent, AuditEventFilter } from '../audit/types.ts';

export const MEMORY_SCHEMA_VERSION = 1;
export const MEMORY_SETTING_KEY = 'memory.enabled';
export const MEMORY_ACTOR_RATE_LIMIT = 30;
export const MEMORY_CHANNEL_RATE_LIMIT = 120;
export const MEMORY_REVISION_CONTENT_LIMIT = 50;
export const MEMORY_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;
export const MEMORY_RATE_WINDOW_MS = 60 * 60 * 1_000;

export type MemoryVisibility = 'public' | 'private';
export type MemoryStoreLifecycle = 'active' | 'sealed' | 'retained';
export type MemoryEntryType = 'fact' | 'decision' | 'project' | 'feedback' | 'preference';
export type MemoryEntryStatus = 'active' | 'stale' | 'expired' | 'superseded' | 'forgotten';
export type MemoryActorClass = 'member' | 'operator' | 'system';

export interface MemoryStoreDescriptor {
  storeId: string;
  workspaceId: string;
  visibility: MemoryVisibility;
  channelId: string | null;
  generation: number | null;
  lifecycle: MemoryStoreLifecycle;
  createdAt: number;
  sealedAt: number | null;
  sealedReason: string | null;
  schemaVersion: number;
}

export interface MemoryEntry {
  entryId: string;
  storeId: string;
  workspaceId: string;
  sourceChannelId: string;
  slug: string;
  description: string;
  type: MemoryEntryType;
  body: string;
  status: MemoryEntryStatus;
  version: number;
  creatorActorId: string | null;
  lastEditorActorId: string | null;
  actorClass: MemoryActorClass;
  sourceEventId: string | null;
  sourceThreadTs: string | null;
  sourceMessageTs: string | null;
  createdAt: number;
  modifiedAt: number;
  expiresAt: number | null;
  contentHash: string | null;
  supersedingEntryId: string | null;
}

export interface MemoryRevision {
  entryId: string;
  version: number;
  operation: 'create' | 'update' | 'merge' | 'forget' | 'expire' | 'restore';
  description: string | null;
  body: string | null;
  type: MemoryEntryType | null;
  actorId: string | null;
  actorClass: MemoryActorClass;
  sourceEventId: string | null;
  sourceThreadTs: string | null;
  sourceMessageTs: string | null;
  createdAt: number;
  beforeHash: string | null;
  afterHash: string | null;
  reasonCode: string | null;
  idempotencyKey: string;
}

export interface CreateMemoryEntryInput {
  entryId: string;
  storeId: string;
  workspaceId: string;
  sourceChannelId: string;
  slug: string;
  description: string;
  type: MemoryEntryType;
  body: string;
  actorId: string;
  actorClass: MemoryActorClass;
  sourceEventId?: string;
  sourceThreadTs?: string;
  sourceMessageTs?: string;
  expiresAt?: number;
  idempotencyKey: string;
}

export interface UpdateMemoryEntryInput {
  entryId: string;
  expectedVersion: number;
  description: string;
  type: MemoryEntryType;
  body: string;
  actorId: string;
  actorClass: MemoryActorClass;
  sourceEventId?: string;
  sourceThreadTs?: string;
  sourceMessageTs?: string;
  expiresAt?: number | null;
  idempotencyKey: string;
}

export interface ForgetMemoryEntryInput {
  entryId: string;
  expectedVersion: number;
  actorId: string;
  actorClass: MemoryActorClass;
  sourceEventId?: string;
  reasonCode?: string;
  idempotencyKey: string;
}

export interface MemoryConversationSelection {
  entryId: string;
  version: number;
}

export interface ResolveMemoryConversationContextInput {
  baseConversationKey: string;
  scopeSignature: string;
  selectionFingerprint: string;
  selected: readonly MemoryConversationSelection[];
  visibilityBarrierAt?: number | null;
  expiresAt: number;
}

export interface MemoryConversationContext {
  baseConversationKey: string;
  epoch: number;
  scopeSignature: string;
  selectionFingerprint: string;
  selected: MemoryConversationSelection[];
  visibilityBarrierAt: number | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface MemoryMutationCounts {
  actor: number;
  channel: number;
  windowStartedAt: number;
}

export interface ObserveMemoryChannelScopeInput {
  workspaceId: string;
  channelId: string;
  privacy: MemoryVisibility;
  displayName: string;
  observedAt: number;
}

export interface MemoryChannelScopeState {
  workspaceId: string;
  channelId: string;
  privacy: MemoryVisibility;
  lifecycle: 'active' | 'retained';
  privateGeneration: number;
  privateStoreId: string | null;
  currentDisplayName: string;
  lastPublicDisplayName: string | null;
  firstObservedAt: number;
  lastObservedAt: number;
  lastVerifiedAt: number;
  visibilityBarrierAt: number | null;
  transitionVersion: number;
}

export interface SetMemoryEnabledInput {
  enabled: boolean;
  actorId: string;
  idempotencyKey: string;
}

export interface MemoryEntryFilter {
  storeId?: string;
  workspaceId?: string;
  sourceChannelId?: string;
  statuses?: readonly MemoryEntryStatus[];
  limit?: number;
}

export class MemoryStateError extends Error {
  override readonly name: string = 'MemoryStateError';

  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, string> = {},
  ) {
    super(message);
  }
}

export class MemoryVersionConflictError extends MemoryStateError {
  override readonly name = 'MemoryVersionConflictError';

  constructor(readonly entryId: string, readonly currentVersion: number) {
    super('memory_version_conflict', 'Memory entry changed before this update.', {
      entryId,
      currentVersion: String(currentVersion),
    });
  }
}

export type MemoryRpcRequest =
  | { kind: 'ensure_public_store'; workspaceId: string }
  | { kind: 'ensure_private_store'; workspaceId: string; channelId: string; generation: number }
  | { kind: 'get_store'; storeId: string }
  | { kind: 'create_entry'; input: CreateMemoryEntryInput }
  | { kind: 'get_entry'; entryId: string }
  | { kind: 'list_entries'; filter: MemoryEntryFilter }
  | { kind: 'update_entry'; input: UpdateMemoryEntryInput }
  | { kind: 'forget_entry'; input: ForgetMemoryEntryInput }
  | { kind: 'list_revisions'; entryId: string }
  | { kind: 'list_audit_events'; filter: AuditEventFilter }
  | { kind: 'get_mutation_counts'; workspaceId: string; channelId: string; actorId: string }
  | { kind: 'resolve_conversation_context'; input: ResolveMemoryConversationContextInput }
  | { kind: 'observe_channel_scope'; input: ObserveMemoryChannelScopeInput }
  | { kind: 'get_channel_scope'; workspaceId: string; channelId: string }
  | { kind: 'cleanup_retention' }
  | { kind: 'get_memory_enabled' }
  | { kind: 'set_memory_enabled'; input: SetMemoryEnabledInput };

export type MemoryRpcResponse =
  | { kind: 'store'; store: MemoryStoreDescriptor | null }
  | { kind: 'entry'; entry: MemoryEntry | null }
  | { kind: 'entries'; entries: MemoryEntry[] }
  | { kind: 'revisions'; revisions: MemoryRevision[] }
  | { kind: 'audit_events'; events: AuditEvent[] }
  | { kind: 'mutation_counts'; counts: MemoryMutationCounts }
  | { kind: 'conversation_context'; context: MemoryConversationContext }
  | { kind: 'channel_scope'; state: MemoryChannelScopeState | null }
  | { kind: 'cleanup'; actorIdsCleared: number; rateWindowsDeleted: number; contextsDeleted: number }
  | { kind: 'memory_enabled'; enabled: boolean };

export interface MemoryStateStore {
  ensurePublicStore(workspaceId: string): Promise<MemoryStoreDescriptor>;
  ensurePrivateStore(
    workspaceId: string,
    channelId: string,
    generation: number,
  ): Promise<MemoryStoreDescriptor>;
  getStore(storeId: string): Promise<MemoryStoreDescriptor | undefined>;
  createEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry>;
  getEntry(entryId: string): Promise<MemoryEntry | undefined>;
  listEntries(filter?: MemoryEntryFilter): Promise<MemoryEntry[]>;
  updateEntry(input: UpdateMemoryEntryInput): Promise<MemoryEntry>;
  forgetEntry(input: ForgetMemoryEntryInput): Promise<MemoryEntry>;
  listRevisions(entryId: string): Promise<MemoryRevision[]>;
  listAuditEvents(filter?: AuditEventFilter): Promise<AuditEvent[]>;
  getMutationCounts(
    workspaceId: string,
    channelId: string,
    actorId: string,
  ): Promise<MemoryMutationCounts>;
  resolveConversationContext(
    input: ResolveMemoryConversationContextInput,
  ): Promise<MemoryConversationContext>;
  observeChannelScope(input: ObserveMemoryChannelScopeInput): Promise<MemoryChannelScopeState>;
  getChannelScope(
    workspaceId: string,
    channelId: string,
  ): Promise<MemoryChannelScopeState | undefined>;
  cleanupRetention(): Promise<{
    actorIdsCleared: number;
    rateWindowsDeleted: number;
    contextsDeleted: number;
  }>;
  getMemoryEnabled(): Promise<boolean>;
  setMemoryEnabled(input: SetMemoryEnabledInput): Promise<boolean>;
  close?(): void;
}
