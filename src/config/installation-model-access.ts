/**
 * Core's model access for one installation: the default resolver and the
 * grants a trusted host attaches to a run or a stateless call.
 *
 * Standalone resolves today's sources in today's order (the deployment
 * environment's key, then the key saved in Admin) and keeps the deployment's
 * endpoint override. An installation of a deployment serving many resolves
 * only the key it saved, through its own scoped env, and every model call is
 * refused while the deployment holds a provider key of its own.
 */
import { STANDALONE_INSTALLATION_IDENTITY } from '../identity/installation-binding.ts';
import { requireInstallationScope } from './installation-scope.ts';
import {
  MODEL_ACCESS_PROVIDER_IDS,
  ModelAccessError,
  configureModelAccessResolver,
  deploymentServesManyInstallations,
  isModelAccessProviderId,
  modelAccessProviderId,
  modelAccessResolverConfigured,
  resolveModelAccessGrant,
  withModelAccess,
  type ModelAccessGrant,
  type ModelAccessProviderId,
  type ModelAccessResolver,
  type ResolvedModelAccess,
} from './model-access.ts';
import {
  ModelCredentialRevisionError,
  customCredentialRefId,
  environmentCredentialRefId,
  environmentCredentialVersion,
  readStoredModelCredential,
  resolveModelCredentialAttribution,
} from './model-credential-refs.ts';
import {
  PROVIDER_KEY_ENV_VARS,
  deploymentModelKeyNames,
  providerBaseUrl,
} from './provider-keys.ts';
import type { SettingsStore } from './settings-store.ts';
import { getSettingsStore, type PlatformEnv } from './state-backend.ts';
import type { ModelCredentialAttribution } from './types.ts';
import { nonEmpty, trimmedNonEmpty } from '../security/content-validation.ts';

export class RuntimeModelReadinessError extends Error {
  readonly repairPath = '/admin/settings#model-providers';

  constructor(
    readonly status: 'provider_setup_required' | 'unsupported',
    readonly providerId: string,
    message: string,
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
      const current = await currentInstallationCredential(grant.providerId, env, settingsFor(env));
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

export const installationModelAccessResolver = createInstallationModelAccessResolver();

// Core's resolver, unless the composing host installs its own (which replaces it).
if (!modelAccessResolverConfigured()) configureModelAccessResolver(installationModelAccessResolver);

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

/** Standalone: every credential the one installation has, read live as each attempt starts. */
export async function installationModelAccessGrants(
  env: PlatformEnv | undefined,
  runId: string,
  settings?: SettingsStore,
): Promise<ModelAccessGrant[]> {
  const grants = await Promise.all(
    MODEL_ACCESS_PROVIDER_IDS.map((providerId) => installationModelAccessGrant(providerId, env, runId, settings)),
  );
  return grants.filter((grant) => grant !== undefined);
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
  if (!providerId) {
    if (deploymentServesManyInstallations(input.env)) {
      throw new ModelAccessError(
        'provider_not_offered',
        `Model provider ${providerPrefix(runtimeModel)} is not offered on a deployment serving many installations.`,
      );
    }
    return fn();
  }
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

async function currentInstallationCredential(
  providerId: ModelAccessProviderId,
  env: PlatformEnv | undefined,
  settings: SettingsStore,
): Promise<InstallationCredential | undefined> {
  if (providerId === 'local-stub') {
    const baseUrl = localStubBaseUrl(env);
    return baseUrl
      ? {
          credentialRefId: customCredentialRefId(providerId),
          version: 1,
          apiKey: process.env.LOCAL_STUB_API_KEY ?? 'offline-stub-key',
          baseUrl,
        }
      : undefined;
  }
  const baseUrl = providerBaseUrl(providerId, env);
  const environmentKey = deploymentServesManyInstallations(env)
    ? undefined
    : process.env[PROVIDER_KEY_ENV_VARS[providerId]];
  if (trimmedNonEmpty(environmentKey)) {
    return {
      credentialRefId: environmentCredentialRefId(providerId),
      version: environmentCredentialVersion(providerId),
      apiKey: environmentKey!,
      ...(baseUrl ? { baseUrl } : {}),
    };
  }
  const stored = await readStoredModelCredential(providerId, settings);
  return stored
    ? {
        credentialRefId: stored.metadata.credentialRefId,
        version: stored.metadata.version,
        apiKey: stored.apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      }
    : undefined;
}

/** The offline verifiers' stub, offered only on standalone. */
function localStubBaseUrl(env: PlatformEnv | undefined): string | undefined {
  return deploymentServesManyInstallations(env) ? undefined : nonEmpty(process.env.LOCAL_STUB_URL);
}

function providerPrefix(model: string): string {
  const separator = model.indexOf('/');
  return separator > 0 ? model.slice(0, separator) : model;
}
