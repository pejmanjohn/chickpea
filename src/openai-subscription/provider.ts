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
  stream as streamCodex,
  streamSimple as streamSimpleCodex,
  type OpenAICodexResponsesOptions,
} from '@earendil-works/pi-ai/api/openai-codex-responses';

import { recordRegisteredProvider } from '../config/providers.ts';
import { createChickpeaPiProvider } from '../config/pi-provider.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  openAiSubscriptionCredentialsAreCurrent,
  recordOpenAiSubscriptionAuthenticationFailure,
  resolveOpenAiSubscriptionCredentials,
  type ResolvedOpenAiSubscriptionCredentials,
} from './credentials.ts';
import { OpenAiSubscriptionError } from './errors.ts';
import {
  listOpenAiSubscriptionModels,
} from './model-catalog.ts';
import {
  catalogModelForLane,
  materializeCatalogModel,
  type ActiveModelCatalogRoute,
} from '../model-catalog/index.ts';
import {
  isSafeOpenAiSubscriptionModelId,
  OPENAI_SUBSCRIPTION_API_BASE,
} from './protocol.ts';
import {
  bindOpenAiSubscriptionTransport,
  clearOpenAiSubscriptionTransport,
  createOpenAiSubscriptionTransportMarker,
  openAiSubscriptionCredentialEpoch,
  OPENAI_SUBSCRIPTION_TRANSPORT_MARKER,
  openAiSubscriptionTransportRevision,
} from './transport.ts';

export const OPENAI_SUBSCRIPTION_PROVIDER_ID = 'openai-subscription';
export const OPENAI_SUBSCRIPTION_API = 'chickpea-openai-subscription-responses';

const SUBSCRIPTION_MODELS = listOpenAiSubscriptionModels();
const SUBSCRIPTION_MODELS_BY_ID = new Map(
  SUBSCRIPTION_MODELS.map((model) => [model.id, model]),
);
const registeredRevisionApis = new Set<string>();

const BOUNDARY_MANAGED_TOKEN =
  'eyJhbGciOiJub25lIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYm91bmRhcnktbWFuYWdlZCJ9fQ.';
const SAFE_ERROR_CODES = new Set([
  'auth_reconnect_required',
  'client_rejected',
  'entitlement_denied',
  'invalid_response',
  'originator_rejected',
  'protocol_drift',
  'provider_unavailable',
  'request_timeout',
  'subscription_quota_exhausted',
  'unsupported_model',
]);

interface CapturedSubscriptionRegistration {
  providerId: string;
  api: string;
  models: readonly Model<string>[];
}

const BUNDLED_SUBSCRIPTION_REGISTRATION: CapturedSubscriptionRegistration = Object.freeze({
  api: OPENAI_SUBSCRIPTION_API,
  providerId: OPENAI_SUBSCRIPTION_PROVIDER_ID,
  models: freezeModels(compileBundledSubscriptionModels()),
});
const hostedSubscriptionRegistrations = new Map<string, CapturedSubscriptionRegistration>();
const subscriptionTransportMarkers = new Map<string, string>();
const boundSubscriptionProviders = new Map<string, ReturnType<typeof createChickpeaPiProvider>>();
const MAX_HOSTED_SUBSCRIPTION_REGISTRATIONS = 16;

export interface BindOpenAiSubscriptionProviderOptions {
  settings: SettingsStore;
  now?: () => number;
  modelId?: string;
  route?: ActiveModelCatalogRoute;
}

export function registerOpenAiSubscriptionApi(): void {
  registerCapturedSubscriptionApi(BUNDLED_SUBSCRIPTION_REGISTRATION);
}

export async function bindOpenAiSubscriptionProvider(
  options: BindOpenAiSubscriptionProviderOptions,
): Promise<void> {
  const route = options.route;
  if (
    options.modelId &&
    (!isSafeOpenAiSubscriptionModelId(options.modelId) ||
      (route ? route.model.id !== options.modelId : !SUBSCRIPTION_MODELS_BY_ID.has(options.modelId)))
  ) {
    throw new OpenAiSubscriptionError('unsupported_model');
  }
  if (route && route.lane !== 'openai_subscription') {
    throw new OpenAiSubscriptionError('unsupported_model');
  }
  const registration = subscriptionRegistration(route);
  const initialTransportRevision = openAiSubscriptionTransportRevision();
  let credentials: ResolvedOpenAiSubscriptionCredentials;
  try {
    credentials = await resolveOpenAiSubscriptionCredentials({
      settings: options.settings,
      ...(options.now ? { now: options.now } : {}),
    });
  } catch (error) {
    clearOpenAiSubscriptionTransport(initialTransportRevision);
    throw error;
  }
  const expectedCredentialEpoch = openAiSubscriptionCredentialEpoch();
  if (!await openAiSubscriptionCredentialsAreCurrent(
    options.settings,
    credentials,
  )) {
    throw new OpenAiSubscriptionError('auth_reconnect_required');
  }
  const marker = createOpenAiSubscriptionTransportMarker();
  bindOpenAiSubscriptionTransport({
    accessToken: credentials.accessToken,
    accountId: credentials.accountId,
  }, {
    expectedCredentialEpoch,
    marker,
    allowedModels: new Set(registration.models.map((model) => model.id)),
    onAuthenticationFailure: async () => {
      await recordOpenAiSubscriptionAuthenticationFailure(options.settings, {
        credentials,
        ...(options.now ? { now: options.now } : {}),
      });
    },
  });
  subscriptionTransportMarkers.set(registration.api, marker);
  const piProvider = createChickpeaPiProvider({
    id: registration.providerId,
    name: 'OpenAI subscription',
    baseUrl: OPENAI_SUBSCRIPTION_API_BASE,
    apiKey: BOUNDARY_MANAGED_TOKEN,
    models: registration.models.map((model) => ({
      ...model,
      provider: registration.providerId,
      api: registration.api,
    })),
    api: subscriptionStreams(registration),
  });
  boundSubscriptionProviders.set(registration.providerId, piProvider);
  setProvider(piProvider);
  recordRegisteredProvider(OPENAI_SUBSCRIPTION_PROVIDER_ID);
}

export function openAiSubscriptionModelSpecifier(
  model: string,
  route?: ActiveModelCatalogRoute,
): string {
  if (!isSafeOpenAiSubscriptionModelId(model)) {
    throw new OpenAiSubscriptionError('unsupported_model');
  }
  return `${subscriptionRegistration(route).providerId}/${model}`;
}

export function isOpenAiSubscriptionProviderId(providerId: string): boolean {
  return providerId === OPENAI_SUBSCRIPTION_PROVIDER_ID ||
    /^chickpea-openai-subscription-r[1-9][0-9]*-[a-f0-9]{12}$/.test(providerId);
}

/** Test seam for the provider-owned stream Flue 2 installs by id. */
export function getBoundOpenAiSubscriptionProviderForTests(providerId: string) {
  return boundSubscriptionProviders.get(providerId);
}

function subscriptionRegistration(
  route?: ActiveModelCatalogRoute,
): CapturedSubscriptionRegistration {
  if (!route || route.snapshot.source === 'bundled') {
    return BUNDLED_SUBSCRIPTION_REGISTRATION;
  }
  const suffix = `r${route.snapshot.revision}-${route.snapshot.sha256.slice(0, 12)}`;
  const cached = hostedSubscriptionRegistrations.get(suffix);
  if (cached) return cached;
  if (hostedSubscriptionRegistrations.size >= MAX_HOSTED_SUBSCRIPTION_REGISTRATIONS) {
    throw new Error('OpenAI subscription catalog activation requires a restart.');
  }
  const models = route.snapshot.entries.flatMap((entry) =>
    entry.lanes.openai_subscription
      ? [materializeCatalogModel(entry, 'openai_subscription')]
      : []
  );
  const registration: CapturedSubscriptionRegistration = Object.freeze({
    providerId: `chickpea-openai-subscription-${suffix}`,
    api: `chickpea-openai-subscription-responses-${suffix}`,
    models: freezeModels(models),
  });
  hostedSubscriptionRegistrations.set(suffix, registration);
  return registration;
}

function compileBundledSubscriptionModels(): Model<string>[] {
  return SUBSCRIPTION_MODELS.map((model) => {
    const compiled = catalogModelForLane(`openai/${model.id}`, 'openai_subscription', {
      nativeFirst: false,
    });
    if (!compiled) throw new Error(`Missing bundled subscription model ${model.id}.`);
    return compiled;
  });
}

function freezeModels(models: readonly Model<string>[]): readonly Model<string>[] {
  return Object.freeze(models.map((model) => Object.freeze(structuredClone(model))));
}

function registerCapturedSubscriptionApi(
  registration: CapturedSubscriptionRegistration,
): void {
  // Kept as an idempotent compatibility seam for startup callers. In Flue 2
  // the API implementation is installed with the bound Pi Provider below.
  registeredRevisionApis.add(registration.api);
}

function subscriptionStreams(
  registration: CapturedSubscriptionRegistration,
): ProviderStreams {
  const captured = Object.freeze({
    ...registration,
    models: freezeModels(registration.models),
  });
  return {
    stream: (model, context, streamOptions) =>
      secureCodexStream(model, context, streamOptions, false, captured),
    streamSimple: (model, context, streamOptions) =>
      secureCodexStream(model, context, streamOptions, true, captured),
  };
}

function secureCodexStream(
  model: Model<string>,
  context: Context,
  options: (StreamOptions & Record<string, unknown>) | SimpleStreamOptions | undefined,
  simple: boolean,
  registration: CapturedSubscriptionRegistration,
): AssistantMessageEventStream {
  const codexModel = capturedCatalogModel(model, registration.models);
  const marker = subscriptionTransportMarkers.get(registration.api);
  if (!marker) throw new OpenAiSubscriptionError('auth_reconnect_required');
  const secureOptions = secureStreamOptions(options, marker);
  const mappedContext = {
    ...context,
    messages: context.messages.map((message) =>
      message.role === 'assistant' && message.provider === registration.providerId
        ? { ...message, provider: 'openai-codex' }
        : message,
    ),
  };
  const source = simple
    ? streamSimpleCodex(codexModel, mappedContext, secureOptions)
    : streamCodex(codexModel, mappedContext, secureOptions);
  return rewriteAndSanitizeStream(source, registration.providerId, registration.api);
}

function capturedCatalogModel(
  model: Model<string>,
  models: readonly Model<string>[],
): Model<'openai-codex-responses'> {
  if (!isSafeOpenAiSubscriptionModelId(model.id)) {
    throw new OpenAiSubscriptionError('unsupported_model');
  }
  const catalogModel = models.find((candidate) => candidate.id === model.id);
  if (!catalogModel) throw new OpenAiSubscriptionError('unsupported_model');
  const contextWindow = catalogModel.contextWindow;
  const maxTokens = catalogModel.maxTokens;
  if (!Number.isInteger(contextWindow) || contextWindow <= 0 ||
      !Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > contextWindow) {
    throw new OpenAiSubscriptionError('protocol_drift');
  }
  return { ...catalogModel, contextWindow, maxTokens } as Model<'openai-codex-responses'>;
}

function secureStreamOptions(
  options: (StreamOptions & Record<string, unknown>) | SimpleStreamOptions | undefined,
  marker: string,
): OpenAICodexResponsesOptions & SimpleStreamOptions {
  const values = (options ?? {}) as Record<string, unknown>;
  return {
    apiKey: BOUNDARY_MANAGED_TOKEN,
    transport: 'sse',
    maxRetries: 0,
    headers: { [OPENAI_SUBSCRIPTION_TRANSPORT_MARKER]: marker },
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(typeof options?.temperature === 'number' ? { temperature: options.temperature } : {}),
    ...(typeof options?.maxTokens === 'number' ? { maxTokens: options.maxTokens } : {}),
    ...(typeof options?.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
    ...(isThinkingLevel(values.reasoning)
      ? { reasoning: values.reasoning }
      : {}),
    ...(isReasoningEffort(values.reasoningEffort)
      ? { reasoningEffort: values.reasoningEffort }
      : {}),
    ...(isReasoningSummary(values.reasoningSummary)
      ? { reasoningSummary: values.reasoningSummary }
      : {}),
    ...(isTextVerbosity(values.textVerbosity)
      ? { textVerbosity: values.textVerbosity }
      : {}),
  };
}

function rewriteAndSanitizeStream(
  source: AssistantMessageEventStream,
  providerId: string,
  api: string,
): AssistantMessageEventStream {
  const target = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        target.push(rewriteEvent(event, providerId));
      }
    } catch {
      target.push(safeErrorEvent(providerId, api));
    } finally {
      target.end();
    }
  })();
  return target;
}

function rewriteEvent(
  event: AssistantMessageEvent,
  providerId: string,
): AssistantMessageEvent {
  if (event.type === 'done') {
    return { ...event, message: safeMessage(event.message, providerId) };
  }
  if (event.type === 'error') {
    return {
      ...event,
      error: safeMessage(event.error, providerId, safeErrorCode(event.error.errorMessage)),
    };
  }
  return { ...event, partial: safeMessage(event.partial, providerId) };
}

function safeMessage(
  message: AssistantMessage,
  providerId: string,
  errorCode?: string,
): AssistantMessage {
  const { diagnostics: _diagnostics, errorMessage: _errorMessage, ...safe } = message;
  return {
    ...safe,
    provider: providerId,
    ...(errorCode
      ? { errorMessage: `OpenAI subscription operation failed (${errorCode}).` }
      : {}),
  };
}

function isThinkingLevel(value: unknown): value is NonNullable<SimpleStreamOptions['reasoning']> {
  return typeof value === 'string' && ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value);
}

function safeErrorEvent(providerId: string, api: string): AssistantMessageEvent {
  return {
    type: 'error',
    reason: 'error',
    error: {
      role: 'assistant',
      content: [],
      api,
      provider: providerId,
      model: 'unknown',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'error',
      errorMessage: 'OpenAI subscription operation failed (provider_unavailable).',
      timestamp: Date.now(),
    },
  };
}

function safeErrorCode(message: string | undefined): string {
  const match = message?.match(/OpenAI subscription operation failed \(([a-z_]+)\)\./);
  const code = match?.[1];
  return code && SAFE_ERROR_CODES.has(code) ? code : 'provider_unavailable';
}

function isReasoningEffort(value: unknown): value is NonNullable<OpenAICodexResponsesOptions['reasoningEffort']> {
  return typeof value === 'string' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value);
}

function isReasoningSummary(value: unknown): value is NonNullable<OpenAICodexResponsesOptions['reasoningSummary']> {
  return typeof value === 'string' && ['auto', 'concise', 'detailed', 'off', 'on'].includes(value);
}

function isTextVerbosity(value: unknown): value is NonNullable<OpenAICodexResponsesOptions['textVerbosity']> {
  return typeof value === 'string' && ['low', 'medium', 'high'].includes(value);
}
