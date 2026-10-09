import { planDependencies, planStatus } from '../chatgpt-plan/connection.ts';
import { loadModelCatalog, resolveActiveCatalogRoute } from '../model-catalog/index.ts';
import { getOpenAiSubscriptionAuthorizationStatus } from '../openai-subscription/device-auth.ts';
import type { ModelRequestFundingSource } from '../usage/model-requests.ts';
import { deploymentServesManyInstallations } from './installation-scope.ts';
import {
  modelProviderUnavailable,
  pricedModelRoute,
  type ModelProviderUnavailableReason,
} from './model-policy.ts';
import { resolveOpenAiAuthMethod } from './openai-auth.ts';
import { installationFunding } from './platform-funding.ts';
import { listInstallationModelProviders, type ProviderKeySource } from './provider-keys.ts';
import { getWorkersAiEnabled } from './provider-models.ts';
import type { RuntimeModelProvider } from './providers.ts';
import type { SettingsStore } from './settings-store.ts';
import { isCloudflareTarget, type PlatformEnv } from './state-backend.ts';

export const PLATFORM_NOT_OFFERED_TEXT = "Not available on Chickpea's models. Choose another model.";

export type ModelUnavailable =
  | { unavailable: 'model_unsupported'; message: string }
  | { unavailable: ModelProviderUnavailableReason };

/** Why one model cannot serve a turn now, or nothing when it can. */
export type ModelReadiness = (modelId: string) => Promise<ModelUnavailable | undefined>;

/**
 * Everything one request's readiness answers share, the funding read included.
 * The active catalog must serve the model, and on Chickpea's models it needs a
 * current price, else its provider must be ready.
 */
export async function resolveModelReadiness(input: {
  settings: SettingsStore;
  env: PlatformEnv | undefined;
  runtimeProviders?: RuntimeModelProvider[] | Promise<RuntimeModelProvider[]>;
  funding?: ModelRequestFundingSource;
}): Promise<ModelReadiness> {
  const { settings, env } = input;
  await loadModelCatalog(settings, env);
  const [funding, openAiAuthMethod, workersAiEnabled, openAiSubscription, runtimeProviders] = await Promise.all([
    input.funding ?? installationFunding(env),
    resolveOpenAiAuthMethod(settings),
    getWorkersAiEnabled(settings),
    chatSubscriptionStatus(settings, env),
    input.runtimeProviders ?? listInstallationModelProviders(env, settings),
  ]);
  const provider = { runtimeProviders, platformEnv: env, openAiAuthMethod, workersAiEnabled, openAiSubscription };
  return async (modelId) => {
    const message = await activeCatalogCompatibilityError(modelId, openAiAuthMethod, settings, env);
    if (message) return { unavailable: 'model_unsupported', message };
    const providerId = modelId.slice(0, modelId.indexOf('/'));
    const unavailable = await modelProviderUnavailable(
      pricedModelRoute(modelId, 'standard_input_output'),
      () => chatModelProviderReady(providerId, provider),
      funding,
    );
    return unavailable ? { unavailable } : undefined;
  };
}

/** A chat-model provider can serve a turn now: the chat default's own health rule. */
export function chatModelProviderReady(providerId: string, input: {
  runtimeProviders: RuntimeModelProvider[];
  platformEnv: PlatformEnv | undefined;
  openAiAuthMethod: 'api_key' | 'subscription';
  workersAiEnabled: boolean;
  openAiSubscription: Awaited<ReturnType<typeof chatSubscriptionStatus>>;
}): boolean {
  const provider = input.runtimeProviders.find(({ id }) => id === providerId);
  const workersAiReady = providerId !== 'cloudflare' ||
    (input.workersAiEnabled && workersAiStatus(input.platformEnv) !== 'missing');
  const providerReady = providerId === 'openai' && input.openAiAuthMethod === 'subscription'
    ? openAiSubscriptionIsReady(input.openAiSubscription)
    : Boolean(provider?.configured);
  return providerReady && workersAiReady;
}

export async function activeCatalogCompatibilityError(
  model: string | null | undefined,
  method: 'api_key' | 'subscription',
  store: SettingsStore, env?: PlatformEnv,
): Promise<string | undefined> {
  if (!model) return undefined;
  if (model.startsWith('openai/') && method === 'subscription' && isCloudflareTarget()) {
    const status = await planStatus(planDependencies(env, store));
    return status.models.some(item => `openai/${item.id}` === model) ? undefined : 'Choose a model available to the connected ChatGPT account.';
  }
  if (model.startsWith('openai/')) {
    const lane = method === 'subscription' ? 'openai_subscription' : 'openai_api_key';
    if (resolveActiveCatalogRoute(model, lane, env)) return undefined;
    return method === 'subscription'
      ? 'The selected ChatGPT subscription does not support this OpenAI model.'
      : 'The active OpenAI API-key catalog does not support this model.';
  }
  if (model.startsWith('anthropic/') &&
      !resolveActiveCatalogRoute(model, 'anthropic_api_key', env)) {
    return 'The active Anthropic API-key catalog does not support this model.';
  }
  return undefined;
}

export async function chatSubscriptionStatus(store: SettingsStore, env?: PlatformEnv) {
  return isCloudflareTarget() ? planStatus(planDependencies(env, store)) : getOpenAiSubscriptionAuthorizationStatus(store);
}

export function openAiSubscriptionIsReady(
  status: Awaited<ReturnType<typeof chatSubscriptionStatus>>,
): boolean {
  return status.state === 'connected' ||
    status.state === 'account_change_confirmation_required' ||
    (status.state === 'authorizing' && 'accountFingerprint' in status && Boolean(status.accountFingerprint));
}

export function workersAiStatus(env: PlatformEnv | undefined): ProviderKeySource {
  // Deployment-funded: not offered to an installation of a deployment serving many.
  if (deploymentServesManyInstallations(env)) return 'missing';
  if (hasWorkersAiBinding(env)) {
    return 'env';
  }
  return process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID ? 'env' : 'missing';
}

function hasWorkersAiBinding(env: PlatformEnv | undefined): boolean {
  const ai = env?.AI;
  return Boolean(ai && typeof ai === 'object' && typeof (ai as { models?: unknown }).models === 'function');
}
