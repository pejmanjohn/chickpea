import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  ANTHROPIC_PRICING_URL,
  OPENROUTER_MODELS_URL,
  PriceReviewUsageError,
  PriceReviewWriteRefused,
  REPOSITORY_ROOT,
  anthropicSlug,
  cloudflareModelUrl,
  openAiModelUrl,
  openRouterEndpointsUrl,
  parseAccepts,
  renderReport,
  reviewPrices,
  scaledDecimal,
  writeReviewCatalog,
  type FetchImpl,
  type PriceReview,
  type PriceReviewResult,
} from '../scripts/lib/price-review.ts';
import { version } from '../src/usage/pricing/catalogs/version.ts';
import type { CurrentPrice } from '../src/usage/pricing/review-due.ts';
import type { ImagePriceRate, TokenPriceRate, UsagePriceVersion } from '../src/usage/pricing/types.ts';

const DAY = 24 * 60 * 60 * 1_000;
// A day no real review ran, so these ids never collide with a generated catalog in the repository.
const AT = Date.UTC(2026, 10, 4, 22, 0, 0, 250);
const REVIEWED = Date.UTC(2026, 9, 7);

const FIXTURES: Record<string, string> = {
  [OPENROUTER_MODELS_URL]: 'openrouter-models.json',
  [ANTHROPIC_PRICING_URL]: 'anthropic-pricing.md',
  [openRouterEndpointsUrl('z-ai/glm-5.3-flash')]: 'openrouter-endpoints-z-ai-glm-5.3-flash.json',
  [openRouterEndpointsUrl('deepseek/deepseek-v4.1-flash')]: 'openrouter-endpoints-deepseek-v4.1-flash.json',
  [openRouterEndpointsUrl('openai/gpt-5.6-terra')]: 'openrouter-endpoints-openai-gpt-5.6-terra.json',
  [openAiModelUrl('gpt-6-sol')]: 'openai-gpt-6-sol.md',
  [openAiModelUrl('gpt-5.6-terra')]: 'openai-gpt-5.6-terra.md',
  [openAiModelUrl('gpt-4.1-mini')]: 'openai-gpt-4.1-mini.md',
  [openAiModelUrl('gpt-image-2.6-flare')]: 'openai-gpt-image-2.6-flare.md',
  [cloudflareModelUrl('@cf/zai-org/glm-4.7-flash')]: 'cloudflare-glm-4.7-flash.json',
  [cloudflareModelUrl('@cf/zai-org/glm-5.2')]: 'cloudflare-glm-5.2.json',
};

/** Recorded public pricing sources from 2026-11-05; `edits` rewrite a source, a `null` edit fails it. */
function recordedSources(edits: Record<string, ((text: string) => string) | null> = {}) {
  const requested: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    requested.push(url);
    const name = FIXTURES[url];
    if (!name || edits[url] === null) return new Response('unavailable', { status: name ? 500 : 404 });
    const text = readFileSync(new URL(`./fixtures/price-review/${name}`, import.meta.url), 'utf8');
    return new Response(edits[url]?.(text) ?? text);
  };
  return { fetchImpl, requested };
}

type TokenRates = Omit<TokenPriceRate, 'priceVersionId' | 'providerId' | 'modelId' | 'modelAliases' | 'currency' | 'unitScale' | 'basis'>;
type ImageRates = Pick<ImagePriceRate, 'textInputMicrosPerUnit' | 'imageInputMicrosPerUnit' | 'imageOutputMicrosPerUnit'>;

function price(
  providerId: string,
  modelId: string,
  rates: TokenRates | ImageRates,
  dates: { reviewedAt?: number; reviewDueAt?: number } = {},
): CurrentPrice {
  const reviewedAt = dates.reviewedAt ?? REVIEWED;
  const basis = 'textInputMicrosPerUnit' in rates ? 'image_tokens' as const : 'standard_input_output' as const;
  const priced: UsagePriceVersion = version({
    id: `test-${providerId}-${modelId}`,
    providerId,
    sourceUrl: 'https://example.com/old-source',
    effectiveFrom: reviewedAt,
    reviewedAt,
    reviewDueAt: dates.reviewDueAt ?? reviewedAt + 90 * DAY,
    currency: 'USD',
    rates: [{ providerId, modelId, modelAliases: [modelId], currency: 'USD', unitScale: 1_000_000, basis, ...rates } as never],
  });
  return { providerId, modelId, version: priced, rate: priced.rates[0]! };
}

const OPUS_5_5: TokenRates = {
  inputMicrosPerUnit: 4_000_000,
  outputMicrosPerUnit: 20_000_000,
  cacheReadMicrosPerUnit: 200_000,
  cacheWriteMicrosPerUnit: 5_000_000,
  cacheWrite1hMicrosPerUnit: 8_000_000,
};
const GPT_6_SOL: TokenRates = {
  inputMicrosPerUnit: 2_000_000,
  outputMicrosPerUnit: 10_000_000,
  cacheReadMicrosPerUnit: 200_000,
  cacheWriteMicrosPerUnit: 2_500_000,
  longContext: {
    fromPromptTokens: 272_001,
    inputMicrosPerUnit: 4_000_000,
    outputMicrosPerUnit: 15_000_000,
    cacheReadMicrosPerUnit: 400_000,
    cacheWriteMicrosPerUnit: 5_000_000,
  },
};
const GPT_5_6_TERRA: TokenRates = {
  inputMicrosPerUnit: 2_000_000,
  outputMicrosPerUnit: 12_000_000,
  cacheReadMicrosPerUnit: 200_000,
  cacheWriteMicrosPerUnit: 2_500_000,
  longContext: {
    fromPromptTokens: 272_000,
    inputMicrosPerUnit: 4_000_000,
    outputMicrosPerUnit: 18_000_000,
    cacheReadMicrosPerUnit: 400_000,
    cacheWriteMicrosPerUnit: 5_000_000,
  },
};
const GLM_5_3_FLASH: TokenRates = { inputMicrosPerUnit: 150_000, outputMicrosPerUnit: 500_000, cacheReadMicrosPerUnit: 30_000 };
const GLM_4_7_FLASH: TokenRates = { inputMicrosPerUnit: 60_000, outputMicrosPerUnit: 400_000 };
const GLM_5_2: TokenRates = {
  inputMicrosPerUnit: 1_400_000,
  outputMicrosPerUnit: 4_400_000,
  cacheReadMicrosPerUnit: 260_000,
  cacheWriteMicrosPerUnit: 1_400_000,
};
const IMAGE_2_6: ImageRates = { textInputMicrosPerUnit: 5_000_000, imageInputMicrosPerUnit: 8_000_000, imageOutputMicrosPerUnit: 30_000_000 };

async function review(prices: CurrentPrice[], options: {
  edits?: Record<string, ((text: string) => string) | null>;
  accepts?: string[];
} = {}) {
  const { fetchImpl, requested } = recordedSources(options.edits);
  const result = await reviewPrices({ at: AT, fetchImpl, prices, accepts: parseAccepts(options.accepts ?? [], AT) });
  return { result, requested };
}

async function reviewOne(subject: CurrentPrice, options: Parameters<typeof review>[1] = {}): Promise<PriceReview> {
  return (await review([subject], options)).result.prices[0]!;
}

const reasons = (reviewed: PriceReview) => reviewed.reasons.join('\n');

test('source prices convert to whole micros per 1M tokens exactly, and anything finer is not whole', () => {
  assert.equal(scaledDecimal('0.000004', 12), 4_000_000);
  assert.equal(scaledDecimal('0.00000000894', 12), 8_940);
  assert.equal(scaledDecimal('0.0000000000001', 12), 'not-whole');
  assert.equal(scaledDecimal('12.50', 6), 12_500_000);
  assert.equal(scaledDecimal(String(0.0605), 6), 60_500);
  assert.equal(scaledDecimal('6.05e-2', 6), 60_500);
  assert.equal(scaledDecimal('0.0000005', 6), 'not-whole');
  assert.equal(scaledDecimal('-1', 12), null);
  assert.equal(scaledDecimal('$4', 6), null);
});

test('a source price that is not whole micros is a disagreement, never rounded into a match', async () => {
  const reviewed = await reviewOne(price('anthropic', 'claude-opus-5-5', OPUS_5_5), {
    edits: {
      [OPENROUTER_MODELS_URL]: (text) => {
        const models = JSON.parse(text);
        models.data.find(({ id }: { id: string }) => id === 'anthropic/claude-opus-5.5').pricing.prompt = '0.0000040000001';
        return JSON.stringify(models);
      },
    },
  });
  assert.equal(reviewed.verdict, 'unverified');
  assert.match(reasons(reviewed), /input: not whole micros: OpenRouter anthropic\/claude-opus-5\.5 0\.0000040000001/);
});

test('Anthropic models map to OpenRouter slugs with the version dotted', () => {
  assert.equal(anthropicSlug('claude-opus-5-5'), 'anthropic/claude-opus-5.5');
  assert.equal(anthropicSlug('claude-haiku-4-5'), 'anthropic/claude-haiku-4.5');
  assert.equal(anthropicSlug('claude-sonnet-5'), 'anthropic/claude-sonnet-5');
});

test('a price both sources confirm is unchanged and cites the provider page', async () => {
  const opus = price('anthropic', 'claude-opus-5-5', OPUS_5_5);
  const reviewed = await reviewOne(opus);
  assert.equal(reviewed.verdict, 'unchanged');
  assert.deepEqual(reviewed.sources.map(({ source }) => source), ['OpenRouter anthropic/claude-opus-5.5', 'Anthropic pricing']);
  assert.ok(reviewed.fields.every(({ outcome, observed }) => outcome === 'confirmed' && observed.length === 2));
  assert.equal(reviewed.proposal?.sourceUrl, ANTHROPIC_PRICING_URL);
  const { priceVersionId: _, ...rate } = opus.rate;
  assert.deepEqual(reviewed.proposal?.rate, rate);
});

test('a change needs two sources that agree with each other', async () => {
  const reviewed = await reviewOne(price('anthropic', 'claude-opus-5-5', { ...OPUS_5_5, inputMicrosPerUnit: 3_000_000 }));
  assert.equal(reviewed.verdict, 'changed');
  const input = reviewed.fields.find(({ field }) => field === 'input');
  assert.equal(input?.proposed, 4_000_000);
  assert.equal(reviewed.proposal?.rate.basis === 'standard_input_output' && reviewed.proposal.rate.inputMicrosPerUnit, 4_000_000);
  assert.equal(reviewed.proposal?.rate.basis === 'standard_input_output' && reviewed.proposal.rate.outputMicrosPerUnit, 20_000_000);
});

test('a difference only one source reports is couldn\'t verify, with the observed value', async () => {
  const cloudflare = await reviewOne(price('cloudflare', '@cf/zai-org/glm-4.7-flash', GLM_4_7_FLASH));
  assert.equal(cloudflare.verdict, 'unverified');
  assert.match(reasons(cloudflare), /input: only Cloudflare model JSON \$0\.0605\/MTok \(https:\/\/raw\.githubusercontent\.com\/.+glm-4\.7-flash\.json\) differs from the catalog's \$0\.06\/MTok/);
  assert.equal(cloudflare.proposal, undefined);

  const image = await reviewOne(price('openai', 'gpt-image-2.6-flare', { ...IMAGE_2_6, textInputMicrosPerUnit: 4_000_000 }));
  assert.equal(image.verdict, 'unverified');
  assert.match(reasons(image), /textInput: only OpenAI model page \$5\/MTok/);
});

test('sources that disagree with each other leave a price unverified', async () => {
  const edits = { [ANTHROPIC_PRICING_URL]: (text: string) => text.replace(/(\| Claude Opus 5\.5 +\| )\$4 \/ MTok/, '$1$5 / MTok') };
  const agreeingWithCatalog = await reviewOne(price('anthropic', 'claude-opus-5-5', OPUS_5_5), { edits });
  assert.equal(agreeingWithCatalog.verdict, 'unverified');
  assert.match(reasons(agreeingWithCatalog), /input: sources disagree: OpenRouter anthropic\/claude-opus-5\.5 \$4\/MTok .*; Anthropic pricing \$5\/MTok .*; catalog \$4\/MTok/);

  const bothDiffering = await reviewOne(price('anthropic', 'claude-opus-5-5', { ...OPUS_5_5, inputMicrosPerUnit: 3_000_000 }), { edits });
  assert.equal(bothDiffering.verdict, 'unverified');
  assert.match(reasons(bothDiffering), /input: sources disagree/);
});

test('a source that fails gives no value, so a field nobody confirms is unverified', async () => {
  const reviewed = await reviewOne(price('openai', 'gpt-image-2.6-flare', IMAGE_2_6), {
    edits: { [openAiModelUrl('gpt-image-2.6-flare')]: null },
  });
  assert.equal(reviewed.verdict, 'unverified');
  assert.match(reasons(reviewed), /textInput: no source lists it; tried OpenAI model page: HTTP 500/);
});

test('OpenRouter models are checked at the maker\'s endpoint, and a missing maker is unverified', async () => {
  const { result } = await review([
    price('openrouter', 'z-ai/glm-5.3-flash', GLM_5_3_FLASH),
    price('openrouter', 'openai/gpt-5.6-terra', GPT_5_6_TERRA),
    price('openrouter', 'deepseek/deepseek-v4.1-flash', { inputMicrosPerUnit: 150_000, outputMicrosPerUnit: 600_000, cacheReadMicrosPerUnit: 3_000 }),
  ]);
  const [deepseek, terra, glm] = result.prices;
  assert.equal(glm?.verdict, 'unchanged', 'cheaper endpoints such as relace/fp4 are not the maker');
  assert.deepEqual(glm?.sources.map(({ source }) => source), ['OpenRouter maker endpoint z-ai/fp8']);
  assert.equal(glm?.proposal?.sourceUrl, openRouterEndpointsUrl('z-ai/glm-5.3-flash'));
  assert.equal(terra?.verdict, 'unchanged', 'OpenAI\'s `openai` endpoint, not openai/flex or openai/fast');
  assert.deepEqual(terra?.sources.map(({ source }) => source), ['OpenRouter maker endpoint openai', 'OpenAI model page']);
  assert.equal(deepseek?.verdict, 'unverified');
  assert.match(reasons(deepseek!), /input: no source lists it; tried OpenRouter maker endpoint: maker endpoint missing/);
});

test('long-context thresholds are min_prompt_tokens for OpenRouter and one more for Anthropic and OpenAI', async () => {
  const { result } = await review([
    price('openai', 'gpt-6-sol', GPT_6_SOL),
    price('openrouter', 'openai/gpt-5.6-terra', GPT_5_6_TERRA),
    price('anthropic', 'claude-haiku-5-5', {
      inputMicrosPerUnit: 100_000,
      outputMicrosPerUnit: 500_000,
      cacheReadMicrosPerUnit: 10_000,
      cacheWriteMicrosPerUnit: 125_000,
      cacheWrite1hMicrosPerUnit: 200_000,
      longContext: {
        fromPromptTokens: 100_001,
        inputMicrosPerUnit: 500_000,
        outputMicrosPerUnit: 2_500_000,
        cacheReadMicrosPerUnit: 50_000,
        cacheWriteMicrosPerUnit: 625_000,
        cacheWrite1hMicrosPerUnit: 1_000_000,
      },
    }),
    price('openai', 'gpt-5.6-terra', GPT_5_6_TERRA),
  ]);
  const verdicts = Object.fromEntries(result.prices.map((reviewed) => [`${reviewed.providerId}/${reviewed.modelId}`, reviewed]));
  assert.equal(verdicts['openai/gpt-6-sol']?.verdict, 'unchanged');
  assert.equal(verdicts['openrouter/openai/gpt-5.6-terra']?.verdict, 'unchanged');
  const haiku = verdicts['anthropic/claude-haiku-5-5']!;
  assert.equal(haiku.verdict, 'unchanged');
  assert.equal(haiku.fields.find(({ field }) => field === 'longContext.fromPromptTokens')?.observed.length, 2);
  const terra = verdicts['openai/gpt-5.6-terra']!;
  assert.equal(terra.verdict, 'unverified', 'OpenAI stores "more than 272K" as 272,001');
  assert.match(reasons(terra), /longContext\.fromPromptTokens: only OpenRouter openai\/gpt-5\.6-terra 272,001 .* differs from the catalog's 272,000/);
});

test('Cloudflare cache writes are derived from the input rate, as the catalog assumes', async () => {
  const reviewed = await reviewOne(price('cloudflare-workers-ai', '@cf/zai-org/glm-5.2', GLM_5_2));
  assert.equal(reviewed.verdict, 'unchanged');
  const cacheWrite = reviewed.fields.find(({ field }) => field === 'cacheWrite');
  assert.equal(cacheWrite?.observed[0]?.value, 1_400_000);
  assert.match(cacheWrite?.observed[0]?.derived ?? '', /no cache-write price/);
  assert.equal(reviewed.proposal?.sourceUrl, cloudflareModelUrl('@cf/zai-org/glm-5.2'));
});

test('a price whose last review set an early due date stays with a human, showing what sources say', async () => {
  const reviewed = await reviewOne(price('openai', 'gpt-6-sol', GPT_6_SOL, { reviewDueAt: REVIEWED + 46 * DAY }));
  assert.equal(reviewed.verdict, 'unverified');
  assert.deepEqual(reviewed.reasons, [
    'the last review set an early due date (2026-11-22); check when its price ends by hand',
    'sources confirm every field',
  ]);
});

test('a price reviewed on the run\'s UTC day is current and fetches nothing', async () => {
  const { result, requested } = await review([price('openai', 'gpt-6-sol', GPT_6_SOL, { reviewedAt: Date.UTC(2026, 10, 4) })]);
  assert.equal(result.prices[0]?.verdict, 'current');
  assert.equal(result.prices[0]?.proposal, undefined);
  assert.deepEqual(requested, []);
});

test('--accept renews the catalog\'s own numbers, due in 90 days or on the given date', async () => {
  const glm = price('cloudflare', '@cf/zai-org/glm-4.7-flash', GLM_4_7_FLASH);
  const deepseek = price('openrouter', 'deepseek/deepseek-v4.1-flash', { inputMicrosPerUnit: 150_000, outputMicrosPerUnit: 600_000 });
  const { result } = await review([glm, deepseek], {
    accepts: ['cloudflare/@cf/zai-org/glm-4.7-flash@2026-12-31', 'openrouter/deepseek/deepseek-v4.1-flash'],
  });
  const [dated, accepted] = result.prices;
  assert.equal(dated?.verdict, 'accepted');
  assert.equal(dated?.proposal?.reviewDueAt, Date.UTC(2026, 11, 31));
  assert.equal(dated?.proposal?.rate.basis === 'standard_input_output' && dated.proposal.rate.inputMicrosPerUnit, 60_000);
  assert.equal(accepted?.verdict, 'accepted');
  assert.equal(accepted?.proposal?.reviewDueAt, AT + 90 * DAY);
  assert.equal(result.counts.accepted, 2);
  assert.match(renderReport(result), /## Accepted by hand\n\n- `cloudflare\/@cf\/zai-org\/glm-4\.7-flash`.*accepted by hand.*due 2026-12-31/);

  assert.throws(() => parseAccepts(['openai/gpt-6-sol@2026-02-30'], AT), PriceReviewUsageError);
  assert.throws(() => parseAccepts(['openai/gpt-6-sol@2026-11-01'], AT), PriceReviewUsageError);
  assert.throws(() => parseAccepts(['gpt-6-sol'], AT), PriceReviewUsageError);
  await assert.rejects(review([glm], { accepts: ['openai/gpt-6-sol'] }), PriceReviewUsageError);
});

test('--accept never renews an old price that two agreeing sources have changed', async () => {
  const stale = price('anthropic', 'claude-opus-5-5', { ...OPUS_5_5, inputMicrosPerUnit: 3_000_000 });
  const { result } = await review([stale], { accepts: ['anthropic/claude-opus-5-5'] });
  const [reviewed] = result.prices;
  assert.equal(reviewed?.verdict, 'unverified');
  assert.equal(reviewed?.proposal, undefined);
  assert.ok(reviewed?.reasons.some((reason) => /sources agree on a new price, so --accept cannot renew the old one/.test(reason)));
  assert.equal(result.counts.accepted, 0);
});

test('the report lists counts, then each verdict\'s section and the notes', async () => {
  const { result } = await review([
    price('openai', 'gpt-4.1-mini', { inputMicrosPerUnit: 400_000, outputMicrosPerUnit: 1_600_000 }),
    price('cloudflare', '@cf/zai-org/glm-4.7-flash', GLM_4_7_FLASH),
  ]);
  const report = renderReport(result);
  assert.match(report, /0 changed, 1 couldn't verify, 0 accepted by hand, 1 unchanged, 0 current/);
  assert.deepEqual(
    [...report.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    ['Changed', "Couldn't verify", 'Accepted by hand', 'Unchanged', 'Current', 'Notes'],
  );
  assert.match(report, /`openai\/gpt-4\.1-mini`: OpenRouter openai\/gpt-4\.1-mini lists cacheRead \$0\.1\/MTok, which the catalog does not hold/);
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'price-review-'));
  for (const file of ['catalog.ts', 'types.ts', 'catalogs/version.ts', 'catalogs/released-hashes.json']) {
    cpSync(path.join(REPOSITORY_ROOT, 'src/usage/pricing', file), path.join(root, 'src/usage/pricing', file));
  }
  return root;
}

async function proposals(): Promise<PriceReviewResult> {
  return (await review([
    price('anthropic', 'claude-opus-5-5', { ...OPUS_5_5, inputMicrosPerUnit: 3_000_000 }),
    price('openai', 'gpt-6-sol', GPT_6_SOL),
    price('openai', 'gpt-image-2.6-flare', IMAGE_2_6),
    price('cloudflare', '@cf/zai-org/glm-4.7-flash', GLM_4_7_FLASH),
    price('openrouter', 'deepseek/deepseek-v4.1-flash', GLM_5_3_FLASH),
  ], { accepts: ['cloudflare/@cf/zai-org/glm-4.7-flash@2026-12-31'] })).result;
}

test('--write adds one version per unchanged, changed or accepted price, registers it once and pins its hash', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalogBefore = readFileSync(path.join(root, 'src/usage/pricing/catalog.ts'), 'utf8');
  const hashesBefore = JSON.parse(readFileSync(path.join(root, 'src/usage/pricing/catalogs/released-hashes.json'), 'utf8'));

  const written = await writeReviewCatalog(await proposals(), root);
  const file = path.join(root, 'src/usage/pricing/catalogs/2026-11-04-review.ts');
  assert.equal(written?.file, file);
  const source = readFileSync(file, 'utf8');
  assert.match(source, /^\/\/ Generated by `npm run prices:review -- --write` on 2026-11-04\. The pull request that adds this file is the approval\.\n/);

  const loaded = (await import(pathToFileURL(file).href)).PRICE_CATALOGS_2026_11_04_REVIEW as UsagePriceVersion[];
  assert.deepEqual(loaded.map(({ id }) => id), [
    'anthropic-claude-opus-5-5_2026-11-04-review',
    'cloudflare-zai-org-glm-4.7-flash_2026-11-04-review',
    'openai-gpt-6-sol_2026-11-04-review',
    'openai-image-gpt-image-2.6-flare_2026-11-04-review',
  ]);
  for (const loadedVersion of loaded) {
    assert.equal(loadedVersion.effectiveFrom, AT, 'takes effect at the run instant, not midnight');
    assert.equal(loadedVersion.reviewedAt, AT);
  }
  assert.deepEqual(loaded.map(({ reviewDueAt }) => reviewDueAt), [AT + 90 * DAY, Date.UTC(2026, 11, 31), AT + 90 * DAY, AT + 90 * DAY]);
  const opus = loaded[0]!.rates[0] as TokenPriceRate;
  assert.equal(opus.inputMicrosPerUnit, 4_000_000);
  assert.equal(opus.cacheWrite1hMicrosPerUnit, 8_000_000);
  assert.deepEqual((loaded[2]!.rates[0] as TokenPriceRate).longContext, GPT_6_SOL.longContext);
  assert.equal(loaded[1]!.sourceUrl, 'https://example.com/old-source', 'an unconfirmed accepted price keeps its old source');
  assert.equal(loaded[2]!.sourceUrl, openAiModelUrl('gpt-6-sol'));
  assert.deepEqual(loaded.map(({ contentHash }) => contentHash), written?.versions.map(({ contentHash }) => contentHash));

  const catalog = readFileSync(path.join(root, 'src/usage/pricing/catalog.ts'), 'utf8');
  assert.equal(catalog.split("import { PRICE_CATALOGS_2026_11_04_REVIEW } from './catalogs/2026-11-04-review.ts';").length, 2);
  assert.equal(catalog.split('  ...PRICE_CATALOGS_2026_11_04_REVIEW,\n];').length, 2, 'spread last in RELEASE_PRICE_CATALOGS');
  assert.equal(catalog.split('\n').length, catalogBefore.split('\n').length + 2);

  const hashes = JSON.parse(readFileSync(path.join(root, 'src/usage/pricing/catalogs/released-hashes.json'), 'utf8'));
  assert.deepEqual(Object.entries(hashes), [
    ...Object.entries(hashesBefore),
    ...loaded.map(({ id, contentHash }) => [id, contentHash]),
  ]);

  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    extends: path.join(REPOSITORY_ROOT, 'tsconfig.json'),
    compilerOptions: { noEmit: true, typeRoots: [path.join(REPOSITORY_ROOT, 'node_modules/@types')] },
    include: [],
    files: [file],
  }));
  const tsc = spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'node_modules/typescript/bin/tsc'), '-p', root], { encoding: 'utf8' });
  assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
});

test('--write refuses when the file or a version id already exists, and writes nothing then', async (t) => {
  const result = await proposals();
  const existing = tempRoot();
  t.after(() => rmSync(existing, { recursive: true, force: true }));
  await writeReviewCatalog(result, existing);
  await assert.rejects(writeReviewCatalog(result, existing), PriceReviewWriteRefused);

  const taken = tempRoot();
  t.after(() => rmSync(taken, { recursive: true, force: true }));
  const hashesFile = path.join(taken, 'src/usage/pricing/catalogs/released-hashes.json');
  const hashes = JSON.parse(readFileSync(hashesFile, 'utf8'));
  writeFileSync(hashesFile, `${JSON.stringify({ ...hashes, 'openai-gpt-6-sol_2026-11-04-review': 'f'.repeat(64) }, null, 2)}\n`);
  const catalogBefore = readFileSync(path.join(taken, 'src/usage/pricing/catalog.ts'), 'utf8');
  await assert.rejects(writeReviewCatalog(result, taken), /openai-gpt-6-sol_2026-11-04-review/);
  assert.equal(existsSync(path.join(taken, 'src/usage/pricing/catalogs/2026-11-04-review.ts')), false);
  assert.equal(readFileSync(path.join(taken, 'src/usage/pricing/catalog.ts'), 'utf8'), catalogBefore);
});

test('--write writes nothing when every price is current or unverified', async () => {
  const { result } = await review([
    price('openai', 'gpt-6-sol', GPT_6_SOL, { reviewedAt: Date.UTC(2026, 10, 4) }),
    price('cloudflare', '@cf/zai-org/glm-4.7-flash', GLM_4_7_FLASH),
  ]);
  assert.equal(await writeReviewCatalog(result, '/nonexistent-price-review-root'), null);
});
