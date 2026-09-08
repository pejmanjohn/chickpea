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
      // Use the actual context window: an artificial 32K floor makes Pi
      // misclassify valid responses as silent overflow and compact/retry them.
      // https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/
      contextWindow: 1_048_576,
      // This budget includes reasoning. The previous 2K cap could end a
      // generation before the first tool call or user-visible answer.
      maxTokens: WORKERS_AI_REASONING_MAX_TOKENS,
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
