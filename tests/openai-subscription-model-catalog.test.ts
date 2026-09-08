import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BUNDLED_OPENAI_SUBSCRIPTION_MODELS,
  listOpenAiSubscriptionModels,
} from '../src/openai-subscription/model-catalog.ts';
import { OPENAI_SUBSCRIPTION_MODELS } from '../src/openai-subscription/protocol.ts';

test('the release catalog contains the seven live-verified subscription models', () => {
  assert.deepEqual(
    BUNDLED_OPENAI_SUBSCRIPTION_MODELS.map((model) => model.id),
    OPENAI_SUBSCRIPTION_MODELS,
  );
  assert.equal(
    BUNDLED_OPENAI_SUBSCRIPTION_MODELS.every((model) =>
      model.contextWindow > 0 &&
      model.maxTokens > 0 &&
      model.maxTokens <= model.contextWindow &&
      model.input.includes('text')
    ),
    true,
  );
});

test('catalog callers receive defensive copies of model metadata', () => {
  const first = listOpenAiSubscriptionModels();
  first[0]!.name = 'mutated';
  first[0]!.input.push('text');

  const second = listOpenAiSubscriptionModels();
  assert.notEqual(second[0]!.name, 'mutated');
  assert.deepEqual(second[0]!.input, ['text', 'image']);
});
