import type { PlatformEnv } from '../../config/state-backend.ts';
import type { RecordUsageTerminalInput } from '../types.ts';
import { priceCatalogFor } from './catalog.ts';
import type { UsageEstimateResult } from './types.ts';

export function usageEstimatesEnabled(
  platformEnv?: PlatformEnv,
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = platformEnv?.USAGE_ESTIMATES ?? processEnv.USAGE_ESTIMATES;
  return value === undefined || value === '1' || value === 'true';
}

interface UsageEstimateInput extends Pick<
  RecordUsageTerminalInput,
  | 'observedAt'
  | 'providerRoute'
  | 'returnedProvider'
  | 'requestedProvider'
  | 'returnedModel'
  | 'requestedModel'
  | 'usageCompleteness'
  | 'inputTokens'
  | 'outputTokens'
> {
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  /** The part of `cacheWriteTokens` written for one hour. */
  cacheWrite1hTokens?: number | null;
  totalTokens?: number | null;
}

export function estimateUsage(input: UsageEstimateInput): UsageEstimateResult {
  if (
    input.usageCompleteness !== 'complete' ||
    input.inputTokens === null ||
    input.outputTokens === null
  ) {
    return unknown('pricing_dimension_unknown', input.usageCompleteness === 'partial' ? 'partial' : 'unknown');
  }
  const oneHourWrites = input.cacheWrite1hTokens ?? 0;
  const provider = input.returnedProvider ?? input.providerRoute ?? input.requestedProvider;
  const model = input.returnedModel ?? input.requestedModel;
  const matched = provider && model
    ? priceCatalogFor('standard_input_output', provider, model, input.observedAt)
    : null;
  // Decided before any other outcome: the store keeps no one-hour count, so
  // this measurement must never read as `price_unknown` or `price_stale`,
  // which a later release's backfill would price at the 5-minute rate.
  if (
    oneHourWrites > 0 &&
    (!matched ||
      input.observedAt >= matched.version.staleAfter ||
      matched.rate.cacheWrite1hMicrosPerUnit === undefined)
  ) return unknown('pricing_dimension_unknown', 'partial');
  if (!provider || !model) return unknown('pricing_dimension_unknown');
  if (!matched) return unknown('price_unknown');
  if (input.observedAt >= matched.version.staleAfter) return unknown('price_stale');
  const { rate } = matched;
  const cache = cacheUsage(input);
  if (!cache || oneHourWrites > cache.write) return unknown('pricing_dimension_unknown', 'partial');
  const fiveMinuteWrites = cache.write - oneHourWrites;
  // A measurement can total several requests, so a total past the threshold
  // does not show that any one request crossed it.
  if (
    rate.longContext &&
    input.inputTokens + cache.read + cache.write >= rate.longContext.fromPromptTokens
  ) return unknown('pricing_dimension_unknown', 'partial');
  if (
    (cache.read > 0 && rate.cacheReadMicrosPerUnit === undefined) ||
    (fiveMinuteWrites > 0 && rate.cacheWriteMicrosPerUnit === undefined)
  ) return unknown('pricing_dimension_unknown', 'partial');
  const amount = Math.round(
    (input.inputTokens * rate.inputMicrosPerUnit +
      input.outputTokens * rate.outputMicrosPerUnit +
      cache.read * (rate.cacheReadMicrosPerUnit ?? 0) +
      fiveMinuteWrites * (rate.cacheWriteMicrosPerUnit ?? 0) +
      oneHourWrites * (rate.cacheWrite1hMicrosPerUnit ?? 0)) /
      rate.unitScale,
  );
  return {
    estimateCompleteness: 'complete',
    estimateAmountMicros: amount,
    estimateCurrency: rate.currency,
    priceVersionId: matched.version.id,
    priceUnknownReason: null,
  };
}

function cacheUsage(input: Pick<
  UsageEstimateInput,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'totalTokens'
>): { read: number; write: number } | null {
  const read = input.cacheReadTokens;
  const write = input.cacheWriteTokens;
  if (read !== undefined && read !== null && write !== undefined && write !== null) {
    return { read, write };
  }
  if (input.inputTokens === null || input.outputTokens === null || input.totalTokens == null) {
    return read == null && write == null ? { read: 0, write: 0 } : null;
  }
  const unclassified = input.totalTokens - input.inputTokens - input.outputTokens - (read ?? 0) - (write ?? 0);
  if (unclassified < 0) return null;
  if (read == null && write == null) return unclassified === 0 ? { read: 0, write: 0 } : null;
  return read == null
    ? { read: unclassified, write: write ?? 0 }
    : { read, write: unclassified };
}

export function notPriced(): UsageEstimateResult {
  return {
    estimateCompleteness: 'not_priced',
    estimateAmountMicros: null,
    estimateCurrency: null,
    priceVersionId: null,
    priceUnknownReason: 'price_unknown',
  };
}

function unknown(
  reason: 'price_unknown' | 'price_stale' | 'pricing_dimension_unknown',
  completeness: 'unknown' | 'partial' = 'unknown',
): UsageEstimateResult {
  return {
    estimateCompleteness: completeness,
    estimateAmountMicros: null,
    estimateCurrency: null,
    priceVersionId: null,
    priceUnknownReason: reason,
  };
}
