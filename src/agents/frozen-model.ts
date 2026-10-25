import { useModel } from '@flue/runtime';

import type { ModelEffort } from '../config/model-effort.ts';
import {
  registerFrozenRuntimeModelRoute,
  type FrozenRuntimeModelRoute,
} from '../config/runtime-model.ts';
import { thinkingLevelForModel } from '../config/workers-ai-models.ts';

/**
 * Select a model frozen at admission. Its route registers first so a cold
 * isolate can resolve it. A curated GLM model's forced `off` wins over a
 * chosen effort; an unset effort leaves Flue's default.
 */
export function useFrozenModel(
  model: string,
  runtimeModel: string,
  runtimeModelRoute: FrozenRuntimeModelRoute | undefined,
  effort: ModelEffort | undefined,
): void {
  registerFrozenRuntimeModelRoute(model, runtimeModel, runtimeModelRoute);
  const thinkingLevel = thinkingLevelForModel(model) ?? effort;
  useModel(runtimeModel, thinkingLevel ? { thinkingLevel } : {});
}
