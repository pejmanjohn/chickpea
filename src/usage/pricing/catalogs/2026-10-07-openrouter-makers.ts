import type { TokenPriceRate, UsagePriceVersion } from '../types.ts';
import { version } from './version.ts';

/** When the endpoints were read; later than the 2026-10-07 review, so these prices replace its OpenRouter ones. */
const REVIEWED_AT = Date.UTC(2026, 9, 7, 15, 57);
const STALE_AFTER = REVIEWED_AT + 90 * 24 * 60 * 60 * 1_000;

type MakerRates = Required<Pick<TokenPriceRate, 'inputMicrosPerUnit' | 'outputMicrosPerUnit' | 'cacheReadMicrosPerUnit'>>;

function maker(modelId: string, datedSlug: string, rates: MakerRates): UsagePriceVersion {
  return version({
    id: `openrouter-${modelId.slice(modelId.indexOf('/') + 1)}_2026-10-07-maker`,
    providerId: 'openrouter',
    sourceUrl: `https://openrouter.ai/api/v1/models/${modelId}/endpoints`,
    effectiveFrom: REVIEWED_AT,
    reviewedAt: REVIEWED_AT,
    staleAfter: STALE_AFTER,
    currency: 'USD',
    rates: [{
      providerId: 'openrouter',
      modelId,
      modelAliases: [modelId, datedSlug],
      currency: 'USD',
      unitScale: 1_000_000,
      basis: 'standard_input_output',
      ...rates,
    }],
  });
}

/**
 * Each OpenRouter model's price at its maker's own endpoint. A platform-funded
 * OpenRouter request is capped at its catalog price, so routing never pays
 * more than the maker charges.
 */
export const PRICE_CATALOGS_2026_10_07_OPENROUTER_MAKERS: UsagePriceVersion[] = [
  // DeepSeek, tag `deepseek`. It charges double on weekdays from 01:00 to 04:00 and 06:00 to 10:00 UTC, so
  // the cap then excludes its own endpoint while cheaper providers still serve.
  maker('deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-20260910', {
    inputMicrosPerUnit: 150_000,
    outputMicrosPerUnit: 600_000,
    cacheReadMicrosPerUnit: 3_000,
  }),
  // Z.AI, tag `z-ai/fp8`.
  maker('z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flash-20260826', {
    inputMicrosPerUnit: 150_000,
    outputMicrosPerUnit: 500_000,
    cacheReadMicrosPerUnit: 30_000,
  }),
  // Moonshot AI, tag `moonshotai/mxfp4`.
  maker('moonshotai/kimi-k3', 'moonshotai/kimi-k3-20260715', {
    inputMicrosPerUnit: 3_000_000,
    outputMicrosPerUnit: 15_000_000,
    cacheReadMicrosPerUnit: 300_000,
  }),
];
