import { randomUUID } from 'node:crypto';

import { InstallationContextError, requireInstallationScope } from './installation-scope.ts';
import { deploymentServesManyInstallations, providerPrefix } from './model-access.ts';
import { modelCredentialSettingKeys } from './model-credential-settings.ts';
import type { ProviderKeyId } from './provider-keys.ts';
import {
  isModelCredentialStore,
  type ModelCredentialRecord,
  type ModelCredentialStore,
  type SettingsStore,
} from './settings-store.ts';
import { getSettingsStore, getUsageStore, type PlatformEnv } from './state-backend.ts';
import type { ModelCredentialAttribution } from './types.ts';
import type { UsageStore } from '../usage/types.ts';
import {
  hasCredentialLikeContent,
  hasDisallowedControlCharacter,
  trimmedNonEmpty,
} from '../security/content-validation.ts';
import { loadCredentialKeyring } from '../slack/credential-keyring.ts';
import {
  decryptModelProviderKeyEnvelope,
  encryptModelProviderKeyEnvelope,
  type CredentialKeyring,
  type ModelProviderKeyEnvelopeContext,
} from '../slack/secret-envelope.ts';

const ENV_KEY_NAMES: Record<ProviderKeyId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const ENV_PREFIXES: Record<ProviderKeyId, string> = {
  anthropic: 'ANTHROPIC',
  openai: 'OPENAI',
  openrouter: 'OPENROUTER',
};

const BUILTIN_PROVIDERS = new Set<ProviderKeyId>(['anthropic', 'openai', 'openrouter']);

interface StoredCredentialMetadata {
  credentialRefId: string;
  version: number;
  active: boolean;
  activeFrom: number;
}

export class ModelCredentialRevisionError extends Error {
  readonly repairPath = '/admin/settings#model-providers';

  constructor(
    readonly credentialRefId: string,
    readonly expectedVersion: number,
  ) {
    super('The frozen model credential changed. Retry this request after provider setup is repaired.');
    this.name = 'ModelCredentialRevisionError';
  }
}

/** A save, rotation or deletion that lost to another writer, or was made against a stale version. */
export class ModelCredentialConflictError extends Error {
  constructor() {
    super('Provider credential metadata changed concurrently.');
    this.name = 'ModelCredentialConflictError';
  }
}

/** A saved key that cannot be decrypted (its keyring slot is gone, or it was tampered with). */
export class ModelCredentialUnavailableError extends Error {
  readonly repairPath = '/admin/settings#model-providers';

  constructor(readonly credentialRefId: string) {
    super('The saved model credential could not be read. Save the provider key again.');
    this.name = 'ModelCredentialUnavailableError';
  }
}

export type ModelCredentialAction = { kind: 'save'; apiKey: string } | { kind: 'delete' };

export interface InstallationModelCredentialInput {
  env: PlatformEnv | undefined;
  settings: SettingsStore;
  usage: UsageStore;
  now?: () => number;
  /** Fence the change on the version the caller read. */
  expectedVersion?: number;
  /** The deployment's credential keyring; loaded through `env` when absent. */
  keyring?: CredentialKeyring;
}

/** What an installation of a deployment serving many needs to read its saved key. */
export interface HostedModelCredentialRead {
  env: PlatformEnv | undefined;
  settings: SettingsStore;
  keyring?: CredentialKeyring;
}

interface ResolveCredentialOptions {
  processEnv?: NodeJS.ProcessEnv;
  now?: () => number;
  /** False when only the attribution is needed, not a usage-registry row. */
  registerUsage?: boolean;
}

export async function resolveModelCredentialAttribution(
  modelSpecifier: string,
  platformEnv?: PlatformEnv,
  settingsStore?: SettingsStore,
  usageStore?: UsageStore,
  options: ResolveCredentialOptions = {},
): Promise<ModelCredentialAttribution | null> {
  const providerId = providerPrefix(modelSpecifier);
  const processEnv = options.processEnv ?? process.env;
  const now = options.now ?? Date.now;
  const settings = settingsStore ?? getSettingsStore(platformEnv);
  const registerCredential = (input: CredentialRegistration) => options.registerUsage === false
    ? Promise.resolve(credentialAttribution(input))
    : registeredCredential(usageStore ?? getUsageStore(platformEnv), input);
  // An installation of a deployment serving many uses only its own stored
  // keys; deployment credentials are never attributed to it.
  const hosted = deploymentServesManyInstallations(platformEnv);

  if (BUILTIN_PROVIDERS.has(providerId as ProviderKeyId)) {
    const id = providerId as ProviderKeyId;
    if (!hosted && trimmedNonEmpty(processEnv[ENV_KEY_NAMES[id]])) {
      const prefix = ENV_PREFIXES[id];
      return registerCredential({
        credentialRefId: environmentCredentialRefId(id),
        version: environmentCredentialVersion(id, processEnv),
        providerId: id,
        sourceKind: 'environment',
        label: safeLabel(
          processEnv[`${prefix}_CREDENTIAL_ALIAS`],
          'Environment credential',
        ),
        scopeLabel: environmentScope(id, processEnv),
        unknownRotation: positiveEpoch(processEnv[`${prefix}_CREDENTIAL_EPOCH`]) === null,
        activeFrom: 0,
      });
    }
    if (hosted) {
      // Only a key saved encrypted counts; reading the record decrypts nothing.
      const current = savedHostedCredential(await hostedModelCredentialStore(settings).readModelCredential(id));
      if (!current) return null;
      return registerCredential(storedRegistration(id, current));
    }
    const apiKey = await settings.getSetting(providerApiKeySetting(id));
    if (!trimmedNonEmpty(apiKey)) return null;
    const metadata = await ensureStoredCredentialMetadata(id, settings, now);
    if (!metadata.active) return null;
    return registerCredential({
      credentialRefId: metadata.credentialRefId,
      version: metadata.version,
      providerId: id,
      sourceKind: 'stored',
      label: `Stored ${providerDisplayName(id)} credential`,
      scopeLabel: null,
      unknownRotation: false,
      activeFrom: metadata.activeFrom,
    });
  }

  if (hosted) return null;

  if (providerId === 'cloudflare-workers-ai') {
    if (!trimmedNonEmpty(processEnv.CLOUDFLARE_API_TOKEN) || !trimmedNonEmpty(processEnv.CLOUDFLARE_ACCOUNT_ID)) {
      return null;
    }
    const epoch = positiveEpoch(processEnv.CLOUDFLARE_WORKERS_AI_CREDENTIAL_EPOCH);
    return registerCredential({
      credentialRefId: 'cred_cloudflare-workers-ai_environment',
      version: epoch ?? 1,
      providerId,
      sourceKind: 'environment',
      label: safeLabel(
        processEnv.CLOUDFLARE_WORKERS_AI_CREDENTIAL_ALIAS,
        'Workers AI API token',
      ),
      scopeLabel: `Cloudflare account ${processEnv.CLOUDFLARE_ACCOUNT_ID}`,
      unknownRotation: epoch === null,
      activeFrom: 0,
    });
  }

  if (providerId === 'cloudflare' && hasWorkersAiBinding(platformEnv)) {
    const epoch = positiveEpoch(processEnv.CHICKPEA_DEPLOYMENT_EPOCH);
    return registerCredential({
      credentialRefId: 'cred_cloudflare_binding',
      version: epoch ?? 1,
      providerId,
      sourceKind: 'cloudflare_binding',
      label: safeLabel(processEnv.CLOUDFLARE_AI_BINDING_ALIAS, 'Workers AI binding'),
      scopeLabel: null,
      unknownRotation: epoch === null,
      activeFrom: 0,
    });
  }

  return registerCredential({
    credentialRefId: customCredentialRefId(providerId),
    version: 1,
    providerId: safeProviderId(providerId),
    sourceKind: 'custom',
    label: 'Custom provider route',
    scopeLabel: null,
    unknownRotation: true,
    activeFrom: 0,
  });
}

/** A retry may use only the credential epoch frozen at original admission. */
export async function revalidateModelCredentialAttribution(
  modelSpecifier: string,
  expected: Pick<ModelCredentialAttribution, 'credentialRefId' | 'version' | 'providerId'>,
  platformEnv?: PlatformEnv,
  settingsStore?: SettingsStore,
  usageStore?: UsageStore,
): Promise<void> {
  const current = await resolveModelCredentialAttribution(
    modelSpecifier,
    platformEnv,
    settingsStore,
    usageStore,
  );
  if (
    !current ||
    current.credentialRefId !== expected.credentialRefId ||
    current.version !== expected.version ||
    current.providerId !== expected.providerId
  ) {
    throw new ModelCredentialRevisionError(expected.credentialRefId, expected.version);
  }
}

/**
 * Save, rotate or delete an installation's stored key, advancing its version
 * under one stable reference and keeping usage attribution per version.
 * Standalone keeps the key in settings, as before. An installation of a
 * deployment serving many keeps it only encrypted, published with its
 * metadata in one version-fenced write.
 */
export async function rotateInstallationModelCredential(
  id: ProviderKeyId,
  action: ModelCredentialAction,
  input: InstallationModelCredentialInput,
): Promise<StoredCredentialMetadata> {
  return deploymentServesManyInstallations(input.env)
    ? rotateHostedModelCredential(id, action, input)
    : rotateStoredModelCredential(id, action, input.settings, input.usage, input.now, input.expectedVersion);
}

/**
 * The key is encrypted for the version it will publish before the store's
 * short transaction begins, so a failure anywhere before publication leaves
 * the previous version and key exactly as they were. Without an expected
 * version, a lost race retries on the newer version; with one, it is a
 * conflict.
 */
async function rotateHostedModelCredential(
  id: ProviderKeyId,
  action: ModelCredentialAction,
  input: InstallationModelCredentialInput,
): Promise<StoredCredentialMetadata> {
  const installationId = hostedInstallationId(input.env);
  const store = hostedModelCredentialStore(input.settings);
  const keyring = action.kind === 'save' ? input.keyring ?? loadCredentialKeyring(input.env) : undefined;
  const now = input.now ?? Date.now;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await store.readModelCredential(id);
    const currentVersion = current?.version ?? 0;
    if (input.expectedVersion !== undefined && currentVersion !== input.expectedVersion) {
      throw new ModelCredentialConflictError();
    }
    const timestamp = now();
    const next: StoredCredentialMetadata = {
      credentialRefId: current?.credentialRefId ?? `cred_${id}_${randomUUID()}`,
      version: currentVersion + 1,
      active: action.kind === 'save',
      activeFrom: timestamp,
    };
    const envelope = action.kind === 'save'
      ? await encryptModelProviderKeyEnvelope(keyring!, modelProviderKeyContext(installationId, id, next), action.apiKey)
      : undefined;
    // Any active version is retired, including one whose key predates encryption.
    const previous = current?.active ? current : undefined;
    if (previous) await input.usage.putCredential(storedRegistration(id, previous));
    const published = await store.publishModelCredential({
      providerId: id,
      expectedVersion: currentVersion,
      credentialRefId: next.credentialRefId,
      version: next.version,
      activeFrom: next.activeFrom,
      ...(envelope ? { envelope } : {}),
    });
    if (!published) {
      if (input.expectedVersion !== undefined) throw new ModelCredentialConflictError();
      continue;
    }
    if (previous) await input.usage.retireCredential(previous.credentialRefId, previous.version, timestamp);
    if (next.active) await input.usage.putCredential(storedRegistration(id, next));
    return next;
  }
  throw new ModelCredentialConflictError();
}

/**
 * The saved key of an installation of a deployment serving many, with its
 * metadata. With `expected` (a grant's frozen reference and version), any
 * other current credential, or none, is refused as a revision change before
 * anything is decrypted: a superseded version is never served the newer key.
 */
export async function readHostedModelCredential(
  id: ProviderKeyId,
  input: HostedModelCredentialRead,
  expected?: { credentialRefId: string; version: number },
): Promise<{ apiKey: string; metadata: StoredCredentialMetadata } | undefined> {
  const current = savedHostedCredential(await hostedModelCredentialStore(input.settings).readModelCredential(id));
  if (expected && (current?.credentialRefId !== expected.credentialRefId || current.version !== expected.version)) {
    throw new ModelCredentialRevisionError(expected.credentialRefId, expected.version);
  }
  if (!current) return undefined;
  const installationId = hostedInstallationId(input.env);
  let apiKey: string;
  try {
    apiKey = await decryptModelProviderKeyEnvelope(
      input.keyring ?? loadCredentialKeyring(input.env),
      modelProviderKeyContext(installationId, id, current),
      current.envelope,
    );
  } catch {
    throw new ModelCredentialUnavailableError(current.credentialRefId);
  }
  const { credentialRefId, version, activeFrom } = current;
  return { apiKey, metadata: { credentialRefId, version, active: true, activeFrom } };
}

/**
 * An explicit, operator-run migration for one installation of a deployment
 * serving many; nothing calls it on its own. A key an earlier build saved in
 * the clear is published encrypted under the next version of the same
 * reference, and its plaintext removed, in the store's one version-fenced
 * write; runs frozen to the old version then fail as a revision change
 * rather than reading a key the store no longer has in that form. A
 * plaintext left beside a deleted or already-encrypted credential is
 * removed without publishing anything. Running it again changes nothing.
 * Standalone keeps its plaintext keys and is refused.
 */
export async function migratePlaintextModelCredentials(
  input: Omit<InstallationModelCredentialInput, 'expectedVersion'>,
): Promise<{ migrated: ProviderKeyId[]; removed: ProviderKeyId[] }> {
  if (!deploymentServesManyInstallations(input.env)) {
    throw new Error('Only an installation of a deployment serving many stores its model keys encrypted.');
  }
  hostedInstallationId(input.env);
  const store = hostedModelCredentialStore(input.settings);
  const migrated: ProviderKeyId[] = [];
  const removed: ProviderKeyId[] = [];
  for (const id of BUILTIN_PROVIDERS) {
    const keys = modelCredentialSettingKeys(id);
    const plaintext = await input.settings.getSetting(keys.apiKey);
    if (plaintext === undefined) continue;
    const current = await store.readModelCredential(id);
    if (!trimmedNonEmpty(plaintext) || (current && (!current.active || current.envelope))) {
      const cleared = await input.settings.applySettingsPatch({
        expectedAll: [
          { key: keys.apiKey, value: plaintext },
          { key: keys.version, value: current ? String(current.version) : null },
        ],
        delete: [keys.apiKey],
      });
      if (!cleared) throw new ModelCredentialConflictError();
      removed.push(id);
      continue;
    }
    await rotateHostedModelCredential(id, { kind: 'save', apiKey: plaintext }, {
      ...input,
      expectedVersion: current?.version ?? 0,
    });
    migrated.push(id);
  }
  return { migrated, removed };
}

/** Whether an installation of a deployment serving many has a saved key, without decrypting it. */
export async function hostedModelCredentialSaved(id: ProviderKeyId, settings: SettingsStore): Promise<boolean> {
  return Boolean(savedHostedCredential(await hostedModelCredentialStore(settings).readModelCredential(id)));
}

async function rotateStoredModelCredential(
  id: ProviderKeyId,
  action: ModelCredentialAction,
  settings: SettingsStore,
  usage: UsageStore,
  now: () => number = Date.now,
  expectedVersion?: number,
): Promise<StoredCredentialMetadata> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await storedCredentialMetadata(id, settings);
    if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) {
      throw new ModelCredentialConflictError();
    }
    const timestamp = now();
    const next: StoredCredentialMetadata = {
      credentialRefId: current?.credentialRefId ?? `cred_${id}_${randomUUID()}`,
      version: (current?.version ?? 0) + 1,
      active: action.kind === 'save',
      activeFrom: timestamp,
    };
    if (current?.active) {
      await usage.putCredential({
        credentialRefId: current.credentialRefId,
        version: current.version,
        providerId: id,
        sourceKind: 'stored',
        label: `Stored ${providerDisplayName(id)} credential`,
        scopeLabel: null,
        unknownRotation: false,
        activeFrom: current.activeFrom,
      });
    }
    const applied = await settings.applySettingsPatch({
      expected: {
        key: credentialVersionSetting(id),
        value: current ? String(current.version) : null,
      },
      set: [
        ...(action.kind === 'save'
          ? [{ key: providerApiKeySetting(id), value: action.apiKey }]
          : []),
        { key: credentialRefSetting(id), value: next.credentialRefId },
        { key: credentialVersionSetting(id), value: String(next.version) },
        { key: credentialActiveSetting(id), value: String(next.active) },
        { key: credentialActiveFromSetting(id), value: String(next.activeFrom) },
      ],
      ...(action.kind === 'delete' ? { delete: [providerApiKeySetting(id)] } : {}),
    });
    if (!applied) {
      if (expectedVersion !== undefined) {
        throw new ModelCredentialConflictError();
      }
      continue;
    }
    if (current?.active) {
      await usage.retireCredential(current.credentialRefId, current.version, timestamp);
    }
    if (next.active) {
      await usage.putCredential({
        credentialRefId: next.credentialRefId,
        version: next.version,
        providerId: id,
        sourceKind: 'stored',
        label: `Stored ${providerDisplayName(id)} credential`,
        scopeLabel: null,
        unknownRotation: false,
        activeFrom: next.activeFrom,
      });
    }
    return next;
  }
  throw new ModelCredentialConflictError();
}

export async function storedCredentialMetadata(
  id: ProviderKeyId,
  settings: SettingsStore,
): Promise<StoredCredentialMetadata | null> {
  const [ref, versionRaw, activeRaw, activeFromRaw] = await settings.getSettings([
    credentialRefSetting(id),
    credentialVersionSetting(id),
    credentialActiveSetting(id),
    credentialActiveFromSetting(id),
  ]);
  const version = positiveEpoch(versionRaw);
  const activeFrom = nonNegativeInteger(activeFromRaw);
  if (!ref || version === null || activeFrom === null) return null;
  return {
    credentialRefId: ref,
    version,
    active: activeRaw === 'true',
    activeFrom,
  };
}

/**
 * Standalone's stored keys with their version metadata, all in one read, so a
 * concurrent rotation can never pair one version's key with another
 * version's metadata. A provider with no active stored key is absent.
 */
export async function readStoredModelCredentials(
  ids: readonly ProviderKeyId[],
  settings: SettingsStore,
): Promise<Map<ProviderKeyId, { apiKey: string; metadata: StoredCredentialMetadata }>> {
  const keysPerProvider = (id: ProviderKeyId) => [
    providerApiKeySetting(id),
    credentialRefSetting(id),
    credentialVersionSetting(id),
    credentialActiveSetting(id),
    credentialActiveFromSetting(id),
  ];
  const values = await settings.getSettings(ids.flatMap(keysPerProvider));
  const credentials = new Map<ProviderKeyId, { apiKey: string; metadata: StoredCredentialMetadata }>();
  ids.forEach((id, index) => {
    const [apiKey, ref, versionRaw, activeRaw, activeFromRaw] = values.slice(index * 5, index * 5 + 5);
    const version = positiveEpoch(versionRaw);
    const activeFrom = nonNegativeInteger(activeFromRaw);
    if (apiKey && trimmedNonEmpty(apiKey) && ref && version !== null && activeFrom !== null && activeRaw === 'true') {
      credentials.set(id, { apiKey, metadata: { credentialRefId: ref, version, active: true, activeFrom } });
    }
  });
  return credentials;
}

/** The reference a deployment environment key is attributed under. */
export function environmentCredentialRefId(id: ProviderKeyId): string {
  return `cred_${id}_environment`;
}

/** The reference a custom provider route (the offline local stub) is attributed under. */
export function customCredentialRefId(providerId: string): string {
  return `cred_${safeProviderId(providerId)}_custom`;
}

/** The version a deployment environment key is attributed under. */
export function environmentCredentialVersion(
  id: ProviderKeyId,
  processEnv: NodeJS.ProcessEnv = process.env,
): number {
  return positiveEpoch(processEnv[`${ENV_PREFIXES[id]}_CREDENTIAL_EPOCH`]) ?? 1;
}

async function ensureStoredCredentialMetadata(
  id: ProviderKeyId,
  settings: SettingsStore,
  now: () => number,
): Promise<StoredCredentialMetadata> {
  const existing = await storedCredentialMetadata(id, settings);
  if (existing) return existing;
  const created: StoredCredentialMetadata = {
    credentialRefId: `cred_${id}_${randomUUID()}`,
    version: 1,
    active: true,
    activeFrom: now(),
  };
  const applied = await settings.applySettingsPatch({
    expected: { key: credentialVersionSetting(id), value: null },
    set: [
      { key: credentialRefSetting(id), value: created.credentialRefId },
      { key: credentialVersionSetting(id), value: '1' },
      { key: credentialActiveSetting(id), value: 'true' },
      { key: credentialActiveFromSetting(id), value: String(created.activeFrom) },
    ],
  });
  if (applied) return created;
  const raced = await storedCredentialMetadata(id, settings);
  if (!raced) throw new Error('Provider credential metadata did not materialize.');
  return raced;
}

type CredentialRegistration = Parameters<UsageStore['putCredential']>[0];

async function registeredCredential(
  store: UsageStore,
  input: CredentialRegistration,
): Promise<ModelCredentialAttribution> {
  let row = input;
  try {
    row = await store.putCredential(input);
  } catch {
    // Credential registration enriches reporting. It must never make model work
    // unavailable when the telemetry store is slow or temporarily unhealthy.
    console.warn('[usage] credential registry write failed; model execution will continue');
  }
  return credentialAttribution(row);
}

function credentialAttribution(row: CredentialRegistration): ModelCredentialAttribution {
  return {
    credentialRefId: row.credentialRefId,
    version: row.version,
    providerId: row.providerId,
    sourceKind: row.sourceKind,
    label: row.label,
    scopeLabel: row.scopeLabel,
    unknownRotation: row.unknownRotation,
  };
}

function hostedInstallationId(env: PlatformEnv | undefined): string {
  const scope = requireInstallationScope(env);
  if (!scope) {
    throw new InstallationContextError(
      'installation_context_missing',
      'An encrypted model credential belongs to one installation and the request has none.',
    );
  }
  return scope.installationId;
}

function hostedModelCredentialStore(settings: SettingsStore): SettingsStore & ModelCredentialStore {
  if (!isModelCredentialStore(settings)) {
    throw new Error('This settings store cannot hold encrypted model credentials.');
  }
  return settings;
}

/** The current credential when it is active with its key saved encrypted. */
function savedHostedCredential(
  record: ModelCredentialRecord | undefined,
): (ModelCredentialRecord & Required<Pick<ModelCredentialRecord, 'envelope'>>) | undefined {
  return record?.active && record.envelope
    ? record as ModelCredentialRecord & Required<Pick<ModelCredentialRecord, 'envelope'>>
    : undefined;
}

function modelProviderKeyContext(
  installationId: string,
  providerId: ProviderKeyId,
  credential: Pick<StoredCredentialMetadata, 'credentialRefId' | 'version'>,
): ModelProviderKeyEnvelopeContext {
  return {
    purpose: 'model_provider_key',
    installationId,
    providerId,
    credentialRefId: credential.credentialRefId,
    credentialVersion: credential.version,
  };
}

function storedRegistration(
  id: ProviderKeyId,
  credential: Pick<StoredCredentialMetadata, 'credentialRefId' | 'version' | 'activeFrom'>,
): CredentialRegistration {
  return {
    credentialRefId: credential.credentialRefId,
    version: credential.version,
    providerId: id,
    sourceKind: 'stored',
    label: `Stored ${providerDisplayName(id)} credential`,
    scopeLabel: null,
    unknownRotation: false,
    activeFrom: credential.activeFrom,
  };
}

function providerApiKeySetting(id: ProviderKeyId): string {
  return modelCredentialSettingKeys(id).apiKey;
}

function credentialRefSetting(id: ProviderKeyId): string {
  return modelCredentialSettingKeys(id).credentialRefId;
}

function credentialVersionSetting(id: ProviderKeyId): string {
  return modelCredentialSettingKeys(id).version;
}

function credentialActiveSetting(id: ProviderKeyId): string {
  return modelCredentialSettingKeys(id).active;
}

function credentialActiveFromSetting(id: ProviderKeyId): string {
  return modelCredentialSettingKeys(id).activeFrom;
}

function environmentScope(id: ProviderKeyId, env: NodeJS.ProcessEnv): string | null {
  if (id === 'openai') return trimmedNonEmpty(env.OPENAI_PROJECT_ID) ?? null;
  if (id === 'anthropic') return trimmedNonEmpty(env.ANTHROPIC_WORKSPACE_ID) ?? null;
  return null;
}

function providerDisplayName(id: ProviderKeyId): string {
  return id === 'openai' ? 'OpenAI' : id === 'openrouter' ? 'OpenRouter' : 'Anthropic';
}

function hasWorkersAiBinding(env: PlatformEnv | undefined): boolean {
  const binding = env?.AI;
  return Boolean(binding && typeof binding === 'object');
}

function safeProviderId(providerId: string): string {
  const normalized = providerId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 80);
  return normalized || 'custom';
}

function positiveEpoch(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}


function safeLabel(value: string | undefined, fallback: string): string {
  const candidate = trimmedNonEmpty(value);
  if (
    !candidate ||
    new TextEncoder().encode(candidate).byteLength > 160 ||
    hasDisallowedControlCharacter(candidate) ||
    hasCredentialLikeContent(candidate)
  ) {
    return fallback;
  }
  return candidate;
}
