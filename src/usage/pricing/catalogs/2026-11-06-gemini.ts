import type { UsagePriceVersion } from '../types.ts';
import { GOOGLE_PRICING_URL } from './review.ts';
import { version } from './version.ts';

const REVIEWED_AT = Date.UTC(2026, 10, 6);
const DAY = 24 * 60 * 60 * 1_000;
const ARGON_PRICE_RISES_AT = Date.UTC(2026, 11, 1);
const FLASH_PRICE_RISES_AT = Date.UTC(2027, 0, 1);

/** Micros per 1M tokens on Google's standard paid tier. Google publishes no cache-write price. */
interface GeminiRates {
  input: number;
  output: number;
  cacheRead: number;
}

function geminiVersion(
  modelId: string,
  effectiveFrom: number,
  reviewDueAt: number,
  rates: GeminiRates,
): UsagePriceVersion {
  return version({
    id: `google-${modelId}_${new Date(effectiveFrom).toISOString().slice(0, 10)}`,
    providerId: 'google',
    sourceUrl: GOOGLE_PRICING_URL,
    effectiveFrom,
    reviewedAt: REVIEWED_AT,
    reviewDueAt,
    currency: 'USD',
    rates: [{
      providerId: 'google',
      modelId,
      modelAliases: [modelId],
      currency: 'USD',
      unitScale: 1_000_000,
      basis: 'standard_input_output',
      inputMicrosPerUnit: rates.input,
      outputMicrosPerUnit: rates.output,
      cacheReadMicrosPerUnit: rates.cacheRead,
    }],
  });
}

/**
 * Gemini list prices read from Google's pricing page on 2026-11-06. Gemini 4
 * Argon's and Gemini 3.8 Flash's introductory prices end on dates Google
 * names, so each later price ships now and takes effect on its date. An
 * introductory price is due for review the day it ends.
 */
export const PRICE_CATALOGS_2026_11_06_GEMINI: UsagePriceVersion[] = [
  geminiVersion('gemini-4-argon', REVIEWED_AT, ARGON_PRICE_RISES_AT,
    { input: 2_000_000, output: 10_000_000, cacheRead: 100_000 }),
  geminiVersion('gemini-4-argon', ARGON_PRICE_RISES_AT, ARGON_PRICE_RISES_AT + 90 * DAY,
    { input: 4_000_000, output: 20_000_000, cacheRead: 200_000 }),
  geminiVersion('gemini-3.8-flash', REVIEWED_AT, FLASH_PRICE_RISES_AT,
    { input: 750_000, output: 3_750_000, cacheRead: 75_000 }),
  geminiVersion('gemini-3.8-flash', FLASH_PRICE_RISES_AT, FLASH_PRICE_RISES_AT + 90 * DAY,
    { input: 1_500_000, output: 7_500_000, cacheRead: 150_000 }),
  geminiVersion('gemini-3.5-flash-lite', REVIEWED_AT, REVIEWED_AT + 90 * DAY,
    { input: 300_000, output: 2_500_000, cacheRead: 30_000 }),
];
