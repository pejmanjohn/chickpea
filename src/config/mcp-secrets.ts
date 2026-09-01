import { nonEmpty } from '../security/content-validation.ts';
import { createSecretCleanupKeys, encodeEnvSegment } from './secret-keys.ts';
import type { SettingsStore } from './settings-store.ts';
import { getSettingsStore, type PlatformEnv } from './state-backend.ts';

/**
 * MCP connection secrets by reference — modeled on `provider-keys.ts`.
 *
 * Bearer tokens and custom-header values are never stored in the profile row,
 * snapshots, or API responses. They live in the SettingsStore under
 * `mcp.<agentId>.<connectionId>.bearer` /
 * `mcp.<agentId>.<connectionId>.header.<name>` and are resolved live at turn
 * time. The agent scope is required because connection ids are user-chosen,
 * profile-local slugs. Environment variables use the same two-part scope and
 * always win over stored values, exactly like provider API keys.
 *
 * No cache here: unlike provider keys, connection secrets are resolved
 * per-use (per test / per turn), so a stale cache would be a footgun.
 */

const cleanupKeys = createSecretCleanupKeys({
  keyPrefix: 'mcp.',
  invalidKeyMessage: 'Invalid MCP secret-cleanup key',
  invalidMarkerMessage: 'Invalid MCP secret-cleanup marker',
});

export type McpSecretSource = 'env' | 'stored' | 'missing';

export interface ResolvedMcpSecrets {
  /** Resolved bearer value (env wins over stored); absent when neither is set. */
  bearer?: string;
  /** headerName → resolved value (env wins over stored); absent names omitted. */
  headers: Record<string, string>;
}

export interface McpSecretSources {
  bearer: McpSecretSource;
  headers: Record<string, McpSecretSource>;
}

export interface McpSecretRef {
  agentId: string;
  connectionId: string;
}

export function mcpBearerSettingKey(ref: McpSecretRef): string {
  return 'mcp.' + ref.agentId + '.' + ref.connectionId + '.bearer';
}

export function mcpHeaderSettingKey(ref: McpSecretRef, name: string): string {
  return 'mcp.' + ref.agentId + '.' + ref.connectionId + '.header.' + name;
}

/**
 * Durable inventory for profile deletion. Config rows and settings are separate
 * operations, so the profile may be gone before all of its secret keys are
 * cleared. Keeping the key list in settings makes cleanup idempotent and
 * retryable even after the profile row (the original inventory) no longer
 * exists. The marker contains key names only, never secret values.
 */
export function mcpSecretCleanupMarkerKey(agentId: string): string {
  return 'mcp-secret-cleanup.' + agentId;
}

export async function stageMcpSecretCleanup(
  agentId: string,
  settingKeys: readonly string[],
  store: SettingsStore,
): Promise<void> {
  const markerKey = mcpSecretCleanupMarkerKey(agentId);
  const keys = cleanupKeys.validate(agentId, settingKeys);
  const merged = await store.mergeSettingStringSet(markerKey, keys);
  cleanupKeys.validate(agentId, merged);
}

/**
 * Finish a previously staged cleanup. The marker is removed last, so a failure
 * deleting any individual secret leaves the complete inventory available to a
 * later DELETE retry. Returns false when no cleanup is pending.
 */
export async function finishMcpSecretCleanup(
  agentId: string,
  store: SettingsStore,
): Promise<boolean> {
  const markerKey = mcpSecretCleanupMarkerKey(agentId);
  const raw = await store.getSetting(markerKey);
  if (raw === undefined) return false;

  const keys = cleanupKeys.parse(agentId, raw);
  for (const key of keys) {
    await store.deleteSetting(key);
  }
  await store.deleteSetting(markerKey);
  return true;
}

export function mcpBearerEnvVar(ref: McpSecretRef): string {
  return (
    'MCP_AGENT_' +
    encodeEnvSegment(ref.agentId) +
    '_CONNECTION_' +
    encodeEnvSegment(ref.connectionId) +
    '_BEARER'
  );
}

export function mcpHeaderEnvVar(ref: McpSecretRef, name: string): string {
  return (
    'MCP_AGENT_' +
    encodeEnvSegment(ref.agentId) +
    '_CONNECTION_' +
    encodeEnvSegment(ref.connectionId) +
    '_HEADER_' +
    encodeEnvSegment(name)
  );
}

export async function resolveMcpSecrets(
  ref: McpSecretRef,
  headerNames: string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<ResolvedMcpSecrets> {
  const settings = store ?? getSettingsStore(env);
  const [bearer, headers] = await Promise.all([
    resolveOne(mcpBearerEnvVar(ref), mcpBearerSettingKey(ref), settings),
    resolveMcpHeaders(ref, headerNames, env, settings),
  ]);
  return { ...(bearer !== undefined ? { bearer } : {}), headers };
}

export async function resolveMcpHeaders(
  ref: McpSecretRef,
  headerNames: string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<Record<string, string>> {
  const settings = store ?? getSettingsStore(env);
  const headerValues = await Promise.all(headerNames.map((name) =>
    resolveOne(mcpHeaderEnvVar(ref, name), mcpHeaderSettingKey(ref, name), settings)
  ));
  const headers: Record<string, string> = {};
  for (const [index, name] of headerNames.entries()) {
    const value = headerValues[index];
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  return headers;
}

export async function describeMcpSecretSources(
  ref: McpSecretRef,
  headerNames: string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<McpSecretSources> {
  const settings = store ?? getSettingsStore(env);
  const [bearer, ...headerSources] = await Promise.all([
    sourceOf(mcpBearerEnvVar(ref), mcpBearerSettingKey(ref), settings),
    ...headerNames.map((name) =>
      sourceOf(mcpHeaderEnvVar(ref, name), mcpHeaderSettingKey(ref, name), settings),
    ),
  ]);
  const headers: Record<string, McpSecretSource> = {};
  for (const [index, name] of headerNames.entries()) {
    headers[name] = headerSources[index]!;
  }
  return { bearer, headers };
}

export async function saveMcpSecrets(
  ref: McpSecretRef,
  input: { bearerToken?: string; headers?: Record<string, string> },
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  if (input.bearerToken !== undefined) {
    await settings.setSetting(mcpBearerSettingKey(ref), input.bearerToken);
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (value !== undefined) {
      await settings.setSetting(mcpHeaderSettingKey(ref, name), value);
    }
  }
}

export async function deleteMcpSecrets(
  ref: McpSecretRef,
  headerNames: string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  await settings.deleteSetting(mcpBearerSettingKey(ref));
  for (const name of headerNames) {
    await settings.deleteSetting(mcpHeaderSettingKey(ref, name));
  }
}

/**
 * Assemble the outgoing request headers for a connection. Custom headers land
 * first; the bearer is applied LAST so a user-added `Authorization` header can
 * never override the real token in bearer mode.
 */
export function buildMcpRequestHeaders(
  authMode: 'none' | 'bearer' | 'oauth',
  secrets: ResolvedMcpSecrets,
): Record<string, string> {
  const bearerManaged = authMode === 'bearer' || authMode === 'oauth';
  const headers = Object.fromEntries(
    Object.entries(secrets.headers).filter(
      ([name]) => !bearerManaged || name.toLowerCase() !== 'authorization',
    ),
  );
  if (bearerManaged && secrets.bearer) {
    headers.Authorization = 'Bearer ' + secrets.bearer;
  }
  return headers;
}

async function resolveOne(
  envVar: string,
  settingKey: string,
  settings: SettingsStore,
): Promise<string | undefined> {
  const fromEnv = nonEmpty(process.env[envVar]);
  if (fromEnv) {
    return fromEnv;
  }
  return nonEmpty(await settings.getSetting(settingKey));
}

async function sourceOf(
  envVar: string,
  settingKey: string,
  settings: SettingsStore,
): Promise<McpSecretSource> {
  if (nonEmpty(process.env[envVar])) {
    return 'env';
  }
  return nonEmpty(await settings.getSetting(settingKey)) ? 'stored' : 'missing';
}

