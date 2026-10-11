import { nonEmpty } from '../security/content-validation.ts';
import { createSecretCleanupKeys, deploymentBoundSecretOverride, encodeEnvSegment } from './secret-keys.ts';
import { validConnectionCredentialRef } from './connection-credential-binding.ts';
import { removeSettingStringSetValues } from './setting-string-set.ts';
import type { SettingsStore } from './settings-store.ts';
import { getSettingsStore, type PlatformEnv } from './state-backend.ts';

const cleanupKeys = createSecretCleanupKeys({
  keyPrefix: 'mcp.',
  invalidKeyMessage: 'Invalid MCP secret-cleanup key',
  invalidMarkerMessage: 'Invalid MCP secret-cleanup marker',
});

type McpSecretSource = 'env' | 'stored' | 'missing';

export interface ResolvedMcpSecrets {
  /** Resolved bearer value (env wins over stored); absent when neither is set. */
  bearer?: string;
  /** headerName → resolved value (env wins over stored); absent names omitted. */
  headers: Record<string, string>;
}

interface McpSecretSources {
  bearer: McpSecretSource;
  headers: Record<string, McpSecretSource>;
}

export interface McpSecretRef {
  agentId: string;
  connectionId: string;
  credentialRef?: string;
}

export interface McpCredentialRef extends McpSecretRef {
  credentialRef: string;
  credentialBinding: string;
}

export function mcpBearerSettingKey(ref: McpCredentialRef): string {
  return credentialPrefix(ref) + '.bearer';
}

export function mcpHeaderSettingKey(ref: McpCredentialRef, name: string): string {
  return credentialPrefix(ref) + '.header.' + name.toLowerCase();
}

function credentialPrefix(ref: McpCredentialRef): string {
  if (!validConnectionCredentialRef(ref.credentialRef)) {
    throw new Error('Invalid MCP credential reference');
  }
  return `mcp.${ref.agentId}.credential.${ref.credentialRef}`;
}

/**
 * Durable inventory for profile deletion. Config rows and settings are separate
 * operations, so the profile may be gone before all of its secret keys are
 * cleared. Keeping the key list in settings makes cleanup idempotent and
 * retryable even after the profile row (the original inventory) no longer
 * exists. The marker contains key names only, never secret values.
 */
export function mcpSecretCleanupMarkerKey(agentId: string, scope?: string): string {
  return 'mcp-secret-cleanup.' + agentId + cleanupMarkerScope(scope);
}

export async function stageMcpSecretCleanup(
  agentId: string,
  settingKeys: readonly string[],
  store: SettingsStore,
  scope?: string,
): Promise<void> {
  const markerKey = mcpSecretCleanupMarkerKey(agentId, scope);
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
  scope?: string,
): Promise<boolean> {
  const markerKey = mcpSecretCleanupMarkerKey(agentId, scope);
  const raw = await store.getSetting(markerKey);
  if (raw === undefined) return false;

  const keys = cleanupKeys.parse(agentId, raw);
  for (const key of keys) {
    await store.deleteSetting(key);
  }
  await store.deleteSetting(markerKey);
  return true;
}

/** Remove successfully retired keys without consuming another connection's cleanup inventory. */
export async function unstageMcpSecretCleanup(
  agentId: string,
  settingKeys: readonly string[],
  store: SettingsStore,
): Promise<void> {
  const keys = cleanupKeys.validate(agentId, settingKeys);
  await removeSettingStringSetValues(store, mcpSecretCleanupMarkerKey(agentId), keys);
}

function cleanupMarkerScope(scope: string | undefined): string {
  if (scope === undefined) return '';
  if (!/^v1:[A-Za-z0-9_-]{43}$/.test(scope)) {
    throw new Error('Invalid MCP secret-cleanup scope');
  }
  return '.' + scope.slice(3);
}

export function mcpBearerEnvVar(ref: McpCredentialRef): string {
  return (
    'MCP_AGENT_' +
    encodeEnvSegment(ref.agentId) +
    '_CONNECTION_' +
    encodeEnvSegment(ref.connectionId) +
    '_BEARER'
  );
}

export function mcpHeaderEnvVar(ref: McpCredentialRef, name: string): string {
  return (
    'MCP_AGENT_' +
    encodeEnvSegment(ref.agentId) +
    '_CONNECTION_' +
    encodeEnvSegment(ref.connectionId) +
    '_HEADER_' +
    encodeEnvSegment(name.toLowerCase())
  );
}

export function mcpCredentialBindingEnvVar(ref: McpCredentialRef): string {
  return (
    'MCP_AGENT_' +
    encodeEnvSegment(ref.agentId) +
    '_CONNECTION_' +
    encodeEnvSegment(ref.connectionId) +
    '_BINDING'
  );
}

export async function resolveMcpSecrets(
  ref: McpCredentialRef,
  headerNames: string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<ResolvedMcpSecrets> {
  const settings = store ?? getSettingsStore(env);
  const [bearer, headers] = await Promise.all([
    resolveOne(mcpBearerEnvVar(ref), mcpBearerSettingKey(ref), ref, settings, env),
    resolveMcpHeaders(ref, headerNames, env, settings),
  ]);
  return { ...(bearer !== undefined ? { bearer } : {}), headers };
}

export async function resolveMcpHeaders(
  ref: McpCredentialRef,
  headerNames: string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<Record<string, string>> {
  const settings = store ?? getSettingsStore(env);
  const headerValues = await Promise.all(headerNames.map((name) =>
    resolveOne(mcpHeaderEnvVar(ref, name), mcpHeaderSettingKey(ref, name), ref, settings, env)
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
  ref: McpCredentialRef,
  headerNames: string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<McpSecretSources> {
  const settings = store ?? getSettingsStore(env);
  const [bearer, ...headerSources] = await Promise.all([
    sourceOf(mcpBearerEnvVar(ref), mcpBearerSettingKey(ref), ref, settings, env),
    ...headerNames.map((name) =>
      sourceOf(mcpHeaderEnvVar(ref, name), mcpHeaderSettingKey(ref, name), ref, settings, env),
    ),
  ]);
  const headers: Record<string, McpSecretSource> = {};
  for (const [index, name] of headerNames.entries()) {
    headers[name] = headerSources[index]!;
  }
  return { bearer, headers };
}

export async function saveMcpSecrets(
  ref: McpCredentialRef,
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
  ref: McpCredentialRef,
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
  ref: McpCredentialRef,
  settings: SettingsStore,
  env: PlatformEnv | undefined,
): Promise<string | undefined> {
  const fromEnv = deploymentBoundSecretOverride(
    envVar,
    mcpCredentialBindingEnvVar(ref),
    ref.credentialBinding,
    env,
  );
  if (fromEnv) {
    return fromEnv;
  }
  return nonEmpty(await settings.getSetting(settingKey));
}

async function sourceOf(
  envVar: string,
  settingKey: string,
  ref: McpCredentialRef,
  settings: SettingsStore,
  env: PlatformEnv | undefined,
): Promise<McpSecretSource> {
  if (deploymentBoundSecretOverride(
    envVar,
    mcpCredentialBindingEnvVar(ref),
    ref.credentialBinding,
    env,
  )) {
    return 'env';
  }
  return nonEmpty(await settings.getSetting(settingKey)) ? 'stored' : 'missing';
}

