import { createHash } from 'node:crypto';

import type { ManagedAccessLane } from '../connections/catalog/index.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../connections/catalog/index.ts';
import { isComposioAuthConfigId } from '../connections/providers/composio.ts';
import { loadCredentialKeyring } from '../slack/credential-keyring.ts';
import {
  decryptSlackSecretEnvelope,
  encryptSlackSecretEnvelope,
  type CredentialKeyring,
  type SlackSecretEnvelopeContext,
} from '../slack/secret-envelope.ts';
import type { EncryptedCredentialStore, SettingsStore } from './settings-store.ts';
import {
  getSettingsStore,
  type PlatformEnv,
} from './state-backend.ts';

const CONFIGURATION_SETTING = 'managed.composio.configuration';
const ENVIRONMENT_PREPARATION_SETTING = 'managed.composio.environment_preparation';
const CREDENTIAL_IDENTITY_ID = 'composio_project';
const CREDENTIAL_APP_ID = 'COMPOSIO';
const METADATA_VERSION = 1 as const;
const LEGACY_AUTH_CONFIG_CACHE_TTL_MS = 5 * 60_000;
const LEGACY_AUTH_CONFIG_FAILURE_CACHE_TTL_MS = 5 * 60_000;
const LEGACY_AUTH_CONFIG_CACHE_LIMIT = 16;
let warnedUnpreparedLegacyAuthConfigIds = false;

type ComposioConfigurationSource = 'env' | 'stored' | 'missing';
type ComposioDesiredState = 'enabled' | 'disabled';
export type ComposioAuthConfigIds = Readonly<Record<
  string,
  Readonly<Partial<Record<ManagedAccessLane, string>>> | undefined
>>;

interface ComposioConfigurationMetadata {
  version: typeof METADATA_VERSION;
  desiredState: ComposioDesiredState;
  generation: number;
  lastKeyFingerprint?: string;
  authConfigGeneration?: number;
  authConfigIds?: ComposioAuthConfigIds;
  reconciliationPending: boolean;
  lastSetupResult?: {
    status: 'ready' | 'partial' | 'failed';
    completedAt: number;
    issueCodes: string[];
  };
}

export interface ResolvedComposioConfiguration {
  /** Request-local secret. Never serialize this object into a response or log. */
  apiKey?: string;
  source: ComposioConfigurationSource;
  readOnly: boolean;
  desiredState: ComposioDesiredState;
  generation: number;
  reconciliationPending: boolean;
  keyFingerprint?: string;
  lastKeyFingerprint?: string;
  authConfigGeneration?: number;
  authConfigIds: ComposioAuthConfigIds;
  lastSetupResult?: ComposioConfigurationMetadata['lastSetupResult'];
}

interface ComposioConfigurationStatus {
  source: ComposioConfigurationSource;
  configured: boolean;
  readOnly: boolean;
  desiredState: ComposioDesiredState;
  generation: number;
  reconciliationPending: boolean;
  connectors: Array<{
    toolkit: string;
    status: 'ready' | 'setup_required';
  }>;
  lastSetupResult?: ComposioConfigurationMetadata['lastSetupResult'];
}

interface ComposioInspectedAuthConfig {
  id: string;
  toolkit: string;
  enabled: boolean;
  managed: boolean;
  unrestricted: boolean;
}

interface RecordComposioPreparationInput {
  expectedGeneration: number;
  authConfigIds: ComposioAuthConfigIds;
  status: 'ready' | 'partial' | 'failed';
  issueCodes?: readonly string[];
  completedAt?: number;
}

export interface ComposioConfigurationDependencies {
  settings: SettingsStore;
  credentials: {
    store: EncryptedCredentialStore;
    keyring: CredentialKeyring;
  };
}

interface ComposioConfigurationStorage {
  settings: SettingsStore;
  credentialStore: EncryptedCredentialStore;
}

export interface ComposioConfigurationOptions extends Partial<ComposioConfigurationDependencies> {
  env?: PlatformEnv;
  now?: () => number;
  /** Admin preparation only; runtime resolution uses persisted verified IDs. */
  verifyLegacyAuthConfigIds?: boolean;
  inspectAuthConfig?: (input: {
    apiKey: string;
    authConfigId: string;
  }) => Promise<ComposioInspectedAuthConfig>;
}

export class ComposioConfigurationMutationError extends Error {
  readonly name = 'ComposioConfigurationMutationError';
  constructor(message = 'Composio configuration is managed by the deployment.') {
    super(message);
  }
}

export class ComposioConfigurationStateError extends Error {
  readonly name = 'ComposioConfigurationStateError';
  constructor() {
    super('Stored Composio configuration is unavailable.');
  }
}

export async function resolveComposioConfiguration(
  options: ComposioConfigurationOptions = {},
): Promise<ResolvedComposioConfiguration> {
  const deploymentOwned = envValue(options.env, 'CHICKPEA_COMPOSIO_CONFIGURATION_MODE') ===
    'deployment';
  const environmentKey = envValue(options.env, 'COMPOSIO_API_KEY');
  if (environmentKey) {
    const keyFingerprint = fingerprint(environmentKey);
    const environmentState = await loadEnvironmentConfigurationState(
      options,
      keyFingerprint,
    );
    const generation = environmentState.metadata.generation;
    const reconciliationPending = environmentState.metadata.reconciliationPending;
    const prepared = environmentState.prepared
      ? environmentState.metadata
      : undefined;
    if (!prepared && !options.verifyLegacyAuthConfigIds) {
      const legacyEntries = legacyAuthConfigEntries(options.env);
      if (legacyEntries.length > 0 && !warnedUnpreparedLegacyAuthConfigIds) {
        warnedUnpreparedLegacyAuthConfigIds = true;
        console.warn(JSON.stringify({
          event: 'chickpea.managed_connection.deployment_preparation_required',
          adapterId: 'composio',
          environmentVariables: legacyEntries
            .map(({ environmentVariable }) => environmentVariable)
            .sort(),
        }));
      }
    }
    const legacyAuthConfigIds = options.verifyLegacyAuthConfigIds
      ? await validateLegacyAuthConfigIds(
          environmentKey,
          options.env,
          options.inspectAuthConfig,
          options.now,
        )
      : {};
    const authConfigIds = mergeAuthConfigIds(
      prepared?.authConfigIds ?? {},
      legacyAuthConfigIds,
    );
    return {
      apiKey: environmentKey,
      source: 'env',
      readOnly: true,
      desiredState: 'enabled',
      generation,
      reconciliationPending,
      keyFingerprint,
      lastKeyFingerprint: keyFingerprint,
      ...(prepared || Object.keys(legacyAuthConfigIds).length > 0
        ? { authConfigGeneration: generation }
        : {}),
      authConfigIds,
      ...(prepared?.lastSetupResult ? { lastSetupResult: prepared.lastSetupResult } : {}),
    };
  }
  if (deploymentOwned) return missingConfiguration(true);

  const storage = configurationStorage(options);
  const rawMetadata = await storage.settings.getSetting(CONFIGURATION_SETTING);
  const metadata = parseMetadata(rawMetadata);
  if (metadata.desiredState === 'disabled') {
    return {
      ...missingConfiguration(false, metadata.generation),
      desiredState: 'disabled',
      reconciliationPending: metadata.reconciliationPending,
      ...(metadata.lastKeyFingerprint
        ? { lastKeyFingerprint: metadata.lastKeyFingerprint }
        : {}),
      ...(metadata.lastSetupResult ? { lastSetupResult: metadata.lastSetupResult } : {}),
    };
  }
  const active = await storage.credentialStore.getEncryptedCredentialRevision(
    CREDENTIAL_IDENTITY_ID,
  );
  if (!active) {
    return missingConfiguration(false, metadata.generation);
  }
  let apiKey: string;
  try {
    const keyring = options.credentials?.keyring ?? loadCredentialKeyring(options.env);
    const secrets = await decryptSlackSecretEnvelope<{ apiKey: string }>(
      keyring,
      credentialContext(active.contextId, active.revision),
      active.envelope,
    );
    apiKey = requireProjectKey(secrets.apiKey);
  } catch {
    throw new ComposioConfigurationStateError();
  }
  const keyFingerprint = fingerprint(apiKey);
  if (metadata.lastKeyFingerprint && metadata.lastKeyFingerprint !== keyFingerprint) {
    throw new ComposioConfigurationStateError();
  }
  return {
    apiKey,
    source: 'stored',
    readOnly: false,
    desiredState: 'enabled',
    generation: metadata.generation,
    reconciliationPending: metadata.reconciliationPending,
    keyFingerprint,
    lastKeyFingerprint: keyFingerprint,
    ...(metadata.authConfigGeneration === metadata.generation
      ? {
          authConfigGeneration: metadata.authConfigGeneration,
          authConfigIds: metadata.authConfigIds ?? {},
        }
      : { authConfigIds: {} }),
    ...(metadata.lastSetupResult ? { lastSetupResult: metadata.lastSetupResult } : {}),
  };
}

export async function describeComposioConfiguration(
  options: ComposioConfigurationOptions = {},
): Promise<ComposioConfigurationStatus> {
  const resolved = await resolveComposioConfiguration(options);
  return {
    source: resolved.source,
    configured: Boolean(resolved.apiKey),
    readOnly: resolved.readOnly,
    desiredState: resolved.desiredState,
    generation: resolved.generation,
    reconciliationPending: resolved.reconciliationPending,
    connectors: MANAGED_CONNECTOR_CATALOG.list().map(({ toolkit }) => ({
      toolkit,
      status: resolved.authConfigIds[toolkit] &&
          Object.values(resolved.authConfigIds[toolkit] ?? {}).some(Boolean)
        ? 'ready'
        : 'setup_required',
    })),
    ...(resolved.lastSetupResult ? { lastSetupResult: resolved.lastSetupResult } : {}),
  };
}

/** Persist only safe connector setup metadata after validation and preparation. */
export async function recordComposioPreparationResult(
  input: RecordComposioPreparationInput,
  options: ComposioConfigurationOptions,
): Promise<void> {
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
    throw new ComposioConfigurationStateError();
  }
  const authConfigIds = normalizeAuthConfigIds(input.authConfigIds);
  const issueCodes = [...new Set(input.issueCodes ?? [])].sort();
  if (issueCodes.length > 64 ||
      issueCodes.some((code) => !/^[a-z][a-z0-9_.-]{0,127}$/.test(code))) {
    throw new ComposioConfigurationStateError();
  }
  const settings = options.settings ?? getSettingsStore(options.env);
  const environmentKey = envValue(options.env, 'COMPOSIO_API_KEY');
  const settingKey = environmentKey
    ? ENVIRONMENT_PREPARATION_SETTING
    : CONFIGURATION_SETTING;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await settings.getSetting(settingKey);
    const environmentState = environmentKey
      ? environmentConfigurationState(raw, fingerprint(environmentKey))
      : undefined;
    const current = environmentState?.metadata ?? parseMetadata(raw);
    if (environmentKey && (
      input.expectedGeneration !== current.generation ||
      current.reconciliationPending && !environmentState?.corrupted
    ) ||
        !environmentKey && (current.desiredState !== 'enabled' ||
          current.generation !== input.expectedGeneration)) {
      throw new ComposioConfigurationStateError();
    }
    const next: ComposioConfigurationMetadata = {
      ...(environmentKey
        ? {
            version: METADATA_VERSION,
            desiredState: 'enabled' as const,
            generation: input.expectedGeneration,
            lastKeyFingerprint: fingerprint(environmentKey),
            reconciliationPending: false,
          }
        : current),
      authConfigGeneration: input.expectedGeneration,
      authConfigIds,
      lastSetupResult: {
        status: input.status,
        completedAt: input.completedAt ?? Date.now(),
        issueCodes,
      },
    };
    if (await settings.applySettingsPatch({
      expected: { key: settingKey, value: raw ?? null },
      set: [{ key: settingKey, value: JSON.stringify(next) }],
    })) {
      return;
    }
  }
  throw new ComposioConfigurationStateError();
}

export async function saveStoredComposioProjectKey(
  value: string,
  options: ComposioConfigurationOptions,
): Promise<ResolvedComposioConfiguration> {
  assertMutable(options);
  const apiKey = requireProjectKey(value);
  const dependencies = configurationDependencies(options);
  const store = dependencies.credentials.store;
  const active = await store.getEncryptedCredentialRevision(CREDENTIAL_IDENTITY_ID);
  const revision = `composio_${crypto.randomUUID().replaceAll('-', '')}`;
  const contextId = active?.contextId ?? `context_${crypto.randomUUID().replaceAll('-', '')}`;
  const envelope = await encryptSlackSecretEnvelope(
    dependencies.credentials.keyring,
    credentialContext(contextId, revision),
    { apiKey },
  );
  const replaced = await store.replaceEncryptedCredentialRevision({
    key: CREDENTIAL_IDENTITY_ID,
    expectedRevision: active?.revision ?? null,
    revision,
    contextId,
    envelope,
  });
  if (!replaced) throw new ComposioConfigurationStateError();

  const nextFingerprint = fingerprint(apiKey);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await dependencies.settings.getSetting(CONFIGURATION_SETTING);
    const { metadata: current, corrupted } = recoverableMetadata(raw);
    const generation = current.lastKeyFingerprint === nextFingerprint
      ? current.generation
      : current.generation + (current.lastKeyFingerprint || corrupted ? 1 : 0);
    const next: ComposioConfigurationMetadata = {
      version: METADATA_VERSION,
      desiredState: 'enabled',
      generation,
      lastKeyFingerprint: nextFingerprint,
      reconciliationPending: corrupted || current.lastKeyFingerprint !== undefined && (
        current.desiredState === 'disabled' || current.lastKeyFingerprint !== nextFingerprint
      ),
    };
    const saved = await dependencies.settings.applySettingsPatch({
      expected: { key: CONFIGURATION_SETTING, value: raw ?? null },
      set: [{ key: CONFIGURATION_SETTING, value: JSON.stringify(next) }],
    });
    if (saved) {
      return resolveComposioConfiguration(options);
    }
  }
  if (active) {
    await store.replaceEncryptedCredentialRevision({
      key: CREDENTIAL_IDENTITY_ID,
      expectedRevision: revision,
      revision: active.revision,
      contextId: active.contextId,
      envelope: active.envelope,
    });
  } else {
    await store.deleteEncryptedCredentialRevision(CREDENTIAL_IDENTITY_ID, revision);
  }
  throw new ComposioConfigurationStateError();
}

export async function disableStoredComposioConfiguration(
  options: ComposioConfigurationOptions,
): Promise<void> {
  assertMutable(options);
  const dependencies = configurationDependencies(options);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await dependencies.settings.getSetting(CONFIGURATION_SETTING);
    const { metadata: current } = recoverableMetadata(raw);
    const next: ComposioConfigurationMetadata = {
      version: METADATA_VERSION,
      desiredState: 'disabled',
      generation: current.generation + 1,
      ...(current.lastKeyFingerprint
        ? { lastKeyFingerprint: current.lastKeyFingerprint }
        : {}),
      reconciliationPending: true,
    };
    if (await dependencies.settings.applySettingsPatch({
      expected: { key: CONFIGURATION_SETTING, value: raw ?? null },
      set: [{ key: CONFIGURATION_SETTING, value: JSON.stringify(next) }],
    })) break;
    if (attempt === 2) throw new ComposioConfigurationStateError();
  }
  const active = await dependencies.credentials.store.getEncryptedCredentialRevision(
    CREDENTIAL_IDENTITY_ID,
  );
  if (active && !await dependencies.credentials.store.deleteEncryptedCredentialRevision(
    CREDENTIAL_IDENTITY_ID,
    active.revision,
  )) {
    throw new ComposioConfigurationStateError();
  }
}

/** Clear only the exact lifecycle marker whose account scan finished. */
export async function completeComposioReconciliation(
  expectedGeneration: number,
  options: ComposioConfigurationOptions,
): Promise<void> {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
    throw new ComposioConfigurationStateError();
  }
  const settings = options.settings ?? getSettingsStore(options.env);
  const environmentKey = envValue(options.env, 'COMPOSIO_API_KEY');
  const settingKey = environmentKey
    ? ENVIRONMENT_PREPARATION_SETTING
    : CONFIGURATION_SETTING;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await settings.getSetting(settingKey);
    const current = environmentKey
      ? environmentConfigurationState(raw, fingerprint(environmentKey)).metadata
      : parseMetadata(raw);
    if (current.generation !== expectedGeneration) {
      throw new ComposioConfigurationStateError();
    }
    if (!current.reconciliationPending) return;
    const next: ComposioConfigurationMetadata = environmentKey
      ? {
          version: METADATA_VERSION,
          desiredState: 'enabled',
          generation: expectedGeneration,
          lastKeyFingerprint: fingerprint(environmentKey),
          reconciliationPending: false,
        }
      : { ...current, reconciliationPending: false };
    if (await settings.applySettingsPatch({
      expected: { key: settingKey, value: raw ?? null },
      set: [{
        key: settingKey,
        value: JSON.stringify(next),
      }],
    })) {
      return;
    }
  }
  throw new ComposioConfigurationStateError();
}

function configurationDependencies(
  options: ComposioConfigurationOptions,
): ComposioConfigurationDependencies {
  const storage = configurationStorage(options);
  return {
    settings: storage.settings,
    credentials: {
      store: storage.credentialStore,
      keyring: options.credentials?.keyring ?? loadCredentialKeyring(options.env),
    },
  };
}

function configurationStorage(
  options: ComposioConfigurationOptions,
): ComposioConfigurationStorage {
  const settings = options.settings ?? getSettingsStore(options.env);
  return {
    settings,
    credentialStore: options.credentials?.store ?? (
      isEncryptedCredentialStore(settings) ? settings : getSettingsStore(options.env)
    ),
  };
}

function isEncryptedCredentialStore(
  value: SettingsStore,
): value is SettingsStore & EncryptedCredentialStore {
  const candidate = value as Partial<EncryptedCredentialStore>;
  return typeof candidate.getEncryptedCredentialRevision === 'function' &&
    typeof candidate.replaceEncryptedCredentialRevision === 'function' &&
    typeof candidate.deleteEncryptedCredentialRevision === 'function';
}

function assertMutable(options: ComposioConfigurationOptions): void {
  if (envValue(options.env, 'COMPOSIO_API_KEY') ||
      envValue(options.env, 'CHICKPEA_COMPOSIO_CONFIGURATION_MODE') === 'deployment') {
    throw new ComposioConfigurationMutationError();
  }
}

export function composioConfigurationIsMutable(
  options: ComposioConfigurationOptions = {},
): boolean {
  return !envValue(options.env, 'COMPOSIO_API_KEY') &&
    envValue(options.env, 'CHICKPEA_COMPOSIO_CONFIGURATION_MODE') !== 'deployment';
}

function credentialContext(deploymentId: string, revision: string): SlackSecretEnvelopeContext {
  return {
    deploymentId,
    identityId: CREDENTIAL_IDENTITY_ID,
    identityClass: 'workspace_installation',
    appId: CREDENTIAL_APP_ID,
    teamId: null,
    purpose: 'managed_connector_project_key',
    revision,
  };
}

function missingConfiguration(
  readOnly: boolean,
  generation = 1,
): ResolvedComposioConfiguration {
  return {
    source: 'missing',
    readOnly,
    desiredState: 'enabled',
    generation,
    reconciliationPending: false,
    authConfigIds: {},
  };
}

function parseMetadata(raw: string | undefined): ComposioConfigurationMetadata {
  if (!raw) {
    return {
      version: METADATA_VERSION,
      desiredState: 'enabled',
      generation: 1,
      reconciliationPending: false,
    };
  }
  try {
    const value = JSON.parse(raw) as Partial<ComposioConfigurationMetadata>;
    if (value.version !== METADATA_VERSION ||
        value.desiredState !== 'enabled' && value.desiredState !== 'disabled' ||
        !Number.isSafeInteger(value.generation) || (value.generation ?? 0) < 1 ||
        typeof value.reconciliationPending !== 'boolean' ||
        value.lastKeyFingerprint !== undefined &&
          !/^[a-f0-9]{24}$/.test(value.lastKeyFingerprint) ||
        value.authConfigGeneration !== undefined &&
          (!Number.isSafeInteger(value.authConfigGeneration) || value.authConfigGeneration < 1)) {
      throw new Error('invalid');
    }
    const normalized = value as ComposioConfigurationMetadata;
    return {
      ...normalized,
      ...(normalized.authConfigIds
        ? { authConfigIds: normalizeAuthConfigIds(normalized.authConfigIds, 'tolerant') }
        : {}),
      ...(normalized.lastSetupResult
        ? { lastSetupResult: normalizeSetupResult(normalized.lastSetupResult) }
        : {}),
    };
  } catch {
    throw new ComposioConfigurationStateError();
  }
}

function recoverableMetadata(raw: string | undefined): {
  metadata: ComposioConfigurationMetadata;
  corrupted: boolean;
} {
  try {
    return { metadata: parseMetadata(raw), corrupted: false };
  } catch {
    return {
      metadata: {
        version: METADATA_VERSION,
        desiredState: 'enabled',
        generation: 1,
        reconciliationPending: false,
      },
      corrupted: true,
    };
  }
}

function normalizeAuthConfigIds(
  value: ComposioAuthConfigIds,
  mode: 'strict' | 'tolerant' = 'strict',
): ComposioAuthConfigIds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ComposioConfigurationStateError();
  }
  const allowedToolkits = new Set(MANAGED_CONNECTOR_CATALOG.list().map(({ toolkit }) => toolkit));
  const normalized: Record<string, Partial<Record<ManagedAccessLane, string>>> = {};
  for (const [toolkit, lanes] of Object.entries(value)) {
    if (!allowedToolkits.has(toolkit) || !lanes || typeof lanes !== 'object' ||
        Array.isArray(lanes)) {
      if (mode === 'tolerant') continue;
      throw new ComposioConfigurationStateError();
    }
    const laneValues: Partial<Record<ManagedAccessLane, string>> = {};
    for (const [lane, id] of Object.entries(lanes)) {
      if (lane !== 'read' && lane !== 'write' || typeof id !== 'string' ||
          !isComposioAuthConfigId(id)) {
        if (mode === 'tolerant') continue;
        throw new ComposioConfigurationStateError();
      }
      laneValues[lane] = id;
    }
    normalized[toolkit] = laneValues;
  }
  return normalized;
}

function normalizeSetupResult(
  value: ComposioConfigurationMetadata['lastSetupResult'],
): NonNullable<ComposioConfigurationMetadata['lastSetupResult']> {
  if (!value || !['ready', 'partial', 'failed'].includes(value.status) ||
      !Number.isSafeInteger(value.completedAt) || value.completedAt < 1 ||
      !Array.isArray(value.issueCodes) || value.issueCodes.length > 64 ||
      value.issueCodes.some((code) =>
        typeof code !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/.test(code))) {
    throw new ComposioConfigurationStateError();
  }
  return { ...value, issueCodes: [...new Set(value.issueCodes)].sort() };
}

async function validateLegacyAuthConfigIds(
  apiKey: string,
  env: PlatformEnv | undefined,
  inspect: ComposioConfigurationOptions['inspectAuthConfig'],
  now: (() => number) | undefined,
): Promise<ComposioAuthConfigIds> {
  const entries = legacyAuthConfigEntries(env);
  if (entries.length === 0) return {};
  const cacheKey = legacyAuthConfigCacheKey(apiKey, entries);
  const currentTime = (now ?? Date.now)();
  const cached = legacyAuthConfigCache.get(cacheKey);
  if (cached && cached.expiresAt > currentTime) return cloneAuthConfigIds(cached.value);

  let inspectAuthConfig: NonNullable<ComposioConfigurationOptions['inspectAuthConfig']>;
  try {
    inspectAuthConfig = inspect ?? await createDefaultAuthConfigInspector(apiKey);
  } catch {
    for (const entry of entries) warnIgnoredLegacyAuthConfig(entry, 'inspection_unavailable');
    return cacheLegacyAuthConfigResult(
      cacheKey,
      cached?.value ?? {},
      currentTime + LEGACY_AUTH_CONFIG_FAILURE_CACHE_TTL_MS,
    );
  }

  const inspected = await Promise.all(entries.map(async (entry) => {
    const { toolkit, id } = entry;
    if (!isComposioAuthConfigId(id)) {
      return { entry, outcome: 'incompatible' as const };
    }
    try {
      let result: ComposioInspectedAuthConfig;
      result = await inspectAuthConfig({ apiKey, authConfigId: id });
      if (result.id !== id || result.toolkit.toLowerCase() !== toolkit || !result.enabled ||
          !result.managed || !result.unrestricted) {
        return { entry, outcome: 'incompatible' as const };
      }
      return { entry, outcome: 'valid' as const };
    } catch {
      return { entry, outcome: 'inspection_unavailable' as const };
    }
  }));

  const result: Record<string, Partial<Record<ManagedAccessLane, string>>> = {};
  let inspectionUnavailable = false;
  for (const item of inspected) {
    const { toolkit, lane, id } = item.entry;
    if (item.outcome === 'valid') {
      (result[toolkit] ??= {})[lane] = id;
      continue;
    }
    if (item.outcome === 'inspection_unavailable') inspectionUnavailable = true;
    warnIgnoredLegacyAuthConfig(item.entry, item.outcome);
  }

  return cacheLegacyAuthConfigResult(
    cacheKey,
    inspectionUnavailable && cached ? cached.value : result,
    currentTime + (inspectionUnavailable
      ? LEGACY_AUTH_CONFIG_FAILURE_CACHE_TTL_MS
      : LEGACY_AUTH_CONFIG_CACHE_TTL_MS),
  );
}

function cacheLegacyAuthConfigResult(
  cacheKey: string,
  value: ComposioAuthConfigIds,
  expiresAt: number,
): ComposioAuthConfigIds {
  legacyAuthConfigCache.set(cacheKey, { value: cloneAuthConfigIds(value), expiresAt });
  while (legacyAuthConfigCache.size > LEGACY_AUTH_CONFIG_CACHE_LIMIT) {
    const oldest = legacyAuthConfigCache.keys().next().value as string | undefined;
    if (!oldest) break;
    legacyAuthConfigCache.delete(oldest);
  }
  return cloneAuthConfigIds(value);
}

function warnIgnoredLegacyAuthConfig(
  entry: LegacyAuthConfigEntry,
  reason: 'incompatible' | 'inspection_unavailable',
): void {
  console.warn(JSON.stringify({
    event: 'chickpea.managed_connection.legacy_auth_config_ignored',
    adapterId: 'composio',
    toolkit: entry.toolkit,
    lane: entry.lane,
    environmentVariable: entry.environmentVariable,
    reason,
  }));
}

const legacyAuthConfigCache = new Map<string, {
  value: ComposioAuthConfigIds;
  expiresAt: number;
}>();

function legacyAuthConfigCacheKey(
  apiKey: string,
  entries: ReadonlyArray<LegacyAuthConfigEntry>,
): string {
  const ids = entries.map(({ toolkit, lane, id }) => `${toolkit}:${lane}:${id}`).join('\n');
  return `${fingerprint(apiKey)}:${createHash('sha256').update(ids).digest('hex').slice(0, 24)}`;
}

function cloneAuthConfigIds(value: ComposioAuthConfigIds): ComposioAuthConfigIds {
  return Object.fromEntries(Object.entries(value).map(([toolkit, lanes]) => [
    toolkit,
    lanes ? { ...lanes } : undefined,
  ]));
}

interface EnvironmentConfigurationState {
  metadata: ComposioConfigurationMetadata;
  prepared: boolean;
  corrupted: boolean;
}

function environmentConfigurationState(
  raw: string | undefined,
  keyFingerprint: string,
): EnvironmentConfigurationState {
  if (!raw) {
    return {
      metadata: {
        version: METADATA_VERSION,
        desiredState: 'enabled',
        generation: 1,
        lastKeyFingerprint: keyFingerprint,
        reconciliationPending: false,
      },
      prepared: false,
      corrupted: false,
    };
  }
  const { metadata, corrupted } = recoverableMetadata(raw);
  if (corrupted) {
    return {
      metadata: {
        version: METADATA_VERSION,
        desiredState: 'enabled',
        generation: 1,
        lastKeyFingerprint: keyFingerprint,
        reconciliationPending: true,
      },
      prepared: false,
      corrupted: true,
    };
  }
  if (metadata.lastKeyFingerprint && metadata.lastKeyFingerprint !== keyFingerprint) {
    return {
      metadata: {
        version: METADATA_VERSION,
        desiredState: 'enabled',
        generation: metadata.generation + 1,
        lastKeyFingerprint: keyFingerprint,
        reconciliationPending: true,
      },
      prepared: false,
      corrupted: false,
    };
  }
  return {
    metadata: {
      ...metadata,
      lastKeyFingerprint: keyFingerprint,
    },
    prepared: metadata.reconciliationPending === false &&
      metadata.authConfigGeneration === metadata.generation,
    corrupted: false,
  };
}

async function loadEnvironmentConfigurationState(
  options: ComposioConfigurationOptions,
  keyFingerprint: string,
): Promise<EnvironmentConfigurationState> {
  const settings = options.settings ?? getSettingsStore(options.env);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await settings.getSetting(ENVIRONMENT_PREPARATION_SETTING);
    const state = environmentConfigurationState(raw, keyFingerprint);
    if (raw !== undefined) return state;
    if (await settings.applySettingsPatch({
      expected: { key: ENVIRONMENT_PREPARATION_SETTING, value: null },
      set: [{
        key: ENVIRONMENT_PREPARATION_SETTING,
        value: JSON.stringify(state.metadata),
      }],
    })) return state;
  }
  throw new ComposioConfigurationStateError();
}

function mergeAuthConfigIds(
  base: ComposioAuthConfigIds,
  overrides: ComposioAuthConfigIds,
): ComposioAuthConfigIds {
  const result: Record<string, Partial<Record<ManagedAccessLane, string>>> = {};
  for (const toolkit of new Set([...Object.keys(base), ...Object.keys(overrides)])) {
    result[toolkit] = { ...base[toolkit], ...overrides[toolkit] };
  }
  return result;
}

async function createDefaultAuthConfigInspector(apiKey: string): Promise<(
  input: { apiKey: string; authConfigId: string },
) => Promise<ComposioInspectedAuthConfig>> {
  const { Composio } = await import('@composio/core');
  const client = new Composio({ apiKey, allowTracking: false });
  return async (input) => {
    const value = await client.authConfigs.get(input.authConfigId, {
      signal: AbortSignal.timeout(10_000),
    });
    const available = value.toolAccessConfig?.toolsAvailableForExecution;
    const creation = value.toolAccessConfig?.toolsForConnectedAccountCreation;
    return {
      id: value.id,
      toolkit: value.toolkit.slug.toLowerCase(),
      enabled: value.status === 'ENABLED',
      managed: value.isComposioManaged === true,
      unrestricted: (value.restrictToFollowingTools?.length ?? 0) === 0 &&
        (available?.length ?? 0) === 0 && (creation?.length ?? 0) === 0,
    };
  };
}

interface LegacyAuthConfigEntry {
  toolkit: string;
  lane: ManagedAccessLane;
  id: string;
  environmentVariable: string;
}

function legacyAuthConfigEntries(env: PlatformEnv | undefined): LegacyAuthConfigEntry[] {
  const definitions: Array<[string, ManagedAccessLane, string]> = [
    ['gmail', 'read', 'COMPOSIO_GMAIL_READ_AUTH_CONFIG_ID'],
    ['gmail', 'write', 'COMPOSIO_GMAIL_WRITE_AUTH_CONFIG_ID'],
    ['googlecalendar', 'read', 'COMPOSIO_CALENDAR_READ_AUTH_CONFIG_ID'],
    ['googlecalendar', 'write', 'COMPOSIO_CALENDAR_WRITE_AUTH_CONFIG_ID'],
    ['googledrive', 'read', 'COMPOSIO_DRIVE_READ_AUTH_CONFIG_ID'],
    ['googledrive', 'write', 'COMPOSIO_DRIVE_WRITE_AUTH_CONFIG_ID'],
    ['googlesheets', 'read', 'COMPOSIO_SHEETS_READ_AUTH_CONFIG_ID'],
    ['googlesheets', 'write', 'COMPOSIO_SHEETS_WRITE_AUTH_CONFIG_ID'],
    ['googledocs', 'read', 'COMPOSIO_DOCS_READ_AUTH_CONFIG_ID'],
    ['googledocs', 'write', 'COMPOSIO_DOCS_WRITE_AUTH_CONFIG_ID'],
    ['googleslides', 'read', 'COMPOSIO_SLIDES_READ_AUTH_CONFIG_ID'],
    ['googleslides', 'write', 'COMPOSIO_SLIDES_WRITE_AUTH_CONFIG_ID'],
    ['notion', 'read', 'COMPOSIO_NOTION_READ_AUTH_CONFIG_ID'],
    ['notion', 'write', 'COMPOSIO_NOTION_WRITE_AUTH_CONFIG_ID'],
    ['google_search_console', 'read', 'COMPOSIO_SEARCH_CONSOLE_READ_AUTH_CONFIG_ID'],
    ['google_analytics', 'read', 'COMPOSIO_ANALYTICS_READ_AUTH_CONFIG_ID'],
    ['hubspot', 'read', 'COMPOSIO_HUBSPOT_READ_AUTH_CONFIG_ID'],
    ['hubspot', 'write', 'COMPOSIO_HUBSPOT_WRITE_AUTH_CONFIG_ID'],
    ['gong', 'read', 'COMPOSIO_GONG_READ_AUTH_CONFIG_ID'],
    ['googleads', 'read', 'COMPOSIO_GOOGLE_ADS_READ_AUTH_CONFIG_ID'],
    ['googleads', 'write', 'COMPOSIO_GOOGLE_ADS_WRITE_AUTH_CONFIG_ID'],
    ['youtube', 'read', 'COMPOSIO_YOUTUBE_READ_AUTH_CONFIG_ID'],
    ['youtube', 'write', 'COMPOSIO_YOUTUBE_WRITE_AUTH_CONFIG_ID'],
  ];
  return definitions.flatMap(([toolkit, lane, environmentVariable]) => {
    const id = envValue(env, environmentVariable);
    return id ? [{ toolkit, lane, id, environmentVariable }] : [];
  });
}

function requireProjectKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 16_384) {
    throw new ComposioConfigurationMutationError('Composio project key is invalid.');
  }
  return normalized;
}

function fingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 24);
}

function envValue(env: PlatformEnv | undefined, name: string): string | undefined {
  const bound = env?.[name];
  const value = typeof bound === 'string' ? bound : process.env[name];
  const normalized = value?.trim();
  return normalized || undefined;
}
