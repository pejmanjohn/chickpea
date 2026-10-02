import { deploymentTenancy, installationCacheKey } from './installation-scope.ts';
import { deploymentServesManyInstallations } from './model-access.ts';
import { rotateStoredModelCredential } from './model-credential-refs.ts';
import {
  listRuntimeModelProviders,
  registeredDeploymentProviders,
  type RuntimeModelProvider,
} from './providers.ts';
import type { SettingsStore } from './settings-store.ts';
import { getSettingsStore, getUsageStore, type PlatformEnv } from './state-backend.ts';
import type { UsageStore } from '../usage/types.ts';
import { nonEmpty } from '../security/content-validation.ts';

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

export const PROVIDER_BASE_URL_ENV_VARS = {
  anthropic: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
} as const;

export const PROVIDER_KEY_IDS = ['anthropic', 'openai', 'openrouter'] as const;

export type ProviderKeyId = (typeof PROVIDER_KEY_IDS)[number];
export type ProviderKeySource = 'env' | 'stored' | 'missing';

export interface ResolvedProviderApiKey {
  apiKey: string | undefined;
  source: ProviderKeySource;
}

// Short on purpose: readiness checks read stored keys through this cache on
// every turn, so the TTL is the worst-case lag between saving a provider key
// in /admin and a warm isolate calling it ready. 60s read as "my key doesn't
// work"; 5s reads as instant while still coalescing reads in a turn. A model
// call never uses this cache: its resolver reads the key with its version.
const STORED_CACHE_TTL_MS = 5_000;

type StoredProviderKeys = Partial<Record<ProviderKeyId, string>>;

// Keyed by installation: a deployment serving many keeps each one's keys apart.
const storedCache = new Map<string, { expiresAt: number; values: StoredProviderKeys }>();
const STORED_CACHE_MAX_INSTALLATIONS = 64;

export function isProviderKeyId(id: string): id is ProviderKeyId {
  return (PROVIDER_KEY_IDS as readonly string[]).includes(id);
}

/**
 * An installation's key for a provider. Standalone keeps its order: the
 * deployment environment's key, then the key saved in Admin. An installation
 * of a deployment serving many has only the key it saved.
 */
export async function resolveProviderApiKey(
  id: ProviderKeyId,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<ResolvedProviderApiKey> {
  const fromEnv = deploymentApiKey(id, env);
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
    PROVIDER_KEY_IDS.map((id) => [id, deploymentApiKey(id, env) ? 'env' : undefined]),
  ) as Partial<Record<ProviderKeyId, ProviderKeySource>>;
  const needsStored = PROVIDER_KEY_IDS.some((id) => envSources[id] === undefined);
  const stored = needsStored ? await readStoredProviderKeys(env, store) : {};
  return Object.fromEntries(
    PROVIDER_KEY_IDS.map((id) => [id, envSources[id] ?? (stored[id] ? 'stored' : 'missing')]),
  ) as Record<ProviderKeyId, ProviderKeySource>;
}

/**
 * The model providers one installation can use. Standalone: the deployment
 * lanes, and each key-backed provider with a key in the environment or saved
 * in Admin (or an endpoint override, as before). An installation of a
 * deployment serving many: only the key-backed providers it saved a key for.
 */
export async function listInstallationModelProviders(
  env: PlatformEnv | undefined,
  settings: SettingsStore,
): Promise<RuntimeModelProvider[]> {
  const hosted = deploymentServesManyInstallations(env);
  const sources = await describeProviderKeySources(env, settings);
  const registered = new Set(hosted ? [] : registeredDeploymentProviders());
  for (const id of PROVIDER_KEY_IDS) {
    if (sources[id] !== 'missing' || providerBaseUrl(id, env)) registered.add(id);
  }
  return listRuntimeModelProviders({
    env: hosted ? {} : process.env,
    registeredProviders: registered,
    ...(hosted ? { offered: new Set<string>(PROVIDER_KEY_IDS) } : {}),
  });
}

export async function saveProviderApiKey(
  id: ProviderKeyId,
  apiKey: string,
  env?: PlatformEnv,
  store?: SettingsStore,
  usageStore?: UsageStore,
  expectedVersion?: number,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  await rotateStoredModelCredential(
    id,
    { kind: 'save', apiKey },
    settings,
    usageStore ?? getUsageStore(env),
    Date.now,
    expectedVersion,
  );
  await primeStoredProviderKeysFromStore(env, settings);
}

export async function deleteProviderApiKey(
  id: ProviderKeyId,
  env?: PlatformEnv,
  store?: SettingsStore,
  usageStore?: UsageStore,
): Promise<ResolvedProviderApiKey> {
  const settings = store ?? getSettingsStore(env);
  await rotateStoredModelCredential(
    id,
    { kind: 'delete' },
    settings,
    usageStore ?? getUsageStore(env),
  );
  await primeStoredProviderKeysFromStore(env, settings);
  return resolveProviderApiKey(id, env, settings);
}

/**
 * The endpoint a standalone deployment points a provider at. An installation
 * of a deployment serving many uses the provider's own endpoint.
 */
export function providerBaseUrl(id: ProviderKeyId, env: PlatformEnv | undefined): string | undefined {
  if (deploymentTenancy(env) === 'installation') return undefined;
  return nonEmpty(process.env[PROVIDER_BASE_URL_ENV_VARS[id]]);
}

/** Deployment-level provider keys, which a deployment serving many installations must not hold. */
export function deploymentModelKeyNames(env: PlatformEnv | undefined): string[] {
  return PROVIDER_KEY_IDS
    .map((id) => PROVIDER_KEY_ENV_VARS[id])
    .filter((name) => nonEmpty(process.env[name]) || nonEmpty(stringValue(env?.[name])));
}

export function invalidateProviderKeyCache(): void {
  storedCache.clear();
}

async function readStoredProviderKeys(
  env: PlatformEnv | undefined,
  store?: SettingsStore,
): Promise<StoredProviderKeys> {
  const now = Date.now();
  const cached = store ? undefined : storedCache.get(installationCacheKey(env));
  if (cached && cached.expiresAt > now) {
    return cached.values;
  }
  const settings = store ?? getSettingsStore(env);
  const entries = await Promise.all(
    PROVIDER_KEY_IDS.map(async (id) => [id, nonEmpty(await settings.getSetting(PROVIDER_KEY_SETTING_KEYS[id]))] as const),
  );
  const values = Object.fromEntries(entries.filter((entry) => entry[1])) as StoredProviderKeys;
  if (!store) cacheStoredProviderKeys(env, { expiresAt: now + STORED_CACHE_TTL_MS, values });
  return values;
}

async function primeStoredProviderKeysFromStore(
  env: PlatformEnv | undefined,
  store: SettingsStore,
): Promise<void> {
  cacheStoredProviderKeys(env, {
    expiresAt: Date.now() + STORED_CACHE_TTL_MS,
    values: await readStoredProviderKeys(env, store),
  });
}

function cacheStoredProviderKeys(
  env: PlatformEnv | undefined,
  entry: { expiresAt: number; values: StoredProviderKeys },
): void {
  const key = installationCacheKey(env);
  // An unscoped env under installation tenancy names no installation to cache for.
  if (!key && deploymentTenancy(env) === 'installation') return;
  if (!storedCache.has(key) && storedCache.size >= STORED_CACHE_MAX_INSTALLATIONS) storedCache.clear();
  storedCache.set(key, entry);
}

function deploymentApiKey(id: ProviderKeyId, env: PlatformEnv | undefined): string | undefined {
  if (deploymentTenancy(env) === 'installation') return undefined;
  return nonEmpty(process.env[PROVIDER_KEY_ENV_VARS[id]]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
