import { registerApiProvider, registerProvider } from '@flue/runtime';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import {
  stream as streamCodex,
  streamSimple as streamSimpleCodex,
  type OpenAICodexResponsesOptions,
} from '@earendil-works/pi-ai/api/openai-codex-responses';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';

import { recordRegisteredProvider } from '../config/providers.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  recordOpenAiSubscriptionAuthenticationFailure,
  resolveOpenAiSubscriptionCredentials,
} from './credentials.ts';
import { OpenAiSubscriptionError } from './errors.ts';
import {
  isOpenAiSubscriptionModel,
  OPENAI_SUBSCRIPTION_MODELS,
} from './protocol.ts';
import {
  bindOpenAiSubscriptionTransport,
  clearOpenAiSubscriptionTransport,
  OPENAI_SUBSCRIPTION_TRANSPORT_MARKER,
} from './transport.ts';

export const OPENAI_SUBSCRIPTION_PROVIDER_ID = 'openai-subscription';
export const OPENAI_SUBSCRIPTION_API = 'chickpea-openai-subscription-responses';

const BOUNDARY_MANAGED_TOKEN =
  'eyJhbGciOiJub25lIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYm91bmRhcnktbWFuYWdlZCJ9fQ.';
const CATALOG_MODELS = getBuiltinModels('openai-codex');
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

export interface BindOpenAiSubscriptionProviderOptions {
  settings: SettingsStore;
  now?: () => number;
}

export function registerOpenAiSubscriptionApi(): void {
  registerApiProvider({
    api: OPENAI_SUBSCRIPTION_API,
    stream: (model, context, streamOptions) =>
      secureCodexStream(model, context, streamOptions, false),
    streamSimple: (model, context, streamOptions) =>
      secureCodexStream(model, context, streamOptions, true),
  });
}

export async function bindOpenAiSubscriptionProvider(
  options: BindOpenAiSubscriptionProviderOptions,
): Promise<void> {
  let credentials: { accessToken: string; accountId: string };
  try {
    credentials = await resolveOpenAiSubscriptionCredentials({
      settings: options.settings,
      ...(options.now ? { now: options.now } : {}),
    });
  } catch (error) {
    clearOpenAiSubscriptionTransport();
    throw error;
  }
  bindOpenAiSubscriptionTransport(credentials, {
    onAuthenticationFailure: async () => {
      await recordOpenAiSubscriptionAuthenticationFailure(options.settings, {
        ...(options.now ? { now: options.now } : {}),
      });
    },
  });
  registerOpenAiSubscriptionApi();
  registerProvider(OPENAI_SUBSCRIPTION_PROVIDER_ID, {
    api: OPENAI_SUBSCRIPTION_API,
    baseUrl: 'https://chatgpt.com/backend-api',
    apiKey: BOUNDARY_MANAGED_TOKEN,
    models: Object.fromEntries(
      CATALOG_MODELS.map((model) => [
        model.id,
        { contextWindow: model.contextWindow, maxTokens: model.maxTokens },
      ]),
    ),
    telemetry: {
      providerName: 'openai_subscription',
      serverAddress: 'chatgpt.com',
      serverPort: 443,
    },
  });
  recordRegisteredProvider(OPENAI_SUBSCRIPTION_PROVIDER_ID);
}

export function openAiSubscriptionModelSpecifier(model: string): string {
  if (!isOpenAiSubscriptionModel(model)) {
    throw new OpenAiSubscriptionError('unsupported_model');
  }
  return `${OPENAI_SUBSCRIPTION_PROVIDER_ID}/${model}`;
}

function secureCodexStream(
  model: Model<string>,
  context: Context,
  options: (StreamOptions & Record<string, unknown>) | SimpleStreamOptions | undefined,
  simple: boolean,
): AssistantMessageEventStream {
  const codexModel = catalogModel(model.id);
  const secureOptions = secureStreamOptions(options);
  const mappedContext = {
    ...context,
    messages: context.messages.map((message) =>
      message.role === 'assistant' && message.provider === OPENAI_SUBSCRIPTION_PROVIDER_ID
        ? { ...message, provider: 'openai-codex' }
        : message,
    ),
  };
  const source = simple
    ? streamSimpleCodex(codexModel, mappedContext, secureOptions)
    : streamCodex(codexModel, mappedContext, secureOptions);
  return rewriteAndSanitizeStream(source);
}

function catalogModel(modelId: string): Model<'openai-codex-responses'> {
  if (!(OPENAI_SUBSCRIPTION_MODELS as readonly string[]).includes(modelId)) {
    throw new OpenAiSubscriptionError('unsupported_model');
  }
  const model = CATALOG_MODELS.find((candidate) => candidate.id === modelId);
  if (!model || model.baseUrl !== 'https://chatgpt.com/backend-api') {
    throw new OpenAiSubscriptionError('protocol_drift');
  }
  return model;
}

function secureStreamOptions(
  options: (StreamOptions & Record<string, unknown>) | SimpleStreamOptions | undefined,
): OpenAICodexResponsesOptions & SimpleStreamOptions {
  const values = (options ?? {}) as Record<string, unknown>;
  return {
    apiKey: BOUNDARY_MANAGED_TOKEN,
    transport: 'sse',
    maxRetries: 0,
    headers: { [OPENAI_SUBSCRIPTION_TRANSPORT_MARKER]: 'v1' },
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

function rewriteAndSanitizeStream(source: AssistantMessageEventStream): AssistantMessageEventStream {
  const target = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        target.push(rewriteEvent(event));
      }
    } catch {
      target.push(safeErrorEvent());
    } finally {
      target.end();
    }
  })();
  return target;
}

function rewriteEvent(event: AssistantMessageEvent): AssistantMessageEvent {
  if (event.type === 'done') {
    return { ...event, message: safeMessage(event.message) };
  }
  if (event.type === 'error') {
    return {
      ...event,
      error: safeMessage(event.error, safeErrorCode(event.error.errorMessage)),
    };
  }
  return { ...event, partial: safeMessage(event.partial) };
}

function safeMessage(message: AssistantMessage, errorCode?: string): AssistantMessage {
  const { diagnostics: _diagnostics, errorMessage: _errorMessage, ...safe } = message;
  return {
    ...safe,
    provider: OPENAI_SUBSCRIPTION_PROVIDER_ID,
    ...(errorCode
      ? { errorMessage: `OpenAI subscription operation failed (${errorCode}).` }
      : {}),
  };
}

function isThinkingLevel(value: unknown): value is NonNullable<SimpleStreamOptions['reasoning']> {
  return typeof value === 'string' && ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value);
}

function safeErrorEvent(): AssistantMessageEvent {
  return {
    type: 'error',
    reason: 'error',
    error: {
      role: 'assistant',
      content: [],
      api: OPENAI_SUBSCRIPTION_API,
      provider: OPENAI_SUBSCRIPTION_PROVIDER_ID,
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
