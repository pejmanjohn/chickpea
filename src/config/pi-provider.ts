import {
  createProvider,
  type Api,
  type Model,
  type Provider,
  type ProviderStreams,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { cloudflareWorkersAIProvider } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai';
import { cloudflareStreams } from '@earendil-works/pi-ai/providers/cloudflare-stream';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { modelAccessProviderId } from './model-access.ts';
import { registerPiProvider, registeredPiProvider } from './pi-provider-registry.ts';

import { decorateAttachmentProviderStreams } from '../slack/attachment-model-context.ts';
import { withWorkersAiOverflowPolicy } from './workers-ai-overflow.ts';
import { decorateWorkersAiPayloadStreams } from './workers-ai-payload.ts';
import {
  CURRENT_WORKERS_AI_MODEL_ID,
  isWorkersAiGlmModel,
  withCurrentWorkersAiModels,
  workersAiGlmOutputLimit,
} from './workers-ai-models.ts';

type PiBuiltinProviderId = 'anthropic' | 'openai' | 'openrouter';

interface PiProviderCredential {
  apiKey?: string;
  baseUrl?: string;
}

const BUILTIN_PROVIDER_PARTS: Record<
  PiBuiltinProviderId,
  { provider: () => Provider; api: () => ProviderStreams }
> = {
  anthropic: { provider: anthropicProvider, api: anthropicMessagesApi },
  openai: { provider: openaiProvider, api: openAIResponsesApi },
  openrouter: { provider: openrouterProvider, api: openAICompletionsApi },
};

// Live-catalog models (OpenRouter) added after startup. Public metadata only,
// shared by every installation like the static catalog itself.
const builtinModelOverlays = new Map<PiBuiltinProviderId, Map<string, Model<Api>>>();

/**
 * Register one generated catalog provider as a credential-free app provider.
 * Its key and endpoint arrive per request from the run's model access
 * (model-access.ts), so registering again, or in another order, changes no
 * credential.
 */
export function registerBuiltinPiProvider(id: PiBuiltinProviderId): void {
  const parts = BUILTIN_PROVIDER_PARTS[id];
  const catalog = parts.provider();
  registerPiProvider(
    createProvider({
      id,
      name: catalog.name,
      auth: modelAccessAuth(catalog.name),
      models: mergeProviderModels(catalog.getModels(), [...(builtinModelOverlays.get(id)?.values() ?? [])]),
      api: decorateAttachmentProviderStreams(parts.api()),
    }),
  );
}

/** Add a model's metadata to a built-in provider; it carries no credential. */
export function addBuiltinProviderModelOverlay(id: PiBuiltinProviderId, model: Model<Api>): void {
  const overlays = builtinModelOverlays.get(id) ?? new Map<string, Model<Api>>();
  const current = overlays.get(model.id);
  if (current && JSON.stringify(current) === JSON.stringify(model)) return;
  overlays.set(model.id, model);
  builtinModelOverlays.set(id, overlays);
  registerBuiltinPiProvider(id);
}

export function builtinProviderModelOverlay(
  id: PiBuiltinProviderId,
  modelId: string,
): Model<Api> | undefined {
  return builtinModelOverlays.get(id)?.get(modelId);
}

export function resetBuiltinProviderModelOverlaysForTests(): void {
  builtinModelOverlays.clear();
}

function mergeProviderModels(
  baseline: readonly Model<Api>[],
  overlays: readonly Model<Api>[],
): Model<Api>[] {
  const models = new Map(baseline.map((model) => [model.id, model]));
  for (const model of overlays) models.set(model.id, model);
  return [...models.values()];
}

interface WorkersAiRestOptions {
  apiKey?: string;
  accountId?: string;
  baseUrl: string;
  contextWindowFloor: number;
  maxTokens: number;
}

export function setWorkersAiRestPiProvider(options: WorkersAiRestOptions): void {
  registerPiProvider(createWorkersAiRestPiProvider(options));
}

/** Pure construction seam for REST payload and credential policy tests. */
export function createWorkersAiRestPiProvider(options: WorkersAiRestOptions): Provider {
  const catalog = cloudflareWorkersAIProvider();
  const models = withCurrentWorkersAiModels(catalog.getModels()).map((model) => ({
    ...model,
    baseUrl: options.baseUrl,
    ...(
      isWorkersAiGlmModel(model.id)
      ? {
          contextWindow: model.id === CURRENT_WORKERS_AI_MODEL_ID
            ? model.contextWindow
            : Math.min(model.contextWindow, options.contextWindowFloor),
          maxTokens: Math.min(model.maxTokens, options.maxTokens, workersAiGlmOutputLimit(model.id)),
        }
      : {}),
  }));
  return createProvider({
    id: 'cloudflare-workers-ai',
    name: catalog.name,
    auth: {
      apiKey: {
        name: 'Cloudflare Workers AI API token',
        resolve: async () =>
          options.apiKey && options.accountId
            ? {
                auth: { apiKey: options.apiKey },
                env: { CLOUDFLARE_ACCOUNT_ID: options.accountId },
                source: 'Chickpea provider policy',
              }
            : undefined,
      },
    },
    models,
    api: withDeploymentToken(
      decorateAttachmentProviderStreams(
        withWorkersAiOverflowPolicy(cloudflareStreams(decorateWorkersAiPayloadStreams(openAICompletionsApi()))),
      ),
      options.apiKey && options.accountId ? options.apiKey : undefined,
    ),
  });
}

/**
 * A direct call (a stateless classifier or visual check) skips Pi's auth
 * step, so this deployment-funded lane applies its own token as that step
 * would. It is a standalone lane: a deployment serving many installations
 * refuses it at the provider proxy.
 */
function withDeploymentToken(streams: ProviderStreams, apiKey: string | undefined): ProviderStreams {
  if (!apiKey) return streams;
  return {
    stream: (model, context, options) =>
      streams.stream(model, context, { ...options, apiKey: options?.apiKey ?? apiKey }),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, { ...options, apiKey: options?.apiKey ?? apiKey }),
  };
}

/** The offline verifiers' stub. Its key arrives per request, like a keyed provider's. */
export function setLocalStubPiProvider(options: {
  baseUrl: string;
  modelIds: readonly string[];
}): void {
  const models: Model<'openai-completions'>[] = [...new Set(options.modelIds)].map(
    (modelId) => ({
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      provider: 'local-stub',
      baseUrl: options.baseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: 2_048,
    }),
  );
  registerPiProvider(
    createProvider({
      id: 'local-stub',
      name: 'Local stub',
      auth: modelAccessAuth('Local stub'),
      models,
      api: decorateAttachmentProviderStreams(openAICompletionsApi()),
    }),
  );
}

/**
 * Build a custom Pi provider while keeping its auth policy uniform. A lane
 * that brings its own boundary credential passes `apiKey`; without one the
 * provider is credential-free and takes the run's model access per request.
 */
export function createChickpeaPiProvider<TApi extends Api>(options: {
  id: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  models: readonly Model<TApi>[];
  api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}): Provider<TApi> {
  const name = options.name ?? options.id;
  return createProvider({
    id: options.id,
    ...(options.name ? { name: options.name } : {}),
    auth: options.apiKey
      ? selectedApiKeyAuth(name, {
          apiKey: options.apiKey,
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        })
      : modelAccessAuth(name),
    models: withProviderBaseUrl(options.models, options.baseUrl),
    api: decorateAttachmentProviderApi(options.api),
  });
}

function decorateAttachmentProviderApi<TApi extends Api>(
  api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>,
): ProviderStreams | Partial<Record<TApi, ProviderStreams>> {
  if ('stream' in api && typeof api.stream === 'function') {
    return decorateAttachmentProviderStreams(api as ProviderStreams);
  }
  return Object.fromEntries(
    Object.entries(api).map(([id, streams]) => [
      id,
      streams ? decorateAttachmentProviderStreams(streams as ProviderStreams) : streams,
    ]),
  ) as Partial<Record<TApi, ProviderStreams>>;
}

function selectedApiKeyAuth(name: string, credential: PiProviderCredential) {
  return {
    apiKey: {
      name: `${name} API key`,
      resolve: async () =>
        credential.apiKey
          ? {
              auth: {
                apiKey: credential.apiKey,
                ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}),
              },
              source: 'Chickpea provider policy',
            }
          : undefined,
    },
  };
}

/**
 * Configured, and never a key: Pi's keyless shape, so a request reaches the
 * provider proxy, which injects the run's access or refuses the request.
 */
function modelAccessAuth(name: string) {
  return {
    apiKey: {
      name: `${name} API key`,
      resolve: async () => ({ auth: {}, source: 'Chickpea model access' }),
    },
  };
}

function withProviderBaseUrl<TApi extends Api>(
  models: readonly Model<TApi>[],
  baseUrl: string | undefined,
): Model<TApi>[] {
  return models.map((model) => (baseUrl ? { ...model, baseUrl } : model));
}

const BUILTIN_API_STREAMS: Partial<Record<Api, () => ProviderStreams>> = {
  'anthropic-messages': anthropicMessagesApi,
  'openai-responses': openAIResponsesApi,
  'openai-completions': openAICompletionsApi,
};

/**
 * Streams for a resolved model without pi-ai's compat dispatcher. The
 * registered app provider wins (it carries Chickpea's model access and
 * attachment policy); a built-in catalog provider Flue registered at boot
 * falls back to the matching API implementation. A provider that takes the
 * run's model access is never reached around the proxy.
 */
export function providerStreamsForModel(model: Model<Api>): ProviderStreams {
  const registered = registeredPiProvider(model.provider);
  if (registered) return registered;
  if (modelAccessProviderId(model.provider)) {
    throw new Error(`Model provider ${model.provider} is not registered.`);
  }
  const api = BUILTIN_API_STREAMS[model.api];
  if (!api) {
    throw new Error(`No API implementation is bundled for "${model.api}" (${model.provider}/${model.id}).`);
  }
  return api();
}
