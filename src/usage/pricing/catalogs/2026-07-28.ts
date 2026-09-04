import { createHash } from 'node:crypto';

import type { UsagePriceRate, UsagePriceVersion } from '../types.ts';

const REVIEWED_AT = Date.UTC(2026, 6, 28);
const STALE_AFTER = REVIEWED_AT + 90 * 24 * 60 * 60 * 1_000;
const CLOUDFLARE_BINDING_REVIEWED_AT = Date.UTC(2026, 6, 30);
const CLOUDFLARE_BINDING_STALE_AFTER =
  CLOUDFLARE_BINDING_REVIEWED_AT + 90 * 24 * 60 * 60 * 1_000;
const CACHE_PRICING_REVIEWED_AT = Date.UTC(2026, 7, 17);
const CACHE_PRICING_STALE_AFTER = CACHE_PRICING_REVIEWED_AT + 90 * 24 * 60 * 60 * 1_000;
const GLM_5_3_REVIEWED_AT = Date.UTC(2026, 7, 27);
const GLM_5_3_STALE_AFTER = GLM_5_3_REVIEWED_AT + 90 * 24 * 60 * 60 * 1_000;
const GLM_4_7_REVIEWED_AT = Date.UTC(2026, 8, 4);
const GLM_4_7_STALE_AFTER = GLM_4_7_REVIEWED_AT + 90 * 24 * 60 * 60 * 1_000;

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
 * Workers AI cached input is modeled from the published model rate. Other
 * cache discounts, batch/priority tiers, negotiated pricing, credits, taxes,
 * and routing-specific adjustments are deliberately not modeled.
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
  version({
    id: 'cloudflare-binding_2026-07-30',
    providerId: 'cloudflare',
    sourceUrl: 'https://developers.cloudflare.com/workers-ai/models/glm-5.2/',
    effectiveFrom: REVIEWED_AT,
    reviewedAt: CLOUDFLARE_BINDING_REVIEWED_AT,
    staleAfter: CLOUDFLARE_BINDING_STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'cloudflare',
      modelId: '@cf/zai-org/glm-5.2',
      modelAliases: ['@cf/zai-org/glm-5.2'],
      currency: 'USD',
      unitScale: 1_000_000,
      inputMicrosPerUnit: 1_400_000,
      outputMicrosPerUnit: 4_400_000,
      basis: 'standard_input_output',
    }],
  }),
  version({
    id: 'cloudflare-binding-cache_2026-08-17',
    providerId: 'cloudflare',
    sourceUrl: 'https://developers.cloudflare.com/workers-ai/models/glm-5.2/',
    effectiveFrom: CACHE_PRICING_REVIEWED_AT,
    reviewedAt: CACHE_PRICING_REVIEWED_AT,
    staleAfter: CACHE_PRICING_STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'cloudflare',
      modelId: '@cf/zai-org/glm-5.2',
      modelAliases: ['@cf/zai-org/glm-5.2'],
      currency: 'USD',
      unitScale: 1_000_000,
      inputMicrosPerUnit: 1_400_000,
      outputMicrosPerUnit: 4_400_000,
      cacheReadMicrosPerUnit: 260_000,
      cacheWriteMicrosPerUnit: 1_400_000,
      basis: 'standard_input_output',
    }],
  }),
  version({
    id: 'cloudflare-workers-ai-cache_2026-08-17',
    providerId: 'cloudflare-workers-ai',
    sourceUrl: 'https://developers.cloudflare.com/workers-ai/models/glm-5.2/',
    effectiveFrom: CACHE_PRICING_REVIEWED_AT,
    reviewedAt: CACHE_PRICING_REVIEWED_AT,
    staleAfter: CACHE_PRICING_STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'cloudflare-workers-ai',
      modelId: '@cf/zai-org/glm-5.2',
      modelAliases: ['@cf/zai-org/glm-5.2'],
      currency: 'USD',
      unitScale: 1_000_000,
      inputMicrosPerUnit: 1_400_000,
      outputMicrosPerUnit: 4_400_000,
      cacheReadMicrosPerUnit: 260_000,
      cacheWriteMicrosPerUnit: 1_400_000,
      basis: 'standard_input_output',
    }],
  }),
  version({
    id: 'cloudflare-binding-glm-5.3_2026-08-27',
    providerId: 'cloudflare',
    sourceUrl: 'https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/',
    effectiveFrom: GLM_5_3_REVIEWED_AT,
    reviewedAt: GLM_5_3_REVIEWED_AT,
    staleAfter: GLM_5_3_STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'cloudflare',
      modelId: '@cf/zai-org/glm-5.3-flash',
      modelAliases: ['@cf/zai-org/glm-5.3-flash'],
      currency: 'USD',
      unitScale: 1_000_000,
      inputMicrosPerUnit: 150_000,
      outputMicrosPerUnit: 500_000,
      cacheReadMicrosPerUnit: 30_000,
      basis: 'standard_input_output',
    }],
  }),
  version({
    id: 'cloudflare-workers-ai-glm-5.3_2026-08-27',
    providerId: 'cloudflare-workers-ai',
    sourceUrl: 'https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/',
    effectiveFrom: GLM_5_3_REVIEWED_AT,
    reviewedAt: GLM_5_3_REVIEWED_AT,
    staleAfter: GLM_5_3_STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'cloudflare-workers-ai',
      modelId: '@cf/zai-org/glm-5.3-flash',
      modelAliases: ['@cf/zai-org/glm-5.3-flash'],
      currency: 'USD',
      unitScale: 1_000_000,
      inputMicrosPerUnit: 150_000,
      outputMicrosPerUnit: 500_000,
      cacheReadMicrosPerUnit: 30_000,
      basis: 'standard_input_output',
    }],
  }),
  // Free-plan keyless default. The model page lists no cached-input rate.
  version({
    id: 'cloudflare-binding-glm-4.7_2026-09-04',
    providerId: 'cloudflare',
    sourceUrl: 'https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/',
    effectiveFrom: GLM_4_7_REVIEWED_AT,
    reviewedAt: GLM_4_7_REVIEWED_AT,
    staleAfter: GLM_4_7_STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'cloudflare',
      modelId: '@cf/zai-org/glm-4.7-flash',
      modelAliases: ['@cf/zai-org/glm-4.7-flash'],
      currency: 'USD',
      unitScale: 1_000_000,
      inputMicrosPerUnit: 60_000,
      outputMicrosPerUnit: 400_000,
      basis: 'standard_input_output',
    }],
  }),
  version({
    id: 'cloudflare-workers-ai-glm-4.7_2026-09-04',
    providerId: 'cloudflare-workers-ai',
    sourceUrl: 'https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/',
    effectiveFrom: GLM_4_7_REVIEWED_AT,
    reviewedAt: GLM_4_7_REVIEWED_AT,
    staleAfter: GLM_4_7_STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'cloudflare-workers-ai',
      modelId: '@cf/zai-org/glm-4.7-flash',
      modelAliases: ['@cf/zai-org/glm-4.7-flash'],
      currency: 'USD',
      unitScale: 1_000_000,
      inputMicrosPerUnit: 60_000,
      outputMicrosPerUnit: 400_000,
      basis: 'standard_input_output',
    }],
  }),
];
