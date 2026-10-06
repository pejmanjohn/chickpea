import type { UsagePriceVersion } from '../types.ts';
import { version } from './version.ts';

const REVIEWED_AT = Date.UTC(2026, 9, 6);
const STALE_AFTER = REVIEWED_AT + 90 * 24 * 60 * 60 * 1_000;
const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';

/**
 * List prices reviewed on 2026-10-06, one version per model. Anthropic cache
 * writes use the 5-minute rate, as in the 2026-10-04 cache version. The
 * OpenAI and OpenRouter prices are unchanged; re-reviewing them restarts
 * their staleness window.
 */
export const PRICE_CATALOGS_2026_10_06: UsagePriceVersion[] = [
  // Model IDs: https://platform.claude.com/docs/en/about-claude/models/overview
  version({
    id: 'anthropic-sonnet-5-5_2026-10-06',
    providerId: 'anthropic',
    sourceUrl: ANTHROPIC_PRICING_URL,
    effectiveFrom: REVIEWED_AT,
    reviewedAt: REVIEWED_AT,
    staleAfter: STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5-5',
      modelAliases: ['claude-sonnet-5-5'],
      currency: 'USD',
      unitScale: 1_000_000,
      inputMicrosPerUnit: 2_000_000,
      outputMicrosPerUnit: 10_000_000,
      cacheReadMicrosPerUnit: 200_000,
      cacheWriteMicrosPerUnit: 2_500_000,
      basis: 'standard_input_output',
    }],
  }),
  version({
    id: 'anthropic-sonnet-5_2026-10-06',
    providerId: 'anthropic',
    sourceUrl: ANTHROPIC_PRICING_URL,
    effectiveFrom: REVIEWED_AT,
    reviewedAt: REVIEWED_AT,
    staleAfter: STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5',
      modelAliases: ['claude-sonnet-5'],
      currency: 'USD',
      unitScale: 1_000_000,
      inputMicrosPerUnit: 2_000_000,
      outputMicrosPerUnit: 10_000_000,
      cacheReadMicrosPerUnit: 200_000,
      cacheWriteMicrosPerUnit: 2_500_000,
      basis: 'standard_input_output',
    }],
  }),
  version({
    id: 'anthropic-haiku-4-5_2026-10-06',
    providerId: 'anthropic',
    sourceUrl: ANTHROPIC_PRICING_URL,
    effectiveFrom: REVIEWED_AT,
    reviewedAt: REVIEWED_AT,
    staleAfter: STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
      modelAliases: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
      currency: 'USD',
      unitScale: 1_000_000,
      inputMicrosPerUnit: 1_000_000,
      outputMicrosPerUnit: 5_000_000,
      cacheReadMicrosPerUnit: 100_000,
      cacheWriteMicrosPerUnit: 1_250_000,
      basis: 'standard_input_output',
    }],
  }),
  version({
    id: 'openai_2026-10-06',
    providerId: 'openai',
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini',
    effectiveFrom: REVIEWED_AT,
    reviewedAt: REVIEWED_AT,
    staleAfter: STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      modelAliases: ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'],
      currency: 'USD',
      unitScale: 1_000_000,
      inputMicrosPerUnit: 400_000,
      outputMicrosPerUnit: 1_600_000,
      basis: 'standard_input_output',
    }],
  }),
  version({
    id: 'openrouter_2026-10-06',
    providerId: 'openrouter',
    sourceUrl: 'https://openrouter.ai/openai/gpt-4.1-2025-04-14/providers',
    effectiveFrom: REVIEWED_AT,
    reviewedAt: REVIEWED_AT,
    staleAfter: STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'openrouter',
      modelId: 'openai/gpt-4.1',
      modelAliases: ['openai/gpt-4.1', 'openai/gpt-4.1-2025-04-14'],
      currency: 'USD',
      unitScale: 1_000_000,
      inputMicrosPerUnit: 2_000_000,
      outputMicrosPerUnit: 8_000_000,
      basis: 'standard_input_output',
    }],
  }),
];
