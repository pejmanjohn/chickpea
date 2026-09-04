import type { Api, Model } from '@earendil-works/pi-ai';

// Reviewed successor model. Note it requires Workers Paid; the Free-plan
// default lives in src/config/seed.ts.
export const CURRENT_WORKERS_AI_MODEL_ID = '@cf/zai-org/glm-5.3-flash';

/**
 * Workers AI GLM models share one chat template whose thinking mode is on by
 * default. Chickpea applies the same binding-boundary policy to each of them.
 */
export const WORKERS_AI_GLM_MODEL_IDS = [
  '@cf/zai-org/glm-4.7-flash',
  '@cf/zai-org/glm-5.2',
  CURRENT_WORKERS_AI_MODEL_ID,
] as const;

export function isWorkersAiGlmModel(modelId: string): boolean {
  return (WORKERS_AI_GLM_MODEL_IDS as readonly string[]).includes(modelId);
}
export const WORKERS_AI_CONTEXT_WINDOW_FLOOR = 32_768;

/**
 * Flue 2.0 currently shares Pi 0.83 with its agent runtime. Keep that single
 * dependency graph, then supplement only models whose Cloudflare metadata we
 * have reviewed from the provider's own documentation.
 */
export function withCurrentWorkersAiModels<TApi extends Api>(
  models: readonly Model<TApi>[],
): Model<TApi>[] {
  if (models.some((model) => model.id === CURRENT_WORKERS_AI_MODEL_ID)) {
    return [...models];
  }
  const template = models.find((model) => model.id === '@cf/zai-org/glm-5.2');
  if (!template) return [...models];
  return [
    ...models,
    {
      ...template,
      id: CURRENT_WORKERS_AI_MODEL_ID,
      name: 'GLM 5.3 Flash',
      reasoning: true,
      input: ['text', 'image'],
      cost: {
        input: 0.15,
        output: 0.5,
        cacheRead: 0.03,
        cacheWrite: 0,
      },
      // The provider advertises 1,048,576 tokens. Chickpea keeps the same
      // conservative floor used by its binding and REST paths until the wider
      // agent pipeline is validated at that limit.
      contextWindow: WORKERS_AI_CONTEXT_WINDOW_FLOOR,
      // Chickpea intentionally keeps Workers AI replies within its existing
      // response ceiling even though the provider accepts a larger value.
      maxTokens: 2_048,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: null,
        max: null,
      },
    },
  ];
}
