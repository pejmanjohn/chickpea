import { createHash } from 'node:crypto';

import { resolveOpenAiAuthMethod } from './openai-auth.ts';
import {
  applyResolvedProviderKey,
  isProviderKeyId,
  resolveProviderApiKey,
  type ProviderKeyId,
} from './provider-keys.ts';
import type { SettingsStore } from './settings-store.ts';
import type { PlatformEnv } from './state-backend.ts';
import {
  bindOpenAiSubscriptionProvider,
  isOpenAiSubscriptionProviderId,
  openAiSubscriptionModelSpecifier,
  registerCapturedOpenAiSubscriptionProvider,
} from '../openai-subscription/provider.ts';
import { OpenAiSubscriptionError } from '../openai-subscription/errors.ts';
import {
  canonicalCompatibilityModel,
  isInternalCompatibilityProvider,
  registerCapturedModelCompatibilityProvider,
} from '../model-compat/provider.ts';
import { resolveApiKeyModelSpecifier } from '../model-compat/routing.ts';
import {
  activeModelCatalogSnapshot,
  loadModelCatalog,
  materializeCatalogModel,
  resolveActiveCatalogRoute,
  type ModelCatalogLoadResult,
} from '../model-catalog/index.ts';
import { revisionedAlias } from '../model-catalog/provider-alias.ts';
import type {
  CompiledModelProfileId,
  ModelAuthLane,
  ModelCatalogEntry,
} from '../model-catalog/types.ts';
import type { ModelCredentialAttribution } from './types.ts';
import type { RunExecutionRouteInput } from '../work/types.ts';
import { ensureOpenRouterRuntimeModel } from './openrouter-runtime-model.ts';
import {
  ProviderModelsUnavailableError,
  ProviderUnreachableError,
} from './provider-models.ts';

export type ProviderAuthRoute = 'openai_api_key' | 'openai_subscription';

export interface ResolvedRuntimeModel {
  /** Internal Flue model specifier. Never persist it as profile configuration. */
  model: string;
  /** Safe billing-lane fact for traces and product audit state. */
  providerAuthRoute?: ProviderAuthRoute;
}

/** Safe hosted-route facts carried across the Flue creation boundary. */
export interface FrozenRuntimeModelRoute {
  source: 'hosted_catalog';
  revision: number;
  sha256: string;
  lane: ModelAuthLane;
  profile: CompiledModelProfileId;
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
}

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

export type SafeRuntimeModelRouteEvidence = Omit<
  RunExecutionRouteInput,
  'executionId' | 'recordedAt'
>;

/**
 * Resolve only the installation-owned OpenAI billing authority. This shares
 * the exact authority reader used by `resolveRuntimeModel`; it does not bind a
 * provider, touch either credential lane, or manufacture an alternate model
 * resolver.
 */
export async function resolveProviderAuthRoute(
  canonicalModel: string,
  settings: SettingsStore,
): Promise<ProviderAuthRoute | undefined> {
  if (providerPrefix(canonicalModel) !== 'openai') return undefined;
  return (await resolveOpenAiAuthMethod(settings)) === 'api_key'
    ? 'openai_api_key'
    : 'openai_subscription';
}

/** Build a secret-free immutable route projection from the active catalog. */
export function safeRuntimeModelRouteEvidence(
  canonicalModel: string,
  providerAuthRoute: ProviderAuthRoute | undefined,
  credential?: ModelCredentialAttribution,
): SafeRuntimeModelRouteEvidence {
  const lane = providerAuthRoute ?? (
    providerPrefix(canonicalModel) === 'anthropic' ? 'anthropic_api_key' : undefined
  );
  const route = lane ? resolveActiveCatalogRoute(canonicalModel, lane) : undefined;
  const snapshot = activeModelCatalogSnapshot();
  const entry = lane
    ? snapshot.entries.find((candidate) => candidate.id === canonicalModel)
    : undefined;
  const compiledProfile = lane && entry ? entry.lanes[lane] : undefined;
  return {
    ...(providerAuthRoute ? { providerAuthRoute } : {}),
    ...(route && compiledProfile
      ? {
          catalogSource: route.snapshot.source,
          catalogRevision: String(route.snapshot.revision),
          catalogDigest: /^[a-f0-9]{64}$/.test(route.snapshot.sha256)
            ? route.snapshot.sha256
            : createHash('sha256').update(route.snapshot.sha256).digest('hex'),
          compiledProfile,
        }
      : {}),
    ...(credential
      ? {
          modelCredentialRef: credential.credentialRefId,
          modelCredentialVersion: credential.version,
        }
      : {}),
  };
}

/** Freeze only code-reviewed catalog inputs needed to recreate a hosted alias in a cold isolate. */
export function freezeRuntimeModelRoute(
  canonicalModel: string,
  providerAuthRoute: ProviderAuthRoute | undefined,
): FrozenRuntimeModelRoute | undefined {
  const lane = authLaneForCanonicalModel(canonicalModel, providerAuthRoute);
  if (!lane) return undefined;
  const route = resolveActiveCatalogRoute(canonicalModel, lane);
  if (!route || route.source !== 'catalog' || route.snapshot.source !== 'hosted') return undefined;
  const entry = route.snapshot.entries.find((candidate) => candidate.id === canonicalModel);
  const profile = entry?.lanes[lane];
  if (!entry || !profile) throw new Error('Hosted runtime model route is incomplete.');
  return {
    source: 'hosted_catalog',
    revision: route.snapshot.revision,
    sha256: route.snapshot.sha256,
    lane,
    profile,
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
    ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
  };
}

/** Validate and synchronously register one frozen hosted alias before useModel(). */
export function registerFrozenRuntimeModelRoute(
  canonicalModel: string,
  runtimeModel: string,
  route: FrozenRuntimeModelRoute | undefined,
): void {
  if (!route) return;
  const { model, aliases } = materializeFrozenRuntimeModelRoute(
    canonicalModel,
    runtimeModel,
    route,
  );
  if (route.lane === 'openai_subscription') {
    registerCapturedOpenAiSubscriptionProvider({
      revision: route.revision,
      sha256: route.sha256,
      models: [model],
    });
    return;
  }
  const provider = route.lane === 'openai_api_key' ? 'openai' : 'anthropic';
  const registered = registerCapturedModelCompatibilityProvider({
    provider,
    revision: route.revision,
    sha256: route.sha256,
    models: [model],
  });
  if (registered?.providerId !== aliases.providerId) {
    throw new Error('Frozen compatibility model route could not be registered.');
  }
}

export function validateFrozenRuntimeModelRoute(
  canonicalModel: string,
  runtimeModel: string,
  route: FrozenRuntimeModelRoute | undefined,
): void {
  if (route) materializeFrozenRuntimeModelRoute(canonicalModel, runtimeModel, route);
}

function materializeFrozenRuntimeModelRoute(
  canonicalModel: string,
  runtimeModel: string,
  route: FrozenRuntimeModelRoute,
) {
  const entry: ModelCatalogEntry = {
    id: canonicalModel as ModelCatalogEntry['id'],
    lanes: { [route.lane]: route.profile },
    ...(route.displayName ? { displayName: route.displayName } : {}),
    ...(route.contextWindow ? { contextWindow: route.contextWindow } : {}),
    ...(route.maxTokens ? { maxTokens: route.maxTokens } : {}),
  };
  const model = materializeCatalogModel(entry, route.lane);
  const family = route.lane === 'openai_subscription'
    ? 'openaiSubscription'
    : route.lane === 'openai_api_key'
      ? 'openaiPlatform'
      : 'anthropic';
  const aliases = revisionedAlias(family, route.revision, route.sha256);
  if (runtimeModel !== `${aliases.providerId}/${model.id}`) {
    throw new Error('Frozen runtime model route does not match its internal specifier.');
  }
  return { model, aliases };
}

interface RuntimeModelDependencies {
  settings: SettingsStore;
  env?: PlatformEnv;
  resolveOpenAiAuthorization?: typeof resolveOpenAiAuthMethod;
  applyProviderKey?: (
    id: ProviderKeyId,
    env: PlatformEnv | undefined,
    settings: SettingsStore,
  ) => Promise<void>;
  bindSubscription?: typeof bindOpenAiSubscriptionProvider;
  loadCatalog?: (settings: SettingsStore) => Promise<ModelCatalogLoadResult>;
  resolveProviderKey?: typeof resolveProviderApiKey;
}

/**
 * Resolve the one billing lane immediately before Flue constructs an Agent.
 * Subscription selection never reads or binds the Platform API key; any
 * subscription failure escapes directly and cannot cross lanes.
 */
export async function resolveRuntimeModel(
  _agentId: string,
  canonicalModel: string,
  dependencies: RuntimeModelDependencies,
): Promise<ResolvedRuntimeModel> {
  await (dependencies.loadCatalog ?? loadModelCatalog)(dependencies.settings);
  const providerId = providerPrefix(canonicalModel);
  if (isOpenAiSubscriptionProviderId(providerId)) {
    throw new OpenAiSubscriptionError('unsupported_model');
  }
  if (isInternalCompatibilityProvider(providerId)) {
    throw new Error('Internal model providers cannot be selected in profiles.');
  }
  if (providerId === 'anthropic') {
    const model = resolveApiKeyModelSpecifier(canonicalModel, 'anthropic');
    await requireProviderKey('anthropic', dependencies);
    await (dependencies.applyProviderKey ?? applyResolvedProviderKey)(
      'anthropic',
      dependencies.env,
      dependencies.settings,
    );
    return { model };
  }
  if (providerId !== 'openai') {
    if (isProviderKeyId(providerId)) {
      await requireProviderKey(providerId, dependencies);
      await (dependencies.applyProviderKey ?? applyResolvedProviderKey)(
        providerId,
        dependencies.env,
        dependencies.settings,
      );
      if (providerId === 'openrouter' && !dependencies.applyProviderKey) {
        let available: boolean;
        try {
          available = await ensureOpenRouterRuntimeModel(
            canonicalModel,
            dependencies.env,
            dependencies.settings,
          );
        } catch (error) {
          if (
            error instanceof ProviderModelsUnavailableError ||
            error instanceof ProviderUnreachableError
          ) {
            throw new RuntimeModelReadinessError(
              'provider_setup_required',
              'openrouter',
              'OpenRouter model availability could not be refreshed. Try again.',
            );
          }
          throw error;
        }
        if (!available) {
          throw new RuntimeModelReadinessError(
            'unsupported',
            'openrouter',
            `OpenRouter no longer lists ${canonicalModel.slice('openrouter/'.length)}.`,
          );
        }
      }
    }
    return { model: canonicalModel };
  }

  const authorization = await (
    dependencies.resolveOpenAiAuthorization ?? resolveOpenAiAuthMethod
  )(dependencies.settings);
  if (authorization === 'api_key') {
    const model = resolveApiKeyModelSpecifier(canonicalModel, 'openai');
    await requireProviderKey('openai', dependencies);
    await (dependencies.applyProviderKey ?? applyResolvedProviderKey)(
      'openai',
      dependencies.env,
      dependencies.settings,
    );
    return { model, providerAuthRoute: 'openai_api_key' };
  }

  // Reject malformed model ids before touching credentials. The provider then
  // validates safe ids against the account-scoped cached or live catalog.
  const modelId = canonicalModel.slice('openai/'.length);
  const route = resolveActiveCatalogRoute(canonicalModel, 'openai_subscription');
  if (!route) throw new OpenAiSubscriptionError('unsupported_model');
  const internalModel = openAiSubscriptionModelSpecifier(modelId, route);
  await (dependencies.bindSubscription ?? bindOpenAiSubscriptionProvider)({
    settings: dependencies.settings,
    modelId,
    route,
  });
  return {
    model: internalModel,
    providerAuthRoute: 'openai_subscription',
  };
}

export function canonicalRuntimeModel(model: string): string {
  const separator = model.indexOf('/');
  const providerId = separator > 0 ? model.slice(0, separator) : model;
  const canonical = isOpenAiSubscriptionProviderId(providerId)
    ? `openai/${model.slice(separator + 1)}`
    : model;
  return canonicalCompatibilityModel(canonical);
}

function providerPrefix(model: string): string {
  const separator = model.indexOf('/');
  return separator > 0 ? model.slice(0, separator) : model;
}

function authLaneForCanonicalModel(
  canonicalModel: string,
  providerAuthRoute: ProviderAuthRoute | undefined,
): ModelAuthLane | undefined {
  const provider = providerPrefix(canonicalModel);
  if (provider === 'anthropic') return 'anthropic_api_key';
  if (provider !== 'openai') return undefined;
  return providerAuthRoute === 'openai_subscription'
    ? 'openai_subscription'
    : 'openai_api_key';
}

async function requireProviderKey(
  providerId: ProviderKeyId,
  dependencies: RuntimeModelDependencies,
): Promise<void> {
  // Tests and alternate runtimes that inject the provider binding own its
  // readiness contract. Production uses the same settings/environment reader
  // as the binding itself, without probing the vendor or invoking a model.
  if (dependencies.applyProviderKey) return;
  const key = await (dependencies.resolveProviderKey ?? resolveProviderApiKey)(
    providerId,
    dependencies.env,
    dependencies.settings,
  );
  if (!key.apiKey) {
    throw new RuntimeModelReadinessError(
      'provider_setup_required',
      providerId,
      `Provider ${providerId} needs setup before this model can run.`,
    );
  }
}
