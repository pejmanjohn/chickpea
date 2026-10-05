import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RELEASE_PRICE_CATALOGS } from '../../src/usage/pricing/catalog.ts';
import { estimateUsage } from '../../src/usage/pricing/estimate.ts';

const OBSERVED_AT = Date.UTC(2026, 6, 28, 12);

function measurement(
  provider: string,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
  overrides: Partial<Parameters<typeof estimateUsage>[0]> = {},
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

test('the current GLM 5.3 price applies to both Cloudflare execution routes', () => {
  const observedAt = Date.UTC(2026, 7, 27, 12);
  for (const [provider, version] of [
    ['cloudflare', 'cloudflare-binding-glm-5.3_2026-08-27'],
    ['cloudflare-workers-ai', 'cloudflare-workers-ai-glm-5.3_2026-08-27'],
  ] as const) {
    assert.deepEqual(estimateUsage(measurement(
      provider,
      '@cf/zai-org/glm-5.3-flash',
      1_000_000,
      1_000_000,
      {
        observedAt,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
        totalTokens: 3_000_000,
      },
    )), {
      estimateCompleteness: 'complete',
      estimateAmountMicros: 680_000,
      estimateCurrency: 'USD',
      priceVersionId: version,
      priceUnknownReason: null,
    });
  }
});

test('Anthropic estimates include cache reads and 5-minute cache writes', () => {
  const observedAt = Date.UTC(2026, 9, 5, 6);
  const cached = {
    observedAt,
    cacheReadTokens: 85_706,
    cacheWriteTokens: 15_654,
    totalTokens: 102_323,
  };
  for (const model of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001']) {
    // 231 × $1 + 732 × $5 + 85,706 × $0.10 + 15,654 × $1.25 per million tokens.
    assert.deepEqual(estimateUsage(measurement('anthropic', model, 231, 732, cached)), {
      estimateCompleteness: 'complete',
      estimateAmountMicros: 32_029,
      estimateCurrency: 'USD',
      priceVersionId: 'anthropic-cache_2026-10-04',
      priceUnknownReason: null,
    });
  }
  // A first turn writes the whole prompt to the cache and reads nothing.
  assert.equal(estimateUsage(measurement('anthropic', 'claude-haiku-4-5', 10, 172, {
    observedAt,
    cacheReadTokens: 0,
    cacheWriteTokens: 37_261,
    totalTokens: 37_443,
  })).estimateAmountMicros, 47_446);
});

test('Anthropic cache prices apply only from their review date, and outlast the July snapshot', () => {
  const cached = {
    cacheReadTokens: 85_706,
    cacheWriteTokens: 15_654,
    totalTokens: 102_323,
  };
  assert.deepEqual(
    estimateUsage(measurement('anthropic', 'claude-haiku-4-5', 231, 732, {
      ...cached,
      observedAt: Date.UTC(2026, 9, 3, 23),
    })),
    {
      estimateCompleteness: 'partial',
      estimateAmountMicros: null,
      estimateCurrency: null,
      priceVersionId: null,
      priceUnknownReason: 'pricing_dimension_unknown',
    },
  );
  const july = RELEASE_PRICE_CATALOGS.find((version) => version.id === 'anthropic_2026-07-28')!;
  const afterJulyStale = estimateUsage(measurement('anthropic', 'claude-haiku-4-5', 1_000, 200, {
    observedAt: july.staleAfter,
  }));
  assert.equal(afterJulyStale.estimateAmountMicros, 2_000);
  assert.equal(afterJulyStale.priceVersionId, 'anthropic-cache_2026-10-04');
});

test('one-hour cache writes leave an estimate partial, whatever the catalog holds', () => {
  const partial = {
    estimateCompleteness: 'partial',
    estimateAmountMicros: null,
    estimateCurrency: null,
    priceVersionId: null,
    priceUnknownReason: 'pricing_dimension_unknown',
  };
  const cached = {
    observedAt: Date.UTC(2026, 9, 5, 6),
    cacheReadTokens: 85_706,
    cacheWriteTokens: 15_654,
    totalTokens: 102_323,
  };
  assert.equal(
    estimateUsage(measurement('anthropic', 'claude-haiku-4-5', 231, 732, {
      ...cached,
      cacheWrite1hTokens: 0,
    })).estimateAmountMicros,
    32_029,
  );
  assert.deepEqual(
    estimateUsage(measurement('anthropic', 'claude-haiku-4-5', 231, 732, {
      ...cached,
      cacheWrite1hTokens: 1,
    })),
    partial,
  );
  // Never `price_unknown` or `price_stale`: a later release backfills those
  // from the stored counts, which do not split out one-hour writes.
  assert.deepEqual(
    estimateUsage(measurement('custom', 'local-model', 1, 1, {
      cacheWriteTokens: 5,
      cacheWrite1hTokens: 5,
      totalTokens: 7,
    })),
    partial,
  );
  const openai = RELEASE_PRICE_CATALOGS.find((version) => version.providerId === 'openai')!;
  assert.deepEqual(
    estimateUsage(measurement('openai', 'gpt-4.1-mini', 10, 5, {
      observedAt: openai.staleAfter,
      cacheWriteTokens: 3,
      cacheWrite1hTokens: 3,
      totalTokens: 18,
    })),
    partial,
  );
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
