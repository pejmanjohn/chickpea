import { validateMcpUrl } from './mcp-url.ts';
import type { SettingsStore } from './settings-store.ts';

const CONFIG_WRITE_ATTEMPTS = 16;
const GENERATION_PATTERN = /^[A-Za-z0-9_-]{8,192}$/;

export const META_ADS_MCP_SERVER_URL = 'https://mcp.facebook.com/ads';
export const META_ADS_OAUTH_ISSUER = 'https://www.facebook.com/ads';
export const META_ADS_OAUTH_DEFAULT_SCOPE = 'ads_mcp_management ads_read';

export interface ConfiguredMcpOAuthClientDescriptor {
  serverUrl: string;
  authorizationServerUrl: string;
  settingKey: string;
  defaultScope: string;
}

export interface ConfiguredMcpOAuthClient {
  serverUrl: string;
  authorizationServerUrl: string;
  clientId: string;
  generation: string;
}

interface StoredConfiguredMcpOAuthClient {
  version: 1;
  serverUrl: string;
  authorizationServerUrl: string;
  clientId?: string;
  generation: string;
}

export class ConfiguredMcpOAuthClientError extends Error {
  readonly name = 'ConfiguredMcpOAuthClientError';

  constructor(
    readonly code: 'unsupported_server' | 'invalid_client_id' | 'invalid_storage' | 'write_conflict',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const DESCRIPTORS: readonly ConfiguredMcpOAuthClientDescriptor[] = [{
  serverUrl: META_ADS_MCP_SERVER_URL,
  authorizationServerUrl: META_ADS_OAUTH_ISSUER,
  settingKey: 'mcp.oauth-client.meta-ads',
  defaultScope: META_ADS_OAUTH_DEFAULT_SCOPE,
}];

export function configuredMcpOAuthClientDescriptor(
  serverUrl: string,
): ConfiguredMcpOAuthClientDescriptor | undefined {
  const validated = validateMcpUrl(serverUrl);
  if (!validated.ok) return undefined;
  return DESCRIPTORS.find((descriptor) => descriptor.serverUrl === validated.url);
}

/** True for an origin reserved by a configured-client descriptor, even when
 * the supplied path/query is not the reviewed endpoint. */
export function isConfiguredMcpOAuthClientOrigin(serverUrl: string): boolean {
  const validated = validateMcpUrl(serverUrl);
  if (!validated.ok) return false;
  const origin = new URL(validated.url).origin;
  return DESCRIPTORS.some((descriptor) => new URL(descriptor.serverUrl).origin === origin);
}

/** One registered redirect shared by Admin and management-assisted setup. */
export function configuredMcpOAuthCallbackUrl(canonicalAdminOrigin: string | undefined): string {
  if (!canonicalAdminOrigin) throw new ConfiguredMcpOAuthClientError('invalid_storage', 'Complete installation setup before configuring Meta Ads.');
  const origin = new URL(canonicalAdminOrigin);
  if (origin.origin !== canonicalAdminOrigin || (origin.protocol !== 'https:' && origin.hostname !== 'localhost')) {
    throw new ConfiguredMcpOAuthClientError('invalid_storage', 'The installation needs a canonical public HTTPS origin.');
  }
  return new URL('/oauth/callback', origin).href;
}

export function isConfiguredMcpOAuthClientGeneration(value: unknown): value is string {
  return typeof value === 'string' && GENERATION_PATTERN.test(value);
}

export async function getConfiguredMcpOAuthClient(
  serverUrl: string,
  settings: SettingsStore,
): Promise<ConfiguredMcpOAuthClient | undefined> {
  const descriptor = configuredMcpOAuthClientDescriptor(serverUrl);
  if (!descriptor) return undefined;
  const raw = await settings.getSetting(descriptor.settingKey);
  if (!raw) return undefined;
  const stored = parseConfiguredClient(raw, descriptor);
  return stored.clientId ? activeConfiguration(stored) : undefined;
}

/**
 * Save an installation-owned public client. Saving the same active client is a
 * no-op so an ordinary Admin save cannot invalidate working accounts. Any real
 * replacement, including re-adding an ID after removal, receives a new random
 * generation.
 */
export async function saveConfiguredMcpOAuthClient(
  serverUrl: string,
  input: { clientId: string },
  settings: SettingsStore,
  options: { randomId?: () => string } = {},
): Promise<ConfiguredMcpOAuthClient> {
  const descriptor = requireDescriptor(serverUrl);
  const clientId = validateClientId(input.clientId);
  for (let attempt = 0; attempt < CONFIG_WRITE_ATTEMPTS; attempt += 1) {
    const currentRaw = await settings.getSetting(descriptor.settingKey);
    const current = currentRaw ? parseConfiguredClient(currentRaw, descriptor) : undefined;
    if (current?.clientId === clientId) return activeConfiguration(current);

    const next: StoredConfiguredMcpOAuthClient = {
      version: 1,
      serverUrl: descriptor.serverUrl,
      authorizationServerUrl: descriptor.authorizationServerUrl,
      clientId,
      generation: nextGeneration(options.randomId),
    };
    const stored = await settings.applySettingsPatch({
      expected: { key: descriptor.settingKey, value: currentRaw ?? null },
      set: [{ key: descriptor.settingKey, value: JSON.stringify(next) }],
    });
    if (stored) return activeConfiguration(next);
  }
  throw new ConfiguredMcpOAuthClientError(
    'write_conflict',
    'Configured MCP OAuth client changed too many times; reload and retry.',
  );
}

/**
 * Removal writes a generation tombstone rather than deleting the setting. A
 * later re-add therefore cannot recreate an earlier configuration identity.
 */
export async function removeConfiguredMcpOAuthClient(
  serverUrl: string,
  settings: SettingsStore,
  options: { randomId?: () => string } = {},
): Promise<{ removed: boolean; generation: string }> {
  const descriptor = requireDescriptor(serverUrl);
  for (let attempt = 0; attempt < CONFIG_WRITE_ATTEMPTS; attempt += 1) {
    const currentRaw = await settings.getSetting(descriptor.settingKey);
    const current = currentRaw ? parseConfiguredClient(currentRaw, descriptor) : undefined;
    if (current && !current.clientId) {
      return { removed: false, generation: current.generation };
    }
    const tombstone: StoredConfiguredMcpOAuthClient = {
      version: 1,
      serverUrl: descriptor.serverUrl,
      authorizationServerUrl: descriptor.authorizationServerUrl,
      generation: nextGeneration(options.randomId),
    };
    const stored = await settings.applySettingsPatch({
      expected: { key: descriptor.settingKey, value: currentRaw ?? null },
      set: [{ key: descriptor.settingKey, value: JSON.stringify(tombstone) }],
    });
    if (stored) return { removed: Boolean(current?.clientId), generation: tombstone.generation };
  }
  throw new ConfiguredMcpOAuthClientError(
    'write_conflict',
    'Configured MCP OAuth client changed too many times; reload and retry.',
  );
}

function requireDescriptor(serverUrl: string): ConfiguredMcpOAuthClientDescriptor {
  const descriptor = configuredMcpOAuthClientDescriptor(serverUrl);
  if (descriptor) return descriptor;
  throw new ConfiguredMcpOAuthClientError(
    'unsupported_server',
    'This MCP server does not support an installation-configured OAuth client.',
  );
}

function activeConfiguration(stored: StoredConfiguredMcpOAuthClient): ConfiguredMcpOAuthClient {
  if (!stored.clientId) {
    throw new ConfiguredMcpOAuthClientError('invalid_storage', 'Configured MCP OAuth client is missing.');
  }
  return {
    serverUrl: stored.serverUrl,
    authorizationServerUrl: stored.authorizationServerUrl,
    clientId: stored.clientId,
    generation: stored.generation,
  };
}

function parseConfiguredClient(
  raw: string,
  descriptor: ConfiguredMcpOAuthClientDescriptor,
): StoredConfiguredMcpOAuthClient {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.serverUrl !== descriptor.serverUrl ||
      value.authorizationServerUrl !== descriptor.authorizationServerUrl ||
      (value.clientId !== undefined && validateClientId(value.clientId) !== value.clientId) ||
      !isConfiguredMcpOAuthClientGeneration(value.generation)
    ) {
      throw new Error('invalid configured client record');
    }
    return {
      version: 1,
      serverUrl: descriptor.serverUrl,
      authorizationServerUrl: descriptor.authorizationServerUrl,
      ...(typeof value.clientId === 'string' ? { clientId: value.clientId } : {}),
      generation: value.generation,
    };
  } catch (error) {
    if (error instanceof ConfiguredMcpOAuthClientError) throw error;
    throw new ConfiguredMcpOAuthClientError(
      'invalid_storage',
      'Stored configured MCP OAuth client is invalid.',
      { cause: error },
    );
  }
}

function validateClientId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,64}$/.test(value)) {
    throw new ConfiguredMcpOAuthClientError(
      'invalid_client_id',
      'Meta App ID must contain only digits.',
    );
  }
  return value;
}

function nextGeneration(randomId: (() => string) | undefined): string {
  const generation = (randomId ?? (() => crypto.randomUUID()))();
  if (!isConfiguredMcpOAuthClientGeneration(generation)) {
    throw new ConfiguredMcpOAuthClientError(
      'invalid_storage',
      'Configured MCP OAuth client generation is invalid.',
    );
  }
  return generation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
