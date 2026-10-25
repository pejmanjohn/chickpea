import { loadModelCatalog, resolveActiveCatalogRoute } from '../model-catalog/index.ts';
import { getBuiltinModel } from '../model-catalog/pi-builtin-models.ts';
import type { ModelAuthLane } from '../model-catalog/types.ts';
import { modelEffortsFor, type ModelEffort } from './model-effort.ts';
import { resolveOpenAiAuthMethod } from './openai-auth.ts';
import { openRouterModelEfforts } from './openrouter-runtime-model.ts';
import type { SettingsStore } from './settings-store.ts';
import type { PlatformEnv } from './state-backend.ts';
import { thinkingLevelForModel } from './workers-ai-models.ts';

export interface ModelEffortDependencies {
  settings: SettingsStore;
  env?: PlatformEnv | undefined;
}

/**
 * The efforts a canonical `provider/model` accepts, read from the metadata its
 * runtime lane routes with. It binds no credential and calls no model; only
 * OpenRouter may read the public model list the Admin already caches.
 */
export async function resolveModelEfforts(
  canonicalModel: string,
  dependencies: ModelEffortDependencies,
): Promise<ModelEffort[]> {
  // Curated GLM models run with thinking forced off whatever is selected.
  if (thinkingLevelForModel(canonicalModel) === 'off') return [];
  const separator = canonicalModel.indexOf('/');
  const provider = separator > 0 ? canonicalModel.slice(0, separator) : '';
  const modelId = canonicalModel.slice(separator + 1);
  switch (provider) {
    case 'anthropic':
      return catalogEfforts(canonicalModel, 'anthropic_api_key', dependencies);
    case 'openai':
      return await resolveOpenAiAuthMethod(dependencies.settings) === 'api_key'
        ? catalogEfforts(canonicalModel, 'openai_api_key', dependencies)
        // The Node subscription provider drops `max`; no live turn has proven
        // the Cloudflare plan accepts it.
        : catalogEfforts(canonicalModel, 'openai_subscription', dependencies, 'xhigh');
    case 'openrouter':
      return openRouterModelEfforts(canonicalModel, dependencies.env, dependencies.settings);
    case 'cloudflare': {
      // Flue's binding provider sends xhigh and max as high.
      const model = getBuiltinModel('cloudflare-workers-ai', modelId);
      return model ? modelEffortsFor(model, 'high') : [];
    }
    case 'cloudflare-workers-ai': {
      const model = getBuiltinModel('cloudflare-workers-ai', modelId);
      return model ? modelEffortsFor(model) : [];
    }
    default:
      return [];
  }
}

async function catalogEfforts(
  canonicalModel: string,
  lane: ModelAuthLane,
  dependencies: ModelEffortDependencies,
  ceiling?: ModelEffort,
): Promise<ModelEffort[]> {
  await loadModelCatalog(dependencies.settings, dependencies.env);
  const route = resolveActiveCatalogRoute(canonicalModel, lane, dependencies.env);
  return route ? modelEffortsFor(route.model, ceiling) : [];
}

export type ModelEffortRejection = 'effort_not_supported' | 'effort_requires_model';

/** Why a named effort cannot ride with `model`; every write path checks here. */
export async function modelEffortChoiceError(
  model: string | undefined,
  effort: ModelEffort,
  dependencies: ModelEffortDependencies,
): Promise<{ code: ModelEffortRejection; message: string } | undefined> {
  if (!model) {
    return { code: 'effort_requires_model', message: 'Choose a model before choosing an effort.' };
  }
  if ((await resolveModelEfforts(model, dependencies)).includes(effort)) return undefined;
  return { code: 'effort_not_supported', message: `${model} does not support ${effort} effort.` };
}
