import type { UsagePriceVersion } from '../types.ts';
import { version } from './version.ts';

const REVIEWED_AT = Date.UTC(2026, 9, 24);
const STALE_AFTER = REVIEWED_AT + 90 * 24 * 60 * 60 * 1_000;
/** OpenAI bills a prompt of more than 272K input tokens at its long-context rates. */
const OPENAI_LONG_CONTEXT_FROM = 272_001;
/** Anthropic bills a Claude Haiku 5.5 prompt of more than 100K tokens, cache reads and writes included, at its higher rates. */
const HAIKU_5_5_LONG_CONTEXT_FROM = 100_001;

/** List prices reviewed on 2026-10-24 for GPT-6.1 Sol and Claude Haiku 5.5, which pi-ai 1.1 ships. */
export const PRICE_CATALOGS_2026_10_24: UsagePriceVersion[] = [
  version({
    id: 'openai-gpt-6.1-sol_2026-10-24',
    providerId: 'openai',
    sourceUrl: 'https://developers.openai.com/api/docs/pricing',
    effectiveFrom: REVIEWED_AT,
    reviewedAt: REVIEWED_AT,
    staleAfter: STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'openai',
      modelId: 'gpt-6.1-sol',
      modelAliases: ['gpt-6.1-sol'],
      currency: 'USD',
      unitScale: 1_000_000,
      basis: 'standard_input_output',
      inputMicrosPerUnit: 2_000_000,
      outputMicrosPerUnit: 10_000_000,
      cacheReadMicrosPerUnit: 100_000,
      cacheWriteMicrosPerUnit: 2_500_000,
      longContext: {
        fromPromptTokens: OPENAI_LONG_CONTEXT_FROM,
        inputMicrosPerUnit: 4_000_000,
        outputMicrosPerUnit: 15_000_000,
        cacheReadMicrosPerUnit: 200_000,
        cacheWriteMicrosPerUnit: 5_000_000,
      },
    }],
  }),
  version({
    id: 'anthropic-haiku-5-5_2026-10-24',
    providerId: 'anthropic',
    sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    effectiveFrom: REVIEWED_AT,
    reviewedAt: REVIEWED_AT,
    staleAfter: STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'anthropic',
      modelId: 'claude-haiku-5-5',
      modelAliases: ['claude-haiku-5-5'],
      currency: 'USD',
      unitScale: 1_000_000,
      basis: 'standard_input_output',
      inputMicrosPerUnit: 100_000,
      outputMicrosPerUnit: 500_000,
      cacheReadMicrosPerUnit: 10_000,
      cacheWriteMicrosPerUnit: 125_000,
      cacheWrite1hMicrosPerUnit: 200_000,
      longContext: {
        fromPromptTokens: HAIKU_5_5_LONG_CONTEXT_FROM,
        inputMicrosPerUnit: 500_000,
        outputMicrosPerUnit: 2_500_000,
        cacheReadMicrosPerUnit: 50_000,
        cacheWriteMicrosPerUnit: 625_000,
        cacheWrite1hMicrosPerUnit: 1_000_000,
      },
    }],
  }),
];
