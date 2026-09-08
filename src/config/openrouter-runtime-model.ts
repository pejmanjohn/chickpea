import type { Api, Model } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';

import {
  hasBuiltinProviderModelOverlay,
  rebindBuiltinProvider,
  resolveProviderApiKey,
} from './provider-keys.ts';
import { listProviderModels, type ProviderModel } from './provider-models.ts';
import type { SettingsStore } from './settings-store.ts';
import type { PlatformEnv } from './state-backend.ts';

const OPENROUTER_PREFIX = 'openrouter/';
const OPENROUTER_CONTEXT_WINDOW_CEILING = 2_000_000;
const OPENROUTER_MAX_COMPLETION_TOKENS = 128_000;

/**
 * The Settings picker reads OpenRouter's live public catalog. Pi ships a
 * reviewed static baseline, so a newly released model needs a small metadata
 * overlay before Flue can resolve it. This keeps selection and execution on
 * the same catalog without treating OpenRouter as a compatibility revision.
 */
export async function ensureOpenRouterRuntimeModel(
  canonicalModel: string,
  env: PlatformEnv | undefined,
  settings: SettingsStore,
): Promise<boolean> {
  if (!canonicalModel.startsWith(OPENROUTER_PREFIX)) return false;
  const modelId = canonicalModel.slice(OPENROUTER_PREFIX.length);
  const catalog = openrouterProvider();
  if (catalog.getModels().some((model) => model.id === modelId)) return true;

  let models: ProviderModel[];
  try {
    ({ models } = await listProviderModels('openrouter', {
      ...(env ? { env } : {}),
      store: settings,
    }));
  } catch (error) {
    // A live catalog outage must not break a model already projected into the
    // runtime during this isolate's lifetime. Cold isolates still fail closed.
    if (hasBuiltinProviderModelOverlay('openrouter', modelId)) return true;
    throw error;
  }
  const discovered = models.find((model) => model.id === modelId);
  if (!discovered) return false;

  const template = catalog.getModels().find((model) => model.id === 'openrouter/auto');
  if (!template) return false;
  const runtimeModel = liveOpenRouterModel(discovered, template);
  const { apiKey } = await resolveProviderApiKey('openrouter', env, settings);
  rebindBuiltinProvider('openrouter', apiKey, [runtimeModel]);
  return true;
}

function liveOpenRouterModel(
  discovered: ProviderModel,
  template: Model<Api>,
): Model<'openai-completions'> {
  const contextWindow = Math.min(
    positiveInteger(discovered.context_length) ?? template.contextWindow,
    OPENROUTER_CONTEXT_WINDOW_CEILING,
  );
  const maxTokens = Math.min(
    positiveInteger(discovered.max_completion_tokens) ?? template.maxTokens,
    contextWindow,
    OPENROUTER_MAX_COMPLETION_TOKENS,
  );
  const supported = new Set(discovered.supported_parameters ?? []);
  const modalities = new Set(discovered.input_modalities ?? []);
  return {
    ...template,
    id: discovered.id,
    name: discovered.display_name ?? discovered.id,
    api: 'openai-completions',
    provider: 'openrouter',
    reasoning:
      supported.has('reasoning') ||
      supported.has('include_reasoning') ||
      supported.has('reasoning_effort'),
    input: modalities.has('image') ? ['text', 'image'] : ['text'],
    cost: {
      input: pricePerMillion(discovered.pricing?.prompt, template.cost.input),
      output: pricePerMillion(discovered.pricing?.completion, template.cost.output),
      cacheRead: pricePerMillion(discovered.pricing?.input_cache_read, template.cost.cacheRead),
      cacheWrite: pricePerMillion(discovered.pricing?.input_cache_write, template.cost.cacheWrite),
    },
    contextWindow,
    maxTokens,
  };
}

function positiveInteger(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value && value > 0 ? value : undefined;
}

function pricePerMillion(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const perToken = Number(value);
  return Number.isFinite(perToken) ? perToken * 1_000_000 : fallback;
}
