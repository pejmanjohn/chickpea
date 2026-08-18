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
  const provider = input.returnedProvider ?? input.providerRoute ?? input.requestedProvider;
  const model = input.returnedModel ?? input.requestedModel;
  if (!provider || !model) return unknown('pricing_dimension_unknown');
  const matched = priceCatalogFor(provider, model, input.observedAt);
  if (!matched) return unknown('price_unknown');
  if (input.observedAt >= matched.version.staleAfter) return unknown('price_stale');
  const cache = cacheUsage(input);
  if (!cache) return unknown('pricing_dimension_unknown', 'partial');
  if (
    (cache.read > 0 && matched.rate.cacheReadMicrosPerUnit === undefined) ||
    (cache.write > 0 && matched.rate.cacheWriteMicrosPerUnit === undefined)
  ) return unknown('pricing_dimension_unknown', 'partial');
  const amount = Math.round(
    (input.inputTokens * matched.rate.inputMicrosPerUnit +
      input.outputTokens * matched.rate.outputMicrosPerUnit +
      cache.read * (matched.rate.cacheReadMicrosPerUnit ?? 0) +
      cache.write * (matched.rate.cacheWriteMicrosPerUnit ?? 0)) /
      matched.rate.unitScale,
  );
  return {
    estimateCompleteness: 'complete',
    estimateAmountMicros: amount,
    estimateCurrency: matched.rate.currency,
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
