import { createHash } from 'node:crypto';

import type { UsagePriceRate, UsagePriceVersion } from '../types.ts';

const REVIEWED_AT = Date.UTC(2026, 6, 28);
const STALE_AFTER = REVIEWED_AT + 90 * 24 * 60 * 60 * 1_000;

function version(
  input: Omit<UsagePriceVersion, 'contentHash' | 'rates'> & {
    rates: Array<Omit<UsagePriceRate, 'priceVersionId'>>;
  },
): UsagePriceVersion {
  const rates = input.rates.map((rate) => ({ ...rate, priceVersionId: input.id }));
  const contentHash = createHash('sha256').update(JSON.stringify({ ...input, rates })).digest('hex');
  return { ...input, contentHash, rates };
}

/**
 * Release-pinned list-price snapshots for only the U0 fixture-proven routes.
 * Cache discounts, batch/priority tiers, negotiated pricing, credits, taxes,
 * and OpenRouter routing-specific adjustments are deliberately not modeled.
 */
export const RELEASE_PRICE_CATALOGS: UsagePriceVersion[] = [
  version({
    id: 'anthropic_2026-07-28',
    providerId: 'anthropic',
    sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
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
      basis: 'standard_input_output',
    }],
  }),
  version({
    id: 'openai_2026-07-28',
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
    id: 'openrouter_2026-07-28',
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
  version({
    id: 'cloudflare-workers-ai_2026-07-28',
    providerId: 'cloudflare-workers-ai',
    sourceUrl: 'https://developers.cloudflare.com/workers-ai/models/glm-5.2/',
    effectiveFrom: REVIEWED_AT,
    reviewedAt: REVIEWED_AT,
    staleAfter: STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'cloudflare-workers-ai',
      modelId: '@cf/zai-org/glm-5.2',
      modelAliases: ['@cf/zai-org/glm-5.2'],
      currency: 'USD',
      unitScale: 1_000_000,
      inputMicrosPerUnit: 1_400_000,
      outputMicrosPerUnit: 4_400_000,
      basis: 'standard_input_output',
    }],
  }),
];
