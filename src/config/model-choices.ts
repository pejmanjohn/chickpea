import { planDependencies, planStatus } from '../chatgpt-plan/connection.ts';
import { imageModelProfileReady } from '../images/provider.ts';
import { findImageModel, listImageModels } from '../model-catalog/image-profiles.ts';
import { activeModelCatalogSnapshot, loadModelCatalog } from '../model-catalog/index.ts';
import { openAiSubscriptionAvailable } from '../openai-subscription/availability.ts';
import type { ModelRequestFundingSource } from '../usage/model-requests.ts';
import { deploymentServesManyInstallations } from './installation-scope.ts';
import { modelEffortChoiceError, type ModelEffortRejection } from './model-effort-capability.ts';
import type { ModelEffort } from './model-effort.ts';
import { modelProviderUnavailable, pricedModelRoute } from './model-policy.ts';
import {
  activeCatalogCompatibilityError,
  chatModelProviderReady,
  chatSubscriptionStatus,
  openAiSubscriptionIsReady,
  PLATFORM_NOT_OFFERED_TEXT,
  resolveModelReadiness,
} from './model-readiness.ts';
import { resolveOpenAiAuthMethod } from './openai-auth.ts';
import { installationFunding } from './platform-funding.ts';
import { describeProviderKeySources, isProviderKeyId } from './provider-keys.ts';
import { getProviderFavorites, getWorkersAiEnabled } from './provider-models.ts';
import type { RuntimeModelProvider } from './providers.ts';
import type { SettingsStore } from './settings-store.ts';
import { isCloudflareTarget, type PlatformEnv } from './state-backend.ts';
import type { ConfigStore } from './store.ts';
import type { ModelRole, NonChatModelRole, OpenAiAuthMethod, WorkspaceInstallation } from './types.ts';

export const PLATFORM_MODELS_SOURCE = 'Chickpea’s models';

/** One provider group of Admin's chat model picker. */
export interface ChatModelPickerProvider extends RuntimeModelProvider {
  authMethods?: {
    activeMethod: OpenAiAuthMethod;
    apiKeyConfigured: boolean;
    subscription?: Awaited<ReturnType<typeof chatSubscriptionStatus>>;
    subscriptionAvailable: boolean;
  };
}

/**
 * Admin's chat model picker: each provider group, whether it is ready, and
 * its suggested models. Reviewed catalog entries augment the API-key
 * providers. OpenRouter and the keyless Workers AI binding show only the
 * starred favorites. On Chickpea's models only priced, served models remain.
 */
export async function chatModelPickerProviders(input: {
  settings: SettingsStore;
  env: PlatformEnv | undefined;
  runtimeProviders: RuntimeModelProvider[];
  funding?: ModelRequestFundingSource;
}): Promise<ChatModelPickerProvider[]> {
  const { settings, env, runtimeProviders } = input;
  // A deployment serving many offers its installations no subscription lane.
  const subscriptionAvailable = !deploymentServesManyInstallations(env);
  const [subscription, activeAuthMethod, workersAiEnabled] = await Promise.all([
    subscriptionAvailable ? chatSubscriptionStatus(settings, env) : undefined,
    resolveOpenAiAuthMethod(settings),
    getWorkersAiEnabled(settings),
  ]);
  const openAiApiModels = activeCatalogModels('openai_api_key', env);
  const subscriptionModels = !subscriptionAvailable
    ? []
    : isCloudflareTarget()
    ? (await planStatus(planDependencies(env, settings))).models.map((model) => ({ ...model, canonical: `openai/${model.id}` }))
    : activeCatalogModels('openai_subscription', env);
  const anthropicApiModels = activeCatalogModels('anthropic_api_key', env);
  const providers = await Promise.all(
    runtimeProviders
      .filter((provider) => provider.id !== 'cloudflare' || workersAiEnabled)
      .map(async (provider): Promise<ChatModelPickerProvider> => {
        if (provider.id === 'openai') {
          const subscriptionActive = activeAuthMethod === 'subscription';
          return {
            ...provider,
            configured: subscriptionActive
              ? subscription !== undefined && openAiSubscriptionIsReady(subscription)
              : provider.configured,
            source: subscriptionActive ? 'ChatGPT subscription' : provider.source,
            suggestions: subscriptionActive
              ? subscriptionModels.map((model) => model.canonical)
              : uniqueStrings([
                  ...openAiApiModels.map((model) => model.canonical),
                  ...provider.suggestions,
                ]),
            authMethods: {
              activeMethod: activeAuthMethod,
              apiKeyConfigured: provider.configured,
              ...(subscription ? { subscription } : {}),
              subscriptionAvailable,
            },
          };
        }
        if (provider.id === 'openrouter') {
          const favorites = await getProviderFavorites('openrouter', settings);
          return { ...provider, suggestions: favorites.map((model) => `openrouter/${model}`) };
        }
        // The binding-backed CF provider surfaces as `cloudflare`; its favorites
        // live under the `workers-ai` key and pin as `cloudflare/<model>`.
        if (provider.id === 'cloudflare') {
          const favorites = await getProviderFavorites('workers-ai', settings);
          return { ...provider, suggestions: favorites.map((model) => `cloudflare/${model}`) };
        }
        if (provider.id === 'anthropic') {
          return {
            ...provider,
            suggestions: uniqueStrings([
              ...anthropicApiModels.map((model) => model.canonical),
              ...provider.suggestions,
            ]),
          };
        }
        return provider;
      }),
  );
  const funding = input.funding ?? await installationFunding(env);
  if (funding !== 'platform') return providers;
  // Chickpea's models are a lane like the ChatGPT subscription. They need no
  // key or starred model, and serve only the models with a current price.
  const unavailable = await resolveModelReadiness({ settings, env, runtimeProviders, funding });
  return Promise.all(providers.map(async (provider) => {
    const candidates = uniqueStrings([
      ...provider.suggestions,
      ...(runtimeProviders.find(({ id }) => id === provider.id)?.suggestions ?? []),
    ]);
    const served = await Promise.all(candidates.map(async (model) => !(await unavailable(model))));
    const suggestions = candidates.filter((_, index) => served[index]);
    return { ...provider, configured: suggestions.length > 0, source: PLATFORM_MODELS_SOURCE, suggestions };
  }));
}

export function activeCatalogModels(
  lane: 'anthropic_api_key' | 'openai_api_key' | 'openai_subscription',
  env: PlatformEnv | undefined,
): Array<{
  canonical: string;
  id: string;
  name?: string;
}> {
  return activeModelCatalogSnapshot(env).entries.flatMap((entry) => {
    const provider = lane === 'anthropic_api_key' ? 'anthropic' : 'openai';
    if (!entry.lanes[lane] || !entry.id.startsWith(`${provider}/`)) return [];
    return [{
      canonical: entry.id,
      id: entry.id.slice(provider.length + 1),
      ...(entry.displayName ? { name: entry.displayName } : {}),
    }];
  });
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** One entry of a role's picker list: a catalog model an Owner may choose now. */
export interface RoleModelChoice {
  id: string;
  name: string;
  providerId: string;
  acceptsImageInput: boolean;
  authMethod: 'api_key' | 'subscription';
  maxOutputs: number;
  supportsOutputControls: boolean;
}

// The image catalog is provider-agnostic by shape; only OpenAI ships an
// adapter in this release, so only its entries can be offered.
export const IMAGE_ROLE_PROVIDER_IDS = ['openai'] as const;

export async function availableRoleModels(
  role: NonChatModelRole,
  settingsStore: SettingsStore,
  platformEnv?: PlatformEnv,
): Promise<RoleModelChoice[]> {
  if (role !== 'image') return [];
  const models = [];
  for (const provider of IMAGE_ROLE_PROVIDER_IDS) {
    for (const profile of listImageModels(provider)) {
      if (!await imageModelProfileReady(profile, platformEnv, settingsStore)) continue;
      models.push({
        id: profile.id,
        name: profile.name,
        providerId: provider,
        acceptsImageInput: profile.input.includes('image'),
        authMethod: profile.authMethod,
        maxOutputs: profile.maxOutputs,
        supportsOutputControls: profile.supportsOutputControls,
      });
    }
  }
  return models;
}

/**
 * the shape-only `modelSpecifier` regex would accept a chat model in the
 * image role, so a role choice is accepted only when the role's own catalog
 * knows it and its own credential lane is ready.
 */
export async function modelRoleChoiceError(input: {
  settingsStore: SettingsStore;
  platformEnv?: PlatformEnv;
  role: NonChatModelRole;
  modelId: string;
  /** The role's picker list when the caller already built it for this request. */
  availableModels?: readonly RoleModelChoice[];
}): Promise<string | undefined> {
  const available = input.availableModels ?? await availableRoleModels(
    input.role,
    input.settingsStore,
    input.platformEnv,
  );
  if (available.some(({ id }) => id === input.modelId)) return undefined;
  const profile = findImageModel(input.modelId);
  if (!profile) return `${input.modelId} is not an image model.`;
  if (profile.authMethod === 'subscription') {
    return openAiSubscriptionAvailable()
      ? `Connect a ChatGPT subscription before choosing ${input.modelId}.`
      : `${input.modelId} is not available on this installation.`;
  }
  return `Add an OpenAI API key before choosing ${input.modelId}.`;
}

/**
 * Why a chat model cannot fill the coding role right now, if it cannot: the
 * active catalog must serve it and its provider must be ready, exactly as for
 * the chat default. The turn still falls back to the Agent's own model if the
 * provider later disappears.
 */
export async function codingModelChoiceError(input: {
  modelId: string;
  settingsStore: SettingsStore;
  platformEnv?: PlatformEnv;
  runtimeProviders: RuntimeModelProvider[];
}): Promise<string | undefined> {
  const providerId = chatModelProviderId(input.modelId);
  if (!providerId) return 'Choose a provider/model value.';
  await loadModelCatalog(input.settingsStore, input.platformEnv);
  const [openAiAuthMethod, workersAiEnabled, openAiSubscription] = await Promise.all([
    resolveOpenAiAuthMethod(input.settingsStore),
    getWorkersAiEnabled(input.settingsStore),
    chatSubscriptionStatus(input.settingsStore, input.platformEnv),
  ]);
  const incompatible = await activeCatalogCompatibilityError(input.modelId, openAiAuthMethod, input.settingsStore, input.platformEnv);
  if (incompatible) return incompatible;
  const unavailable = await modelProviderUnavailable(
    pricedModelRoute(input.modelId, 'standard_input_output'),
    async () => {
      // A key-lane provider is ready when the turn's own key lookup finds a key,
      // so Admin never calls ready what a turn would silently replace.
      if (isProviderKeyId(providerId) &&
          !(providerId === 'openai' && openAiAuthMethod === 'subscription')) {
        return (await describeProviderKeySources(input.platformEnv, input.settingsStore))[providerId] !== 'missing';
      }
      return chatModelProviderReady(providerId, {
        runtimeProviders: input.runtimeProviders,
        platformEnv: input.platformEnv,
        openAiAuthMethod,
        workersAiEnabled,
        openAiSubscription,
      });
    },
    installationFunding(input.platformEnv),
  );
  if (!unavailable) return undefined;
  return unavailable === 'funding_not_offered'
    ? PLATFORM_NOT_OFFERED_TEXT
    : `Set up ${providerId} in Model providers before choosing ${input.modelId}.`;
}

function chatModelProviderId(modelId: string): string | undefined {
  const separator = modelId.indexOf('/');
  return separator > 0 && separator < modelId.length - 1 ? modelId.slice(0, separator) : undefined;
}

/** A Workspace model choice Admin refuses: the request's code and the refusal people read. */
export interface WorkspaceModelChoiceRefusal {
  code: 'invalid_request' | ModelEffortRejection;
  message: string;
}

/**
 * Why Admin refuses a Workspace model: the default chat model, or the image or
 * coding role. A null model clears a role. The caller checks authority and
 * the installation first.
 */
export async function workspaceModelChoiceRefusal(input: {
  role: ModelRole;
  modelId: string | null;
  effort: ModelEffort | undefined;
  settings: SettingsStore;
  env: PlatformEnv | undefined;
  runtimeProviders: RuntimeModelProvider[];
  /** The image role's picker list when the caller already built it for this request. */
  availableImageModels?: readonly RoleModelChoice[];
}): Promise<WorkspaceModelChoiceRefusal | undefined> {
  const { role, modelId, effort, settings, env } = input;
  if (role === 'image' && effort !== undefined) {
    return { code: 'invalid_request', message: 'The image model has no effort setting.' };
  }
  if (role === 'chat' && modelId === null) {
    return { code: 'invalid_request', message: 'The Workspace default model cannot be cleared. Choose another model.' };
  }
  if (modelId !== null) {
    let message: string | undefined;
    if (role === 'chat') {
      await loadModelCatalog(settings, env);
      message = await activeCatalogCompatibilityError(modelId, await resolveOpenAiAuthMethod(settings), settings, env);
    } else if (role === 'coding') {
      message = await codingModelChoiceError({
        modelId,
        settingsStore: settings,
        ...(env ? { platformEnv: env } : {}),
        runtimeProviders: input.runtimeProviders,
      });
    } else {
      message = await modelRoleChoiceError({
        settingsStore: settings,
        ...(env ? { platformEnv: env } : {}),
        role,
        modelId,
        ...(input.availableImageModels ? { availableModels: input.availableImageModels } : {}),
      });
    }
    if (message) return { code: 'invalid_request', message };
  }
  return effort ? modelEffortChoiceError(modelId ?? undefined, effort, { settings, env }) : undefined;
}

/** The installation whose Workspace models Admin edits: the only one, or none. */
export async function modelDefaultInstallation(
  configStore: Pick<ConfigStore, 'listWorkspaceInstallations'>,
): Promise<WorkspaceInstallation | undefined> {
  const installations = await configStore.listWorkspaceInstallations();
  return installations.length === 1 ? installations[0] : undefined;
}
