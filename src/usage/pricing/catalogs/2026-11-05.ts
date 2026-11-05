import type { UsagePriceVersion } from '../types.ts';
import { version } from './version.ts';

const REVIEWED_AT = Date.UTC(2026, 10, 5);
const REVIEW_DUE_AT = REVIEWED_AT + 90 * 24 * 60 * 60 * 1_000;

function imageVersion(id: string, modelId: string): UsagePriceVersion {
  return version({
    id,
    providerId: 'openai',
    sourceUrl: `https://developers.openai.com/api/docs/models/${modelId}`,
    effectiveFrom: REVIEWED_AT,
    reviewedAt: REVIEWED_AT,
    reviewDueAt: REVIEW_DUE_AT,
    currency: 'USD',
    rates: [{
      providerId: 'openai',
      modelId,
      modelAliases: [modelId],
      currency: 'USD',
      unitScale: 1_000_000,
      basis: 'image_tokens',
      textInputMicrosPerUnit: 5_000_000,
      imageInputMicrosPerUnit: 8_000_000,
      imageOutputMicrosPerUnit: 30_000_000,
    }],
  });
}

/** Images endpoint list prices reviewed on 2026-11-05 for GPT Image 2.6 Flare and Sunburst, and re-reviewed for the 2.5 models. */
export const PRICE_CATALOGS_2026_11_05: UsagePriceVersion[] = [
  imageVersion('openai-image-gpt-image-2.6-flare_2026-11-05', 'gpt-image-2.6-flare'),
  imageVersion('openai-image-gpt-image-2.6-sunburst_2026-11-05', 'gpt-image-2.6-sunburst'),
  imageVersion('openai-image-gpt-image-2.5-flare_2026-11-05', 'gpt-image-2.5-flare'),
  imageVersion('openai-image-gpt-image-2.5-sunburst_2026-11-05', 'gpt-image-2.5-sunburst'),
];
