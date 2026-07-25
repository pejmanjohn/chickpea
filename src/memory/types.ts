import type { AuditEvent, AuditEventFilter } from '../audit/types.ts';

export const MEMORY_SCHEMA_VERSION = 1;
export const MEMORY_ACTOR_RATE_LIMIT = 30;
export const MEMORY_CHANNEL_RATE_LIMIT = 120;
export const MEMORY_REVISION_CONTENT_LIMIT = 50;
export const MEMORY_SOURCE_ENTRY_LIMIT = 64;
export const MEMORY_PUBLIC_ENTRY_LIMIT = 512;
export const MEMORY_PRIVATE_ENTRY_LIMIT = 128;
export const MEMORY_PUBLIC_BYTES_LIMIT = 1_048_576;
export const MEMORY_PRIVATE_BYTES_LIMIT = 262_144;
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
  /** Stable normalized seed used to bind idempotent create replays. */
  slugSeed?: string;
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
  confirmationTokenHash?: string;
}

export interface CreateForgetChallengeInput {
  challengeId: string;
  tokenHash: string;
  actorId: string;
  storeId: string;
  entryId: string;
  expectedVersion: number;
  expiresAt: number;
}

export interface MemoryForgetChallenge {
  storeId: string;
  entryId: string;
  expectedVersion: number;
  expiresAt: number;
}

export interface TransitionMemoryEntryInput {
  entryId: string;
  expectedVersion: number;
  transition: 'expire' | 'restore';
  actorId: string;
  actorClass: MemoryActorClass;
  sourceEventId?: string;
  reasonCode?: string;
  idempotencyKey: string;
}

export interface MergeMemoryEntriesInput {
  replacement: CreateMemoryEntryInput;
  sources: Array<{ entryId: string; expectedVersion: number }>;
}

export interface RecordMemoryReviewInput {
  entryId: string;
  expectedVersion: number;
  action: 'requested' | 'resolved';
  resolution?: 'confirmed' | 'corrected' | 'expired';
  reasonCode?: 'stale' | 'incorrect' | 'unsafe' | 'unclear';
  actorId: string;
  actorClass: MemoryActorClass;
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

export interface ConfirmMemoryConversationContextInput {
  baseConversationKey: string;
  epoch: number;
  selectionFingerprint: string;
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
  /** True only when the caller must seed a newly rotated agent transcript. */
  inject: boolean;
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

export class MemoryRateLimitError extends MemoryStateError {
  override readonly name = 'MemoryRateLimitError';

  constructor(readonly retryAt: number) {
    super('memory_rate_limited', 'Too many memory changes; try again later.', {
      retryAt: String(retryAt),
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
  | { kind: 'transition_entry'; input: TransitionMemoryEntryInput }
  | { kind: 'merge_entries'; input: MergeMemoryEntriesInput }
  | { kind: 'record_review'; input: RecordMemoryReviewInput }
  | { kind: 'create_forget_challenge'; input: CreateForgetChallengeInput }
  | { kind: 'get_forget_challenge'; tokenHash: string; actorId: string }
  | { kind: 'list_revisions'; entryId: string }
  | { kind: 'list_audit_events'; filter: AuditEventFilter }
  | { kind: 'get_mutation_counts'; workspaceId: string; channelId: string; actorId: string }
  | { kind: 'resolve_conversation_context'; input: ResolveMemoryConversationContextInput }
  | { kind: 'confirm_conversation_context'; input: ConfirmMemoryConversationContextInput }
  | { kind: 'observe_channel_scope'; input: ObserveMemoryChannelScopeInput }
  | { kind: 'get_channel_scope'; workspaceId: string; channelId: string }
  | { kind: 'cleanup_retention' };

export type MemoryRpcResponse =
  | { kind: 'ok' }
  | { kind: 'store'; store: MemoryStoreDescriptor | null }
  | { kind: 'entry'; entry: MemoryEntry | null }
  | { kind: 'entries'; entries: MemoryEntry[] }
  | { kind: 'revisions'; revisions: MemoryRevision[] }
  | { kind: 'audit_events'; events: AuditEvent[] }
  | { kind: 'mutation_counts'; counts: MemoryMutationCounts }
  | { kind: 'conversation_context'; context: MemoryConversationContext }
  | { kind: 'conversation_context_confirmed'; confirmed: boolean }
  | { kind: 'channel_scope'; state: MemoryChannelScopeState | null }
  | { kind: 'forget_challenge'; challenge: MemoryForgetChallenge | null }
  | { kind: 'cleanup'; actorIdsCleared: number; rateWindowsDeleted: number; contextsDeleted: number };

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
  transitionEntry(input: TransitionMemoryEntryInput): Promise<MemoryEntry>;
  mergeEntries(input: MergeMemoryEntriesInput): Promise<MemoryEntry>;
  recordReview(input: RecordMemoryReviewInput): Promise<void>;
  createForgetChallenge(input: CreateForgetChallengeInput): Promise<void>;
  getForgetChallenge(
    tokenHash: string,
    actorId: string,
  ): Promise<MemoryForgetChallenge | undefined>;
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
  confirmConversationContext(input: ConfirmMemoryConversationContextInput): Promise<boolean>;
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
  close?(): void;
}
