import type {
  ModelRequestAttribution,
  ModelRequestFundingSource,
  ModelRequestOutcome,
  ModelRequestRecord,
} from '../usage/model-requests.ts';
import { priceCatalogFor } from '../usage/pricing/catalog.ts';
import type { ImagePriceRate, UsageEstimateResult, UsagePriceVersion } from '../usage/pricing/types.ts';
import type { ImageCallResult, ImageCallUsage } from './openai-images-client.ts';

export interface ImagePrice {
  readonly version: UsagePriceVersion;
  readonly rate: ImagePriceRate;
}

export function currentImagePrice(provider: string, model: string, at: number): ImagePrice | null {
  const price = priceCatalogFor('image_tokens', provider, model, at);
  return price && at < price.version.staleAfter ? price : null;
}

export interface ImageRequestEnd {
  readonly requestId: string;
  readonly attribution: ModelRequestAttribution;
  readonly provider: string;
  readonly model: string;
  readonly fundingSource: ModelRequestFundingSource;
  readonly result: ImageCallResult;
  readonly finishedAt: number;
}

export function sentImageRequestRecord(end: ImageRequestEnd): ModelRequestRecord {
  const billed = end.result.ok ? end.result.usage ?? 'unknown' : end.result.billed;
  const usage = typeof billed === 'object' ? billed : undefined;
  const price = imageUsagePrice(end, billed);
  return {
    requestId: end.requestId,
    installationId: end.attribution.installationId,
    runId: end.attribution.runId,
    attemptId: end.attribution.attemptId,
    agentId: end.attribution.agentId,
    provider: end.provider,
    model: end.model,
    fundingSource: end.fundingSource,
    outcome: outcomeOf(end.result),
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: { total: usage?.output_tokens ?? 0, reasoning: null },
    cacheReadTokens: 0,
    cacheWriteTokens: { total: 0, oneHour: null },
    priceVersionId: 'amount' in price ? price.priceVersionId : null,
    listPriceUsdMicros: 'amount' in price ? price.amount : null,
    priceUnknownReason: 'amount' in price ? null : price.unknown,
    providerCostUsdMicros: null,
    providerResponseId: null,
    providerServiceTier: null,
    providerInferenceGeo: null,
    finishedAt: end.finishedAt,
  };
}

type PricedUsage =
  | { readonly amount: number; readonly priceVersionId: string }
  | { readonly unknown: NonNullable<UsageEstimateResult['priceUnknownReason']> };

function imageUsagePrice(end: ImageRequestEnd, billed: ImageCallUsage | 'unknown' | undefined): PricedUsage {
  const matched = priceCatalogFor('image_tokens', end.provider, end.model, end.finishedAt);
  if (!matched) return { unknown: 'price_unknown' };
  if (end.finishedAt >= matched.version.staleAfter) return { unknown: 'price_stale' };
  if (billed === undefined) return { amount: 0, priceVersionId: matched.version.id };
  const parts = billed !== 'unknown' && imageTokenParts(billed);
  if (!parts) return { unknown: 'pricing_dimension_unknown' };
  const { rate } = matched;
  const amount = Math.round(
    (parts.textInput * rate.textInputMicrosPerUnit +
      parts.imageInput * rate.imageInputMicrosPerUnit +
      parts.imageOutput * rate.imageOutputMicrosPerUnit) /
      rate.unitScale,
  );
  return { amount, priceVersionId: matched.version.id };
}

function imageTokenParts(
  usage: ImageCallUsage,
): { textInput: number; imageInput: number; imageOutput: number } | null {
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (input === undefined || output === undefined) return null;
  const textInput = usage.input_tokens_details?.text_tokens ?? 0;
  const imageInput = usage.input_tokens_details?.image_tokens ?? 0;
  if (textInput + imageInput !== input) return null;
  if ((usage.output_tokens_details?.text_tokens ?? 0) > 0) return null;
  return { textInput, imageInput, imageOutput: output };
}

function outcomeOf(result: ImageCallResult): ModelRequestOutcome {
  if (result.ok) return 'completed';
  return result.reason === 'timeout' ? 'stopped' : 'error';
}
