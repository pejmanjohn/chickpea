/**
 * Credential operations a host runs against one installation of a deployment
 * serving many, from an operator job or its cron. Each takes the
 * installation's scoped env, touches only that installation's stores, and is
 * safe to run again, so a host drives every installation by running each one
 * on its own and retrying it independently.
 *
 * - `rewrapInstallationCredentials` re-encrypts the Slack bot bundle and the
 *   saved model keys under the deployment keyring's current key, and reports
 *   a key-ID census of every encrypted record, naming anything still under an
 *   older key that no rewrap covers.
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
import { rewrapSlackCredentialsToCurrentKey } from '../slack/installation-credentials.ts';
import type { CredentialKeyring } from '../slack/secret-envelope.ts';
import type { UsageStore } from '../usage/types.ts';

/** Encrypted settings classes a rewrap covers. Every other class blocks retiring a key it still uses. */
const REWRAPPED_SETTINGS_CLASSES = new Set(['model_provider']);

/** Named in `unrewrappable` while a parked Slack candidate cannot be opened; retention scrubs it within a day. */
export const UNREADABLE_SLACK_CANDIDATE = 'slack_credential_candidate';

export interface InstallationCredentialCensus {
  /** Live Slack bot bundle revisions (active and candidate), by key ID. */
  readonly slackCredentials: Readonly<Record<string, number>>;
  /** Encrypted settings revisions by class (`model_provider`, `website_login`, ...), then key ID. */
  readonly encryptedSettings: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Model providers whose key an earlier build saved in the clear. */
  readonly plaintextModelKeys: readonly ProviderKeyId[];
}

export interface InstallationRewrapResult {
  readonly slack: {
    readonly rewrapped: number;
    /** Parked candidates that will not open: left for retention, never latched. */
    readonly unreadableCandidates: number;
    /** The active bundle would not open, so the installation latched recovery, as its next read would. */
    readonly recoveryOnly: boolean;
    /** Live revisions still under an older key. */
    readonly remaining: number;
  };
  readonly modelKeys: {
    readonly rewrapped: readonly ProviderKeyId[];
    readonly alreadyCurrent: readonly ProviderKeyId[];
    readonly remaining: readonly ProviderKeyId[];
  };
  readonly census: InstallationCredentialCensus;
  /** What still holds an older key that no rewrap moves; each blocks retiring that key. */
  readonly unrewrappable: readonly string[];
  /** Nothing in this installation's stores is under any key but the current one. */
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
 * the keyring's current key, then census what any older key still protects.
 * `expectedCurrentKeyId` is the current key the drive recorded when it
 * began: a keyring that changed underneath it stops the drive with
 * `keyring_changed` rather than mixing two targets. Store errors propagate
 * for a retry.
 */
export async function rewrapInstallationCredentials(
  env: PlatformEnv,
  options: InstallationStores & { expectedCurrentKeyId: string; keyring?: CredentialKeyring },
): Promise<InstallationRewrapResult> {
  const { identity, settings } = installationStores(env, options);
  const keyring = options.keyring ?? loadCredentialKeyring(env);
  if (keyring.currentKeyId !== options.expectedCurrentKeyId) throw new CredentialKeyringChangedError();
  const slack = await rewrapSlackCredentialsToCurrentKey({ state: identity, keyring });
  const modelKeys = await rewrapHostedModelCredentials({ env, settings, keyring });
  const census = await censusInstallationCredentials(env, { identity, settings });
  const older = (byKey: Readonly<Record<string, number>>) =>
    Object.entries(byKey).some(([keyId, count]) => keyId !== keyring.currentKeyId && count > 0);
  const unrewrappable = [
    ...(slack.unreadableCandidates > 0 ? [UNREADABLE_SLACK_CANDIDATE] : []),
    ...Object.entries(census.encryptedSettings)
      .filter(([credentialClass, byKey]) => !REWRAPPED_SETTINGS_CLASSES.has(credentialClass) && older(byKey))
      .map(([credentialClass]) => credentialClass),
  ];
  return {
    slack,
    modelKeys,
    census,
    unrewrappable,
    done: !slack.recoveryOnly && !older(census.slackCredentials) &&
      !Object.values(census.encryptedSettings).some(older),
  };
}

/** A key-ID census of every encrypted record in one installation's stores; no value is read. */
export async function censusInstallationCredentials(
  env: PlatformEnv,
  options: InstallationStores = {},
): Promise<InstallationCredentialCensus> {
  const { identity, settings } = installationStores(env, options);
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
  const { settings } = installationStores(env, options);
  return migratePlaintextModelCredentials({
    env,
    settings,
    usage: options.usage ?? getUsageStore(env),
    ...(options.keyring ? { keyring: options.keyring } : {}),
  });
}

/** The installation's stores, after refusing an env that serves no single installation. */
function installationStores(
  env: PlatformEnv,
  options: InstallationStores,
): { identity: IdentityStore; settings: SettingsStore } {
  if (!requireInstallationScope(env)) {
    throw new InstallationContextError(
      'installation_context_missing',
      'These operations run for one installation of a deployment serving many.',
    );
  }
  return {
    identity: options.identity ?? getIdentityStore(env),
    settings: options.settings ?? getSettingsStore(env),
  };
}
