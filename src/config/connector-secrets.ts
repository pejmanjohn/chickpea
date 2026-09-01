import { nonEmpty } from '../security/content-validation.ts';
import { createSecretCleanupKeys, encodeEnvSegment } from './secret-keys.ts';
import type { SettingsStore } from './settings-store.ts';
import { getSettingsStore, type PlatformEnv } from './state-backend.ts';

/**
 * API connection credentials by reference, parallel to `mcp-secrets.ts`.
 *
 * The raw credential is stored separately from profile policy. In particular,
 * `headerValuePrefix` is not baked into this value; turn-time injection applies
 * that policy later. Environment variables always win over stored values.
 *
 * No cache here: connector credentials are resolved per-use, so a stale cache
 * would be a footgun.
 */

const cleanupKeys = createSecretCleanupKeys({
  keyPrefix: 'connector.',
  invalidKeyMessage: 'Invalid connector secret-cleanup key',
  invalidMarkerMessage: 'Invalid connector secret-cleanup marker',
});

type ConnectorCredentialSource = 'env' | 'stored' | 'missing';

interface ConnectorCredentialRef {
  agentId: string;
  connectionId: string;
}

/** Canonical U6 secret reference. It is independent of every Agent binding. */
export interface ConnectionAccountSecretRef {
  secretRefId: string;
}

export function connectionAccountSecretSettingKey(secretRefId: string): string {
  return `connection-account.${validatedSecretRefId(secretRefId)}.credential`;
}

export function connectionAccountSecretEnvVar(secretRefId: string): string {
  return `CONNECTION_ACCOUNT_${encodeEnvSegment(validatedSecretRefId(secretRefId))}_CREDENTIAL`;
}

export async function saveConnectionAccountSecret(
  secretRefId: string,
  value: string,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const normalized = value.trim();
  if (!normalized) throw new Error('Connection account credential is empty');
  const settings = store ?? getSettingsStore(env);
  await settings.setSetting(connectionAccountSecretSettingKey(secretRefId), normalized);
}

export async function resolveConnectionAccountSecret(
  ref: ConnectionAccountSecretRef,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<string | undefined> {
  const settings = store ?? getSettingsStore(env);
  const fromEnv = nonEmpty(process.env[connectionAccountSecretEnvVar(ref.secretRefId)]);
  if (fromEnv) return fromEnv;
  return nonEmpty(await settings.getSetting(connectionAccountSecretSettingKey(ref.secretRefId)));
}

/** Revocation is a tombstone: secret material disappears; the account row remains. */
export async function tombstoneConnectionAccountSecret(
  secretRefId: string,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  await settings.deleteSetting(connectionAccountSecretSettingKey(secretRefId));
}

export function connectorCredentialSettingKey(
  agentId: string,
  connectionId: string,
): string {
  return 'connector.' + agentId + '.' + connectionId + '.credential';
}

export function connectorCredentialEnvVar(agentId: string, connectionId: string): string {
  return (
    'CONNECTOR_AGENT_' +
    encodeEnvSegment(agentId) +
    '_CONNECTION_' +
    encodeEnvSegment(connectionId) +
    '_CREDENTIAL'
  );
}

/**
 * Durable inventory for profile deletion. The marker contains setting keys,
 * never credential values, so cleanup stays idempotent and retryable after the
 * profile row has already disappeared.
 */
export function connectorSecretCleanupMarkerKey(agentId: string): string {
  return 'connector-secret-cleanup.' + agentId;
}

export async function stageConnectorSecretCleanup(
  agentId: string,
  connectionIds: readonly string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  const markerKey = connectorSecretCleanupMarkerKey(agentId);
  const keys = cleanupKeys.validate(
    agentId,
    connectionIds.map((connectionId) => connectorCredentialSettingKey(agentId, connectionId)),
  );
  const merged = await settings.mergeSettingStringSet(markerKey, keys);
  cleanupKeys.validate(agentId, merged);
}

/** Stage additional fixed connector settings (for example BYO OAuth records). */
export async function stageConnectorSettingCleanup(
  agentId: string,
  settingKeys: readonly string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  if (settingKeys.length === 0) return;
  const settings = store ?? getSettingsStore(env);
  const markerKey = connectorSecretCleanupMarkerKey(agentId);
  const keys = cleanupKeys.validate(agentId, settingKeys);
  const merged = await settings.mergeSettingStringSet(markerKey, keys);
  cleanupKeys.validate(agentId, merged);
}

export async function finishConnectorSecretCleanup(
  agentId: string,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<boolean> {
  const settings = store ?? getSettingsStore(env);
  const markerKey = connectorSecretCleanupMarkerKey(agentId);
  const raw = await settings.getSetting(markerKey);
  if (raw === undefined) return false;

  const keys = cleanupKeys.parse(agentId, raw);
  for (const key of keys) {
    await settings.deleteSetting(key);
  }
  await settings.deleteSetting(markerKey);
  return true;
}

export async function resolveConnectorCredential(
  ref: ConnectorCredentialRef,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<string | undefined> {
  const settings = store ?? getSettingsStore(env);
  const fromEnv = nonEmpty(process.env[connectorCredentialEnvVar(ref.agentId, ref.connectionId)]);
  if (fromEnv) return fromEnv;
  return nonEmpty(
    await settings.getSetting(connectorCredentialSettingKey(ref.agentId, ref.connectionId)),
  );
}

export async function saveConnectorCredential(
  agentId: string,
  connectionId: string,
  value: string,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  await settings.setSetting(connectorCredentialSettingKey(agentId, connectionId), value);
}

export async function clearConnectorCredential(
  agentId: string,
  connectionId: string,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  await settings.deleteSetting(connectorCredentialSettingKey(agentId, connectionId));
}

export async function describeConnectorCredentialSource(
  agentId: string,
  connectionId: string,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<ConnectorCredentialSource> {
  const settings = store ?? getSettingsStore(env);
  if (nonEmpty(process.env[connectorCredentialEnvVar(agentId, connectionId)])) {
    return 'env';
  }
  return nonEmpty(await settings.getSetting(connectorCredentialSettingKey(agentId, connectionId)))
    ? 'stored'
    : 'missing';
}

export async function deleteConnectorSecrets(
  agentId: string,
  connectionIds: readonly string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  for (const connectionId of connectionIds) {
    await settings.deleteSetting(connectorCredentialSettingKey(agentId, connectionId));
  }
}

function validatedSecretRefId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(normalized)) {
    throw new Error('Connection account secret reference is invalid');
  }
  return normalized;
}
