import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listRuntimeModelProviders } from '../../src/config/providers.ts';
import { findImageModel, IMAGE_MODEL_IDS } from '../../src/model-catalog/image-profiles.ts';
import {
  ANTHROPIC_COMPAT_PROVIDER_ID,
  OPENAI_PLATFORM_COMPAT_PROVIDER_ID,
  revisionedAlias,
} from '../../src/model-catalog/provider-alias.ts';
import { openStateDb } from '../../src/state/node-state-db.ts';
import { priceCatalogFor } from '../../src/usage/pricing/catalog.ts';
import { estimateUsage } from '../../src/usage/pricing/estimate.ts';
import { UsageStoreLogic } from '../../src/usage/store.ts';

const REVIEWED = Date.UTC(2026, 9, 7, 12);
const SNAPSHOT = 'a'.repeat(64);

function measurement(
  provider: string,
  model: string,
  overrides: Partial<Parameters<typeof estimateUsage>[0]> = {},
) {
  return {
    observedAt: REVIEWED,
    providerRoute: provider,
    returnedProvider: provider,
    requestedProvider: provider,
    returnedModel: model,
    requestedModel: model,
    usageCompleteness: 'complete' as const,
    inputTokens: 1_000,
    outputTokens: 100,
    ...overrides,
  };
}

function split(specifier: string): [string, string] {
  const slash = specifier.indexOf('/');
  return [specifier.slice(0, slash), specifier.slice(slash + 1)];
}

function suggestedModels(): string[] {
  const listed = () => listRuntimeModelProviders({ env: {}, registeredProviders: new Set() })
    .flatMap((provider) => provider.suggestions);
  const node = listed();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  try {
    return [...new Set([...node, ...listed()])];
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
}

test('every suggested model and every API-key image model has a current price', () => {
  const suggestions = suggestedModels();
  for (const credits of [
    'openrouter/deepseek/deepseek-v4.1-flash',
    'openrouter/z-ai/glm-5.3-flash',
    'openrouter/moonshotai/kimi-k3',
    'cloudflare/@cf/zai-org/glm-4.7-flash',
  ]) assert.ok(suggestions.includes(credits), `${credits} is suggested`);
  const unpriced = suggestions.filter((specifier) => {
    const [provider, model] = split(specifier);
    return estimateUsage(measurement(provider, model)).estimateCompleteness !== 'complete';
  });
  assert.deepEqual(unpriced, []);

  const profiles = IMAGE_MODEL_IDS.map((id) => findImageModel(id)!);
  assert.deepEqual(
    profiles.filter((profile) => profile.authMethod !== 'api_key').map((profile) => profile.id),
    ['openai/chatgpt-image'],
    'only the subscription image model is unmetered: its plan is a flat fee',
  );
  const unpricedImages = profiles
    .filter((profile) => profile.authMethod === 'api_key')
    .filter((profile) => {
      const priced = priceCatalogFor('image_tokens', profile.provider, profile.model, REVIEWED);
      return !priced ||
        REVIEWED >= priced.version.staleAfter ||
        !(priced.rate.textInputMicrosPerUnit > 0 &&
          priced.rate.imageInputMicrosPerUnit > 0 &&
          priced.rate.imageOutputMicrosPerUnit > 0);
    })
    .map((profile) => profile.id);
  assert.deepEqual(unpricedImages, []);
});

test('catalog models under alias providers and dated slugs price as their canonical entry', () => {
  const routes = [
    ['anthropic', 'claude-opus-5-5', [ANTHROPIC_COMPAT_PROVIDER_ID, revisionedAlias('anthropic', 3, SNAPSHOT).providerId]],
    ['anthropic', 'claude-sonnet-5-5', [ANTHROPIC_COMPAT_PROVIDER_ID, revisionedAlias('anthropic', 3, SNAPSHOT).providerId]],
    ['openai', 'gpt-5.6-terra', [OPENAI_PLATFORM_COMPAT_PROVIDER_ID, revisionedAlias('openaiPlatform', 3, SNAPSHOT).providerId]],
    ['openai', 'gpt-6-sol', [OPENAI_PLATFORM_COMPAT_PROVIDER_ID, revisionedAlias('openaiPlatform', 3, SNAPSHOT).providerId]],
  ] as const;
  for (const [canonical, model, aliases] of routes) {
    const expected = estimateUsage(measurement(canonical, model));
    assert.equal(expected.estimateCompleteness, 'complete', model);
    for (const alias of aliases) {
      assert.deepEqual(estimateUsage(measurement(alias, model)), expected, `${alias}/${model}`);
    }
  }
  assert.deepEqual(
    estimateUsage(measurement('anthropic', 'claude-haiku-4-5-20251001')),
    estimateUsage(measurement('anthropic', 'claude-haiku-4-5')),
  );
  for (const [model, dated] of [
    ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-20260910'],
    ['z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flash-20260826'],
    ['moonshotai/kimi-k3', 'moonshotai/kimi-k3-20260715'],
    ['anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5-20260630'],
    ['openai/gpt-5.6-terra', 'openai/gpt-5.6-terra-20260709'],
  ] as const) {
    const undated = estimateUsage(measurement('openrouter', model));
    assert.equal(undated.estimateCompleteness, 'complete', model);
    assert.deepEqual(estimateUsage(measurement('openrouter', dated)), undated, dated);
  }
  for (const subscription of ['openai-subscription', revisionedAlias('openaiSubscription', 3, SNAPSHOT).providerId]) {
    assert.equal(
      estimateUsage(measurement(subscription, 'gpt-5.6-terra')).priceUnknownReason,
      'price_unknown',
      'a subscription turn is a flat fee, never per-token spend',
    );
  }
});

test('one-hour cache writes price at the one-hour rate from the 2026-10-07 review on', () => {
  const cached = {
    inputTokens: 231,
    outputTokens: 732,
    cacheReadTokens: 85_706,
    cacheWriteTokens: 15_654,
    cacheWrite1hTokens: 10_000,
  };
  // 231×2 + 732×10 + 85,706×0.20 + 5,654×2.50 + 10,000×4 USD per million tokens.
  assert.deepEqual(estimateUsage(measurement('anthropic', 'claude-sonnet-5-5', cached)), {
    estimateCompleteness: 'complete',
    estimateAmountMicros: 79_058,
    estimateCurrency: 'USD',
    priceVersionId: 'anthropic-sonnet-5-5_2026-10-07',
    priceUnknownReason: null,
  });
  assert.equal(
    estimateUsage(measurement(ANTHROPIC_COMPAT_PROVIDER_ID, 'claude-opus-5-5', cached)).estimateAmountMicros,
    // 231×4 + 732×20 + 85,706×0.20 + 5,654×5 + 10,000×8
    140_975,
  );
  assert.equal(
    estimateUsage(measurement('openrouter', 'anthropic/claude-sonnet-5', cached)).estimateAmountMicros,
    79_058,
  );
  const partial = {
    estimateCompleteness: 'partial',
    estimateAmountMicros: null,
    estimateCurrency: null,
    priceVersionId: null,
    priceUnknownReason: 'pricing_dimension_unknown',
  };
  assert.deepEqual(
    estimateUsage(measurement('anthropic', 'claude-sonnet-5-5', { ...cached, observedAt: Date.UTC(2026, 9, 6, 12) })),
    partial,
    'the 2026-10-06 price has no one-hour rate',
  );
  assert.deepEqual(
    estimateUsage(measurement('anthropic', 'claude-sonnet-5-5', { ...cached, cacheWrite1hTokens: 15_655 })),
    partial,
    'more one-hour writes than writes',
  );
});

test('a measurement whose prompt reaches the long-context tier stays partial', () => {
  const prompt = (tokens: number) => ({ inputTokens: tokens - 72_000, cacheReadTokens: 72_000, cacheWriteTokens: 0 });
  assert.equal(
    estimateUsage(measurement('openai', 'gpt-5.6-terra', prompt(272_000))).estimateCompleteness,
    'complete',
    'OpenAI bills more than 272K input tokens at long-context rates',
  );
  assert.equal(
    estimateUsage(measurement('openai', 'gpt-5.6-terra', prompt(272_001))).priceUnknownReason,
    'pricing_dimension_unknown',
  );
  assert.equal(
    estimateUsage(measurement('openrouter', 'openai/gpt-5.6-terra', prompt(272_000))).priceUnknownReason,
    'pricing_dimension_unknown',
    'OpenRouter applies its override from 272,000 prompt tokens',
  );
  assert.equal(
    estimateUsage(measurement('anthropic', 'claude-sonnet-5-5', prompt(900_000))).estimateCompleteness,
    'complete',
    'Anthropic prices the full context window at one rate',
  );
});

test('recorded measurements keep their price version; only unpriced ones are backfilled', () => {
  const db = openStateDb(':memory:');
  const beforeReview = Date.UTC(2026, 9, 6, 12);
  const afterReview = Date.UTC(2026, 9, 7, 1);
  const usage = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 };
  const terminal = (executionId: string, observedAt: number, provider: string, model: string) => {
    const estimate = estimateUsage({ ...measurement(provider, model, { observedAt }), ...usage });
    return {
      operationId: `op_${executionId}`,
      executionId,
      status: 'completed' as const,
      finishedAt: observedAt,
      observedAt,
      providerRoute: provider,
      requestedProvider: 'anthropic',
      requestedModel: model,
      returnedProvider: provider,
      returnedModel: model,
      credentialRefId: null,
      credentialVersion: null,
      usageCompleteness: 'complete' as const,
      ...usage,
      usageUnknownReason: null,
      ...estimate,
    };
  };
  try {
    const before = new UsageStoreLogic(db, () => afterReview);
    const recorded = [
      terminal('sonnet_before_review', beforeReview, 'anthropic', 'claude-sonnet-5-5'),
      { ...terminal('opus_alias_unpriced', afterReview, ANTHROPIC_COMPAT_PROVIDER_ID, 'claude-opus-5-5'),
        estimateCompleteness: 'unknown' as const, estimateAmountMicros: null, estimateCurrency: null,
        priceVersionId: null, priceUnknownReason: 'price_unknown' as const },
    ];
    for (const row of recorded) {
      before.admitOperation({
        operationId: row.operationId,
        operationKind: 'interactive_turn',
        sourceId: row.operationId,
        startedAt: row.observedAt - 1,
        installationId: 'test',
        workspaceId: 'T_TEST',
        agentId: 'agent_default',
        agentLabel: 'Default',
        channelId: 'C_TEST',
        channelLabel: 'bot-test',
        conversationKind: 'named_channel',
        requestedProvider: 'anthropic',
        requestedModel: row.requestedModel,
        credentialRefId: null,
        credentialVersion: null,
      });
      before.recordTerminal(row);
    }
    assert.equal(recorded[0]?.priceVersionId, 'anthropic-sonnet-5-5_2026-10-06');

    const after = new UsageStoreLogic(db, () => afterReview + 1);
    const kept = after.getOperation('op_sonnet_before_review')?.measurements[0];
    assert.equal(kept?.priceVersionId, 'anthropic-sonnet-5-5_2026-10-06');
    assert.equal(kept?.estimateAmountMicros, 3_000);
    const backfilled = after.getOperation('op_opus_alias_unpriced')?.measurements[0];
    assert.equal(backfilled?.estimateCompleteness, 'complete');
    assert.equal(backfilled?.priceVersionId, 'anthropic-opus-5-5_2026-10-07');
    assert.equal(backfilled?.estimateAmountMicros, 6_000);
  } finally {
    db.close();
  }
});
