import type { UsagePriceRate, UsagePriceVersion } from '../types.ts';
import { type RateInput, version } from './version.ts';

export const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
export const GOOGLE_PRICING_URL = 'https://aistudio.google.com/docs/pricing';
export const openRouterEndpointsUrl = (modelId: string) => `https://openrouter.ai/api/v1/models/${modelId}/endpoints`;
export const openAiModelUrl = (modelId: string) => `https://developers.openai.com/api/docs/models/${modelId}.md`;
export const cloudflareModelUrl = (modelId: string) =>
  `https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/workers-ai-models/${modelId.slice(modelId.lastIndexOf('/') + 1)}.json`;

/** Row rate names and the rate fields they fill, in the order the hashes pin. */
export const TOKEN_FIELDS = {
  input: 'inputMicrosPerUnit',
  output: 'outputMicrosPerUnit',
  cacheRead: 'cacheReadMicrosPerUnit',
  cacheWrite: 'cacheWriteMicrosPerUnit',
  cacheWrite1h: 'cacheWrite1hMicrosPerUnit',
} as const;
export const IMAGE_FIELDS = {
  textInput: 'textInputMicrosPerUnit',
  imageInput: 'imageInputMicrosPerUnit',
  imageOutput: 'imageOutputMicrosPerUnit',
} as const;

type TokenRates = { input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number };
export type ReviewRates =
  | TokenRates & { longContext?: TokenRates & { fromPromptTokens: number } }
  | { textInput: number; imageInput: number; imageOutput: number };

/** Micros per 1M tokens. Aliases default to `[modelId]`; `reviewDueAt` overrides the catalog's due date. */
export type ReviewRow = [
  providerId: string,
  modelId: string,
  source: string | ((modelId: string) => string),
  rates: ReviewRates,
  options?: { aliases?: string[]; reviewDueAt?: number },
];

/** Review catalogs derive their ids with this, so changing it changes their released hashes. */
export function reviewVersionId(providerId: string, basis: UsagePriceRate['basis'], modelId: string, at: number): string {
  const model = modelId.replace(/^@cf\//, '').replace(/[^a-z0-9.]+/g, '-');
  return `${providerId}${basis === 'image_tokens' ? '-image' : ''}-${model}_${new Date(at).toISOString().slice(0, 10)}-review`;
}

/** One single-rate version per row, reviewed and effective at `at`, built exactly as the verbose `version()` input. */
export function reviewVersions(at: number, reviewDueAt: number, rows: readonly ReviewRow[]): UsagePriceVersion[] {
  return rows.map(([providerId, modelId, source, rates, options = {}]) => {
    const basis = 'imageOutput' in rates ? 'image_tokens' : 'standard_input_output';
    const long = 'longContext' in rates ? rates.longContext : undefined;
    const rate = {
      providerId,
      modelId,
      modelAliases: options.aliases ?? [modelId],
      currency: 'USD',
      unitScale: 1_000_000,
      basis,
      ...micros(rates, basis === 'image_tokens' ? IMAGE_FIELDS : TOKEN_FIELDS),
      ...(long && { longContext: { fromPromptTokens: long.fromPromptTokens, ...micros(long, TOKEN_FIELDS) } }),
    } as RateInput;
    return version({
      id: reviewVersionId(providerId, basis, modelId, at),
      providerId,
      sourceUrl: typeof source === 'string' ? source : source(modelId),
      effectiveFrom: at,
      reviewedAt: at,
      reviewDueAt: options.reviewDueAt ?? reviewDueAt,
      currency: 'USD',
      rates: [rate],
    });
  });
}

function micros(rates: object, fields: Record<string, string>): Record<string, number> {
  const values = rates as Record<string, number | undefined>;
  return Object.fromEntries(
    Object.entries(fields).filter(([name]) => values[name] !== undefined).map(([name, field]) => [field, values[name]!]),
  );
}
