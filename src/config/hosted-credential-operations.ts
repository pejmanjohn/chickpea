/**
 * Credential operations a host runs against one installation of a deployment
 * serving many, from an operator job or its cron. Each takes the
 * installation's scoped env, touches only that installation's stores, and is
 * safe to run again, so a host drives every installation by running each one
 * on its own and retrying it independently.
 *
 * - `rewrapInstallationCredentials` re-encrypts what the deployment keyring's
 *   previous key still protects (the Slack bot bundle and the saved model
 *   keys) and reports a key-ID census of every encrypted record, naming any
 *   class still under the previous key that no rewrap covers.
 * - `censusInstallationCredentials` reports that census alone, with which
 *   model providers still hold a plaintext key (never the key).
 * - `migrateInstallationPlaintextModelCredentials` encrypts any model key an
 *   earlier build saved in the clear.
 *
 * Standalone keeps one installation and its own keyring file, and is refused.
 */
import { InstallationContextError, requireInstallationScope } from './installation-scope.ts';
import {
  migratePlaintextModelCredentials,
  rewrapHostedModelCredentials,
} from './model-credential-refs.ts';
import { modelCredentialSettingKeys } from './model-credential-settings.ts';
import { PROVIDER_KEY_IDS, type ProviderKeyId } from './provider-keys.ts';
import { isEncryptedCredentialCensusStore, type SettingsStore } from './settings-store.ts';
import { getIdentityStore, getSettingsStore, getUsageStore, type PlatformEnv } from './state-backend.ts';
import type { IdentityStore } from '../identity/types.ts';
import { loadCredentialKeyring } from '../slack/credential-keyring.ts';
import {
  rotateSlackCredentialEncryption,
  SlackCredentialRecoveryOnlyError,
} from '../slack/installation-credentials.ts';
import type { CredentialKeyring } from '../slack/secret-envelope.ts';
import type { UsageStore } from '../usage/types.ts';

/** Encrypted settings classes a rewrap covers. Every other class blocks retiring a key it still uses. */
const REWRAPPED_SETTINGS_CLASSES = new Set(['model_provider']);

export interface InstallationCredentialCensus {
  /** Live Slack bot bundle revisions (active and candidate), by key ID. */
  readonly slackCredentials: Readonly<Record<string, number>>;
  /** Encrypted settings revisions by class (`model_provider`, `website_login`, ...), then key ID. */
  readonly encryptedSettings: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Model providers whose key an earlier build saved in the clear. */
  readonly plaintextModelKeys: readonly ProviderKeyId[];
}

export interface InstallationRewrapResult {
  /** The Slack rotation; `recoveryOnly` when a bundle could not be opened and the installation latched. */
  readonly slack: { readonly rewrapped: number } | { readonly recoveryOnly: true };
  readonly modelKeys: {
    readonly rewrapped: readonly ProviderKeyId[];
    readonly alreadyCurrent: readonly ProviderKeyId[];
    readonly remaining: readonly ProviderKeyId[];
  };
  readonly census: InstallationCredentialCensus;
  /** Classes still holding the previous key that no rewrap covers; each blocks retiring it. */
  readonly unrewrappable: readonly string[];
  /** Nothing in this installation's stores is still under the previous key. */
  readonly done: boolean;
}

/** The deployment keyring's current key is not the one the drive started with. */
export class CredentialKeyringChangedError extends Error {
  readonly name = 'CredentialKeyringChangedError';
  readonly code = 'keyring_changed';
  constructor() {
    super('The deployment keyring\'s current key changed during the rewrap drive.');
  }
}

interface InstallationStores {
  identity?: IdentityStore;
  settings?: SettingsStore;
}

/**
 * Re-encrypt one installation's Slack bot bundle and saved model keys under
 * the keyring's current key, then count what remains under `previousKeyId`.
 * `expectedCurrentKeyId` is the current key the drive recorded when it began:
 * a drive whose keyring changed underneath it stops with `keyring_changed`
 * rather than mixing two targets. Store errors propagate for a retry.
 */
export async function rewrapInstallationCredentials(
  env: PlatformEnv,
  options: InstallationStores & {
    previousKeyId: string;
    expectedCurrentKeyId?: string;
    keyring?: CredentialKeyring;
  },
): Promise<InstallationRewrapResult> {
  hostedInstallation(env);
  const keyring = options.keyring ?? loadCredentialKeyring(env);
  if (options.expectedCurrentKeyId !== undefined && keyring.currentKeyId !== options.expectedCurrentKeyId) {
    throw new CredentialKeyringChangedError();
  }
  if (options.previousKeyId === keyring.currentKeyId) {
    throw new Error('The previous key is the deployment keyring\'s current key.');
  }
  const identity = options.identity ?? getIdentityStore(env);
  const settings = options.settings ?? getSettingsStore(env);
  const slack = await rewrapSlackCredentials(identity, keyring);
  const modelKeys = await rewrapHostedModelCredentials({ env, settings, keyring });
  const census = await censusInstallationCredentials(env, { identity, settings });
  const unrewrappable = Object.entries(census.encryptedSettings)
    .filter(([credentialClass, byKey]) =>
      !REWRAPPED_SETTINGS_CLASSES.has(credentialClass) && (byKey[options.previousKeyId] ?? 0) > 0)
    .map(([credentialClass]) => credentialClass);
  const underPrevious = (census.slackCredentials[options.previousKeyId] ?? 0) +
    Object.values(census.encryptedSettings)
      .reduce((total, byKey) => total + (byKey[options.previousKeyId] ?? 0), 0);
  return {
    slack,
    modelKeys,
    census,
    unrewrappable,
    done: !('recoveryOnly' in slack) && underPrevious === 0,
  };
}

/** A key-ID census of every encrypted record in one installation's stores; no value is read. */
export async function censusInstallationCredentials(
  env: PlatformEnv,
  options: InstallationStores = {},
): Promise<InstallationCredentialCensus> {
  hostedInstallation(env);
  const identity = options.identity ?? getIdentityStore(env);
  const settings = options.settings ?? getSettingsStore(env);
  if (!isEncryptedCredentialCensusStore(settings)) {
    throw new Error('This settings store cannot count its encrypted credentials.');
  }
  const slackCredentials: Record<string, number> = {};
  for (const revision of await identity.listLiveSlackCredentialRevisions()) {
    const keyId = revision.envelope?.keyId;
    if (keyId) slackCredentials[keyId] = (slackCredentials[keyId] ?? 0) + 1;
  }
  const encryptedSettings: Record<string, Record<string, number>> = {};
  for (const row of await settings.censusEncryptedCredentialRevisions()) {
    (encryptedSettings[row.credentialClass] ??= {})[row.keyId] = row.count;
  }
  const plaintext = await settings.getSettings(PROVIDER_KEY_IDS.map((id) => modelCredentialSettingKeys(id).apiKey));
  return {
    slackCredentials,
    encryptedSettings,
    plaintextModelKeys: PROVIDER_KEY_IDS.filter((_id, index) => plaintext[index] !== undefined),
  };
}

/**
 * The entry point for one installation's plaintext model-key migration:
 * each key an earlier build saved in the clear is published encrypted under
 * its next version, and a stale plaintext beside a deleted or encrypted key
 * is removed. Running it again changes nothing.
 */
export async function migrateInstallationPlaintextModelCredentials(
  env: PlatformEnv,
  options: { settings?: SettingsStore; usage?: UsageStore; keyring?: CredentialKeyring } = {},
): Promise<{ migrated: ProviderKeyId[]; removed: ProviderKeyId[] }> {
  hostedInstallation(env);
  return migratePlaintextModelCredentials({
    env,
    settings: options.settings ?? getSettingsStore(env),
    usage: options.usage ?? getUsageStore(env),
    ...(options.keyring ? { keyring: options.keyring } : {}),
  });
}

/**
 * Advance the installation's Slack encryption to the keyring's current key,
 * or resume a rotation already begun, and rewrap every live revision. A
 * revision that cannot be opened latches the installation into recovery,
 * exactly as its next read would, and is reported rather than thrown.
 */
async function rewrapSlackCredentials(
  identity: IdentityStore,
  keyring: CredentialKeyring,
): Promise<InstallationRewrapResult['slack']> {
  const control = await identity.getSlackCredentialControl();
  if (!control) return { rewrapped: 0 };
  const beginning = control.currentKeyId !== keyring.currentKeyId;
  try {
    const rotated = await rotateSlackCredentialEncryption({ state: identity, keyring }, {
      expectedEpoch: beginning ? control.rotationEpoch : control.rotationEpoch - 1,
      previousKeyId: control.currentKeyId,
    });
    return { rewrapped: rotated.rewrapped };
  } catch (error) {
    if (error instanceof SlackCredentialRecoveryOnlyError) return { recoveryOnly: true };
    throw error;
  }
}

function hostedInstallation(env: PlatformEnv): string {
  const scope = requireInstallationScope(env);
  if (!scope) {
    throw new InstallationContextError(
      'installation_context_missing',
      'These operations run for one installation of a deployment serving many.',
    );
  }
  return scope.installationId;
}
