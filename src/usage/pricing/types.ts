interface PriceRateIdentity {
  priceVersionId: string;
  providerId: string;
  modelId: string;
  modelAliases: string[];
  currency: 'USD';
  unitScale: 1_000_000;
}

/** Rates for a request whose prompt reaches `fromPromptTokens`; they replace the base rates for the whole request. */
export interface LongContextRates {
  fromPromptTokens: number;
  inputMicrosPerUnit: number;
  outputMicrosPerUnit: number;
  cacheReadMicrosPerUnit?: number;
  cacheWriteMicrosPerUnit?: number;
}

export interface TokenPriceRate extends PriceRateIdentity {
  basis: 'standard_input_output';
  inputMicrosPerUnit: number;
  outputMicrosPerUnit: number;
  cacheReadMicrosPerUnit?: number;
  /** The 5-minute write rate, which is also the provider's only write rate when it has no 1-hour cache. */
  cacheWriteMicrosPerUnit?: number;
  cacheWrite1hMicrosPerUnit?: number;
  longContext?: LongContextRates;
}

/** Image generation, metered in the images endpoint's `usage` token fields. */
export interface ImagePriceRate extends PriceRateIdentity {
  basis: 'image_tokens';
  textInputMicrosPerUnit: number;
  imageInputMicrosPerUnit: number;
  imageOutputMicrosPerUnit: number;
}

export type UsagePriceRate = TokenPriceRate | ImagePriceRate;

export interface UsagePriceVersion {
  id: string;
  providerId: string;
  sourceUrl: string;
  effectiveFrom: number;
  reviewedAt: number;
  staleAfter: number;
  currency: 'USD';
  contentHash: string;
  rates: UsagePriceRate[];
}

export interface UsageEstimateResult {
  estimateCompleteness: 'complete' | 'partial' | 'unknown' | 'not_priced';
  estimateAmountMicros: number | null;
  estimateCurrency: string | null;
  priceVersionId: string | null;
  priceUnknownReason: 'price_unknown' | 'price_stale' | 'pricing_dimension_unknown' | null;
}
