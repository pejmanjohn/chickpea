import type { PlatformEnv } from '../../config/state-backend.ts';
import type { RecordUsageTerminalInput, UsageMeasurement } from '../types.ts';
import { canonicalPriceProviderId, priceCatalogFor, RELEASE_PRICE_CATALOGS } from './catalog.ts';
import type { TokenPriceRate, UsageEstimateResult, UsagePriceVersion } from './types.ts';

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
  /** The usage of exactly one request, whose prompt alone decides a long-context tier. */
  singleRequest?: boolean;
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
  // this measurement must never read as `price_unknown`, which a later
  // release's backfill would price at the 5-minute rate.
  if (oneHourWrites > 0 && (!matched || matched.rate.cacheWrite1hMicrosPerUnit === undefined)) {
    return unknown('pricing_dimension_unknown', 'partial');
  }
  if (!provider || !model) return unknown('pricing_dimension_unknown');
  if (!matched) return unknown('price_unknown');
  let { rate } = matched;
  const cache = cacheUsage(input);
  if (!cache || oneHourWrites > cache.write) return unknown('pricing_dimension_unknown', 'partial');
  const fiveMinuteWrites = cache.write - oneHourWrites;
  if (rate.longContext && input.inputTokens + cache.read + cache.write >= rate.longContext.fromPromptTokens) {
    // A measurement can total several requests, so a total past the threshold
    // does not show that any one request crossed it.
    if (!input.singleRequest) return unknown('pricing_dimension_unknown', 'partial');
    const { fromPromptTokens: _from, ...longContext } = rate.longContext;
    const {
      cacheReadMicrosPerUnit: _read, cacheWriteMicrosPerUnit: _write, cacheWrite1hMicrosPerUnit: _oneHour,
      longContext: _tier, ...identity
    } = rate;
    rate = { ...identity, ...longContext };
  }
  if (
    (cache.read > 0 && rate.cacheReadMicrosPerUnit === undefined) ||
    (fiveMinuteWrites > 0 && rate.cacheWriteMicrosPerUnit === undefined) ||
    (oneHourWrites > 0 && rate.cacheWrite1hMicrosPerUnit === undefined)
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

/** The tokens of one type an estimate priced, and what they cost. */
export interface TokenTypeCost {
  tokens: number;
  micros: number;
}

/** A complete USD estimate split by token type. The costs are non-negative and sum exactly to the estimate. */
export interface EstimateByTokenType {
  input: TokenTypeCost;
  output: TokenTypeCost;
  cacheRead: TokenTypeCost;
  cacheWrite: TokenTypeCost;
}

// Rounding three parts and the total separately leaves them at most this far apart.
const ROUNDING_MICROS = 2;

/**
 * Splits a stored estimate by token type at the rates of the price version
 * that priced it. Cache writes take what the other parts leave, because the
 * store keeps no one-hour write count and the amount may price some writes
 * at the one-hour rate. Null when the rates cannot account for the amount.
 */
export function estimateByTokenType(
  measurement: Pick<
    UsageMeasurement,
    | 'estimateCompleteness'
    | 'estimateCurrency'
    | 'estimateAmountMicros'
    | 'priceVersionId'
    | 'returnedProvider'
    | 'providerRoute'
    | 'requestedProvider'
    | 'returnedModel'
    | 'requestedModel'
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheReadTokens'
    | 'cacheWriteTokens'
    | 'totalTokens'
  >,
  catalogs: readonly UsagePriceVersion[] = RELEASE_PRICE_CATALOGS,
): EstimateByTokenType | null {
  const { estimateAmountMicros: amount, inputTokens, outputTokens } = measurement;
  if (
    measurement.estimateCompleteness !== 'complete' ||
    measurement.estimateCurrency !== 'USD' ||
    amount === null ||
    measurement.priceVersionId === null ||
    inputTokens === null ||
    outputTokens === null
  ) return null;
  const provider = measurement.returnedProvider ?? measurement.providerRoute ?? measurement.requestedProvider;
  const model = measurement.returnedModel ?? measurement.requestedModel;
  if (!provider || !model) return null;
  const version = catalogs.find((candidate) => candidate.id === measurement.priceVersionId);
  if (version?.providerId !== canonicalPriceProviderId(provider)) return null;
  const rate = version.rates.find((candidate): candidate is TokenPriceRate =>
    candidate.basis === 'standard_input_output' && candidate.modelAliases.includes(model));
  const cache = cacheUsage(measurement);
  if (!rate || !cache) return null;
  if (rate.longContext && inputTokens + cache.read + cache.write >= rate.longContext.fromPromptTokens) return null;
  if (
    (cache.read > 0 && rate.cacheReadMicrosPerUnit === undefined) ||
    (cache.write > 0 && rate.cacheWriteMicrosPerUnit === undefined)
  ) return null;
  const cost = (tokens: number, microsPerUnit = 0) => tokens * microsPerUnit / rate.unitScale;
  const micros = {
    input: Math.round(cost(inputTokens, rate.inputMicrosPerUnit)),
    output: Math.round(cost(outputTokens, rate.outputMicrosPerUnit)),
    cacheRead: Math.round(cost(cache.read, rate.cacheReadMicrosPerUnit)),
    cacheWrite: 0,
  };
  const writes = amount - micros.input - micros.output - micros.cacheRead;
  const fiveMinute = cost(cache.write, rate.cacheWriteMicrosPerUnit);
  const oneHour = cost(cache.write, rate.cacheWrite1hMicrosPerUnit ?? rate.cacheWriteMicrosPerUnit);
  if (writes < fiveMinute - ROUNDING_MICROS || writes > oneHour + ROUNDING_MICROS) return null;
  if (cache.write > 0 && writes >= 0) {
    micros.cacheWrite = writes;
  } else {
    // What is left is rounding, which the largest part absorbs.
    const largest = (['output', 'cacheRead', 'input'] as const)
      .reduce((top, key) => micros[key] > micros[top] ? key : top);
    micros[largest] += writes;
    if (micros[largest] < 0) return null;
  }
  return {
    input: { tokens: inputTokens, micros: micros.input },
    output: { tokens: outputTokens, micros: micros.output },
    cacheRead: { tokens: cache.read, micros: micros.cacheRead },
    cacheWrite: { tokens: cache.write, micros: micros.cacheWrite },
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
  reason: NonNullable<UsageEstimateResult['priceUnknownReason']>,
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
