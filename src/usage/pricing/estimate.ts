import type { PlatformEnv } from '../../config/state-backend.ts';
import type { RecordUsageTerminalInput } from '../types.ts';
import { priceCatalogFor } from './catalog.ts';
import type { UsageEstimateResult } from './types.ts';

export function usageEstimatesEnabled(
  platformEnv?: PlatformEnv,
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = platformEnv?.USAGE_ESTIMATES ?? processEnv.USAGE_ESTIMATES;
  return value === '1' || value === 'true';
}

export function estimateUsage(
  input: Pick<
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
  >,
): UsageEstimateResult {
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
  const amount = Math.round(
    (input.inputTokens * matched.rate.inputMicrosPerUnit +
      input.outputTokens * matched.rate.outputMicrosPerUnit) /
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
