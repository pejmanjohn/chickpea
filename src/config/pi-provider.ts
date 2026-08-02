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
import { setProvider } from '@flue/runtime';

export type PiBuiltinProviderId = 'anthropic' | 'openai' | 'openrouter';

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
): void {
  const parts = BUILTIN_PROVIDER_PARTS[id];
  const catalog = parts.provider();
  const models = withProviderBaseUrl(catalog.getModels(), credential.baseUrl);
  setProvider(
    createProvider({
      id,
      name: catalog.name,
      auth: selectedApiKeyAuth(catalog.name, credential),
      models,
      api: parts.api(),
    }),
  );
}

export function setWorkersAiRestPiProvider(options: {
  apiKey?: string;
  accountId?: string;
  baseUrl: string;
  contextWindowFloor: number;
  maxTokens: number;
}): void {
  const catalog = cloudflareWorkersAIProvider();
  const models = catalog.getModels().map((model) => ({
    ...model,
    baseUrl: options.baseUrl,
    ...(model.id === '@cf/zai-org/glm-5.2'
      ? {
          contextWindow: Math.min(model.contextWindow, options.contextWindowFloor),
          maxTokens: Math.min(model.maxTokens, options.maxTokens),
        }
      : {}),
  }));
  setProvider(
    createProvider({
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
      api: cloudflareStreams(openAICompletionsApi()),
    }),
  );
}

export function setLocalStubPiProvider(options: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}): void {
  const model: Model<'openai-completions'> = {
    id: options.modelId,
    name: options.modelId,
    api: 'openai-completions',
    provider: 'local-stub',
    baseUrl: options.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 2_048,
  };
  setProvider(
    createProvider({
      id: 'local-stub',
      name: 'Local stub',
      auth: selectedApiKeyAuth('Local stub', {
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
      }),
      models: [model],
      api: openAICompletionsApi(),
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
    api: options.api,
  });
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
