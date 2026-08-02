import { setProvider } from '@flue/runtime';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import {
  stream as streamAnthropic,
  streamSimple as streamSimpleAnthropic,
  type AnthropicOptions,
} from '@earendil-works/pi-ai/api/anthropic-messages';
import {
  stream as streamOpenAi,
  streamSimple as streamSimpleOpenAi,
  type OpenAIResponsesOptions,
} from '@earendil-works/pi-ai/api/openai-responses';

import {
  catalogModelForLane,
  listBundledCatalogModels,
} from '../model-catalog/bundled.ts';
import type { CatalogProviderId, ModelAuthLane } from '../model-catalog/types.ts';
import { createChickpeaPiProvider } from '../config/pi-provider.ts';

export const OPENAI_PLATFORM_COMPAT_PROVIDER_ID = 'chickpea-openai-platform-bundled-v1';
export const ANTHROPIC_COMPAT_PROVIDER_ID = 'chickpea-anthropic-api-bundled-v1';
export const OPENAI_PLATFORM_COMPAT_API = 'chickpea-openai-platform-responses-bundled-v1';
export const ANTHROPIC_COMPAT_API = 'chickpea-anthropic-messages-bundled-v1';

type ApiKeyCompatibilityProvider = Extract<CatalogProviderId, 'anthropic' | 'openai'>;
type ApiKeyCompatibilityLane = Extract<
  ModelAuthLane,
  'anthropic_api_key' | 'openai_api_key'
>;

interface CapturedCompatibilityRegistration {
  provider: ApiKeyCompatibilityProvider;
  lane: ApiKeyCompatibilityLane;
  providerId: string;
  api: string;
  models: readonly Model<string>[];
  resolveModel: (canonicalModel: string, lane: ApiKeyCompatibilityLane) =>
    Model<string> | undefined;
}

interface BoundCompatibilityCredential {
  apiKey?: string;
  baseUrl?: string;
}

const capturedRegistrations = new Map<string, CapturedCompatibilityRegistration>();
const boundCredentials = new Map<ApiKeyCompatibilityProvider, BoundCompatibilityCredential>();

export interface ModelCompatibilityStreamAdapters {
  openAiStream?: typeof streamOpenAi;
  openAiStreamSimple?: typeof streamSimpleOpenAi;
  anthropicStream?: typeof streamAnthropic;
  anthropicStreamSimple?: typeof streamSimpleAnthropic;
  /** Captured snapshot resolver for a revisioned hosted route. */
  resolveModel?: (
    canonicalModel: string,
    lane: ApiKeyCompatibilityLane,
  ) => Model<string> | undefined;
  /** Captured route for aliases other than the immutable bundled-v1 aliases. */
  route?: {
    provider: ApiKeyCompatibilityProvider;
    lane: ApiKeyCompatibilityLane;
  };
}

export function registerModelCompatibilityApis(): void {
  // Flue 2 no longer has a process-global API registry. Each Pi Provider owns
  // its stream implementation and is installed when credentials are bound.
}

/**
 * Bind the same boundary-resolved key as the canonical provider under an
 * internal provider id. The key never enters catalog data or model metadata.
 */
export function bindModelCompatibilityProvider(
  provider: ApiKeyCompatibilityProvider,
  apiKey: string | undefined,
  options: { baseUrl?: string } = {},
): void {
  boundCredentials.set(provider, {
    ...(apiKey ? { apiKey } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
  registerModelCompatibilityApis();
  const lane = laneForProvider(provider);
  const models = listBundledCatalogModels(lane);
  const providerId = compatibilityProviderId(provider);
  const api = provider === 'openai' ? OPENAI_PLATFORM_COMPAT_API : ANTHROPIC_COMPAT_API;
  const baseUrl = options.baseUrl ?? models[0]?.baseUrl;
  if (!baseUrl) throw new Error(`No compiled compatibility models for ${provider}.`);
  setProvider(createChickpeaPiProvider({
    id: providerId,
    name: provider === 'openai' ? 'OpenAI compatibility' : 'Anthropic compatibility',
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    models: compatibilityModels(models, providerId, api),
    api: compatibilityStreams(),
  }));
  for (const registration of capturedRegistrations.values()) {
    if (registration.provider === provider) registerCapturedProviderBinding(registration);
  }
}

export function revisionedCompatibilityAliases(
  provider: ApiKeyCompatibilityProvider,
  revision: number,
  sha256: string,
): { providerId: string; api: string } {
  if (!Number.isSafeInteger(revision) || revision <= 0 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Invalid model catalog alias identity.');
  }
  const suffix = `r${revision}-${sha256.slice(0, 12)}`;
  return provider === 'openai'
    ? {
      providerId: `chickpea-openai-platform-${suffix}`,
      api: `chickpea-openai-platform-responses-${suffix}`,
    }
    : {
      providerId: `chickpea-anthropic-api-${suffix}`,
      api: `chickpea-anthropic-messages-${suffix}`,
    };
}

/** Register one immutable hosted alias whose stream closure owns its models. */
export function registerCapturedModelCompatibilityProvider(options: {
  provider: ApiKeyCompatibilityProvider;
  revision: number;
  sha256: string;
  models: readonly Model<string>[];
}): { providerId: string; api: string } | undefined {
  if (options.models.length === 0) return undefined;
  const lane = laneForProvider(options.provider);
  const aliases = revisionedCompatibilityAliases(options.provider, options.revision, options.sha256);
  const existing = capturedRegistrations.get(aliases.providerId);
  if (existing) return { providerId: existing.providerId, api: existing.api };
  const models = Object.freeze(options.models.map((model) => Object.freeze(structuredClone(model))));
  const byCanonical = new Map(models.map((model) => [
    `${options.provider}/${model.id}`,
    model,
  ]));
  const registration: CapturedCompatibilityRegistration = {
    provider: options.provider,
    lane,
    providerId: aliases.providerId,
    api: aliases.api,
    models,
    resolveModel: (canonicalModel, requestedLane) => {
      if (requestedLane !== lane) return undefined;
      const model = byCanonical.get(canonicalModel);
      return model ? structuredClone(model) : undefined;
    },
  };
  capturedRegistrations.set(aliases.providerId, registration);
  registerCapturedProviderBinding(registration);
  return aliases;
}

export function canonicalCompatibilityModel(model: string): string {
  const slash = model.indexOf('/');
  if (slash <= 0) return model;
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  if (isOpenAiCompatibilityProvider(provider)) {
    return `openai/${modelId}`;
  }
  if (isAnthropicCompatibilityProvider(provider)) {
    return `anthropic/${modelId}`;
  }
  return model;
}

export function isInternalCompatibilityProvider(provider: string): boolean {
  return isOpenAiCompatibilityProvider(provider) || isAnthropicCompatibilityProvider(provider);
}

export function isOpenAiPlatformCompatibilityProviderId(provider: string): boolean {
  return isOpenAiCompatibilityProvider(provider);
}

export function resetCapturedModelCompatibilityProvidersForTests(): void {
  capturedRegistrations.clear();
}

export function createModelCompatibilityStream(
  incomingModel: Model<string>,
  context: Context,
  options: StreamOptions | SimpleStreamOptions | undefined,
  simple: boolean,
  adapters: ModelCompatibilityStreamAdapters = {},
): AssistantMessageEventStream {
  const route = adapters.route ?? compatibilityRoute(incomingModel.provider);
  const compiled = (adapters.resolveModel ?? catalogModelForLane)(
    `${route.provider}/${incomingModel.id}`,
    route.lane,
  );
  if (!compiled) {
    throw new Error(`Model ${incomingModel.id} is not in the active compatibility catalog.`);
  }
  // The optional base URL is supplied only by Chickpea's trusted provider-key
  // boundary (for example ANTHROPIC_BASE_URL), never by catalog data.
  const adapterModel = {
    ...compiled,
    baseUrl: incomingModel.baseUrl,
  };
  const mappedContext = mapHistory(context, incomingModel.provider, compiled.provider, compiled.api);

  let source: AssistantMessageEventStream;
  if (route.provider === 'openai') {
    const model = adapterModel as Model<'openai-responses'>;
    source = simple
      ? (adapters.openAiStreamSimple ?? streamSimpleOpenAi)(
        model,
        mappedContext,
        options as SimpleStreamOptions | undefined,
      )
      : (adapters.openAiStream ?? streamOpenAi)(
        model,
        mappedContext,
        options as OpenAIResponsesOptions | undefined,
      );
  } else {
    const model = adapterModel as Model<'anthropic-messages'>;
    source = simple
      ? (adapters.anthropicStreamSimple ?? streamSimpleAnthropic)(
        model,
        mappedContext,
        options as SimpleStreamOptions | undefined,
      )
      : (adapters.anthropicStream ?? streamAnthropic)(
        model,
        mappedContext,
        options as AnthropicOptions | undefined,
      );
  }
  return rewriteStream(source, incomingModel);
}

function compatibilityProviderId(provider: ApiKeyCompatibilityProvider): string {
  return provider === 'openai'
    ? OPENAI_PLATFORM_COMPAT_PROVIDER_ID
    : ANTHROPIC_COMPAT_PROVIDER_ID;
}

function laneForProvider(
  provider: ApiKeyCompatibilityProvider,
): ApiKeyCompatibilityLane {
  return provider === 'openai' ? 'openai_api_key' : 'anthropic_api_key';
}

function compatibilityRoute(provider: string): {
  provider: ApiKeyCompatibilityProvider;
  lane: ApiKeyCompatibilityLane;
} {
  if (provider === OPENAI_PLATFORM_COMPAT_PROVIDER_ID) {
    return { provider: 'openai', lane: 'openai_api_key' };
  }
  if (provider === ANTHROPIC_COMPAT_PROVIDER_ID) {
    return { provider: 'anthropic', lane: 'anthropic_api_key' };
  }
  throw new Error(`Unknown model compatibility provider: ${provider}.`);
}

function registerCapturedProviderBinding(
  registration: CapturedCompatibilityRegistration,
): void {
  const credential = boundCredentials.get(registration.provider);
  const baseUrl = credential?.baseUrl ?? registration.models[0]?.baseUrl;
  if (!baseUrl) throw new Error(`No captured models for ${registration.provider}.`);
  setProvider(createChickpeaPiProvider({
    id: registration.providerId,
    name: registration.provider === 'openai'
      ? 'OpenAI captured compatibility'
      : 'Anthropic captured compatibility',
    ...(credential?.apiKey ? { apiKey: credential.apiKey } : {}),
    baseUrl,
    models: compatibilityModels(
      registration.models,
      registration.providerId,
      registration.api,
    ),
    api: compatibilityStreams({
      route: { provider: registration.provider, lane: registration.lane },
      resolveModel: registration.resolveModel,
    }),
  }));
}

function compatibilityModels(
  models: readonly Model<string>[],
  providerId: string,
  api: string,
): Model<string>[] {
  return models.map((model) => ({ ...model, provider: providerId, api }));
}

function compatibilityStreams(
  adapters: Pick<ModelCompatibilityStreamAdapters, 'route' | 'resolveModel'> = {},
): ProviderStreams {
  return {
    stream: (model, context, options) =>
      createModelCompatibilityStream(model, context, options, false, adapters),
    streamSimple: (model, context, options) =>
      createModelCompatibilityStream(model, context, options, true, adapters),
  };
}

function isOpenAiCompatibilityProvider(provider: string): boolean {
  return provider === OPENAI_PLATFORM_COMPAT_PROVIDER_ID ||
    /^chickpea-openai-platform-r[1-9][0-9]*-[a-f0-9]{12}$/.test(provider);
}

function isAnthropicCompatibilityProvider(provider: string): boolean {
  return provider === ANTHROPIC_COMPAT_PROVIDER_ID ||
    /^chickpea-anthropic-api-r[1-9][0-9]*-[a-f0-9]{12}$/.test(provider);
}

function mapHistory(
  context: Context,
  internalProvider: string,
  canonicalProvider: string,
  canonicalApi: string,
): Context {
  return {
    ...context,
    messages: context.messages.map((message) =>
      message.role === 'assistant' && message.provider === internalProvider
        ? { ...message, provider: canonicalProvider, api: canonicalApi }
        : message
    ),
  };
}

function rewriteStream(
  source: AssistantMessageEventStream,
  incomingModel: Model<string>,
): AssistantMessageEventStream {
  const target = createAssistantMessageEventStream();
  let latest: AssistantMessage | undefined;
  void (async () => {
    try {
      for await (const event of source) {
        const rewritten = rewriteEvent(event, incomingModel.provider, incomingModel.api);
        latest = eventMessage(rewritten);
        target.push(rewritten);
      }
    } catch {
      const failure = sanitizedStreamFailure(latest, incomingModel);
      target.push({ type: 'error', reason: 'error', error: failure });
      target.end(failure);
      return;
    }
    target.end();
  })();
  return target;
}

function eventMessage(event: AssistantMessageEvent): AssistantMessage {
  if (event.type === 'done') return event.message;
  if (event.type === 'error') return event.error;
  return event.partial;
}

function sanitizedStreamFailure(
  latest: AssistantMessage | undefined,
  incomingModel: Model<string>,
): AssistantMessage {
  return {
    role: 'assistant',
    content: latest?.content ?? [],
    api: incomingModel.api,
    provider: incomingModel.provider,
    model: incomingModel.id,
    usage: latest?.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: 'Model provider stream failed.',
    timestamp: Date.now(),
  };
}

function rewriteEvent(
  event: AssistantMessageEvent,
  provider: string,
  api: string,
): AssistantMessageEvent {
  if (event.type === 'done') {
    return { ...event, message: rewriteMessage(event.message, provider, api) };
  }
  if (event.type === 'error') {
    return { ...event, error: rewriteMessage(event.error, provider, api) };
  }
  return { ...event, partial: rewriteMessage(event.partial, provider, api) };
}

function rewriteMessage(
  message: AssistantMessage,
  provider: string,
  api: string,
): AssistantMessage {
  return { ...message, provider, api };
}
