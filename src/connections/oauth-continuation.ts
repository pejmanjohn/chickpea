import { createHash, timingSafeEqual } from 'node:crypto';

import type { SettingsStore } from '../config/settings-store.ts';
import type {
  OAuthContinuation,
  OAuthContinuationResult,
} from './types.ts';

const DEFAULT_TTL_MS = 15 * 60_000;

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
  const authorized: OAuthContinuation = { ...continuation, status: 'authorized', updatedAt: now };
  const changed = await input.settings.applySettingsPatch({
    expected: { key: settingKey, value: raw },
    set: [{ key: settingKey, value: JSON.stringify(authorized) }],
  });
  if (!changed) throw new OAuthContinuationError('replayed');
  return authorized;
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
  return resumed;
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
