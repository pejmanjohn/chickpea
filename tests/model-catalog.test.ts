import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeContext, type Model } from '@earendil-works/pi-ai';
import { streamSimple as streamCodex } from '@earendil-works/pi-ai/api/openai-codex-responses';

import hosted from '../catalog/current.json' with { type: 'json' };
import {
  BUNDLED_MODEL_CATALOG,
  catalogModelForLane,
  isPiNativeModel,
  materializeCatalogModel,
  type ModelCatalogEntry,
} from '../src/model-catalog/index.ts';
import { getBuiltinModel } from '../src/model-catalog/pi-builtin-models.ts';
import { compiledModelProfile, isCompiledModelProfileId } from '../src/model-catalog/profiles.ts';

test('the bundled catalog describes only canonical ids, lane profiles, and shrink-only limits', () => {
  assert.equal(BUNDLED_MODEL_CATALOG.length, 16);
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

test('Pi-native models win while reviewed profiles remain available for non-native routes', () => {
  assert.equal(isPiNativeModel('openai/gpt-5.4'), true);
  assert.equal(isPiNativeModel('anthropic/claude-fable-5'), true);
  assert.equal(isPiNativeModel('openai/gpt-5.6-sol'), true);
  assert.equal(isPiNativeModel('anthropic/claude-opus-5'), true);

  assert.equal(catalogModelForLane('openai/gpt-5.4', 'openai_api_key'), undefined);
  assert.equal(catalogModelForLane('openai/gpt-5.6-sol', 'openai_api_key'), undefined);
  const openAi = catalogModelForLane('openai/gpt-5.6-sol', 'openai_api_key', {
    nativeFirst: false,
  });
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

  assert.equal(catalogModelForLane('anthropic/claude-opus-5', 'anthropic_api_key'), undefined);
  const anthropic = catalogModelForLane('anthropic/claude-opus-5', 'anthropic_api_key', {
    nativeFirst: false,
  });
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

test('no catalog lane sends reasoning effort `none` to a model Pi says cannot turn it off', () => {
  const lanes = [
    ...BUNDLED_MODEL_CATALOG.map((entry) => ({ id: entry.id, profiles: Object.values(entry.lanes) })),
    ...hosted.entries.map((entry) => ({ id: entry.canonical, profiles: Object.values(entry.lanes) })),
  ];
  let checked = 0;
  for (const { id, profiles } of lanes) {
    const modelId = id.slice(id.indexOf('/') + 1);
    for (const profile of profiles) {
      assert.ok(isCompiledModelProfileId(profile), `${id} names compiled profile ${profile}`);
      const model = compiledModelProfile(profile, { id: modelId, name: modelId });
      if (getBuiltinModel(model.provider, modelId)?.thinkingLevelMap?.off !== null) continue;
      assert.equal(model.thinkingLevelMap?.off, null, `${id} on ${profile} would send effort none`);
      checked += 1;
    }
  }
  assert.ok(checked >= 4, 'GPT-6.1 Sol and GPT-6 Astra are checked on both OpenAI lanes');
});

test('a subscription request with no thinking level leaves the reasoning effort to the backend', async () => {
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } };
  const apiKey = ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');
  const context = normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] });
  for (const entry of BUNDLED_MODEL_CATALOG) {
    const model = catalogModelForLane(entry.id, 'openai_subscription', { nativeFirst: false });
    if (!model) continue;
    for (const reasoning of [undefined, 'high'] as const) {
      let payload: { reasoning?: { effort?: string } } | undefined;
      await streamCodex(model as Model<'openai-codex-responses'>, context, {
        apiKey,
        ...(reasoning ? { reasoning } : {}),
        onPayload: (body) => {
          payload = body as typeof payload;
          throw new Error('payload captured');
        },
      }).result();
      assert.ok(payload, `${entry.id} built a request`);
      assert.equal(payload.reasoning?.effort, reasoning, `${entry.id} with ${reasoning ?? 'no'} thinking level`);
    }
  }
});
