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
import { registerPiProvider, registeredPiProvider } from './pi-provider-registry.ts';

import { decorateAttachmentProviderStreams } from '../slack/attachment-model-context.ts';
import { decorateWorkersAiPayloadStreams } from './workers-ai-payload.ts';
import {
  isWorkersAiGlmModel,
  withCurrentWorkersAiModels,
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

/**
 * Replace one generated catalog provider with an app-owned Pi provider whose
 * auth resolver carries the credential selected at Chickpea's policy seam.
 * Replacing by id is intentional: deleting a browser-saved key must also
 * clear that key from a warm isolate instead of leaving the previous provider
 * object reachable.
 */
export function setBuiltinPiProvider(
  id: PiBuiltinProviderId,
  credential: PiProviderCredential,
  modelOverlays: readonly Model<Api>[] = [],
): void {
  const parts = BUILTIN_PROVIDER_PARTS[id];
  const catalog = parts.provider();
  const models = withProviderBaseUrl(
    mergeProviderModels(catalog.getModels(), modelOverlays),
    credential.baseUrl,
  );
  registerPiProvider(
    createProvider({
      id,
      name: catalog.name,
      auth: selectedApiKeyAuth(catalog.name, credential),
      models,
      api: decorateAttachmentProviderStreams(parts.api()),
    }),
  );
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
          contextWindow: Math.min(model.contextWindow, options.contextWindowFloor),
          maxTokens: Math.min(model.maxTokens, options.maxTokens),
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
    api: decorateAttachmentProviderStreams(
      cloudflareStreams(decorateWorkersAiPayloadStreams(openAICompletionsApi())),
    ),
  });
}

export function setLocalStubPiProvider(options: {
  baseUrl: string;
  apiKey: string;
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
      auth: selectedApiKeyAuth('Local stub', {
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
      }),
      models,
      api: decorateAttachmentProviderStreams(openAICompletionsApi()),
    }),
  );
}

/** Build a custom Pi provider while keeping its auth policy uniform. */
export function createChickpeaPiProvider<TApi extends Api>(options: {
  id: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  models: readonly Model<TApi>[];
  api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}): Provider<TApi> {
  return createProvider({
    id: options.id,
    ...(options.name ? { name: options.name } : {}),
    auth: selectedApiKeyAuth(options.name ?? options.id, {
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    }),
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
 * registered app provider wins (it carries Chickpea's auth and attachment
 * policy); a built-in catalog provider Flue registered at boot falls back to
 * the matching API implementation, which reads `options.apiKey` directly.
 */
export function providerStreamsForModel(model: Model<Api>): ProviderStreams {
  const registered = registeredPiProvider(model.provider);
  if (registered) return registered;
  const api = BUILTIN_API_STREAMS[model.api];
  if (!api) {
    throw new Error(`No API implementation is bundled for "${model.api}" (${model.provider}/${model.id}).`);
  }
  return api();
}
