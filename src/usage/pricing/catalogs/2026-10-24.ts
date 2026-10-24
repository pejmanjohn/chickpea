import type { UsagePriceVersion } from '../types.ts';
import { version } from './version.ts';

const REVIEWED_AT = Date.UTC(2026, 9, 24);
const STALE_AFTER = REVIEWED_AT + 90 * 24 * 60 * 60 * 1_000;
/** OpenAI bills a prompt of more than 272K input tokens at its long-context rates. */
const OPENAI_LONG_CONTEXT_FROM = 272_001;

/** List price reviewed on 2026-10-24 for GPT-6.1 Sol, which pi-ai 1.1 ships. */
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
];
