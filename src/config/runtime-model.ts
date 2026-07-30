import { resolveOpenAiAuthMethod } from './openai-auth.ts';
import {
  applyResolvedProviderKey,
  isProviderKeyId,
  type ProviderKeyId,
} from './provider-keys.ts';
import type { SettingsStore } from './settings-store.ts';
import type { PlatformEnv } from './state-backend.ts';
import {
  bindOpenAiSubscriptionProvider,
  isOpenAiSubscriptionProviderId,
  openAiSubscriptionModelSpecifier,
} from '../openai-subscription/provider.ts';
import { OpenAiSubscriptionError } from '../openai-subscription/errors.ts';
import { requireOpenAiSubscriptionEnabled } from '../openai-subscription/feature.ts';
import {
  canonicalCompatibilityModel,
  isInternalCompatibilityProvider,
} from '../model-compat/provider.ts';
import { resolveApiKeyModelSpecifier } from '../model-compat/routing.ts';
import {
  loadModelCatalog,
  resolveActiveCatalogRoute,
  type ModelCatalogLoadResult,
} from '../model-catalog/index.ts';

export type ProviderAuthRoute = 'openai_api_key' | 'openai_subscription';

export interface ResolvedRuntimeModel {
  /** Internal Flue model specifier. Never persist it as profile configuration. */
  model: string;
  /** Safe billing-lane fact for traces and product audit state. */
  providerAuthRoute?: ProviderAuthRoute;
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
  requireSubscriptionEnabled?: (env?: PlatformEnv) => void;
  loadCatalog?: (settings: SettingsStore) => Promise<ModelCatalogLoadResult>;
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
    await (dependencies.applyProviderKey ?? applyResolvedProviderKey)(
      'anthropic',
      dependencies.env,
      dependencies.settings,
    );
    return { model };
  }
  if (providerId !== 'openai') {
    if (isProviderKeyId(providerId)) {
      await (dependencies.applyProviderKey ?? applyResolvedProviderKey)(
        providerId,
        dependencies.env,
        dependencies.settings,
      );
    }
    return { model: canonicalModel };
  }

  const authorization = await (
    dependencies.resolveOpenAiAuthorization ?? resolveOpenAiAuthMethod
  )(dependencies.settings);
  if (authorization === 'api_key') {
    const model = resolveApiKeyModelSpecifier(canonicalModel, 'openai');
    await (dependencies.applyProviderKey ?? applyResolvedProviderKey)(
      'openai',
      dependencies.env,
      dependencies.settings,
    );
    return { model, providerAuthRoute: 'openai_api_key' };
  }

  // The rollout switch is checked after resolving the installation-wide
  // billing authority but before touching either credential lane. Disabling
  // the preview preserves the setting and stored tokens while making every
  // OpenAI operation fail closed.
  (dependencies.requireSubscriptionEnabled ?? requireOpenAiSubscriptionEnabled)(
    dependencies.env,
  );

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
