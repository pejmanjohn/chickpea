import type { Api, Model } from '@earendil-works/pi-ai';

// Reviewed successor model. Note it requires Workers Paid; the Free-plan
// default lives in src/config/seed.ts.
export const CURRENT_WORKERS_AI_MODEL_ID = '@cf/zai-org/glm-5.3-flash';
export const WORKERS_AI_REASONING_MAX_TOKENS = 8_192;

export function workersAiGlmOutputLimit(modelId: string): number {
  return modelId === CURRENT_WORKERS_AI_MODEL_ID ? WORKERS_AI_REASONING_MAX_TOKENS : 2_048;
}

/**
 * Curated Workers AI GLM models use a binding-boundary thinking policy. The
 * current model requires thinking parsing enabled; older models support off.
 */
export const WORKERS_AI_GLM_MODEL_IDS = [
  '@cf/zai-org/glm-4.7-flash',
  '@cf/zai-org/glm-5.2',
  CURRENT_WORKERS_AI_MODEL_ID,
] as const;

export function isWorkersAiGlmModel(modelId: string): boolean {
  return (WORKERS_AI_GLM_MODEL_IDS as readonly string[]).includes(modelId);
}

/**
 * The thinking level for a canonical `provider/model` id: Workers AI GLM
 * models run with thinking off, every other model keeps its default.
 */
export function thinkingLevelForModel(model: string): 'off' | undefined {
  const slash = model.indexOf('/');
  const provider = model.slice(0, slash);
  return slash > 0 &&
    (provider === 'cloudflare' || provider === 'cloudflare-workers-ai') &&
    isWorkersAiGlmModel(model.slice(slash + 1))
    ? 'off'
    : undefined;
}
export const WORKERS_AI_CONTEXT_WINDOW_FLOOR = 32_768;

/**
 * Pi's Workers AI catalog with Chickpea's reviewed output caps. Every other
 * field, including the current model's context window, cost, and input, is
 * the upstream metadata. The binding and REST request paths apply the same
 * cap to each generation.
 */
export function withReviewedWorkersAiOutputCaps<TApi extends Api>(
  models: readonly Model<TApi>[],
): Model<TApi>[] {
  return models.map((model) => isWorkersAiGlmModel(model.id)
    ? { ...model, maxTokens: Math.min(model.maxTokens, workersAiGlmOutputLimit(model.id)) }
    : model);
}
