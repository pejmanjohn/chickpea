import { openAiModelUrl, reviewVersions } from './review.ts';

const REVIEWED_AT = Date.UTC(2026, 10, 6);
const REVIEW_DUE_AT = REVIEWED_AT + 90 * 24 * 60 * 60 * 1_000;

/**
 * GPT-6.1 Terra's list price, read from OpenAI's model page and OpenRouter's models API on 2026-11-06.
 * The page bills a prompt of more than 272K input tokens at 2x input and cache rates and 1.5x output.
 */
export const PRICE_CATALOGS_2026_11_06 = reviewVersions(REVIEWED_AT, REVIEW_DUE_AT, [
  ['openai', 'gpt-6.1-terra', openAiModelUrl, { input: 1_000_000, output: 5_000_000, cacheRead: 50_000, cacheWrite: 1_250_000,
    longContext: { fromPromptTokens: 272_001, input: 2_000_000, output: 7_500_000, cacheRead: 100_000, cacheWrite: 2_500_000 } }],
]);
