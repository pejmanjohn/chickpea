import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';

/**
 * Reasoning effort a chat-model selection may carry. Pi's `minimal` and `off`
 * are never offered: Pi reports `minimal` whenever a model's map omits it, and
 * `off` breaks models that refuse disabled thinking.
 */
export const MODEL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export function isModelEffort(value: unknown): value is ModelEffort {
  return typeof value === 'string' && (MODEL_EFFORTS as readonly string[]).includes(value);
}

/**
 * Levels a resolved Pi model accepts, in MODEL_EFFORTS order and no higher
 * than `ceiling`; [] when fewer than two remain, because one level is no choice.
 */
export function modelEffortsFor(model: Model<Api>, ceiling: ModelEffort = 'max'): ModelEffort[] {
  const supported = new Set<string>(getSupportedThinkingLevels(model));
  const efforts = MODEL_EFFORTS
    .slice(0, MODEL_EFFORTS.indexOf(ceiling) + 1)
    .filter((effort) => supported.has(effort));
  return efforts.length < 2 ? [] : efforts;
}

/**
 * The level an unset effort runs at. Flue sends `medium`, which Pi's
 * clampThinkingLevel moves to the nearest supported level, upward first.
 */
export function standardModelEffort(efforts: readonly ModelEffort[]): ModelEffort | undefined {
  const medium = MODEL_EFFORTS.indexOf('medium');
  return MODEL_EFFORTS.slice(medium).find((effort) => efforts.includes(effort)) ??
    MODEL_EFFORTS.slice(0, medium).reverse().find((effort) => efforts.includes(effort));
}

/**
 * The effort an Agent keeps after a patch. Naming a different model without
 * an effort clears it, so no write path leaves a pair the new model may not
 * accept; an Agent without a model has no effort.
 */
export function agentModelEffortAfterPatch(
  current: { model?: string; modelEffort?: ModelEffort },
  patch: { model?: string | null; modelEffort?: ModelEffort | null },
): ModelEffort | undefined {
  const model = patch.model === undefined ? current.model : patch.model ?? undefined;
  if (!model) return undefined;
  if (patch.modelEffort !== undefined) return patch.modelEffort ?? undefined;
  return model === current.model ? current.modelEffort : undefined;
}
