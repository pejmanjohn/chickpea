import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { modelEffortChoiceError, resolveModelEfforts } from '../src/config/model-effort-capability.ts';
import {
  agentModelEffortAfterPatch,
  modelEffortsFor,
  standardModelEffort,
} from '../src/config/model-effort.ts';
import { OPENAI_AUTH_METHOD_SETTING_KEY } from '../src/config/openai-auth.ts';
import { invalidateProviderModelCache } from '../src/config/provider-models.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { getBuiltinModel } from '../src/model-catalog/pi-builtin-models.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  invalidateProviderModelCache();
});

async function withSettings<T>(run: (settings: SqliteSettingsStore) => Promise<T>): Promise<T> {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    return await run(settings);
  } finally {
    settings.close();
  }
}

test('each lane offers the efforts its runtime model accepts', async () => {
  await withSettings(async (settings) => {
    const efforts = (model: string) => resolveModelEfforts(model, { settings });
    assert.deepEqual(await efforts('anthropic/claude-opus-5-5'), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(await efforts('anthropic/claude-haiku-4-5'), ['low', 'medium', 'high']);
    assert.deepEqual(await efforts('openai/gpt-5.5'), ['low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(await efforts('openai/gpt-5.5-pro'), ['medium', 'high', 'xhigh']);
    // Workers AI GLM runs with thinking off, so it has no effort setting.
    assert.deepEqual(await efforts('cloudflare/@cf/zai-org/glm-5.3-flash'), []);
    assert.deepEqual(await efforts('cloudflare-workers-ai/@cf/zai-org/glm-5.3-flash'), []);
    // The binding sends xhigh as high; REST sends what Pi maps.
    assert.deepEqual(await efforts('cloudflare/@cf/qwen/qwen3.8-27b'), ['low', 'medium']);
    assert.deepEqual(await efforts('cloudflare-workers-ai/@cf/qwen/qwen3.8-27b'), ['low', 'medium', 'xhigh']);
    assert.deepEqual(await efforts('cloudflare/@cf/openai/gpt-oss-120b'), ['low', 'medium', 'high']);
    // One remaining level is no choice.
    assert.deepEqual(await efforts('cloudflare/@cf/moonshotai/kimi-k2.6'), []);
    assert.deepEqual(await efforts('anthropic/claude-unknown-9'), []);
    assert.deepEqual(await efforts('local-stub/model'), []);
    assert.deepEqual(await efforts('not-a-model'), []);
  });
});

test('the ChatGPT subscription never offers max', async () => {
  await withSettings(async (settings) => {
    await settings.setSetting(OPENAI_AUTH_METHOD_SETTING_KEY, 'subscription');
    assert.deepEqual(
      await resolveModelEfforts('openai/gpt-5.5', { settings }),
      ['low', 'medium', 'high', 'xhigh'],
    );
    assert.deepEqual(await resolveModelEfforts('openai/gpt-6.1-sol', { settings }), ['low', 'medium', 'high', 'xhigh']);
  });
});

test('OpenRouter models use Pi\'s entry, else the live list\'s efforts, and unknown models have none', async () => {
  await withSettings(async (settings) => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return Response.json({
        data: [{
          id: 'acme/listed-efforts',
          supported_parameters: ['reasoning'],
          reasoning: { supported_efforts: ['high', 'low', 'none'] },
        }],
      });
    };
    const efforts = (model: string) => resolveModelEfforts(model, { settings });
    assert.deepEqual(await efforts('openrouter/anthropic/claude-opus-5.5'), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(fetches, 0, 'a model Pi knows needs no live list');
    assert.deepEqual(await efforts('openrouter/acme/listed-efforts'), ['low', 'high']);
    assert.deepEqual(await efforts('openrouter/acme/unlisted'), []);
    assert.equal(fetches, 1, 'the live list is cached');
  });
});

test('modelEffortsFor keeps Chickpea\'s levels in order and drops a single level', () => {
  const opus = getBuiltinModel('anthropic', 'claude-opus-5-5')!;
  assert.deepEqual(modelEffortsFor(opus), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(modelEffortsFor(opus, 'high'), ['low', 'medium', 'high']);
  const kimi = getBuiltinModel('cloudflare-workers-ai', '@cf/moonshotai/kimi-k2.6')!;
  assert.deepEqual(modelEffortsFor(kimi), [], 'off and high leave one level');
  assert.deepEqual(modelEffortsFor({ ...opus, reasoning: false }), []);
});

test('the standard effort is medium moved like Pi\'s clamp, upward first', () => {
  assert.equal(standardModelEffort(['low', 'medium', 'high']), 'medium');
  assert.equal(standardModelEffort(['low', 'high', 'max']), 'high');
  assert.equal(standardModelEffort(['high', 'xhigh']), 'high');
  assert.equal(standardModelEffort(['low']), 'low');
  assert.equal(standardModelEffort([]), undefined);
});

test('an Agent keeps its effort only while its model stays the same', () => {
  const pinned = { model: 'anthropic/claude-opus-5-5', modelEffort: 'max' as const };
  assert.equal(agentModelEffortAfterPatch(pinned, {}), 'max');
  assert.equal(agentModelEffortAfterPatch(pinned, { model: 'anthropic/claude-opus-5-5' }), 'max');
  assert.equal(agentModelEffortAfterPatch(pinned, { model: 'openai/gpt-5.5' }), undefined);
  assert.equal(agentModelEffortAfterPatch(pinned, { model: 'openai/gpt-5.5', modelEffort: 'high' }), 'high');
  assert.equal(agentModelEffortAfterPatch(pinned, { modelEffort: null }), undefined);
  assert.equal(agentModelEffortAfterPatch(pinned, { model: null }), undefined);
  assert.equal(agentModelEffortAfterPatch({}, { modelEffort: 'high' }), undefined);
  // Medium is a choice like any other, never folded into unset.
  assert.equal(agentModelEffortAfterPatch(pinned, { modelEffort: 'medium' }), 'medium');
});

test('a named effort needs a model that accepts it', async () => {
  await withSettings(async (settings) => {
    assert.equal(await modelEffortChoiceError('anthropic/claude-opus-5-5', 'max', { settings }), undefined);
    assert.equal(
      (await modelEffortChoiceError('anthropic/claude-haiku-4-5', 'max', { settings }))?.code,
      'effort_not_supported',
    );
    assert.equal((await modelEffortChoiceError(undefined, 'high', { settings }))?.code, 'effort_requires_model');
  });
});
