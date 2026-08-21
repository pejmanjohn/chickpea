import { createHash, timingSafeEqual } from 'node:crypto';

import type { SettingsStore } from '../config/settings-store.ts';
import type { IdentityStore } from '../identity/types.ts';
import { isActiveConnectionActor } from './runtime.ts';
import type {
  OAuthContinuation,
  OAuthContinuationResult,
} from './types.ts';

const DEFAULT_TTL_MS = 15 * 60_000;
const RESUME_PENDING_INDEX_KEY = 'connection-oauth-resume-pending';

export class OAuthContinuationError extends Error {
  readonly name = 'OAuthContinuationError';
  constructor(readonly code: 'invalid_state' | 'expired' | 'replayed' | 'wrong_actor' | 'wrong_agent') {
    super(`OAuth continuation ${code.replace('_', ' ')}`);
  }
}

export async function createOAuthContinuation(input: {
  settings: SettingsStore;
  workspaceId: string;
  actorMembershipId: string;
  agentId: string;
  channelId: string;
  threadTs: string;
  taskId: string;
  providerId: string;
  accountId: string;
  now?: () => number;
  randomId?: () => string;
  ttlMs?: number;
}): Promise<OAuthContinuationResult> {
  const now = (input.now ?? Date.now)();
  const random = input.randomId ?? (() => crypto.randomUUID().replace(/-/g, ''));
  const id = `oauthcontinuation_${random()}`;
  const capability = random();
  const continuation: OAuthContinuation = {
    id,
    workspaceId: input.workspaceId,
    actorMembershipId: input.actorMembershipId,
    agentId: input.agentId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    taskId: input.taskId,
    providerId: input.providerId,
    accountId: input.accountId,
    stateHash: hash(capability),
    status: 'pending',
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
    updatedAt: now,
  };
  await input.settings.setSetting(key(id), JSON.stringify(continuation));
  return { continuation, state: encodeState(id, capability) };
}

export async function authorizeOAuthContinuation(input: {
  settings: SettingsStore;
  state: string;
  actorMembershipId: string;
  agentId: string;
  now?: () => number;
}): Promise<OAuthContinuation> {
  const { id, capability } = decodeState(input.state);
  const settingKey = key(id);
  const raw = await input.settings.getSetting(settingKey);
  if (!raw) throw new OAuthContinuationError('invalid_state');
  const continuation = parse(raw);
  if (!safeHashEqual(continuation.stateHash, hash(capability))) {
    throw new OAuthContinuationError('invalid_state');
  }
  if (continuation.actorMembershipId !== input.actorMembershipId) {
    throw new OAuthContinuationError('wrong_actor');
  }
  if (continuation.agentId !== input.agentId) throw new OAuthContinuationError('wrong_agent');
  if (continuation.status !== 'pending') throw new OAuthContinuationError('replayed');
  const now = (input.now ?? Date.now)();
  if (continuation.expiresAt <= now) {
    await input.settings.applySettingsPatch({
      expected: { key: settingKey, value: raw },
      set: [{ key: settingKey, value: JSON.stringify({ ...continuation, status: 'expired', updatedAt: now }) }],
    });
    throw new OAuthContinuationError('expired');
  }
  const authorized: OAuthContinuation = { ...continuation, status: 'authorized', updatedAt: now };
  const changed = await input.settings.applySettingsPatch({
    expected: { key: settingKey, value: raw },
    set: [{ key: settingKey, value: JSON.stringify(authorized) }],
  });
  if (!changed) throw new OAuthContinuationError('replayed');
  return authorized;
}

/**
 * Provider callbacks have already consumed their own opaque OAuth state. This
 * second capability binds that successful callback to the exact Slack task
 * that initiated it without trusting browser query parameters.
 */
export async function authorizeOAuthContinuationFromProvider(input: {
  settings: SettingsStore;
  state: string;
  now?: () => number;
}): Promise<OAuthContinuation> {
  const { id, capability } = decodeState(input.state);
  const settingKey = key(id);
  const raw = await input.settings.getSetting(settingKey);
  if (!raw) throw new OAuthContinuationError('invalid_state');
  const continuation = parse(raw);
  if (!safeHashEqual(continuation.stateHash, hash(capability))) {
    throw new OAuthContinuationError('invalid_state');
  }
  if (continuation.status !== 'pending') throw new OAuthContinuationError('replayed');
  const now = (input.now ?? Date.now)();
  if (continuation.expiresAt <= now) {
    await input.settings.applySettingsPatch({
      expected: { key: settingKey, value: raw },
      set: [{ key: settingKey, value: JSON.stringify({ ...continuation, status: 'expired', updatedAt: now }) }],
    });
    throw new OAuthContinuationError('expired');
  }
  // Index first. A crash can leave a harmless pending entry, but can never
  // leave an authorized continuation invisible to the periodic repair loop.
  await input.settings.mergeSettingStringSet(RESUME_PENDING_INDEX_KEY, [continuation.id]);
  const authorized: OAuthContinuation = { ...continuation, status: 'authorized', updatedAt: now };
  const changed = await input.settings.applySettingsPatch({
    expected: { key: settingKey, value: raw },
    set: [{ key: settingKey, value: JSON.stringify(authorized) }],
  });
  if (!changed) throw new OAuthContinuationError('replayed');
  return authorized;
}

/** Read and verify the task capability before promoting a freshly authorized account. */
export async function inspectOAuthContinuationFromProvider(input: {
  settings: SettingsStore;
  state: string;
  now?: () => number;
}): Promise<OAuthContinuation> {
  const { id, capability } = decodeState(input.state);
  const raw = await input.settings.getSetting(key(id));
  if (!raw) throw new OAuthContinuationError('invalid_state');
  const continuation = parse(raw);
  if (!safeHashEqual(continuation.stateHash, hash(capability))) {
    throw new OAuthContinuationError('invalid_state');
  }
  if (continuation.status !== 'pending') throw new OAuthContinuationError('replayed');
  if (continuation.expiresAt <= (input.now ?? Date.now)()) {
    throw new OAuthContinuationError('expired');
  }
  return continuation;
}

/** Exact active membership fence for OAuth promotion and later resume repair. */
export async function isOAuthContinuationActorActive(input: {
  continuation: OAuthContinuation;
  identity: Pick<
    IdentityStore,
    | 'getOrganization'
    | 'getMembership'
    | 'getMembershipAccessOverlay'
    | 'getUser'
    | 'resolveSlackIdentity'
  >;
}): Promise<boolean> {
  return isActiveConnectionActor({
    identity: input.identity,
    workspaceId: input.continuation.workspaceId,
    actorMembershipId: input.continuation.actorMembershipId,
  });
}

export async function cancelOAuthContinuationFromProvider(input: {
  settings: SettingsStore;
  state: string;
  now?: () => number;
}): Promise<OAuthContinuation> {
  const { id, capability } = decodeState(input.state);
  const settingKey = key(id);
  const raw = await input.settings.getSetting(settingKey);
  if (!raw) throw new OAuthContinuationError('invalid_state');
  const continuation = parse(raw);
  if (!safeHashEqual(continuation.stateHash, hash(capability))) {
    throw new OAuthContinuationError('invalid_state');
  }
  if (continuation.status !== 'pending') throw new OAuthContinuationError('replayed');
  const cancelled: OAuthContinuation = {
    ...continuation,
    status: 'cancelled',
    updatedAt: (input.now ?? Date.now)(),
  };
  const changed = await input.settings.applySettingsPatch({
    expected: { key: settingKey, value: raw },
    set: [{ key: settingKey, value: JSON.stringify(cancelled) }],
  });
  if (!changed) throw new OAuthContinuationError('replayed');
  return cancelled;
}

export async function linkOAuthProviderState(input: {
  settings: SettingsStore;
  providerState: string;
  continuationState: string;
}): Promise<void> {
  await input.settings.setSetting(providerStateKey(input.providerState), input.continuationState);
}

/** Consume-once lookup; callback replay cannot authorize the Slack task twice. */
export async function takeOAuthContinuationForProviderState(input: {
  settings: SettingsStore;
  providerState: string;
}): Promise<string | undefined> {
  const settingKey = providerStateKey(input.providerState);
  const raw = await input.settings.getSetting(settingKey);
  if (!raw) return undefined;
  const changed = await input.settings.applySettingsPatch({
    expected: { key: settingKey, value: raw },
    delete: [settingKey],
  });
  return changed ? raw : undefined;
}

export async function claimOAuthContinuationResume(input: {
  settings: SettingsStore;
  continuationId: string;
  now?: () => number;
}): Promise<OAuthContinuation> {
  const settingKey = key(input.continuationId);
  const raw = await input.settings.getSetting(settingKey);
  if (!raw) throw new OAuthContinuationError('invalid_state');
  const continuation = parse(raw);
  if (continuation.status !== 'authorized') throw new OAuthContinuationError('replayed');
  const resumed: OAuthContinuation = {
    ...continuation,
    status: 'resumed',
    updatedAt: (input.now ?? Date.now)(),
  };
  const changed = await input.settings.applySettingsPatch({
    expected: { key: settingKey, value: raw },
    set: [{ key: settingKey, value: JSON.stringify(resumed) }],
  });
  if (!changed) throw new OAuthContinuationError('replayed');
  await removePendingResumeId(input.settings, continuation.id);
  return resumed;
}

/** Repair authorized-but-not-resumed tasks from the durable settings outbox. */
export async function repairPendingOAuthContinuationResumes(input: {
  settings: SettingsStore;
  onReady: (continuation: OAuthContinuation) => Promise<void>;
  limit?: number;
  now?: () => number;
}): Promise<{ resumed: number; pending: number; pruned: number }> {
  const now = input.now ?? Date.now;
  const ids = await pendingResumeIds(input.settings);
  let resumed = 0;
  let pending = 0;
  let pruned = 0;
  for (const id of ids.slice(0, input.limit ?? 25)) {
    const raw = await input.settings.getSetting(key(id));
    if (!raw) {
      await removePendingResumeId(input.settings, id);
      pruned += 1;
      continue;
    }
    let continuation: OAuthContinuation;
    try {
      continuation = parse(raw);
    } catch {
      await removePendingResumeId(input.settings, id);
      pruned += 1;
      continue;
    }
    if (continuation.status === 'authorized') {
      if (continuation.expiresAt <= now()) {
        const expired = { ...continuation, status: 'expired' as const, updatedAt: now() };
        await input.settings.applySettingsPatch({
          expected: { key: key(id), value: raw },
          set: [{ key: key(id), value: JSON.stringify(expired) }],
        });
        await removePendingResumeId(input.settings, id);
        pruned += 1;
        continue;
      }
      try {
        await input.onReady(continuation);
        await claimOAuthContinuationResume({
          settings: input.settings,
          continuationId: continuation.id,
          now,
        });
        resumed += 1;
      } catch {
        // Keep the authorized continuation indexed for the next repair pass,
        // but never let one unavailable turn starve later entries in the batch.
        pending += 1;
      }
      continue;
    }
    if (continuation.status === 'pending') {
      const checkedAt = now();
      if (continuation.expiresAt <= checkedAt) {
        const changed = await input.settings.applySettingsPatch({
          expected: { key: key(id), value: raw },
          set: [{
            key: key(id),
            value: JSON.stringify({
              ...continuation,
              status: 'expired' as const,
              updatedAt: checkedAt,
            }),
          }],
        });
        if (changed) {
          await removePendingResumeId(input.settings, id);
          pruned += 1;
        } else {
          pending += 1;
        }
        continue;
      }
      pending += 1;
      continue;
    }
    await removePendingResumeId(input.settings, id);
    pruned += 1;
  }
  return { resumed, pending, pruned };
}

function key(id: string): string {
  if (!/^oauthcontinuation_[a-zA-Z0-9_-]{1,160}$/.test(id)) {
    throw new OAuthContinuationError('invalid_state');
  }
  return `connection-oauth-continuation.${id}`;
}

function providerStateKey(providerState: string): string {
  if (!providerState || providerState.length > 2_048) {
    throw new OAuthContinuationError('invalid_state');
  }
  return `connection-oauth-provider-state.${hash(providerState)}`;
}

async function pendingResumeIds(settings: SettingsStore): Promise<string[]> {
  const raw = await settings.getSetting(RESUME_PENDING_INDEX_KEY);
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string =>
          typeof id === 'string' && /^oauthcontinuation_[a-zA-Z0-9_-]{1,160}$/.test(id)
        ))]
      : [];
  } catch {
    return [];
  }
}

async function removePendingResumeId(settings: SettingsStore, id: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const raw = await settings.getSetting(RESUME_PENDING_INDEX_KEY);
    if (!raw) return;
    let ids: string[];
    try {
      const value = JSON.parse(raw) as unknown;
      ids = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
      ids = [];
    }
    const remaining = [...new Set(ids)].filter((candidate) => candidate !== id);
    const changed = await settings.applySettingsPatch({
      expected: { key: RESUME_PENDING_INDEX_KEY, value: raw },
      ...(remaining.length
        ? { set: [{ key: RESUME_PENDING_INDEX_KEY, value: JSON.stringify(remaining) }] }
        : { delete: [RESUME_PENDING_INDEX_KEY] }),
    });
    if (changed) return;
  }
}

function encodeState(id: string, capability: string): string {
  return Buffer.from(JSON.stringify({ id, capability })).toString('base64url');
}

function decodeState(state: string): { id: string; capability: string } {
  try {
    if (!state || state.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(state)) throw new Error();
    const value = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.capability !== 'string') throw new Error();
    key(record.id);
    return { id: record.id, capability: record.capability };
  } catch (error) {
    if (error instanceof OAuthContinuationError) throw error;
    throw new OAuthContinuationError('invalid_state');
  }
}

function parse(raw: string): OAuthContinuation {
  try {
    const value = JSON.parse(raw) as OAuthContinuation;
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' ||
        typeof value.actorMembershipId !== 'string' || typeof value.agentId !== 'string' ||
        typeof value.stateHash !== 'string' || typeof value.expiresAt !== 'number') {
      throw new Error();
    }
    return value;
  } catch {
    throw new OAuthContinuationError('invalid_state');
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
