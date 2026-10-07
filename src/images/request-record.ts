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

/** The image model's images-endpoint price at `at`, or null when it has none or it is stale. */
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

/**
 * One image request that reached the provider, as a model request record.
 * The record keeps the input and output totals; its price applies the text
 * and image input rates to the parts the provider reported.
 */
export function imageRequestRecord(end: ImageRequestEnd): ModelRequestRecord {
  const { usage } = end.result;
  const price = imageUsagePrice(end, usage);
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
    finishedAt: end.finishedAt,
  };
}

type PricedUsage =
  | { readonly amount: number; readonly priceVersionId: string }
  | { readonly unknown: NonNullable<UsageEstimateResult['priceUnknownReason']> };

function imageUsagePrice(end: ImageRequestEnd, usage: ImageCallUsage | undefined): PricedUsage {
  const matched = priceCatalogFor('image_tokens', end.provider, end.model, end.finishedAt);
  if (!matched) return { unknown: 'price_unknown' };
  if (end.finishedAt >= matched.version.staleAfter) return { unknown: 'price_stale' };
  // Refused by the provider with no usage reported: nothing was made to bill.
  if (!usage && !end.result.ok && !end.result.usageUnavailable) {
    return { amount: 0, priceVersionId: matched.version.id };
  }
  const parts = usage && imageTokenParts(usage);
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

/** Null unless every reported token falls in a part the image rates price. */
function imageTokenParts(
  usage: ImageCallUsage,
): { textInput: number; imageInput: number; imageOutput: number } | null {
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (input === undefined || output === undefined) return null;
  const textInput = usage.input_tokens_details?.text_tokens ?? 0;
  const imageInput = usage.input_tokens_details?.image_tokens ?? 0;
  if (textInput + imageInput !== input) return null;
  // The images endpoint publishes no text output rate.
  if ((usage.output_tokens_details?.text_tokens ?? 0) > 0) return null;
  return { textInput, imageInput, imageOutput: output };
}

function outcomeOf(result: ImageCallResult): ModelRequestOutcome {
  if (result.ok) return 'completed';
  return result.reason === 'timeout' ? 'stopped' : 'error';
}
