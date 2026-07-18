import { createHash } from 'node:crypto';

import { registerProvider } from '@flue/runtime';

import { forgetRegisteredProvider, recordRegisteredProvider } from './providers.ts';
import type { SettingsStore } from './settings-store.ts';
import { getSettingsStore, type PlatformEnv } from './state-backend.ts';

export const PROVIDER_KEY_SETTING_KEYS = {
  anthropic: 'provider.anthropic.apiKey',
  openai: 'provider.openai.apiKey',
  openrouter: 'provider.openrouter.apiKey',
} as const;

export const PROVIDER_KEY_ENV_VARS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
} as const;

export const PROVIDER_KEY_IDS = ['anthropic', 'openai', 'openrouter'] as const;

export type ProviderKeyId = (typeof PROVIDER_KEY_IDS)[number];
export type ProviderKeySource = 'env' | 'stored' | 'missing';

export interface ResolvedProviderApiKey {
  apiKey: string | undefined;
  source: ProviderKeySource;
}

// Short on purpose: the agent Durable Object isolate reads stored keys through
// this cache on every turn, so the TTL is the worst-case lag between saving a
// provider key in /admin and a warm isolate honoring it. 60s read as "my key
// doesn't work"; 5s reads as instant while still coalescing reads in a turn.
const STORED_CACHE_TTL_MS = 5_000;

type StoredProviderKeys = Partial<Record<ProviderKeyId, string>>;
type ProviderRegistrationOptions = { apiKey?: string; baseUrl?: string };

let storedCache: { expiresAt: number; values: StoredProviderKeys } | undefined;
const appliedProviderFingerprints = new Map<ProviderKeyId, string>();

export function isProviderKeyId(id: string): id is ProviderKeyId {
  return (PROVIDER_KEY_IDS as readonly string[]).includes(id);
}

export async function resolveProviderApiKey(
  id: ProviderKeyId,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<ResolvedProviderApiKey> {
  const fromEnv = envApiKey(id);
  if (fromEnv) {
    return { apiKey: fromEnv, source: 'env' };
  }
  const stored = await readStoredProviderKeys(env, store);
  const apiKey = stored[id];
  return { apiKey, source: apiKey ? 'stored' : 'missing' };
}

export async function describeProviderKeySources(
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<Record<ProviderKeyId, ProviderKeySource>> {
  const envSources = Object.fromEntries(
    PROVIDER_KEY_IDS.map((id) => [id, envApiKey(id) ? 'env' : undefined]),
  ) as Partial<Record<ProviderKeyId, ProviderKeySource>>;
  const needsStored = PROVIDER_KEY_IDS.some((id) => envSources[id] === undefined);
  const stored = needsStored ? await readStoredProviderKeys(env, store) : {};
  return Object.fromEntries(
    PROVIDER_KEY_IDS.map((id) => [id, envSources[id] ?? (stored[id] ? 'stored' : 'missing')]),
  ) as Record<ProviderKeyId, ProviderKeySource>;
}

export async function saveProviderApiKey(
  id: ProviderKeyId,
  apiKey: string,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  await settings.setSetting(PROVIDER_KEY_SETTING_KEYS[id], apiKey);
  await primeStoredProviderKeysFromStore(env, settings);
  const resolved = await resolveProviderApiKey(id, env, settings);
  rebindBuiltinProvider(id, resolved.apiKey);
}

export async function deleteProviderApiKey(
  id: ProviderKeyId,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<ResolvedProviderApiKey> {
  const settings = store ?? getSettingsStore(env);
  await settings.deleteSetting(PROVIDER_KEY_SETTING_KEYS[id]);
  await primeStoredProviderKeysFromStore(env, settings);
  const resolved = await resolveProviderApiKey(id, env, settings);
  rebindBuiltinProvider(id, resolved.apiKey);
  return resolved;
}

export async function applyResolvedProviderKeys(
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  await Promise.all(
    PROVIDER_KEY_IDS.map(async (id) => {
      const { apiKey } = await resolveProviderApiKey(id, env, store);
      rebindBuiltinProvider(id, apiKey);
    }),
  );
}

/**
 * Re-registering a built-in provider is how a browser-saved key takes effect
 * in the current isolate. Flue replaces the previous registration per provider
 * id, so `{}` deliberately clears a previously stored key after deletion.
 */
export function rebindBuiltinProvider(id: ProviderKeyId, apiKey: string | undefined): void {
  const options = providerRegistrationOptions(id, apiKey);
  const fingerprint = keyFingerprint(JSON.stringify(options));
  if (appliedProviderFingerprints.get(id) === fingerprint) {
    return;
  }
  registerProvider(id, options);
  appliedProviderFingerprints.set(id, fingerprint);
  if (apiKey || options.baseUrl) {
    recordRegisteredProvider(id);
  } else {
    forgetRegisteredProvider(id);
  }
}

export function invalidateProviderKeyCache(): void {
  storedCache = undefined;
  appliedProviderFingerprints.clear();
}

async function readStoredProviderKeys(
  env: PlatformEnv | undefined,
  store?: SettingsStore,
): Promise<StoredProviderKeys> {
  const now = Date.now();
  if (!store && storedCache && storedCache.expiresAt > now) {
    return storedCache.values;
  }
  const settings = store ?? getSettingsStore(env);
  const entries = await Promise.all(
    PROVIDER_KEY_IDS.map(async (id) => [id, nonEmpty(await settings.getSetting(PROVIDER_KEY_SETTING_KEYS[id]))] as const),
  );
  const values = Object.fromEntries(entries.filter((entry) => entry[1])) as StoredProviderKeys;
  if (!store) {
    storedCache = { expiresAt: now + STORED_CACHE_TTL_MS, values };
  }
  return values;
}

async function primeStoredProviderKeysFromStore(
  env: PlatformEnv | undefined,
  store: SettingsStore,
): Promise<void> {
  storedCache = {
    expiresAt: Date.now() + STORED_CACHE_TTL_MS,
    values: await readStoredProviderKeys(env, store),
  };
}

function envApiKey(id: ProviderKeyId): string | undefined {
  return nonEmpty(process.env[PROVIDER_KEY_ENV_VARS[id]]);
}

function providerRegistrationOptions(
  id: ProviderKeyId,
  apiKey: string | undefined,
): ProviderRegistrationOptions {
  const options: ProviderRegistrationOptions = {};
  if (id === 'anthropic') {
    const baseUrl = nonEmpty(process.env.ANTHROPIC_BASE_URL);
    if (baseUrl) {
      options.baseUrl = baseUrl;
    }
  }
  if (apiKey) {
    options.apiKey = apiKey;
  }
  return options;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function keyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}
