export interface UsagePriceRate {
  priceVersionId: string;
  providerId: string;
  modelId: string;
  modelAliases: string[];
  currency: 'USD';
  unitScale: 1_000_000;
  inputMicrosPerUnit: number;
  outputMicrosPerUnit: number;
  basis: 'standard_input_output';
}

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
