import type { SettingsStore } from './settings-store.ts';
import { getSettingsStore, type PlatformEnv } from './state-backend.ts';

/**
 * MCP connection secrets by reference — modeled on `provider-keys.ts`.
 *
 * Bearer tokens and custom-header values are never stored in the profile row,
 * snapshots, or API responses. They live in the SettingsStore under
 * `mcp.<id>.bearer` / `mcp.<id>.header.<name>` and are resolved live at turn
 * time. An environment variable (`MCP_<ID>_BEARER` / `MCP_<ID>_HEADER_<NAME>`)
 * always wins over a stored value, exactly like provider API keys, so a
 * `wrangler secret put` / .env value takes precedence over a browser-saved one.
 *
 * No cache here: unlike provider keys, connection secrets are resolved
 * per-use (per test / per turn), so a stale cache would be a footgun.
 */

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

export function mcpBearerSettingKey(id: string): string {
  return 'mcp.' + id + '.bearer';
}

export function mcpHeaderSettingKey(id: string, name: string): string {
  return 'mcp.' + id + '.header.' + name;
}

export function mcpBearerEnvVar(id: string): string {
  return 'MCP_' + mangle(id) + '_BEARER';
}

export function mcpHeaderEnvVar(id: string, name: string): string {
  return 'MCP_' + mangle(id) + '_HEADER_' + mangle(name);
}

export async function resolveMcpSecrets(
  id: string,
  headerNames: string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<ResolvedMcpSecrets> {
  const settings = store ?? getSettingsStore(env);
  const bearer = await resolveOne(mcpBearerEnvVar(id), mcpBearerSettingKey(id), settings);
  const headers: Record<string, string> = {};
  for (const name of headerNames) {
    const value = await resolveOne(mcpHeaderEnvVar(id, name), mcpHeaderSettingKey(id, name), settings);
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  return { ...(bearer !== undefined ? { bearer } : {}), headers };
}

export async function describeMcpSecretSources(
  id: string,
  headerNames: string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<McpSecretSources> {
  const settings = store ?? getSettingsStore(env);
  const bearer = await sourceOf(mcpBearerEnvVar(id), mcpBearerSettingKey(id), settings);
  const headers: Record<string, McpSecretSource> = {};
  for (const name of headerNames) {
    headers[name] = await sourceOf(mcpHeaderEnvVar(id, name), mcpHeaderSettingKey(id, name), settings);
  }
  return { bearer, headers };
}

export async function saveMcpSecrets(
  id: string,
  input: { bearerToken?: string; headers?: Record<string, string> },
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  if (input.bearerToken !== undefined) {
    await settings.setSetting(mcpBearerSettingKey(id), input.bearerToken);
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (value !== undefined) {
      await settings.setSetting(mcpHeaderSettingKey(id, name), value);
    }
  }
}

export async function deleteMcpSecrets(
  id: string,
  headerNames: string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  await settings.deleteSetting(mcpBearerSettingKey(id));
  for (const name of headerNames) {
    await settings.deleteSetting(mcpHeaderSettingKey(id, name));
  }
}

/**
 * Assemble the outgoing request headers for a connection. Custom headers land
 * first; the bearer is applied LAST so a user-added `Authorization` header can
 * never override the real token in bearer mode.
 */
export function buildMcpRequestHeaders(
  authMode: 'none' | 'bearer',
  secrets: ResolvedMcpSecrets,
): Record<string, string> {
  const headers: Record<string, string> = { ...secrets.headers };
  if (authMode === 'bearer' && secrets.bearer) {
    headers.Authorization = 'Bearer ' + secrets.bearer;
  }
  return headers;
}

function mangle(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '_');
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

function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}
