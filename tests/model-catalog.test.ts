import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BUNDLED_MODEL_CATALOG,
  catalogModelForLane,
  isPiNativeModel,
  materializeCatalogModel,
  type ModelCatalogEntry,
} from '../src/model-catalog/index.ts';

test('the bundled catalog describes only canonical ids, lane profiles, and shrink-only limits', () => {
  assert.equal(BUNDLED_MODEL_CATALOG.length, 9);
  assert.deepEqual(
    BUNDLED_MODEL_CATALOG.filter((entry) => entry.id.startsWith('openai/gpt-5.6-'))
      .map((entry) => entry.id),
    ['openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna'],
  );
  for (const entry of BUNDLED_MODEL_CATALOG) {
    assert.match(entry.id, /^(openai|anthropic)\/[a-z0-9][a-z0-9._-]+$/);
    assert.deepEqual(
      Object.keys(entry).sort(),
      Object.keys(entry).filter((key) =>
        ['id', 'displayName', 'lanes', 'contextWindow', 'maxTokens'].includes(key)
      ).sort(),
    );
    assert.equal(Object.keys(entry.lanes).length > 0, true);
  }
});

test('Pi-native models win and current Pi gaps are supplied by reviewed profiles', () => {
  assert.equal(isPiNativeModel('openai/gpt-5.4'), true);
  assert.equal(isPiNativeModel('anthropic/claude-fable-5'), true);
  assert.equal(isPiNativeModel('openai/gpt-5.6-sol'), false);
  assert.equal(isPiNativeModel('anthropic/claude-opus-5'), false);

  assert.equal(catalogModelForLane('openai/gpt-5.4', 'openai_api_key'), undefined);
  const openAi = catalogModelForLane('openai/gpt-5.6-sol', 'openai_api_key');
  assert.equal(openAi?.provider, 'openai');
  assert.equal(openAi?.api, 'openai-responses');
  assert.equal(openAi?.reasoning, true);
  assert.deepEqual(openAi?.input, ['text', 'image']);
  assert.equal(openAi?.contextWindow, 272_000);
  assert.equal(openAi?.maxTokens, 128_000);
  assert.deepEqual(openAi?.cost, {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  });

  const anthropic = catalogModelForLane('anthropic/claude-opus-5', 'anthropic_api_key');
  assert.equal(anthropic?.provider, 'anthropic');
  assert.equal(anthropic?.api, 'anthropic-messages');
  assert.equal(anthropic?.contextWindow, 1_000_000);
  assert.equal(anthropic?.maxTokens, 128_000);
  assert.deepEqual(anthropic?.compat, {
    forceAdaptiveThinking: true,
    supportsTemperature: false,
  });
});

test('catalog limits may shrink compiled ceilings but can never expand them', () => {
  const base = BUNDLED_MODEL_CATALOG.find((entry) => entry.id === 'openai/gpt-5.6-sol');
  assert.ok(base);
  const smaller: ModelCatalogEntry = {
    ...base,
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
  const model = materializeCatalogModel(smaller, 'openai_api_key');
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.maxTokens, 64_000);

  assert.throws(
    () => materializeCatalogModel({ ...base, contextWindow: 300_000 }, 'openai_api_key'),
    /cannot exceed compiled profile/i,
  );
  assert.throws(
    () => materializeCatalogModel({ ...base, maxTokens: 129_000 }, 'openai_api_key'),
    /cannot exceed compiled profile/i,
  );
});

test('subscription inventory is catalog-backed even when the API-key model is Pi-native', () => {
  const subscription = catalogModelForLane('openai/gpt-5.4', 'openai_subscription', {
    nativeFirst: false,
  });
  assert.equal(subscription?.provider, 'openai-codex');
  assert.equal(subscription?.api, 'openai-codex-responses');
  assert.equal(subscription?.contextWindow, 272_000);
  assert.equal(subscription?.maxTokens, 128_000);
});
