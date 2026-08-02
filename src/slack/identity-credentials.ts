import type { SettingsStore } from '../config/settings-store.ts';
import {
  getSettingsStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../config/types.ts';
import {
  readSlackConnectionRevision,
  resolveSlackCredentials,
  type ResolvedSlackCredentials,
} from './credentials.ts';

const IDENTITY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const CACHE_TTL_MS = 60_000;
const MAX_CACHED_IDENTITIES = 64;

export interface SlackIdentityCredentialSettingKeys {
  connectionRevision: string;
  botToken: string;
  signingSecret: string;
  botUserId: string;
}

export interface ResolvedSlackIdentityCredentials extends ResolvedSlackCredentials {
  connectionRevision: string | null;
}

export interface SlackIdentityCredentialWrite {
  botToken: string;
  signingSecret: string;
  botUserId?: string;
}

export class SlackIdentityCredentialRevisionError extends Error {
  constructor(readonly identityId: string) {
    super(`Slack identity ${identityId} credentials changed`);
    this.name = 'SlackIdentityCredentialRevisionError';
  }
}

interface CacheEntry {
  expiresAt: number;
  revision: string | null;
  values: ResolvedSlackIdentityCredentials;
}

let cacheByStore = new WeakMap<SettingsStore, Map<string, CacheEntry>>();

export function slackIdentityCredentialSettingKeys(
  identityId: string,
): SlackIdentityCredentialSettingKeys {
  requireDedicatedIdentityId(identityId);
  const prefix = `slack.identity.${identityId}`;
  return {
    connectionRevision: `${prefix}.connectionRevision`,
    botToken: `${prefix}.botToken`,
    signingSecret: `${prefix}.signingSecret`,
    botUserId: `${prefix}.botUserId`,
  };
}

/**
 * Resolve one identity without allowing dedicated identities to inherit the
 * installation-wide environment credentials. The workspace default delegates
 * to the legacy env-first resolver unchanged.
 */
export async function resolveSlackIdentityCredentials(
  identityId: string,
  env?: PlatformEnv,
  explicitStore?: SettingsStore,
): Promise<ResolvedSlackIdentityCredentials> {
  const store = explicitStore ?? getSettingsStore(env);
  if (identityId === WORKSPACE_DEFAULT_SLACK_IDENTITY_ID) {
    return {
      ...(await resolveSlackCredentials(env, explicitStore)),
      connectionRevision: await readSlackConnectionRevision(store),
    };
  }

  const keys = slackIdentityCredentialSettingKeys(identityId);
  const revision = (await store.getSetting(keys.connectionRevision)) ?? null;
  const cached = cacheFor(store).get(identityId);
  const now = Date.now();
  if (cached && cached.expiresAt > now && cached.revision === revision) {
    touchCacheEntry(store, identityId, cached);
    return cached.values;
  }

  const [snapshotRevision, botToken, signingSecret, botUserId] = await store.getSettings([
    keys.connectionRevision,
    keys.botToken,
    keys.signingSecret,
    keys.botUserId,
  ]);
  const values: ResolvedSlackIdentityCredentials = {
    botToken: nonEmpty(botToken),
    signingSecret: nonEmpty(signingSecret),
    botUserId: nonEmpty(botUserId),
    connectionRevision: snapshotRevision ?? null,
  };
  touchCacheEntry(store, identityId, {
    expiresAt: now + CACHE_TTL_MS,
    revision: values.connectionRevision,
    values,
  });
  return values;
}

/** Revision-fenced replacement of the complete dedicated credential bundle. */
export async function writeSlackIdentityCredentials(
  store: SettingsStore,
  identityId: string,
  expectedRevision: string | null,
  values: SlackIdentityCredentialWrite,
): Promise<string> {
  if (!values.botToken.trim() || !values.signingSecret.trim()) {
    throw new Error('Slack identity bot token and signing secret are required');
  }
  const keys = slackIdentityCredentialSettingKeys(identityId);
  const nextRevision = generateCredentialRevision();
  const applied = await store.applySettingsPatch({
    expected: { key: keys.connectionRevision, value: expectedRevision },
    set: [
      { key: keys.connectionRevision, value: nextRevision },
      { key: keys.botToken, value: values.botToken },
      { key: keys.signingSecret, value: values.signingSecret },
      ...(values.botUserId ? [{ key: keys.botUserId, value: values.botUserId }] : []),
    ],
    delete: values.botUserId ? [] : [keys.botUserId],
  });
  if (!applied) throw new SlackIdentityCredentialRevisionError(identityId);
  invalidateSlackIdentityCredentialCache(store, identityId);
  return nextRevision;
}

/**
 * Delete the secret bundle but retain a fresh revision tombstone so a delayed
 * validator cannot recreate credentials with an older snapshot.
 */
export async function clearSlackIdentityCredentials(
  store: SettingsStore,
  identityId: string,
  expectedRevision: string | null,
  additionalDeletes: readonly string[] = [],
): Promise<string> {
  const keys = slackIdentityCredentialSettingKeys(identityId);
  const nextRevision = generateCredentialRevision();
  const applied = await store.applySettingsPatch({
    expected: { key: keys.connectionRevision, value: expectedRevision },
    set: [{ key: keys.connectionRevision, value: nextRevision }],
    delete: [
      keys.botToken,
      keys.signingSecret,
      keys.botUserId,
      ...additionalDeletes,
    ],
  });
  if (!applied) throw new SlackIdentityCredentialRevisionError(identityId);
  invalidateSlackIdentityCredentialCache(store, identityId);
  return nextRevision;
}

export function invalidateSlackIdentityCredentialCache(
  store?: SettingsStore,
  identityId?: string,
): void {
  if (!store) {
    cacheByStore = new WeakMap();
    return;
  }
  if (!identityId) {
    cacheByStore.delete(store);
    return;
  }
  cacheByStore.get(store)?.delete(identityId);
}

function cacheFor(store: SettingsStore): Map<string, CacheEntry> {
  let cache = cacheByStore.get(store);
  if (!cache) {
    cache = new Map();
    cacheByStore.set(store, cache);
  }
  return cache;
}

function touchCacheEntry(store: SettingsStore, identityId: string, entry: CacheEntry): void {
  const cache = cacheFor(store);
  cache.delete(identityId);
  cache.set(identityId, entry);
  while (cache.size > MAX_CACHED_IDENTITIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function requireDedicatedIdentityId(identityId: string): void {
  if (identityId === WORKSPACE_DEFAULT_SLACK_IDENTITY_ID) {
    throw new Error('The workspace-default Slack identity uses the legacy credential keys');
  }
  if (!IDENTITY_ID_PATTERN.test(identityId)) {
    throw new Error('Invalid Slack identity id');
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function generateCredentialRevision(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
