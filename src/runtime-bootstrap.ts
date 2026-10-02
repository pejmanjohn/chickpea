import { registerModelCompatibilityApis } from './model-compat/provider.ts';
import { registerOpenAiSubscriptionApi } from './openai-subscription/provider.ts';
import {
  registerBuiltinPiProvider,
  setLocalStubPiProvider,
  setWorkersAiRestPiProvider,
} from './config/pi-provider.ts';
import { installationModelAccessResolver } from './config/installation-model-access.ts';
import { configureModelAccessResolver, modelAccessResolverConfigured } from './config/model-access.ts';
import { PROVIDER_KEY_IDS } from './config/provider-keys.ts';
import { recordRegisteredProvider } from './config/providers.ts';
import { openAiSubscriptionAvailable } from './openai-subscription/availability.ts';
import { WORKERS_AI_CONTEXT_WINDOW_FLOOR, WORKERS_AI_REASONING_MAX_TOKENS } from './config/workers-ai-models.ts';

export { WORKERS_AI_CONTEXT_WINDOW_FLOOR };

let bootstrapped = false;

/**
 * Install app-owned Pi providers exactly once in this module graph. Both the
 * application router and directly executed agent modules call this function,
 * so `flue run src/agents/...` has the same provider surface as Vite.
 *
 * The key-backed providers are registered without credentials: each request
 * carries its run's model access (config/model-access.ts), resolved by Core's
 * resolver unless the composing host installed its own first.
 */
export function bootstrapRuntimeProviders(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  if (!modelAccessResolverConfigured()) configureModelAccessResolver(installationModelAccessResolver);

  // Deployment-funded lane: a deployment serving many installations refuses it.
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
    maxTokens: WORKERS_AI_REASONING_MAX_TOKENS,
  });
  recordRegisteredProvider('cloudflare-workers-ai');

  registerModelCompatibilityApis();
  if (openAiSubscriptionAvailable()) registerOpenAiSubscriptionApi();

  for (const id of PROVIDER_KEY_IDS) registerBuiltinPiProvider(id);

  if (process.env.LOCAL_STUB_URL) {
    const configuredModel = process.env.SLACK_TAG_MODEL?.startsWith('local-stub/')
      ? process.env.SLACK_TAG_MODEL.slice('local-stub/'.length)
      : 'model';
    const configuredModels = (process.env.LOCAL_STUB_MODELS ?? '')
      .split(',')
      .map((model) => model.trim())
      .filter((model) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(model));
    setLocalStubPiProvider({
      baseUrl: process.env.LOCAL_STUB_URL,
      modelIds: [configuredModel, ...configuredModels],
    });
    recordRegisteredProvider('local-stub');
  }
}
