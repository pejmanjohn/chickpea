import {
  resolveLiveOpenAiAuthorization,
  type LiveOpenAiAuthorization,
} from './effective-config.ts';
import {
  applyResolvedProviderKey,
  isProviderKeyId,
  type ProviderKeyId,
} from './provider-keys.ts';
import type { SettingsStore } from './settings-store.ts';
import type { PlatformEnv } from './state-backend.ts';
import type { CustomAgentConfig } from './types.ts';
import {
  bindOpenAiSubscriptionProvider,
  openAiSubscriptionModelSpecifier,
} from '../openai-subscription/provider.ts';

export type ProviderAuthRoute = 'openai_api_key' | 'openai_subscription';

export interface ResolvedRuntimeModel {
  /** Internal Flue model specifier. Never persist it as profile configuration. */
  model: string;
  /** Safe billing-lane fact for traces and product audit state. */
  providerAuthRoute?: ProviderAuthRoute;
}

interface RuntimeModelDependencies {
  agents: { getAgent(id: string): Promise<CustomAgentConfig> };
  settings: SettingsStore;
  env?: PlatformEnv;
  resolveOpenAiAuthorization?: typeof resolveLiveOpenAiAuthorization;
  applyProviderKey?: (
    id: ProviderKeyId,
    env: PlatformEnv | undefined,
    settings: SettingsStore,
  ) => Promise<void>;
  bindSubscription?: typeof bindOpenAiSubscriptionProvider;
}

/**
 * Resolve the one billing lane immediately before Flue constructs an Agent.
 * Subscription selection never reads or binds the Platform API key; any
 * subscription failure escapes directly and cannot cross lanes.
 */
export async function resolveRuntimeModel(
  agentId: string,
  canonicalModel: string,
  dependencies: RuntimeModelDependencies,
): Promise<ResolvedRuntimeModel> {
  const providerId = providerPrefix(canonicalModel);
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
    dependencies.resolveOpenAiAuthorization ?? resolveLiveOpenAiAuthorization
  )(agentId, canonicalModel, dependencies.agents);
  if (!authorization) {
    throw new Error('OpenAI billing authority could not be resolved');
  }
  if (authorization.method === 'api_key') {
    await (dependencies.applyProviderKey ?? applyResolvedProviderKey)(
      'openai',
      dependencies.env,
      dependencies.settings,
    );
    return { model: canonicalModel, providerAuthRoute: 'openai_api_key' };
  }

  // Validate the allowlist before resolving credentials or registering a live
  // transport. A malformed/unsupported profile fails without touching either
  // OpenAI credential lane.
  const internalModel = openAiSubscriptionModelSpecifier(
    canonicalModel.slice('openai/'.length),
  );
  await (dependencies.bindSubscription ?? bindOpenAiSubscriptionProvider)({
    settings: dependencies.settings,
  });
  return {
    model: internalModel,
    providerAuthRoute: routeForOpenAiAuthorization(authorization),
  };
}

export function canonicalRuntimeModel(model: string): string {
  return model.startsWith('openai-subscription/')
    ? `openai/${model.slice('openai-subscription/'.length)}`
    : model;
}

function routeForOpenAiAuthorization(
  authorization: LiveOpenAiAuthorization,
): ProviderAuthRoute {
  return authorization.method === 'subscription'
    ? 'openai_subscription'
    : 'openai_api_key';
}

function providerPrefix(model: string): string {
  const separator = model.indexOf('/');
  return separator > 0 ? model.slice(0, separator) : model;
}
