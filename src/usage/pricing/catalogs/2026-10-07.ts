import type { ImagePriceRate, TokenPriceRate, UsagePriceVersion } from '../types.ts';
import { version } from './version.ts';

const REVIEWED_AT = Date.UTC(2026, 9, 7);
const STALE_AFTER = REVIEWED_AT + 90 * 24 * 60 * 60 * 1_000;
const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
/** OpenAI bills a prompt of more than 272K input tokens at its long-context rates. */
const OPENAI_LONG_CONTEXT_FROM = 272_001;
/** OpenRouter's `min_prompt_tokens` for the same tier. */
const OPENROUTER_LONG_CONTEXT_FROM = 272_000;

type TokenRates = Omit<
  TokenPriceRate,
  'priceVersionId' | 'providerId' | 'modelId' | 'modelAliases' | 'currency' | 'unitScale' | 'basis'
>;
type ImageRates = Pick<
  ImagePriceRate,
  'textInputMicrosPerUnit' | 'imageInputMicrosPerUnit' | 'imageOutputMicrosPerUnit'
>;

function tokenVersion(
  id: string,
  providerId: string,
  sourceUrl: string,
  modelAliases: [string, ...string[]],
  rates: TokenRates,
  staleAfter = STALE_AFTER,
): UsagePriceVersion {
  return version({
    id,
    providerId,
    sourceUrl,
    effectiveFrom: REVIEWED_AT,
    reviewedAt: REVIEWED_AT,
    staleAfter,
    currency: 'USD',
    rates: [{
      providerId,
      modelId: modelAliases[0],
      modelAliases,
      currency: 'USD',
      unitScale: 1_000_000,
      basis: 'standard_input_output',
      ...rates,
    }],
  });
}

function imageVersion(id: string, modelId: string, rates: ImageRates): UsagePriceVersion {
  return version({
    id,
    providerId: 'openai',
    sourceUrl: `https://developers.openai.com/api/docs/models/${modelId}`,
    effectiveFrom: REVIEWED_AT,
    reviewedAt: REVIEWED_AT,
    staleAfter: STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'openai',
      modelId,
      modelAliases: [modelId],
      currency: 'USD',
      unitScale: 1_000_000,
      basis: 'image_tokens',
      ...rates,
    }],
  });
}

const anthropic = (slug: string, aliases: [string, ...string[]], rates: TokenRates) =>
  tokenVersion(`anthropic-${slug}_2026-10-07`, 'anthropic', ANTHROPIC_PRICING_URL, aliases, rates);

const openai = (modelId: string, rates: TokenRates, staleAfter?: number) =>
  tokenVersion(
    `openai-${modelId}_2026-10-07`,
    'openai',
    `https://developers.openai.com/api/docs/models/${modelId}`,
    [modelId],
    rates,
    staleAfter,
  );

const openrouter = (modelId: string, datedSlug: string, rates: TokenRates) =>
  tokenVersion(
    `openrouter-${modelId.slice(modelId.indexOf('/') + 1)}_2026-10-07`,
    'openrouter',
    `https://openrouter.ai/${modelId}`,
    [modelId, datedSlug],
    rates,
  );

/**
 * List prices reviewed on 2026-10-07 for every suggested model, the image
 * models, and the OpenRouter models offered on credits. Each Anthropic price
 * carries the 5-minute and 1-hour cache-write rates. OpenRouter prices are the
 * ones each model page states, which are its cheapest provider's.
 */
export const PRICE_CATALOGS_2026_10_07: UsagePriceVersion[] = [
  // Model IDs: https://platform.claude.com/docs/en/about-claude/models/overview
  anthropic('fable-5-1', ['claude-fable-5-1'], {
    inputMicrosPerUnit: 10_000_000,
    outputMicrosPerUnit: 50_000_000,
    cacheReadMicrosPerUnit: 250_000,
    cacheWriteMicrosPerUnit: 12_500_000,
    cacheWrite1hMicrosPerUnit: 20_000_000,
  }),
  anthropic('fable-5', ['claude-fable-5'], {
    inputMicrosPerUnit: 10_000_000,
    outputMicrosPerUnit: 50_000_000,
    cacheReadMicrosPerUnit: 1_000_000,
    cacheWriteMicrosPerUnit: 12_500_000,
    cacheWrite1hMicrosPerUnit: 20_000_000,
  }),
  anthropic('opus-5-5', ['claude-opus-5-5'], {
    inputMicrosPerUnit: 4_000_000,
    outputMicrosPerUnit: 20_000_000,
    cacheReadMicrosPerUnit: 200_000,
    cacheWriteMicrosPerUnit: 5_000_000,
    cacheWrite1hMicrosPerUnit: 8_000_000,
  }),
  anthropic('opus-5', ['claude-opus-5'], {
    inputMicrosPerUnit: 5_000_000,
    outputMicrosPerUnit: 25_000_000,
    cacheReadMicrosPerUnit: 500_000,
    cacheWriteMicrosPerUnit: 6_250_000,
    cacheWrite1hMicrosPerUnit: 10_000_000,
  }),
  anthropic('sonnet-5-5', ['claude-sonnet-5-5'], {
    inputMicrosPerUnit: 2_000_000,
    outputMicrosPerUnit: 10_000_000,
    cacheReadMicrosPerUnit: 200_000,
    cacheWriteMicrosPerUnit: 2_500_000,
    cacheWrite1hMicrosPerUnit: 4_000_000,
  }),
  anthropic('sonnet-5', ['claude-sonnet-5'], {
    inputMicrosPerUnit: 2_000_000,
    outputMicrosPerUnit: 10_000_000,
    cacheReadMicrosPerUnit: 200_000,
    cacheWriteMicrosPerUnit: 2_500_000,
    cacheWrite1hMicrosPerUnit: 4_000_000,
  }),
  anthropic('haiku-4-5', ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'], {
    inputMicrosPerUnit: 1_000_000,
    outputMicrosPerUnit: 5_000_000,
    cacheReadMicrosPerUnit: 100_000,
    cacheWriteMicrosPerUnit: 1_250_000,
    cacheWrite1hMicrosPerUnit: 2_000_000,
  }),
  openai('gpt-6-astra', {
    inputMicrosPerUnit: 10_000_000,
    outputMicrosPerUnit: 50_000_000,
    cacheReadMicrosPerUnit: 1_000_000,
    cacheWriteMicrosPerUnit: 12_500_000,
    longContext: {
      fromPromptTokens: OPENAI_LONG_CONTEXT_FROM,
      inputMicrosPerUnit: 20_000_000,
      outputMicrosPerUnit: 75_000_000,
      cacheReadMicrosPerUnit: 2_000_000,
      cacheWriteMicrosPerUnit: 25_000_000,
    },
  }),
  openai('gpt-6-sol', {
    inputMicrosPerUnit: 2_000_000,
    outputMicrosPerUnit: 10_000_000,
    cacheReadMicrosPerUnit: 200_000,
    cacheWriteMicrosPerUnit: 2_500_000,
    longContext: {
      fromPromptTokens: OPENAI_LONG_CONTEXT_FROM,
      inputMicrosPerUnit: 4_000_000,
      outputMicrosPerUnit: 15_000_000,
      cacheReadMicrosPerUnit: 400_000,
      cacheWriteMicrosPerUnit: 5_000_000,
    },
  }),
  openai('gpt-6-luna', {
    inputMicrosPerUnit: 100_000,
    outputMicrosPerUnit: 500_000,
    cacheReadMicrosPerUnit: 10_000,
    cacheWriteMicrosPerUnit: 125_000,
    longContext: {
      fromPromptTokens: OPENAI_LONG_CONTEXT_FROM,
      inputMicrosPerUnit: 200_000,
      outputMicrosPerUnit: 750_000,
      cacheReadMicrosPerUnit: 20_000,
      cacheWriteMicrosPerUnit: 250_000,
    },
  }),
  // The page guarantees this promotional price only through 2026-11-21.
  openai('gpt-5.6-sol', {
    inputMicrosPerUnit: 4_000_000,
    outputMicrosPerUnit: 20_000_000,
    cacheReadMicrosPerUnit: 400_000,
    cacheWriteMicrosPerUnit: 5_000_000,
    longContext: {
      fromPromptTokens: OPENAI_LONG_CONTEXT_FROM,
      inputMicrosPerUnit: 8_000_000,
      outputMicrosPerUnit: 30_000_000,
      cacheReadMicrosPerUnit: 800_000,
      cacheWriteMicrosPerUnit: 10_000_000,
    },
  }, Date.UTC(2026, 10, 22)),
  openai('gpt-5.6-terra', {
    inputMicrosPerUnit: 2_000_000,
    outputMicrosPerUnit: 12_000_000,
    cacheReadMicrosPerUnit: 200_000,
    cacheWriteMicrosPerUnit: 2_500_000,
    longContext: {
      fromPromptTokens: OPENAI_LONG_CONTEXT_FROM,
      inputMicrosPerUnit: 4_000_000,
      outputMicrosPerUnit: 18_000_000,
      cacheReadMicrosPerUnit: 400_000,
      cacheWriteMicrosPerUnit: 5_000_000,
    },
  }),
  openai('gpt-5.6-luna', {
    inputMicrosPerUnit: 200_000,
    outputMicrosPerUnit: 1_200_000,
    cacheReadMicrosPerUnit: 20_000,
    cacheWriteMicrosPerUnit: 250_000,
    longContext: {
      fromPromptTokens: OPENAI_LONG_CONTEXT_FROM,
      inputMicrosPerUnit: 400_000,
      outputMicrosPerUnit: 1_800_000,
      cacheReadMicrosPerUnit: 40_000,
      cacheWriteMicrosPerUnit: 500_000,
    },
  }),
  // Images endpoint rates; cached-input rates apply only to images made through the responses endpoint.
  imageVersion('openai-image-gpt-image-2.5-flare_2026-10-07', 'gpt-image-2.5-flare', {
    textInputMicrosPerUnit: 5_000_000,
    imageInputMicrosPerUnit: 8_000_000,
    imageOutputMicrosPerUnit: 30_000_000,
  }),
  imageVersion('openai-image-gpt-image-2.5-sunburst_2026-10-07', 'gpt-image-2.5-sunburst', {
    textInputMicrosPerUnit: 5_000_000,
    imageInputMicrosPerUnit: 8_000_000,
    imageOutputMicrosPerUnit: 30_000_000,
  }),
  openrouter('anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5-20260630', {
    inputMicrosPerUnit: 2_000_000,
    outputMicrosPerUnit: 10_000_000,
    cacheReadMicrosPerUnit: 200_000,
    cacheWriteMicrosPerUnit: 2_500_000,
    cacheWrite1hMicrosPerUnit: 4_000_000,
  }),
  openrouter('openai/gpt-5.6-terra', 'openai/gpt-5.6-terra-20260709', {
    inputMicrosPerUnit: 2_000_000,
    outputMicrosPerUnit: 12_000_000,
    cacheReadMicrosPerUnit: 200_000,
    cacheWriteMicrosPerUnit: 2_500_000,
    longContext: {
      fromPromptTokens: OPENROUTER_LONG_CONTEXT_FROM,
      inputMicrosPerUnit: 4_000_000,
      outputMicrosPerUnit: 18_000_000,
      cacheReadMicrosPerUnit: 400_000,
      cacheWriteMicrosPerUnit: 5_000_000,
    },
  }),
  openrouter('deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-20260910', {
    inputMicrosPerUnit: 50_000,
    outputMicrosPerUnit: 1_200_000,
    cacheReadMicrosPerUnit: 20_000,
  }),
  openrouter('z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flash-20260826', {
    inputMicrosPerUnit: 36_000,
    outputMicrosPerUnit: 500_000,
    cacheReadMicrosPerUnit: 36_000,
  }),
  openrouter('moonshotai/kimi-k3', 'moonshotai/kimi-k3-20260715', {
    inputMicrosPerUnit: 615_000,
    outputMicrosPerUnit: 13_000_000,
    cacheReadMicrosPerUnit: 450_000,
  }),
];
