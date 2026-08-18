import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RELEASE_PRICE_CATALOGS } from '../../src/usage/pricing/catalog.ts';
import { estimateUsage } from '../../src/usage/pricing/estimate.ts';
import type { RecordUsageTerminalInput } from '../../src/usage/types.ts';

const OBSERVED_AT = Date.UTC(2026, 6, 28, 12);

function measurement(
  provider: string,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
  overrides: Partial<RecordUsageTerminalInput> = {},
) {
  return {
    observedAt: OBSERVED_AT,
    providerRoute: provider,
    returnedProvider: provider,
    requestedProvider: provider,
    returnedModel: model,
    requestedModel: model,
    usageCompleteness: 'complete' as const,
    inputTokens,
    outputTokens,
    ...overrides,
  };
}

test('golden standard-rate estimates match every U0-priceable provider fixture', () => {
  const cases = [
    ['anthropic', 'claude-haiku-4-5', 11, 5, 36, 'anthropic_2026-07-28'],
    ['openai', 'gpt-4.1-mini', 13, 7, 16, 'openai_2026-07-28'],
    ['openrouter', 'openai/gpt-4.1', 17, 9, 106, 'openrouter_2026-07-28'],
    ['cloudflare-workers-ai', '@cf/zai-org/glm-5.2', 19, 11, 75, 'cloudflare-workers-ai_2026-07-28'],
    ['cloudflare', '@cf/zai-org/glm-5.2', 19, 11, 75, 'cloudflare-binding_2026-07-30'],
  ] as const;
  for (const [provider, model, input, output, amount, version] of cases) {
    assert.deepEqual(estimateUsage(measurement(provider, model, input, output)), {
      estimateCompleteness: 'complete',
      estimateAmountMicros: amount,
      estimateCurrency: 'USD',
      priceVersionId: version,
      priceUnknownReason: null,
    });
  }
});

test('Workers AI estimates include cached input at the provider-specific rate', () => {
  const estimate = estimateUsage(measurement(
    'cloudflare',
    '@cf/zai-org/glm-5.2',
    1_921,
    1_471,
    {
      observedAt: Date.UTC(2026, 7, 17, 12),
      cacheReadTokens: 138_432,
      cacheWriteTokens: 0,
      totalTokens: 141_824,
    },
  ));

  assert.deepEqual(estimate, {
    estimateCompleteness: 'complete',
    estimateAmountMicros: 45_154,
    estimateCurrency: 'USD',
    priceVersionId: 'cloudflare-binding-cache_2026-08-17',
    priceUnknownReason: null,
  });
});

test('non-zero cache usage without a matching price dimension stays partial', () => {
  assert.deepEqual(
    estimateUsage(measurement('openai', 'gpt-4.1-mini', 10, 5, {
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      totalTokens: 35,
    })),
    {
      estimateCompleteness: 'partial',
      estimateAmountMicros: null,
      estimateCurrency: null,
      priceVersionId: null,
      priceUnknownReason: 'pricing_dimension_unknown',
    },
  );
});

test('snapshot aliases price identically while unknown models remain unknown', () => {
  assert.equal(
    estimateUsage(measurement('openai', 'gpt-4.1-mini-2025-04-14', 13, 7)).estimateAmountMicros,
    16,
  );
  assert.equal(
    estimateUsage(measurement('cloudflare', '@cf/zai-org/glm-5.2', 19, 11)).priceVersionId,
    'cloudflare-binding_2026-07-30',
  );
  assert.equal(
    estimateUsage(measurement('custom', 'local-model', 1, 1)).priceUnknownReason,
    'price_unknown',
  );
});

test('missing billable dimensions, effective dates, and catalog staleness never imply precision', () => {
  assert.deepEqual(
    estimateUsage(measurement('openai', 'gpt-4.1-mini', 10, null, {
      usageCompleteness: 'partial',
    })),
    {
      estimateCompleteness: 'partial', estimateAmountMicros: null, estimateCurrency: null,
      priceVersionId: null, priceUnknownReason: 'pricing_dimension_unknown',
    },
  );
  assert.equal(
    estimateUsage(measurement('openai', 'gpt-4.1-mini', 10, 5, {
      observedAt: Date.UTC(2026, 6, 27),
    })).priceUnknownReason,
    'price_unknown',
  );
  const openai = RELEASE_PRICE_CATALOGS.find((version) => version.providerId === 'openai')!;
  assert.equal(
    estimateUsage(measurement('openai', 'gpt-4.1-mini', 10, 5, {
      observedAt: openai.staleAfter,
    })).priceUnknownReason,
    'price_stale',
  );
});

test('a stored historical estimate is reproducible from its immutable price version', () => {
  const first = estimateUsage(measurement('anthropic', 'claude-haiku-4-5-20251001', 1_000, 200));
  const second = estimateUsage(measurement('anthropic', 'claude-haiku-4-5-20251001', 1_000, 200));
  assert.deepEqual(second, first);
  assert.equal(first.estimateAmountMicros, 2_000);
  assert.equal(first.priceVersionId, 'anthropic_2026-07-28');
});
