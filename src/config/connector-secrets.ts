import { nonEmpty } from '../security/content-validation.ts';
import { validConnectionCredentialRef } from './connection-credential-binding.ts';
import { createSecretCleanupKeys, deploymentBoundSecretOverride, deploymentSecretOverride, encodeEnvSegment } from './secret-keys.ts';
import { removeSettingStringSetValues } from './setting-string-set.ts';
import type { SettingsStore } from './settings-store.ts';
import { getSettingsStore, type PlatformEnv } from './state-backend.ts';

const cleanupKeys = createSecretCleanupKeys({
  keyPrefix: 'connector.',
  invalidKeyMessage: 'Invalid connector secret-cleanup key',
  invalidMarkerMessage: 'Invalid connector secret-cleanup marker',
});

type ConnectorCredentialSource = 'env' | 'stored' | 'missing';

export interface ConnectorCredentialRef {
  agentId: string;
  connectionId: string;
  credentialRef: string;
  credentialBinding: string;
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
  const fromEnv = deploymentSecretOverride(connectionAccountSecretEnvVar(ref.secretRefId), env);
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
  ref: ConnectorCredentialRef,
): string {
  if (!validConnectionCredentialRef(ref.credentialRef)) {
    throw new Error('Invalid connector credential reference');
  }
  return `connector.${ref.agentId}.credential.${ref.credentialRef}.credential`;
}

export function connectorCredentialEnvVar(ref: ConnectorCredentialRef): string {
  return (
    'CONNECTOR_AGENT_' +
    encodeEnvSegment(ref.agentId) +
    '_CONNECTION_' +
    encodeEnvSegment(ref.connectionId) +
    '_CREDENTIAL'
  );
}

export function connectorCredentialBindingEnvVar(ref: ConnectorCredentialRef): string {
  return (
    'CONNECTOR_AGENT_' +
    encodeEnvSegment(ref.agentId) +
    '_CONNECTION_' +
    encodeEnvSegment(ref.connectionId) +
    '_BINDING'
  );
}

/**
 * Durable inventory for profile deletion. The marker contains setting keys,
 * never credential values, so cleanup stays idempotent and retryable after the
 * profile row has already disappeared.
 */
export function connectorSecretCleanupMarkerKey(agentId: string, scope?: string): string {
  return 'connector-secret-cleanup.' + agentId + cleanupMarkerScope(scope);
}

export async function stageConnectorSecretCleanup(
  agentId: string,
  refs: readonly ConnectorCredentialRef[],
  env?: PlatformEnv,
  store?: SettingsStore,
  scope?: string,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  const markerKey = connectorSecretCleanupMarkerKey(agentId, scope);
  const keys = cleanupKeys.validate(
    agentId,
    refs.map(connectorCredentialSettingKey),
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
  scope?: string,
): Promise<void> {
  if (settingKeys.length === 0) return;
  const settings = store ?? getSettingsStore(env);
  const markerKey = connectorSecretCleanupMarkerKey(agentId, scope);
  const keys = cleanupKeys.validate(agentId, settingKeys);
  const merged = await settings.mergeSettingStringSet(markerKey, keys);
  cleanupKeys.validate(agentId, merged);
}

export async function finishConnectorSecretCleanup(
  agentId: string,
  env?: PlatformEnv,
  store?: SettingsStore,
  scope?: string,
): Promise<boolean> {
  const settings = store ?? getSettingsStore(env);
  const markerKey = connectorSecretCleanupMarkerKey(agentId, scope);
  const raw = await settings.getSetting(markerKey);
  if (raw === undefined) return false;

  const keys = cleanupKeys.parse(agentId, raw);
  for (const key of keys) {
    await settings.deleteSetting(key);
  }
  await settings.deleteSetting(markerKey);
  return true;
}

/** Remove successfully retired keys without consuming another connection's cleanup inventory. */
export async function unstageConnectorSecretCleanup(
  agentId: string,
  refs: readonly ConnectorCredentialRef[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  const keys = cleanupKeys.validate(agentId, refs.map(connectorCredentialSettingKey));
  await removeSettingStringSetValues(settings, connectorSecretCleanupMarkerKey(agentId), keys);
}

export async function unstageConnectorSettingCleanup(
  agentId: string,
  settingKeys: readonly string[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  const keys = cleanupKeys.validate(agentId, settingKeys);
  await removeSettingStringSetValues(settings, connectorSecretCleanupMarkerKey(agentId), keys);
}

function cleanupMarkerScope(scope: string | undefined): string {
  if (scope === undefined) return '';
  if (!/^v1:[A-Za-z0-9_-]{43}$/.test(scope)) {
    throw new Error('Invalid connector secret-cleanup scope');
  }
  return '.' + scope.slice(3);
}

export async function resolveConnectorCredential(
  ref: ConnectorCredentialRef,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<string | undefined> {
  const settings = store ?? getSettingsStore(env);
  const fromEnv = deploymentBoundSecretOverride(
    connectorCredentialEnvVar(ref),
    connectorCredentialBindingEnvVar(ref),
    ref.credentialBinding,
    env,
  );
  if (fromEnv) return fromEnv;
  return nonEmpty(await settings.getSetting(connectorCredentialSettingKey(ref)));
}

export async function saveConnectorCredential(
  ref: ConnectorCredentialRef,
  value: string,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  await settings.setSetting(connectorCredentialSettingKey(ref), value);
}

export async function clearConnectorCredential(
  ref: ConnectorCredentialRef,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  await settings.deleteSetting(connectorCredentialSettingKey(ref));
}

export async function describeConnectorCredentialSource(
  ref: ConnectorCredentialRef,
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<ConnectorCredentialSource> {
  const settings = store ?? getSettingsStore(env);
  if (deploymentBoundSecretOverride(
    connectorCredentialEnvVar(ref),
    connectorCredentialBindingEnvVar(ref),
    ref.credentialBinding,
    env,
  )) {
    return 'env';
  }
  return nonEmpty(await settings.getSetting(connectorCredentialSettingKey(ref)))
    ? 'stored'
    : 'missing';
}

export async function deleteConnectorSecrets(
  agentId: string,
  refs: readonly ConnectorCredentialRef[],
  env?: PlatformEnv,
  store?: SettingsStore,
): Promise<void> {
  const settings = store ?? getSettingsStore(env);
  for (const ref of refs) {
    if (ref.agentId !== agentId) throw new Error('Connector cleanup belongs to another Agent');
    await settings.deleteSetting(connectorCredentialSettingKey(ref));
  }
}

function validatedSecretRefId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(normalized)) {
    throw new Error('Connection account secret reference is invalid');
  }
  return normalized;
}
