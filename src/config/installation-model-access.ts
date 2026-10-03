/**
 * Core's model access for one installation: the default resolver and the
 * grants a trusted host attaches to a run or a stateless call.
 *
 * Standalone resolves today's sources in today's order (the deployment
 * environment's key, then the key saved in Admin) and keeps the deployment's
 * endpoint override. An installation of a deployment serving many resolves
 * only the key it saved, encrypted, through its own scoped env, and only for
 * the exact credential version its grant froze; every model call is refused
 * while the deployment holds a provider key of its own.
 */
import { STANDALONE_INSTALLATION_IDENTITY } from '../identity/installation-binding.ts';
import { deploymentServesManyInstallations, requireInstallationScope } from './installation-scope.ts';
import {
  MODEL_ACCESS_PROVIDER_IDS,
  ModelAccessError,
  isModelAccessProviderId,
  modelAccessProviderId,
  providerPrefix,
  resolveModelAccessGrant,
  withDeploymentLane,
  withModelAccess,
  type ModelAccessGrant,
  type ModelAccessProviderId,
  type ModelAccessResolver,
  type ResolvedModelAccess,
} from './model-access.ts';
import {
  ModelCredentialRevisionError,
  ModelCredentialUnavailableError,
  customCredentialRefId,
  environmentCredentialRefId,
  environmentCredentialVersion,
  readHostedModelCredential,
  readStoredModelCredentials,
  resolveModelCredentialAttribution,
} from './model-credential-refs.ts';
import {
  PROVIDER_KEY_ENV_VARS,
  deploymentModelKeyNames,
  isProviderKeyId,
  providerBaseUrl,
  type ProviderKeyId,
} from './provider-keys.ts';
import type { SettingsStore } from './settings-store.ts';
import { getSettingsStore, type PlatformEnv } from './state-backend.ts';
import type { ModelCredentialAttribution } from './types.ts';
import { nonEmpty, trimmedNonEmpty } from '../security/content-validation.ts';
import type { CredentialKeyring } from '../slack/secret-envelope.ts';

export class RuntimeModelReadinessError extends Error {
  readonly repairPath = '/admin/settings#model-providers';

  constructor(
    readonly status: 'provider_setup_required' | 'unsupported',
    readonly providerId: string,
    message: string,
    /** The provider could not be checked just now: a retry can succeed with nothing repaired. */
    readonly transient = false,
  ) {
    super(message);
    this.name = 'RuntimeModelReadinessError';
  }
}

export function providerSetupRequired(providerId: string): RuntimeModelReadinessError {
  return new RuntimeModelReadinessError(
    'provider_setup_required',
    providerId,
    `Provider ${providerId} needs setup before this model can run.`,
  );
}

/** The installation a trusted env serves. */
export function modelAccessInstallationId(env: PlatformEnv | undefined): string {
  return requireInstallationScope(env)?.installationId ?? STANDALONE_INSTALLATION_IDENTITY.installationId;
}

/** A deployment serving many installations refuses model calls while it holds a provider key itself. */
export function requireNoDeploymentModelKeys(env: PlatformEnv | undefined): void {
  if (!deploymentServesManyInstallations(env)) return;
  const names = deploymentModelKeyNames(env);
  if (names.length > 0) {
    throw new ModelAccessError(
      'deployment_key_present',
      `This deployment serves many installations and refuses model calls while a deployment provider key is set (${names.join(', ')}).`,
    );
  }
}

interface InstallationCredential {
  credentialRefId: string;
  version: number;
  apiKey: string;
  baseUrl?: string;
}

export function createInstallationModelAccessResolver(options: {
  settings?: (env: PlatformEnv | undefined) => SettingsStore;
  /** The deployment's credential keyring; by default loaded through the env. */
  keyring?: (env: PlatformEnv | undefined) => CredentialKeyring;
} = {}): ModelAccessResolver {
  const settingsFor = options.settings ?? ((env) => getSettingsStore(env));
  return {
    async resolve(grant, env) {
      if (!isModelAccessProviderId(grant.providerId)) {
        throw new ModelAccessError('provider_not_offered', 'The model access grant names an unknown provider.');
      }
      if (grant.installationId !== modelAccessInstallationId(env)) {
        throw new ModelAccessError('installation_mismatch', 'The model access grant belongs to another installation.');
      }
      if (grant.fundingSource !== 'customer') {
        throw new ModelAccessError('funding_not_offered', 'This deployment offers only customer-funded model access.');
      }
      requireNoDeploymentModelKeys(env);
      if (deploymentServesManyInstallations(env)) {
        // Only the saved key of exactly the grant's version, decrypted after that check.
        if (!isProviderKeyId(grant.providerId)) {
          throw new ModelCredentialRevisionError(grant.credentialRefId, grant.credentialVersion);
        }
        let saved: Awaited<ReturnType<typeof readHostedModelCredential>>;
        try {
          saved = await readHostedModelCredential(grant.providerId, {
            env,
            settings: settingsFor(env),
            ...(options.keyring ? { keyring: options.keyring(env) } : {}),
          }, { credentialRefId: grant.credentialRefId, version: grant.credentialVersion });
        } catch (error) {
          // A key that will not decrypt asks for the same repair as a missing one.
          if (error instanceof ModelCredentialUnavailableError) throw providerSetupRequired(grant.providerId);
          throw error;
        }
        if (!saved) throw new ModelCredentialRevisionError(grant.credentialRefId, grant.credentialVersion);
        return Object.freeze({ apiKey: saved.apiKey });
      }
      const current = (await currentInstallationCredentials([grant.providerId], env, settingsFor(env)))
        .get(grant.providerId);
      if (
        !current ||
        current.credentialRefId !== grant.credentialRefId ||
        current.version !== grant.credentialVersion
      ) {
        throw new ModelCredentialRevisionError(grant.credentialRefId, grant.credentialVersion);
      }
      return Object.freeze({
        apiKey: current.apiKey,
        ...(current.baseUrl ? { baseUrl: current.baseUrl } : {}),
      });
    },
  };
}

/** Core's resolver; runtime-bootstrap installs it unless the composing host installed its own. */
export const installationModelAccessResolver = createInstallationModelAccessResolver();

/** The grant for a credential a run froze at admission, when its provider takes run-scoped access. */
export function frozenModelAccessGrant(
  credential: Pick<ModelCredentialAttribution, 'credentialRefId' | 'version' | 'providerId'>,
  installationId: string,
  runId: string,
): ModelAccessGrant | undefined {
  if (!isModelAccessProviderId(credential.providerId)) return undefined;
  return Object.freeze({
    installationId,
    providerId: credential.providerId,
    credentialRefId: credential.credentialRefId,
    credentialVersion: credential.version,
    runId,
    fundingSource: 'customer' as const,
  });
}

/** The installation's current grant for a provider, or undefined when it has no credential. */
export async function installationModelAccessGrant(
  providerId: ModelAccessProviderId,
  env: PlatformEnv | undefined,
  runId: string,
  settings?: SettingsStore,
): Promise<ModelAccessGrant | undefined> {
  requireNoDeploymentModelKeys(env);
  if (providerId === 'local-stub' && !localStubBaseUrl(env)) return undefined;
  const attribution = await resolveModelCredentialAttribution(
    `${providerId}/`,
    env,
    settings ?? getSettingsStore(env),
    undefined,
    { registerUsage: false },
  );
  return attribution
    ? frozenModelAccessGrant(attribution, modelAccessInstallationId(env), runId)
    : undefined;
}

/**
 * Standalone: a grant for every credential the one installation has, read
 * live (in one settings read) as each attempt starts. An installation of a
 * deployment serving many gets none: each of its runs carries its own grant.
 */
export async function installationModelAccessGrants(
  env: PlatformEnv | undefined,
  runId: string,
  settings: SettingsStore = getSettingsStore(env),
): Promise<ModelAccessGrant[]> {
  requireNoDeploymentModelKeys(env);
  if (deploymentServesManyInstallations(env)) return [];
  const installationId = modelAccessInstallationId(env);
  const credentials = await currentInstallationCredentials(MODEL_ACCESS_PROVIDER_IDS, env, settings);
  return [...credentials].map(([providerId, credential]) => Object.freeze({
    installationId,
    providerId,
    credentialRefId: credential.credentialRefId,
    credentialVersion: credential.version,
    runId,
    fundingSource: 'customer' as const,
  }));
}

/**
 * A stateless model call at a host boundary (a classifier), made with the
 * installation's current credential for `runtimeModel`'s provider. A lane
 * that brings its own deployment credential runs as it is on standalone and
 * is refused on a deployment serving many installations.
 */
export async function withStatelessModelAccess<T>(
  runtimeModel: string,
  input: { env: PlatformEnv | undefined; settings?: SettingsStore; runId: string },
  fn: () => Promise<T>,
): Promise<T> {
  const providerId = modelAccessProviderId(providerPrefix(runtimeModel));
  if (!providerId) return withDeploymentLane(input.env, fn);
  const grant = await installationModelAccessGrant(providerId, input.env, input.runId, input.settings);
  if (!grant) throw providerSetupRequired(providerId);
  return withModelAccess(grant, input.env, fn);
}

/** The installation's current access for a model client outside Pi (image generation). */
export async function resolveInstallationModelAccess(
  providerId: ModelAccessProviderId,
  env: PlatformEnv | undefined,
  runId: string,
  settings?: SettingsStore,
): Promise<ResolvedModelAccess | undefined> {
  const grant = await installationModelAccessGrant(providerId, env, runId, settings);
  return grant ? resolveModelAccessGrant(grant, env) : undefined;
}

/**
 * Standalone's current credential for each provider that has one: the
 * environment key first (with its endpoint override), then the key saved in
 * Admin. An installation of a deployment serving many never reads these.
 */
async function currentInstallationCredentials(
  providerIds: readonly ModelAccessProviderId[],
  env: PlatformEnv | undefined,
  settings: SettingsStore,
): Promise<Map<ModelAccessProviderId, InstallationCredential>> {
  const credentials = new Map<ModelAccessProviderId, InstallationCredential>();
  const localStub = providerIds.includes('local-stub') ? localStubBaseUrl(env) : undefined;
  if (localStub) {
    credentials.set('local-stub', {
      credentialRefId: customCredentialRefId('local-stub'),
      version: 1,
      apiKey: process.env.LOCAL_STUB_API_KEY ?? 'offline-stub-key',
      baseUrl: localStub,
    });
  }
  const storedIds: ProviderKeyId[] = [];
  for (const providerId of providerIds.filter(isProviderKeyId)) {
    const environmentKey = process.env[PROVIDER_KEY_ENV_VARS[providerId]];
    if (environmentKey && trimmedNonEmpty(environmentKey)) {
      credentials.set(providerId, withBaseUrl(providerId, env, {
        credentialRefId: environmentCredentialRefId(providerId),
        version: environmentCredentialVersion(providerId),
        apiKey: environmentKey,
      }));
    } else {
      storedIds.push(providerId);
    }
  }
  if (storedIds.length === 0) return credentials;
  for (const [providerId, stored] of await readStoredModelCredentials(storedIds, settings)) {
    credentials.set(providerId, withBaseUrl(providerId, env, {
      credentialRefId: stored.metadata.credentialRefId,
      version: stored.metadata.version,
      apiKey: stored.apiKey,
    }));
  }
  return credentials;
}

function withBaseUrl(
  providerId: ProviderKeyId,
  env: PlatformEnv | undefined,
  credential: InstallationCredential,
): InstallationCredential {
  const baseUrl = providerBaseUrl(providerId, env);
  return baseUrl ? { ...credential, baseUrl } : credential;
}

/** The offline verifiers' stub, offered only on standalone. */
function localStubBaseUrl(env: PlatformEnv | undefined): string | undefined {
  return deploymentServesManyInstallations(env) ? undefined : nonEmpty(process.env.LOCAL_STUB_URL);
}
