import { registerModelCompatibilityApis } from './model-compat/provider.ts';
import { registerOpenAiSubscriptionApi } from './openai-subscription/provider.ts';
import {
  setBuiltinPiProvider,
  setLocalStubPiProvider,
  setWorkersAiRestPiProvider,
} from './config/pi-provider.ts';
import { recordRegisteredProvider } from './config/providers.ts';

export const WORKERS_AI_CONTEXT_WINDOW_FLOOR = 32_768;

let bootstrapped = false;

/**
 * Install app-owned Pi providers exactly once in this module graph. Both the
 * application router and directly executed agent modules call this function,
 * so `flue run src/agents/...` has the same provider surface as Vite.
 */
export function bootstrapRuntimeProviders(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  const workersAiBaseUrl =
    process.env.CLOUDFLARE_WORKERS_AI_BASE_URL ||
    `https://api.cloudflare.com/client/v4/accounts/${
      process.env.CLOUDFLARE_ACCOUNT_ID || '{CLOUDFLARE_ACCOUNT_ID}'
    }/ai/v1`;
  setWorkersAiRestPiProvider({
    baseUrl: workersAiBaseUrl,
    ...(process.env.CLOUDFLARE_API_TOKEN
      ? { apiKey: process.env.CLOUDFLARE_API_TOKEN }
      : {}),
    ...(process.env.CLOUDFLARE_ACCOUNT_ID
      ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID }
      : {}),
    contextWindowFloor: WORKERS_AI_CONTEXT_WINDOW_FLOOR,
    maxTokens: 2_048,
  });
  recordRegisteredProvider('cloudflare-workers-ai');

  registerModelCompatibilityApis();
  registerOpenAiSubscriptionApi();

  for (const [id, apiKey, baseUrl] of [
    ['anthropic', process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_BASE_URL],
    ['openai', process.env.OPENAI_API_KEY, process.env.OPENAI_BASE_URL],
    ['openrouter', process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_BASE_URL],
  ] as const) {
    setBuiltinPiProvider(id, {
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });
    if (apiKey || baseUrl) recordRegisteredProvider(id);
  }

  if (process.env.LOCAL_STUB_URL) {
    const configuredModel = process.env.SLACK_TAG_MODEL?.startsWith('local-stub/')
      ? process.env.SLACK_TAG_MODEL.slice('local-stub/'.length)
      : 'model';
    setLocalStubPiProvider({
      baseUrl: process.env.LOCAL_STUB_URL,
      apiKey: process.env.LOCAL_STUB_API_KEY ?? 'offline-stub-key',
      modelId: configuredModel,
    });
    recordRegisteredProvider('local-stub');
  }
}

export function resetRuntimeBootstrapForTests(): void {
  bootstrapped = false;
}
