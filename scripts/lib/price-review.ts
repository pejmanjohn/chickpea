import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRecord } from '../../src/security/content-validation.ts';
import { RELEASE_PRICE_CATALOGS } from '../../src/usage/pricing/catalog.ts';
import { version } from '../../src/usage/pricing/catalogs/version.ts';
import { currentPrices, type CurrentPrice } from '../../src/usage/pricing/review-due.ts';
import type { UsagePriceRate, UsagePriceVersion } from '../../src/usage/pricing/types.ts';

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAY = 24 * 60 * 60 * 1_000;
export const REVIEW_INTERVAL_DAYS = 90;

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
export const openRouterEndpointsUrl = (modelId: string) => `https://openrouter.ai/api/v1/models/${modelId}/endpoints`;
export const openAiModelUrl = (modelId: string) => `https://developers.openai.com/api/docs/models/${modelId}.md`;
export const cloudflareModelUrl = (modelId: string) =>
  `https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/workers-ai-models/${modelId.slice(modelId.lastIndexOf('/') + 1)}.json`;

const TOKEN_FIELDS = {
  input: 'inputMicrosPerUnit',
  output: 'outputMicrosPerUnit',
  cacheRead: 'cacheReadMicrosPerUnit',
  cacheWrite: 'cacheWriteMicrosPerUnit',
  cacheWrite1h: 'cacheWrite1hMicrosPerUnit',
} as const;
const IMAGE_FIELDS = {
  textInput: 'textInputMicrosPerUnit',
  imageInput: 'imageInputMicrosPerUnit',
  imageOutput: 'imageOutputMicrosPerUnit',
} as const;
type TokenField = keyof typeof TOKEN_FIELDS;
type ImageField = keyof typeof IMAGE_FIELDS;
export type PriceField = TokenField | ImageField | 'longContext.fromPromptTokens' | `longContext.${TokenField}`;
const THRESHOLD: PriceField = 'longContext.fromPromptTokens';

/** A source's value for one field, in micros per 1M tokens (or prompt tokens for the threshold). */
export type Observation = { value: number; derived?: string } | { notWhole: string };

export interface SourceReading {
  source: string;
  url: string;
  /** The catalog provider's own price page, preferred as the new version's `sourceUrl`. */
  own: boolean;
  values: Partial<Record<PriceField, Observation>>;
  /** Why the source gave no values at all. */
  problem?: string;
  notes: string[];
}

export interface ObservedValue {
  source: string;
  url: string;
  value?: number;
  notWhole?: string;
  derived?: string;
}

export interface FieldCheck {
  field: PriceField;
  catalog: number;
  observed: ObservedValue[];
  outcome: 'confirmed' | 'changed' | 'unverified';
  proposed?: number;
  reason?: string;
}

type RateInput = UsagePriceRate extends infer Rate
  ? Rate extends UsagePriceRate ? Omit<Rate, 'priceVersionId'> : never
  : never;

export interface ProposedVersion {
  id: string;
  sourceUrl: string;
  reviewDueAt: number;
  rate: RateInput;
}

export type Verdict = 'current' | 'unchanged' | 'changed' | 'unverified' | 'accepted';

export interface PriceReview {
  providerId: string;
  basis: UsagePriceRate['basis'];
  modelId: string;
  priceVersionId: string;
  reviewedAt: string;
  reviewDueAt: string;
  verdict: Verdict;
  reasons: string[];
  notes: string[];
  fields: FieldCheck[];
  sources: Array<{ source: string; url: string; problem?: string }>;
  proposal?: ProposedVersion;
}

export interface PriceReviewResult {
  runAt: string;
  counts: Record<Verdict, number>;
  prices: PriceReview[];
}

export class PriceReviewUsageError extends Error {}
export class PriceReviewWriteRefused extends Error {}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** `--accept provider/model[@YYYY-MM-DD]` values, keyed `provider/model`, with the due date when one was given. */
export function parseAccepts(values: readonly string[], at: number): Map<string, number | undefined> {
  const accepts = new Map<string, number | undefined>();
  for (const value of values) {
    const dated = /^(.+)@(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const key = dated?.[1] ?? value;
    let dueAt: number | undefined;
    if (dated) {
      const [, , year, month, day] = dated;
      dueAt = Date.UTC(Number(year), Number(month) - 1, Number(day));
      if (new Date(dueAt).toISOString().slice(0, 10) !== `${year}-${month}-${day}`) {
        throw new PriceReviewUsageError(`--accept ${value}: ${year}-${month}-${day} is not a date`);
      }
      if (dueAt <= at) throw new PriceReviewUsageError(`--accept ${value}: the due date must be after the run`);
    }
    const slash = key.indexOf('/');
    if (slash <= 0 || slash === key.length - 1) {
      throw new PriceReviewUsageError(`--accept ${value}: expected <provider>/<model>[@YYYY-MM-DD]`);
    }
    accepts.set(key, dueAt);
  }
  return accepts;
}

/**
 * Compares every current price with its sources. Only fields the catalog holds
 * are compared; a change needs two sources that agree with each other.
 */
export async function reviewPrices(options: {
  at: number;
  fetchImpl?: FetchImpl;
  accepts?: ReadonlyMap<string, number | undefined>;
  prices?: readonly CurrentPrice[];
}): Promise<PriceReviewResult> {
  const { at } = options;
  const accepts = options.accepts ?? new Map<string, number | undefined>();
  const prices = options.prices ?? currentPrices(at);
  const unknown = [...accepts.keys()].filter((key) =>
    !prices.some((price) => `${price.providerId}/${price.modelId}` === key));
  if (unknown.length > 0) {
    throw new PriceReviewUsageError(`--accept names no current price: ${unknown.join(', ')}`);
  }
  const sources = new Sources(options.fetchImpl ?? fetch);
  const reviews = await Promise.all(sortPrices(prices).map((price) => reviewPrice(price, at, accepts, sources)));
  const counts: Record<Verdict, number> = { current: 0, unchanged: 0, changed: 0, unverified: 0, accepted: 0 };
  for (const review of reviews) counts[review.verdict] += 1;
  return { runAt: new Date(at).toISOString(), counts, prices: reviews };
}

function sortPrices(prices: readonly CurrentPrice[]): CurrentPrice[] {
  return [...prices].sort((left, right) =>
    left.providerId.localeCompare(right.providerId) ||
    left.modelId.localeCompare(right.modelId) ||
    left.rate.basis.localeCompare(right.rate.basis));
}

async function reviewPrice(
  price: CurrentPrice,
  at: number,
  accepts: ReadonlyMap<string, number | undefined>,
  sources: Sources,
): Promise<PriceReview> {
  const { providerId, modelId, version: current, rate } = price;
  const review: PriceReview = {
    providerId,
    basis: rate.basis,
    modelId,
    priceVersionId: current.id,
    reviewedAt: new Date(current.reviewedAt).toISOString(),
    reviewDueAt: new Date(current.reviewDueAt).toISOString(),
    verdict: 'unverified',
    reasons: [],
    notes: [],
    fields: [],
    sources: [],
  };
  const key = `${providerId}/${modelId}`;
  if (utcDay(current.reviewedAt) === utcDay(at)) {
    review.verdict = 'current';
    if (accepts.has(key)) review.notes.push('--accept ignored: this price was already reviewed today');
    return review;
  }

  const readings = await Promise.all(sourcesFor(price).map((read) => read(sources)));
  review.sources = readings.map(({ source, url, problem }) => (problem ? { source, url, problem } : { source, url }));
  const catalog = catalogFields(rate);
  review.fields = [...catalog].map(([field, value]) => checkField(field, value, readings));
  for (const reading of readings) {
    review.notes.push(...reading.notes.map((note) => `${reading.source}: ${note}`));
    for (const [field, observation] of Object.entries(reading.values) as Array<[PriceField, Observation]>) {
      if (catalog.has(field) || ('derived' in observation && observation.derived)) continue;
      review.notes.push(`${reading.source} lists ${field} ${describe(field, observation)}, which the catalog does not hold (${reading.url})`);
    }
  }

  const problems = review.fields.filter(({ outcome }) => outcome === 'unverified');
  const changes = review.fields.filter(({ outcome }) => outcome === 'changed');
  const earlyDue = current.reviewDueAt - current.reviewedAt < REVIEW_INTERVAL_DAYS * DAY;
  const proposedFields = new Map(review.fields.map(({ field, catalog: value, proposed }) => [field, proposed ?? value]));

  // A hand check renews the catalog's numbers, so it must not override two sources that agree on new ones.
  if (accepts.has(key) && changes.length > 0) {
    review.reasons.push(
      ...changes.map((change) => `sources agree on a new price, so --accept cannot renew the old one: ${describeChange(change)}`),
      ...problems.map(({ reason }) => reason ?? ''),
    );
    return review;
  }
  if (accepts.has(key)) {
    const dueAt = accepts.get(key);
    review.verdict = 'accepted';
    review.notes.push(...problems.map(({ reason }) => `sources: ${reason}`), ...changes.map((change) => `sources: ${describeChange(change)}`));
    review.proposal = proposal(price, catalog, readings, at, dueAt ?? at + REVIEW_INTERVAL_DAYS * DAY);
    return review;
  }
  if (earlyDue) {
    review.reasons.push(`the last review set an early due date (${review.reviewDueAt.slice(0, 10)}); check when its price ends by hand`);
  }
  review.reasons.push(...problems.map(({ reason }) => reason ?? ''));
  if (earlyDue || problems.length > 0) {
    review.reasons.push(...changes.map((change) => `sources would change ${describeChange(change)}`));
    if (problems.length === 0 && changes.length === 0) review.reasons.push('sources confirm every field');
    return review;
  }
  review.verdict = changes.length > 0 ? 'changed' : 'unchanged';
  review.proposal = proposal(price, proposedFields, readings, at, at + REVIEW_INTERVAL_DAYS * DAY);
  return review;
}

function checkField(field: PriceField, catalog: number, readings: readonly SourceReading[]): FieldCheck {
  const observed: ObservedValue[] = [];
  for (const { source, url, values } of readings) {
    const observation = values[field];
    if (!observation) continue;
    observed.push('notWhole' in observation
      ? { source, url, notWhole: observation.notWhole }
      : { source, url, value: observation.value, ...(observation.derived ? { derived: observation.derived } : {}) });
  }
  const check: FieldCheck = { field, catalog, observed, outcome: 'unverified' };
  const listed = observed.map((entry) => `${entry.source} ${describeObserved(field, entry)} (${entry.url})`).join('; ');
  if (observed.length === 0) {
    const tried = readings.map(({ source, url, problem }) => `${source}${problem ? `: ${problem}` : ''} (${url})`);
    return { ...check, reason: `${field}: no source lists it; tried ${tried.join('; ') || 'no source'}` };
  }
  if (observed.some((entry) => entry.notWhole !== undefined)) {
    return { ...check, reason: `${field}: not whole micros: ${listed}; catalog ${format(field, catalog)}` };
  }
  const differing = observed.filter((entry) => entry.value !== catalog);
  if (differing.length === 0) return { ...check, outcome: 'confirmed' };
  const values = new Set(differing.map((entry) => entry.value));
  if (differing.length < observed.length || values.size > 1) {
    return { ...check, reason: `${field}: sources disagree: ${listed}; catalog ${format(field, catalog)}` };
  }
  if (differing.length < 2) {
    return {
      ...check,
      reason: `${field}: only ${listed} differs from the catalog's ${format(field, catalog)}; a change needs two agreeing sources`,
    };
  }
  return { ...check, outcome: 'changed', proposed: differing[0]!.value! };
}

function proposal(
  price: CurrentPrice,
  fields: ReadonlyMap<PriceField, number>,
  readings: readonly SourceReading[],
  at: number,
  reviewDueAt: number,
): ProposedVersion {
  const own = readings.find((reading) => reading.own && confirms(reading, fields));
  const openRouter = readings.find((reading) => !reading.problem && reading.url.startsWith('https://openrouter.ai/'));
  return {
    id: reviewVersionId(price.providerId, price.rate.basis, price.modelId, at),
    sourceUrl: own?.url ?? openRouter?.url ?? price.version.sourceUrl,
    reviewDueAt,
    rate: rateWith(price.rate, fields),
  };
}

function confirms(reading: SourceReading, fields: ReadonlyMap<PriceField, number>): boolean {
  const reported = [...fields].filter(([field]) => reading.values[field]);
  return !reading.problem && reported.length > 0 && reported.every(([field, value]) => {
    const observation = reading.values[field]!;
    return 'value' in observation && observation.value === value;
  });
}

export function reviewVersionId(providerId: string, basis: UsagePriceRate['basis'], modelId: string, at: number): string {
  const model = modelId.replace(/^@cf\//, '').replace(/[^a-z0-9.]+/g, '-');
  return `${providerId}${basis === 'image_tokens' ? '-image' : ''}-${model}_${utcDay(at)}-review`;
}

function catalogFields(rate: UsagePriceRate): Map<PriceField, number> {
  const fields = new Map<PriceField, number>();
  if (rate.basis === 'image_tokens') {
    for (const [field, property] of Object.entries(IMAGE_FIELDS) as Array<[ImageField, keyof typeof rate]>) {
      fields.set(field, rate[property] as number);
    }
    return fields;
  }
  for (const [field, property] of Object.entries(TOKEN_FIELDS) as Array<[TokenField, (typeof TOKEN_FIELDS)[TokenField]]>) {
    const value = rate[property];
    if (value !== undefined) fields.set(field, value);
  }
  if (rate.longContext) {
    fields.set(THRESHOLD, rate.longContext.fromPromptTokens);
    for (const [field, property] of Object.entries(TOKEN_FIELDS) as Array<[TokenField, (typeof TOKEN_FIELDS)[TokenField]]>) {
      const value = rate.longContext[property];
      if (value !== undefined) fields.set(`longContext.${field}`, value);
    }
  }
  return fields;
}

/** The current rate's identity with `fields`' numbers, keys in one fixed order so the written file hashes the same. */
function rateWith(rate: UsagePriceRate, fields: ReadonlyMap<PriceField, number>): RateInput {
  const identity = {
    providerId: rate.providerId,
    modelId: rate.modelId,
    modelAliases: [...rate.modelAliases],
    currency: rate.currency,
    unitScale: rate.unitScale,
  };
  if (rate.basis === 'image_tokens') {
    return {
      ...identity,
      basis: 'image_tokens',
      textInputMicrosPerUnit: fields.get('textInput')!,
      imageInputMicrosPerUnit: fields.get('imageInput')!,
      imageOutputMicrosPerUnit: fields.get('imageOutput')!,
    };
  }
  const token = (prefix: '' | 'longContext.') => Object.fromEntries(
    (Object.entries(TOKEN_FIELDS) as Array<[TokenField, string]>)
      .filter(([field]) => fields.has(`${prefix}${field}`))
      .map(([field, property]) => [property, fields.get(`${prefix}${field}`)!]),
  ) as { inputMicrosPerUnit: number; outputMicrosPerUnit: number };
  const threshold = fields.get(THRESHOLD);
  return {
    ...identity,
    basis: 'standard_input_output',
    ...token(''),
    ...(threshold === undefined ? {} : { longContext: { fromPromptTokens: threshold, ...token('longContext.') } }),
  };
}

// ---- sources ----

type Read = (sources: Sources) => Promise<SourceReading>;

/** One fetch per URL per run, however many prices read it. */
class Sources {
  readonly #texts = new Map<string, Promise<{ text: string } | { error: string }>>();
  readonly #json = new Map<string, Promise<{ json: unknown } | { error: string }>>();
  readonly #fetch: FetchImpl;

  constructor(fetchImpl: FetchImpl) {
    this.#fetch = fetchImpl;
  }

  text(url: string): Promise<{ text: string } | { error: string }> {
    let pending = this.#texts.get(url);
    if (!pending) {
      pending = this.#fetch(url, { signal: AbortSignal.timeout(30_000) })
        .then(async (response) => response.ok
          ? { text: await response.text() }
          : { error: `HTTP ${response.status}` })
        .catch((error: unknown) => ({ error: `fetch failed: ${error instanceof Error ? error.message : String(error)}` }));
      this.#texts.set(url, pending);
    }
    return pending;
  }

  json(url: string): Promise<{ json: unknown } | { error: string }> {
    let pending = this.#json.get(url);
    if (!pending) {
      pending = this.text(url).then((fetched) => {
        if ('error' in fetched) return fetched;
        try {
          return { json: JSON.parse(fetched.text) as unknown };
        } catch {
          return { error: 'not JSON' };
        }
      });
      this.#json.set(url, pending);
    }
    return pending;
  }
}

function sourcesFor({ providerId, modelId, rate }: CurrentPrice): Read[] {
  if (providerId === 'anthropic') {
    return [openRouterModel(anthropicSlug(modelId), 1), anthropicPage(modelId, 1, true)];
  }
  if (providerId === 'openai') {
    return rate.basis === 'image_tokens'
      ? [openAiPage(modelId, 'image', true)]
      : [openRouterModel(`openai/${modelId}`, 1), openAiPage(modelId, 'text', true)];
  }
  if (providerId === 'openrouter') {
    const author = modelId.slice(0, modelId.indexOf('/'));
    const name = modelId.slice(modelId.indexOf('/') + 1);
    const reads = [openRouterMaker(modelId)];
    if (author === 'anthropic') reads.push(anthropicPage(name.replaceAll('.', '-'), 0, false));
    if (author === 'openai') reads.push(openAiPage(name, 'text', false));
    return reads;
  }
  if (providerId === 'cloudflare' || providerId === 'cloudflare-workers-ai') return [cloudflareModel(modelId)];
  return [];
}

/** `claude-opus-5-5` is OpenRouter's `anthropic/claude-opus-5.5`. */
export function anthropicSlug(modelId: string): string {
  return `anthropic/${modelId.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
}

function reading(source: string, url: string, own: boolean): SourceReading {
  return { source, url, own, values: {}, notes: [] };
}

function failed(base: SourceReading, problem: string): SourceReading {
  return { ...base, problem };
}

/**
 * Exact `text × 10^exponent` as an integer: a price string in dollars per token
 * (exponent 12) or per million tokens (exponent 6) as micros per million tokens.
 */
export function scaledDecimal(text: string, exponent: number): number | 'not-whole' | null {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!match) return null;
  const [, whole, fraction = '', power = '0'] = match;
  let digits = BigInt(`${whole}${fraction}`);
  const shift = exponent + Number(power) - fraction.length;
  if (shift >= 0) {
    digits *= 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    if (digits % divisor !== 0n) return 'not-whole';
    digits /= divisor;
  }
  return digits <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(digits) : null;
}

function observe(text: string, exponent: number): Observation | undefined {
  const value = scaledDecimal(text, exponent);
  if (value === null) return undefined;
  return value === 'not-whole' ? { notWhole: text } : { value };
}

const OPENROUTER_FIELDS: Record<string, TokenField> = {
  prompt: 'input',
  completion: 'output',
  input_cache_read: 'cacheRead',
  input_cache_write: 'cacheWrite',
  input_cache_write_1h: 'cacheWrite1h',
};

/**
 * OpenRouter's per-token prices. An override with `min_prompt_tokens` is the
 * long-context tier, whose catalog threshold is `min_prompt_tokens + offset`;
 * time-of-day overrides (`utc_*`) are surcharges the catalog does not hold.
 */
function readOpenRouterPricing(pricing: unknown, offset: number, into: SourceReading): SourceReading {
  if (!isRecord(pricing)) return failed(into, 'no pricing object');
  const read = (prices: Record<string, unknown>, prefix: '' | 'longContext.') => {
    for (const [key, field] of Object.entries(OPENROUTER_FIELDS)) {
      const text = prices[key];
      if (text === undefined) continue;
      const observation = typeof text === 'string' ? observe(text, 12) : undefined;
      if (observation) into.values[`${prefix}${field}`] = observation;
      else into.notes.push(`unreadable ${key} price ${JSON.stringify(text)}`);
    }
  };
  read(pricing, '');
  const overrides = Array.isArray(pricing.overrides) ? pricing.overrides.filter(isRecord) : [];
  const timed = overrides.filter((override) => Object.keys(override).some((key) => key.startsWith('utc_')));
  if (timed.length > 0) into.notes.push(`ignored ${timed.length} time-of-day price override(s)`);
  const tiers = overrides.filter((override) => !timed.includes(override) && typeof override.min_prompt_tokens === 'number');
  if (tiers.length > 1) into.notes.push(`${tiers.length} long-context overrides; none read`);
  if (tiers.length === 1) {
    into.values[THRESHOLD] = { value: (tiers[0]!.min_prompt_tokens as number) + offset };
    read(tiers[0]!, 'longContext.');
  }
  return into;
}

function openRouterModel(slug: string, offset: number): Read {
  return async (sources) => {
    const base = reading(`OpenRouter ${slug}`, OPENROUTER_MODELS_URL, false);
    const fetched = await sources.json(OPENROUTER_MODELS_URL);
    if ('error' in fetched) return failed(base, fetched.error);
    const models = isRecord(fetched.json) && Array.isArray(fetched.json.data) ? fetched.json.data.filter(isRecord) : [];
    const model = models.filter((entry) => entry.id === slug);
    if (model.length !== 1) return failed(base, model.length === 0 ? 'model not listed' : 'model listed more than once');
    return readOpenRouterPricing(model[0]!.pricing, offset, base);
  };
}

/**
 * The maker's endpoint: its tag's first segment is the slug's author. Top-level
 * model pricing is the cheapest provider, which is not the maker's list price.
 */
function openRouterMaker(modelId: string): Read {
  return async (sources) => {
    const url = openRouterEndpointsUrl(modelId);
    const author = modelId.slice(0, modelId.indexOf('/'));
    const base = reading('OpenRouter maker endpoint', url, false);
    const fetched = await sources.json(url);
    if ('error' in fetched) return failed(base, fetched.error);
    const data = isRecord(fetched.json) && isRecord(fetched.json.data) ? fetched.json.data : undefined;
    const endpoints = data && Array.isArray(data.endpoints) ? data.endpoints.filter(isRecord) : [];
    const makers = endpoints.filter((endpoint) => typeof endpoint.tag === 'string' && endpoint.tag.split('/')[0] === author);
    // OpenAI also lists `openai/flex` and `openai/fast`, other service tiers at other prices.
    const exact = makers.filter((endpoint) => endpoint.tag === author);
    const chosen = exact.length === 1 ? exact : makers;
    if (chosen.length === 0) return failed(base, 'maker endpoint missing');
    if (chosen.length > 1) {
      return failed(base, `maker endpoint ambiguous (${chosen.map((endpoint) => String(endpoint.tag)).join(', ')})`);
    }
    const maker = chosen[0]!;
    return readOpenRouterPricing(maker.pricing, 0, { ...base, source: `OpenRouter maker endpoint ${String(maker.tag)}` });
  };
}

const ANTHROPIC_COLUMNS: Record<string, TokenField> = {
  'base input tokens': 'input',
  '5m cache writes': 'cacheWrite',
  '1h cache writes': 'cacheWrite1h',
  'cache hits and refreshes': 'cacheRead',
  'output tokens': 'output',
};

/**
 * A row of Anthropic's "Model pricing" table. "Claude Opus 5.5" is
 * `claude-opus-5-5`; a "(for prompts over N tokens)" row is the long-context tier.
 */
interface AnthropicRow {
  modelId: string;
  over?: number;
  cells: Partial<Record<TokenField, string>>;
}

export function anthropicPricingRows(markdown: string): AnthropicRow[] {
  const section = sectionAfter(markdown, /^## Model pricing\s*$/m, /^## /m);
  if (section === undefined) return [];
  const table = markdownTable(section);
  if (!table) return [];
  const columns = table.header.map((cell) => ANTHROPIC_COLUMNS[cell.toLowerCase()]);
  return table.rows.map((cells) => {
    const label = cells[0] ?? '';
    const over = /\(for prompts over ([\d,]+) tokens\)/.exec(label);
    const row: AnthropicRow = {
      modelId: label.replace(/\s*\(.*$/, '').trim().toLowerCase().replace(/[\s.]+/g, '-'),
      cells: {},
    };
    if (over) row.over = Number(over[1]!.replaceAll(',', ''));
    cells.forEach((cell, index) => {
      const field = columns[index];
      if (field) row.cells[field] = cell;
    });
    return row;
  });
}

function anthropicPage(modelId: string, offset: number, own: boolean): Read {
  return async (sources) => {
    const base = reading('Anthropic pricing', ANTHROPIC_PRICING_URL, own);
    const fetched = await sources.text(ANTHROPIC_PRICING_URL);
    if ('error' in fetched) return failed(base, fetched.error);
    const rows = anthropicPricingRows(fetched.text).filter((row) => row.modelId === modelId);
    const plain = rows.filter((row) => row.over === undefined);
    const tiers = rows.filter((row) => row.over !== undefined);
    if (plain.length !== 1) return failed(base, plain.length === 0 ? 'no row for the model' : 'more than one row for the model');
    const read = (row: AnthropicRow, prefix: '' | 'longContext.') => {
      for (const [field, cell] of Object.entries(row.cells) as Array<[TokenField, string]>) {
        const price = /^\$(\d+(?:\.\d+)?) \/ MTok$/.exec(cell);
        const observation = price ? observe(price[1]!, 6) : undefined;
        if (observation) base.values[`${prefix}${field}`] = observation;
        else base.notes.push(`unreadable ${field} cell ${JSON.stringify(cell)}`);
      }
    };
    read(plain[0]!, '');
    if (tiers.length > 1) base.notes.push('more than one long-context row; none read');
    if (tiers.length === 1) {
      base.values[THRESHOLD] = { value: tiers[0]!.over! + offset };
      read(tiers[0]!, 'longContext.');
    }
    return base;
  };
}

const OPENAI_TEXT_ROWS: Record<string, TokenField> = {
  input: 'input',
  'cached input': 'cacheRead',
  'cache writes': 'cacheWrite',
  output: 'output',
};
const OPENAI_IMAGE_ROWS: Record<string, ImageField> = {
  'text tokens/input': 'textInput',
  'image tokens/input': 'imageInput',
  'image tokens/output': 'imageOutput',
};

/** OpenAI's per-model page: the "Text tokens" table, and for image models the "Image tokens" table. It has no long-context table. */
function openAiPage(modelId: string, kind: 'text' | 'image', own: boolean): Read {
  return async (sources) => {
    const url = openAiModelUrl(modelId);
    const base = reading('OpenAI model page', url, own);
    const fetched = await sources.text(url);
    if ('error' in fetched) return failed(base, fetched.error);
    const named = /^Model ID: `([^`]+)`/m.exec(fetched.text)?.[1];
    if (named !== modelId) return failed(base, named ? `page is for ${named}` : 'page names no model ID');
    const pricing = sectionAfter(fetched.text, /^## Pricing\s*$/m, /^## /m);
    if (pricing === undefined) return failed(base, 'no Pricing section');
    for (const table of ['Text tokens', 'Image tokens']) {
      const section = sectionAfter(pricing, new RegExp(`^### ${table}\\s*$`, 'm'), /^#{2,3} /m);
      const rows = section === undefined ? undefined : markdownTable(section);
      if (!rows) continue;
      for (const [metric = '', price = '', unit = ''] of rows.rows) {
        const field = kind === 'text'
          ? (table === 'Text tokens' ? OPENAI_TEXT_ROWS[metric.toLowerCase()] : undefined)
          : OPENAI_IMAGE_ROWS[`${table}/${metric}`.toLowerCase()];
        const dollars = /^\$(\d+(?:\.\d+)?)$/.exec(price);
        const observation = dollars && unit === '1M tokens' ? observe(dollars[1]!, 6) : undefined;
        if (!field) {
          base.notes.push(`lists ${table} ${metric} ${price} per ${unit}, which the catalog does not hold`);
        } else if (observation) {
          base.values[field] = observation;
        } else {
          base.notes.push(`unreadable ${table} ${metric} row ${JSON.stringify(`${price} / ${unit}`)}`);
        }
      }
    }
    return base;
  };
}

const CLOUDFLARE_UNITS: Record<string, TokenField> = {
  'per m input tokens': 'input',
  'per m output tokens': 'output',
  'per m cached input tokens': 'cacheRead',
};

/**
 * The JSON behind Cloudflare's model pages. Its rendered pricing page rounds to
 * three decimals ($0.060 for $0.0605), so it is never a source.
 */
function cloudflareModel(modelId: string): Read {
  return async (sources) => {
    const url = cloudflareModelUrl(modelId);
    const base = reading('Cloudflare model JSON', url, true);
    const fetched = await sources.json(url);
    if ('error' in fetched) return failed(base, fetched.error);
    const model = isRecord(fetched.json) ? fetched.json : {};
    if (model.name !== modelId) return failed(base, `file is for ${JSON.stringify(model.name)}`);
    const properties = Array.isArray(model.properties) ? model.properties.filter(isRecord) : [];
    const price = properties.find((property) => property.property_id === 'price');
    const entries = price && Array.isArray(price.value) ? price.value.filter(isRecord) : [];
    if (entries.length === 0) return failed(base, 'no price property');
    for (const entry of entries) {
      const field = typeof entry.unit === 'string' ? CLOUDFLARE_UNITS[entry.unit.toLowerCase()] : undefined;
      const text = typeof entry.price === 'number' || typeof entry.price === 'string' ? String(entry.price) : '';
      const observation = entry.currency === 'USD' ? observe(text, 6) : undefined;
      if (!field) base.notes.push(`lists ${String(entry.price)} ${String(entry.unit)}, which the catalog does not hold`);
      else if (observation) base.values[field] = observation;
      else base.notes.push(`unreadable ${String(entry.unit)} price ${JSON.stringify(entry.price)} ${String(entry.currency)}`);
    }
    const input = base.values.input;
    if (input && 'value' in input && !base.values.cacheWrite) {
      base.values.cacheWrite = { value: input.value, derived: 'Cloudflare lists no cache-write price; the catalog bills cache writes at the input rate' };
    }
    return base;
  };
}

function sectionAfter(text: string, start: RegExp, end: RegExp): string | undefined {
  const found = start.exec(text);
  if (!found) return undefined;
  const rest = text.slice(found.index + found[0].length);
  const next = end.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** The first Markdown table in `text`, cells cleaned of links and `<sup>` notes. */
function markdownTable(text: string): { header: string[]; rows: string[][] } | undefined {
  const lines = text.split('\n').map((line) => line.trim());
  const first = lines.findIndex((line) => line.startsWith('|'));
  if (first < 0) return undefined;
  const block: string[] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith('|')) break;
    block.push(line);
  }
  const cells = (line: string) => line.replace(/^\||\|$/g, '').split('|').map(cleanCell);
  const [header, separator, ...rows] = block;
  if (!header || !separator || !/^\|[\s:|-]+\|$/.test(separator)) return undefined;
  return { header: cells(header), rows: rows.map(cells) };
}

function cleanCell(cell: string): string {
  return cell
    .replace(/<sup>.*?<\/sup>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- report ----

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Exact dollars from micros, e.g. 60_500 → "$0.0605". */
function usd(micros: number): string {
  const whole = Math.trunc(micros / 1_000_000);
  const fraction = String(micros % 1_000_000).padStart(6, '0').replace(/0+$/, '');
  return `$${whole}${fraction ? `.${fraction}` : ''}`;
}

function format(field: PriceField, value: number): string {
  return field === THRESHOLD ? value.toLocaleString('en-US') : `${usd(value)}/MTok`;
}

function describe(field: PriceField, observation: Observation): string {
  return 'notWhole' in observation ? `${observation.notWhole} (not whole micros)` : format(field, observation.value);
}

function describeObserved(field: PriceField, entry: ObservedValue): string {
  if (entry.notWhole !== undefined) return `${entry.notWhole} (not whole micros)`;
  return `${format(field, entry.value!)}${entry.derived ? ` (derived: ${entry.derived})` : ''}`;
}

function describeChange(check: FieldCheck): string {
  const sources = check.observed.map(({ source, url }) => `${source} ${url}`).join('; ');
  return `${check.field} ${format(check.field, check.catalog)} → ${format(check.field, check.proposed!)} (${sources})`;
}

const SECTIONS: Array<[Verdict, string]> = [
  ['changed', 'Changed'],
  ['unverified', "Couldn't verify"],
  ['accepted', 'Accepted by hand'],
  ['unchanged', 'Unchanged'],
  ['current', 'Current'],
];

export function renderReport(result: PriceReviewResult): string {
  const { counts, prices } = result;
  const lines = [
    `# Price review ${result.runAt.slice(0, 10)}`,
    '',
    `Run at ${result.runAt} over ${prices.length} current prices: ${counts.changed} changed, ${counts.unverified} couldn't verify, ` +
      `${counts.accepted} accepted by hand, ${counts.unchanged} unchanged, ${counts.current} current.`,
  ];
  for (const [verdict, title] of SECTIONS) {
    lines.push('', `## ${title}`, '');
    const section = prices.filter((price) => price.verdict === verdict);
    if (section.length === 0) lines.push('None.');
    for (const price of section) lines.push(...renderPrice(price));
  }
  lines.push('', '## Notes', '');
  const notes = prices.flatMap((price) => price.notes.map((note) => `- ${name(price)}: ${note}`));
  lines.push(...(notes.length > 0 ? notes : ['None.']));
  return `${lines.join('\n')}\n`;
}

function name(price: PriceReview): string {
  return `\`${price.providerId}/${price.modelId}\`${price.basis === 'image_tokens' ? ' (image)' : ''}`;
}

function renderPrice(price: PriceReview): string[] {
  const head = `- ${name(price)}, ${price.priceVersionId}`;
  switch (price.verdict) {
    case 'current':
      return [`${head}, reviewed ${price.reviewedAt}`];
    case 'unchanged':
      return [`${head}: confirmed by ${confirmingSources(price)}`];
    case 'changed':
      return [
        `${head} → ${price.proposal!.id}`,
        ...price.fields.filter(({ outcome }) => outcome === 'changed').map((check) => `  - ${describeChange(check)}`),
      ];
    case 'accepted':
      return [`${head}: accepted by hand; renews the catalog's numbers as ${price.proposal!.id}, due ${utcDay(price.proposal!.reviewDueAt)}`];
    case 'unverified':
      return [`${head}, due ${price.reviewDueAt.slice(0, 10)}`, ...price.reasons.map((reason) => `  - ${reason}`)];
  }
}

function confirmingSources(price: PriceReview): string {
  const sources = new Set(price.fields.flatMap(({ observed }) => observed.map(({ source }) => source)));
  return [...sources].join(', ');
}

// ---- write ----

export interface WrittenReview {
  file: string;
  exportName: string;
  versions: UsagePriceVersion[];
}

const CATALOG_DIRECTORY = ['src', 'usage', 'pricing', 'catalogs'];

/**
 * Writes one new version per unchanged, changed or accepted price, registers
 * the file in `catalog.ts`, and pins each version's hash. Refuses when the
 * file or any id already exists; writes nothing when no price has a proposal.
 */
export async function writeReviewCatalog(result: PriceReviewResult, root = REPOSITORY_ROOT): Promise<WrittenReview | null> {
  const proposals = result.prices.filter((price) => price.proposal).map((price) => price.proposal!);
  if (proposals.length === 0) return null;
  const at = Date.parse(result.runAt);
  const day = utcDay(at);
  const exportName = `PRICE_CATALOGS_${day.replaceAll('-', '_')}_REVIEW`;
  const file = path.join(root, ...CATALOG_DIRECTORY, `${day}-review.ts`);
  const catalogFile = path.join(root, 'src', 'usage', 'pricing', 'catalog.ts');
  const hashesFile = path.join(root, ...CATALOG_DIRECTORY, 'released-hashes.json');
  if (existsSync(file)) throw new PriceReviewWriteRefused(`${path.relative(root, file)} already exists`);
  const hashes = JSON.parse(await readFile(hashesFile, 'utf8')) as Record<string, string>;
  const taken = new Set([...Object.keys(hashes), ...RELEASE_PRICE_CATALOGS.map(({ id }) => id)]);
  const clashes = proposals.map(({ id }) => id).filter((id) => taken.has(id));
  if (clashes.length > 0) throw new PriceReviewWriteRefused(`price version ids already exist: ${clashes.join(', ')}`);

  const versions = proposals.map((proposed) => version(versionInput(proposed, at)));
  const catalog = registerCatalog(await readFile(catalogFile, 'utf8'), exportName, `./catalogs/${day}-review.ts`);
  for (const { id, contentHash } of versions) hashes[id] = contentHash;

  await writeFile(file, renderCatalogModule(proposals, at, exportName));
  await writeFile(catalogFile, catalog);
  await writeFile(hashesFile, `${JSON.stringify(hashes, null, 2)}\n`);
  return { file, exportName, versions };
}

function versionInput(proposed: ProposedVersion, at: number) {
  return {
    id: proposed.id,
    providerId: proposed.rate.providerId,
    sourceUrl: proposed.sourceUrl,
    effectiveFrom: at,
    reviewedAt: at,
    reviewDueAt: proposed.reviewDueAt,
    currency: 'USD' as const,
    rates: [proposed.rate],
  };
}

function registerCatalog(source: string, exportName: string, modulePath: string): string {
  if (source.includes(exportName)) throw new PriceReviewWriteRefused(`catalog.ts already names ${exportName}`);
  const imports = [...source.matchAll(/^import \{ PRICE_CATALOGS_\w+ \} from '\.\/catalogs\/[^']+';\n/gm)];
  const last = imports.at(-1);
  const list = /^export const RELEASE_PRICE_CATALOGS: UsagePriceVersion\[\] = \[\n(?:  \.\.\.\w+,\n)*\];\n/m.exec(source);
  if (!last || !list) throw new PriceReviewWriteRefused('catalog.ts no longer has the import and list shape the tool edits');
  const listEnd = list.index + list[0].length - '];\n'.length;
  const importEnd = last.index + last[0].length;
  return source.slice(0, importEnd) +
    `import { ${exportName} } from '${modulePath}';\n` +
    source.slice(importEnd, listEnd) +
    `  ...${exportName},\n` +
    source.slice(listEnd);
}

function renderCatalogModule(proposals: readonly ProposedVersion[], at: number, exportName: string): string {
  const day = utcDay(at);
  const defaultDue = at + REVIEW_INTERVAL_DAYS * DAY;
  const lines = [
    `// Generated by \`npm run prices:review -- --write\` on ${day}. The pull request that adds this file is the approval.`,
    "import type { UsagePriceVersion } from '../types.ts';",
    "import { version } from './version.ts';",
    '',
    `const REVIEWED_AT = ${dateUtc(at)};`,
    `const REVIEW_DUE_AT = REVIEWED_AT + ${REVIEW_INTERVAL_DAYS} * 24 * 60 * 60 * 1_000;`,
    '',
    `/** Prices checked against their sources on ${day}; each takes effect at the review instant. */`,
    `export const ${exportName}: UsagePriceVersion[] = [`,
  ];
  for (const proposed of proposals) {
    lines.push(
      '  version({',
      `    id: ${quote(proposed.id)},`,
      `    providerId: ${quote(proposed.rate.providerId)},`,
      `    sourceUrl: ${quote(proposed.sourceUrl)},`,
      '    effectiveFrom: REVIEWED_AT,',
      '    reviewedAt: REVIEWED_AT,',
      `    reviewDueAt: ${proposed.reviewDueAt === defaultDue ? 'REVIEW_DUE_AT' : dateUtc(proposed.reviewDueAt)},`,
      "    currency: 'USD',",
      '    rates: [{',
      ...renderObject(proposed.rate, '      '),
      '    }],',
      '  }),',
    );
  }
  lines.push('];', '');
  return lines.join('\n');
}

function renderObject(value: object, indent: string): string[] {
  return Object.entries(value).flatMap(([key, entry]) => {
    if (Array.isArray(entry)) return [`${indent}${key}: [${entry.map((item) => quote(String(item))).join(', ')}],`];
    if (typeof entry === 'object' && entry !== null) {
      return [`${indent}${key}: {`, ...renderObject(entry as object, `${indent}  `), `${indent}},`];
    }
    return [`${indent}${key}: ${typeof entry === 'number' ? numberLiteral(entry) : quote(String(entry))},`];
  });
}

function quote(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function numberLiteral(value: number): string {
  return value >= 1_000 ? String(value).replace(/\B(?=(\d{3})+$)/g, '_') : String(value);
}

function dateUtc(at: number): string {
  const date = new Date(at);
  const parts = [
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
  ];
  while (parts.length > 3 && parts.at(-1) === 0) parts.pop();
  return `Date.UTC(${parts.join(', ')})`;
}
