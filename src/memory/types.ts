import type { AuditEvent, AuditEventFilter } from '../audit/types.ts';

export const MEMORY_SCHEMA_VERSION = 2;
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
export type MemoryImportEntryStatus = Exclude<MemoryEntryStatus, 'forgotten'>;
export type MemoryActorClass = 'member' | 'operator' | 'system';

export type MemoryOwnerKind = 'agent' | 'channel';

export interface MemoryOwnerRef {
  workspaceId: string;
  ownerKind: MemoryOwnerKind;
  ownerId: string;
}

export interface MemoryOwnerDescriptor extends MemoryOwnerRef {
  storeId: string;
  lifecycle: 'active' | 'sealed';
  resetEpoch: number;
  createdAt: number;
  sealedAt: number | null;
  sealedReason: string | null;
  schemaVersion: 2;
}

/** Provenance only. Authorization is always bound from MemoryOwnerDescriptor. */
export type MemoryWriteOrigin =
  | { kind: 'admin' }
  | { kind: 'slack_channel'; channelId: string }
  | { kind: 'slack_dm'; channelId: string };

export interface OwnerMemoryEntry {
  entryId: string;
  storeId: string;
  workspaceId: string;
  ownerKind: MemoryOwnerKind;
  ownerId: string;
  slug: string;
  description: string;
  type: MemoryEntryType;
  body: string;
  status: MemoryEntryStatus;
  version: number;
  creatorActorId: string | null;
  lastEditorActorId: string | null;
  actorClass: MemoryActorClass;
  writeOrigin: MemoryWriteOrigin | null;
  sourceEventId: string | null;
  sourceThreadTs: string | null;
  sourceMessageTs: string | null;
  createdAt: number;
  modifiedAt: number;
  expiresAt: number | null;
  contentHash: string | null;
  supersedingEntryId: string | null;
}

export interface CreateOwnerMemoryEntryInput {
  entryId: string;
  storeId: string;
  workspaceId: string;
  slug: string;
  slugSeed?: string;
  description: string;
  type: MemoryEntryType;
  body: string;
  actorId: string;
  actorClass: MemoryActorClass;
  writeOrigin?: MemoryWriteOrigin | null;
  sourceEventId?: string;
  sourceThreadTs?: string;
  sourceMessageTs?: string;
  expiresAt?: number;
  idempotencyKey: string;
}

export type UpdateOwnerMemoryEntryInput = UpdateMemoryEntryInput;

export type ForgetOwnerMemoryEntryInput = ForgetMemoryEntryInput;
export type TransitionOwnerMemoryEntryInput = TransitionMemoryEntryInput;
export type RecordOwnerMemoryReviewInput = RecordMemoryReviewInput;

export interface MergeOwnerMemoryEntriesInput {
  replacement: CreateOwnerMemoryEntryInput;
  sources: Array<{ entryId: string; expectedVersion: number }>;
}

export interface ApplyOwnerMemoryImportOperation {
  action: 'create' | 'update';
  entryId: string;
  expectedVersion?: number;
  slug: string;
  description: string;
  type: MemoryEntryType;
  body: string;
  status?: MemoryImportEntryStatus;
}

export interface ApplyOwnerMemoryImportInput {
  owner: MemoryOwnerRef;
  actorId: string;
  archiveSha256: string;
  idempotencyKey: string;
  operations: ApplyOwnerMemoryImportOperation[];
}

export type ReplayOwnerMemoryImportInput = Omit<ApplyOwnerMemoryImportInput, 'operations'>;

export interface OwnerMemoryLifecycleInput {
  actorId: string;
  idempotencyKey: string;
}

export interface SealMemoryOwnerInput extends OwnerMemoryLifecycleInput {
  reason: 'channel_archived' | 'agent_deleted' | 'operator_sealed';
}

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
  reviewRequestEventId?: string;
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

export interface RetainMemoryChannelScopeInput {
  workspaceId: string;
  channelId: string;
  reason: 'archived' | 'deleted';
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
  offset?: number;
}

export interface MemoryEntryScopeSummary {
  storeId: string;
  sourceChannelId: string;
  entryCount: number;
}

export interface ApplyMemoryImportOperation {
  action: 'create' | 'update';
  entryId: string;
  expectedVersion?: number;
  sourceChannelId: string;
  slug: string;
  description: string;
  type: MemoryEntryType;
  body: string;
  /** Absent only for legacy content-only callers, which import as active. */
  status?: MemoryImportEntryStatus;
}

export interface ApplyMemoryImportInput {
  storeId: string;
  workspaceId: string;
  actorId: string;
  archiveSha256: string;
  idempotencyKey: string;
  operations: ApplyMemoryImportOperation[];
}

export type ReplayMemoryImportInput = Omit<ApplyMemoryImportInput, 'operations'>;

export interface RecordMemoryAdminViewInput {
  entryId: string;
  actorId: string;
  idempotencyKey: string;
}

export interface RecordMemoryAdminEventInput {
  eventType: 'memory.exported';
  storeId: string;
  actorId: string;
  idempotencyKey: string;
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
  | { kind: 'ensure_owner'; owner: MemoryOwnerRef }
  | { kind: 'get_owner'; storeId: string }
  | { kind: 'list_owners'; workspaceId?: string }
  | { kind: 'create_owner_entry'; input: CreateOwnerMemoryEntryInput }
  | { kind: 'get_owner_entry'; entryId: string }
  | { kind: 'update_owner_entry'; input: UpdateOwnerMemoryEntryInput }
  | { kind: 'forget_owner_entry'; input: ForgetOwnerMemoryEntryInput }
  | { kind: 'transition_owner_entry'; input: TransitionOwnerMemoryEntryInput }
  | { kind: 'merge_owner_entries'; input: MergeOwnerMemoryEntriesInput }
  | { kind: 'record_owner_review'; input: RecordOwnerMemoryReviewInput }
  | { kind: 'create_owner_forget_challenge'; input: CreateForgetChallengeInput }
  | { kind: 'replay_owner_import'; input: ReplayOwnerMemoryImportInput }
  | { kind: 'apply_owner_import'; input: ApplyOwnerMemoryImportInput }
  | { kind: 'list_owner_entries'; owner: MemoryOwnerRef }
  | { kind: 'list_owner_revisions'; entryId: string }
  | { kind: 'reset_owner'; owner: MemoryOwnerRef; input: OwnerMemoryLifecycleInput }
  | { kind: 'seal_owner'; owner: MemoryOwnerRef; input: SealMemoryOwnerInput }
  | { kind: 'ensure_public_store'; workspaceId: string }
  | { kind: 'ensure_private_store'; workspaceId: string; channelId: string; generation: number }
  | { kind: 'get_store'; storeId: string }
  | { kind: 'list_stores'; workspaceId?: string }
  | { kind: 'create_entry'; input: CreateMemoryEntryInput }
  | { kind: 'get_entry'; entryId: string }
  | { kind: 'list_entries'; filter: MemoryEntryFilter }
  | { kind: 'replay_import'; input: ReplayMemoryImportInput }
  | { kind: 'apply_import'; input: ApplyMemoryImportInput }
  | { kind: 'record_admin_view'; input: RecordMemoryAdminViewInput }
  | { kind: 'record_admin_event'; input: RecordMemoryAdminEventInput }
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
  | { kind: 'retain_channel_scope'; input: RetainMemoryChannelScopeInput }
  | { kind: 'get_channel_scope'; workspaceId: string; channelId: string }
  | { kind: 'list_channel_scopes'; workspaceId?: string }
  | { kind: 'list_entry_scope_summaries'; workspaceId?: string }
  | { kind: 'cleanup_retention' };

export type MemoryRpcResponse =
  | { kind: 'ok' }
  | { kind: 'owner'; owner: MemoryOwnerDescriptor | null }
  | { kind: 'owners'; owners: MemoryOwnerDescriptor[] }
  | { kind: 'owner_entry'; entry: OwnerMemoryEntry | null }
  | { kind: 'owner_entries'; entries: OwnerMemoryEntry[] }
  | { kind: 'owner_import_replay'; entries: OwnerMemoryEntry[] | null }
  | { kind: 'store'; store: MemoryStoreDescriptor | null }
  | { kind: 'stores'; stores: MemoryStoreDescriptor[] }
  | { kind: 'entry'; entry: MemoryEntry | null }
  | { kind: 'entries'; entries: MemoryEntry[] }
  | { kind: 'import_replay'; entries: MemoryEntry[] | null }
  | { kind: 'channel_scopes'; states: MemoryChannelScopeState[] }
  | { kind: 'entry_scope_summaries'; summaries: MemoryEntryScopeSummary[] }
  | { kind: 'revisions'; revisions: MemoryRevision[] }
  | { kind: 'audit_events'; events: AuditEvent[] }
  | { kind: 'mutation_counts'; counts: MemoryMutationCounts }
  | { kind: 'conversation_context'; context: MemoryConversationContext }
  | { kind: 'conversation_context_confirmed'; confirmed: boolean }
  | { kind: 'channel_scope'; state: MemoryChannelScopeState | null }
  | { kind: 'forget_challenge'; challenge: MemoryForgetChallenge | null }
  | {
      kind: 'cleanup';
      actorIdsCleared: number;
      rateWindowsDeleted: number;
      contextsDeleted: number;
      forgetChallengesDeleted: number;
    };

export interface MemoryStateStore {
  ensureOwner(owner: MemoryOwnerRef): Promise<MemoryOwnerDescriptor>;
  getOwner(storeId: string): Promise<MemoryOwnerDescriptor | undefined>;
  listOwners(workspaceId?: string): Promise<MemoryOwnerDescriptor[]>;
  createOwnerEntry(input: CreateOwnerMemoryEntryInput): Promise<OwnerMemoryEntry>;
  getOwnerEntry(entryId: string): Promise<OwnerMemoryEntry | undefined>;
  updateOwnerEntry(input: UpdateOwnerMemoryEntryInput): Promise<OwnerMemoryEntry>;
  forgetOwnerEntry(input: ForgetOwnerMemoryEntryInput): Promise<OwnerMemoryEntry>;
  transitionOwnerEntry(input: TransitionOwnerMemoryEntryInput): Promise<OwnerMemoryEntry>;
  mergeOwnerEntries(input: MergeOwnerMemoryEntriesInput): Promise<OwnerMemoryEntry>;
  recordOwnerReview(input: RecordOwnerMemoryReviewInput): Promise<void>;
  createOwnerForgetChallenge(input: CreateForgetChallengeInput): Promise<void>;
  replayOwnerImport(input: ReplayOwnerMemoryImportInput): Promise<OwnerMemoryEntry[] | undefined>;
  applyOwnerImport(input: ApplyOwnerMemoryImportInput): Promise<OwnerMemoryEntry[]>;
  listOwnerEntries(owner: MemoryOwnerRef): Promise<OwnerMemoryEntry[]>;
  listOwnerRevisions(entryId: string): Promise<MemoryRevision[]>;
  resetOwner(owner: MemoryOwnerRef, input: OwnerMemoryLifecycleInput): Promise<MemoryOwnerDescriptor>;
  sealOwner(owner: MemoryOwnerRef, input: SealMemoryOwnerInput): Promise<MemoryOwnerDescriptor>;
  ensurePublicStore(workspaceId: string): Promise<MemoryStoreDescriptor>;
  ensurePrivateStore(
    workspaceId: string,
    channelId: string,
    generation: number,
  ): Promise<MemoryStoreDescriptor>;
  getStore(storeId: string): Promise<MemoryStoreDescriptor | undefined>;
  listStores(workspaceId?: string): Promise<MemoryStoreDescriptor[]>;
  createEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry>;
  getEntry(entryId: string): Promise<MemoryEntry | undefined>;
  listEntries(filter?: MemoryEntryFilter): Promise<MemoryEntry[]>;
  replayImport(input: ReplayMemoryImportInput): Promise<MemoryEntry[] | undefined>;
  applyImport(input: ApplyMemoryImportInput): Promise<MemoryEntry[]>;
  recordAdminView(input: RecordMemoryAdminViewInput): Promise<void>;
  recordAdminEvent(input: RecordMemoryAdminEventInput): Promise<void>;
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
  retainChannelScope(input: RetainMemoryChannelScopeInput): Promise<MemoryChannelScopeState>;
  getChannelScope(
    workspaceId: string,
    channelId: string,
  ): Promise<MemoryChannelScopeState | undefined>;
  listChannelScopes(workspaceId?: string): Promise<MemoryChannelScopeState[]>;
  listEntryScopeSummaries(workspaceId?: string): Promise<MemoryEntryScopeSummary[]>;
  cleanupRetention(): Promise<{
    actorIdsCleared: number;
    rateWindowsDeleted: number;
    contextsDeleted: number;
    forgetChallengesDeleted: number;
  }>;
  close?(): void;
}
