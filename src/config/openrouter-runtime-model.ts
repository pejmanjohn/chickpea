import type { Api, Model } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';

import { addBuiltinProviderModelOverlay, builtinProviderModelOverlay } from './pi-provider.ts';
import { listProviderModels, type ProviderModel } from './provider-models.ts';
import type { SettingsStore } from './settings-store.ts';
import type { PlatformEnv } from './state-backend.ts';

const OPENROUTER_PREFIX = 'openrouter/';
const OPENROUTER_CONTEXT_WINDOW_CEILING = 2_000_000;
const OPENROUTER_MAX_COMPLETION_TOKENS = 128_000;

/**
 * The live-catalog metadata a turn admitted with an overlaid OpenRouter model.
 * Flue resolves a model synchronously while it renders the agent, before any
 * app hook can await the live catalog, so a cold Durable Object isolate
 * registers the overlay from this frozen copy instead.
 */
export interface FrozenOpenRouterLiveModelRoute {
  source: 'openrouter_live_catalog';
  displayName: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * The Settings picker reads OpenRouter's live public catalog. Pi ships a
 * reviewed static baseline, so a newly released model needs a small metadata
 * overlay before Flue can resolve it. This keeps selection and execution on
 * the same catalog without treating OpenRouter as a compatibility revision.
 * The overlay is public metadata; the key reaches a call only through the
 * run's model access.
 */
export async function ensureOpenRouterRuntimeModel(
  canonicalModel: string,
  env: PlatformEnv | undefined,
  settings: SettingsStore,
): Promise<boolean> {
  if (!canonicalModel.startsWith(OPENROUTER_PREFIX)) return false;
  const modelId = canonicalModel.slice(OPENROUTER_PREFIX.length);
  if (isOpenRouterBaselineModel(modelId)) return true;

  let models: ProviderModel[];
  try {
    ({ models } = await listProviderModels('openrouter', {
      ...(env ? { env } : {}),
      store: settings,
    }));
  } catch (error) {
    // A live catalog outage must not break a model already projected into the
    // runtime during this isolate's lifetime. Cold isolates still fail closed.
    if (builtinProviderModelOverlay('openrouter', modelId)) return true;
    throw error;
  }
  const discovered = models.find((model) => model.id === modelId);
  if (!discovered) return false;

  const template = openRouterTemplate();
  if (!template) return false;
  addBuiltinProviderModelOverlay('openrouter', liveOpenRouterModel(discovered, template));
  return true;
}

/**
 * Freeze the overlay this isolate projected for a model outside Pi's static
 * baseline. Baseline models need no route: every isolate already knows them.
 */
export function freezeOpenRouterRuntimeModelRoute(
  canonicalModel: string,
): FrozenOpenRouterLiveModelRoute | undefined {
  const modelId = canonicalModel.slice(OPENROUTER_PREFIX.length);
  if (isOpenRouterBaselineModel(modelId)) return undefined;
  const overlay = builtinProviderModelOverlay('openrouter', modelId);
  if (!overlay) return undefined;
  return {
    source: 'openrouter_live_catalog',
    // The plan parser bounds displayName to 1-160 characters; OpenRouter's
    // `name` is unbounded and may be empty.
    displayName: overlay.name.slice(0, 160) || modelId,
    contextWindow: overlay.contextWindow,
    maxTokens: overlay.maxTokens,
    reasoning: overlay.reasoning,
    input: [...overlay.input],
    cost: { ...overlay.cost },
  };
}

/**
 * Synchronously register a frozen overlay before useModel() in a cold isolate.
 * A model that has since entered Pi's reviewed baseline keeps the baseline
 * entry: a continuing instance re-registers its first-turn route every render.
 */
export function registerFrozenOpenRouterRuntimeModelRoute(
  canonicalModel: string,
  runtimeModel: string,
  route: FrozenOpenRouterLiveModelRoute,
): void {
  const model = frozenOpenRouterRuntimeModel(canonicalModel, runtimeModel, route);
  if (isOpenRouterBaselineModel(model.id)) return;
  addBuiltinProviderModelOverlay('openrouter', model);
}

export function frozenOpenRouterRuntimeModel(
  canonicalModel: string,
  runtimeModel: string,
  route: FrozenOpenRouterLiveModelRoute,
): Model<'openai-completions'> {
  if (!canonicalModel.startsWith(OPENROUTER_PREFIX) || runtimeModel !== canonicalModel) {
    throw new Error('Frozen OpenRouter model route does not match its model.');
  }
  const template = openRouterTemplate();
  if (!template) throw new Error('OpenRouter model template is unavailable.');
  return {
    ...template,
    id: canonicalModel.slice(OPENROUTER_PREFIX.length),
    name: route.displayName,
    api: 'openai-completions',
    provider: 'openrouter',
    reasoning: route.reasoning,
    input: [...route.input],
    cost: { ...route.cost },
    ...openRouterLimits(route.contextWindow, route.maxTokens),
  };
}

function isOpenRouterBaselineModel(modelId: string): boolean {
  return openrouterProvider().getModels().some((model) => model.id === modelId);
}

function openRouterTemplate(): Model<Api> | undefined {
  return openrouterProvider().getModels().find((model) => model.id === 'openrouter/auto');
}

function openRouterLimits(
  contextWindow: number,
  maxTokens: number,
): Pick<Model<Api>, 'contextWindow' | 'maxTokens'> {
  const boundedContextWindow = Math.min(contextWindow, OPENROUTER_CONTEXT_WINDOW_CEILING);
  return {
    contextWindow: boundedContextWindow,
    maxTokens: Math.min(maxTokens, boundedContextWindow, OPENROUTER_MAX_COMPLETION_TOKENS),
  };
}

function liveOpenRouterModel(
  discovered: ProviderModel,
  template: Model<Api>,
): Model<'openai-completions'> {
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
    ...openRouterLimits(
      positiveInteger(discovered.context_length) ?? template.contextWindow,
      positiveInteger(discovered.max_completion_tokens) ?? template.maxTokens,
    ),
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
