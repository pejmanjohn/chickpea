import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  findImageModel,
  isImageModelId,
  listImageModels,
  IMAGE_EDIT_INPUT_CAP,
  type ImageModelProfile,
} from '../src/model-catalog/image-profiles.ts';

test('the image catalog lists both OpenAI models for the OpenAI provider only', () => {
  const models = listImageModels('openai');

  assert.deepEqual(
    models.map((model) => model.id),
    ['openai/gpt-image-2.5-flare', 'openai/gpt-image-2.5-sunburst'],
  );
  for (const provider of ['anthropic', 'openrouter', 'workers-ai', 'google', '']) {
    assert.deepEqual(listImageModels(provider), []);
  }
});

test('each entry declares the capability shape the tool and Admin read', () => {
  for (const model of listImageModels('openai')) {
    assert.equal(model.provider, 'openai');
    assert.equal(model.api, 'openai-images');
    assert.deepEqual(model.input, ['text', 'image']);
    assert.deepEqual(model.output, ['image']);
    assert.equal(model.maxEditInputs, 16);
    assert.equal(IMAGE_EDIT_INPUT_CAP, 16);
    // The wire id drops the provider prefix the catalog id carries.
    assert.equal(model.model, model.id.slice('openai/'.length));
    assert.equal(model.baseUrl, 'https://api.openai.com/v1');
    assert.ok(model.name.length > 0);
  }
});

test('models are found by catalog id and unknown ids resolve to nothing', () => {
  const found = findImageModel('openai/gpt-image-2.5-sunburst');

  assert.equal(found?.model, 'gpt-image-2.5-sunburst');
  assert.equal(findImageModel('gpt-image-2.5-sunburst'), undefined);
  assert.equal(findImageModel('openai/gpt-5.3'), undefined);
  assert.equal(findImageModel('google/imagen-4'), undefined);
  assert.equal(isImageModelId('openai/gpt-image-2.5-flare'), true);
  assert.equal(isImageModelId('openai/gpt-image-1.5'), false);
  assert.equal(isImageModelId(42), false);
});

test('a caller cannot mutate the shared catalog through a listing', () => {
  const models = listImageModels('openai');
  models.pop();
  assert.equal(listImageModels('openai').length, 2);

  const profile = listImageModels('openai')[0] as ImageModelProfile;
  assert.throws(() => {
    (profile as { model: string }).model = 'tampered';
  });
  assert.equal(findImageModel('openai/gpt-image-2.5-flare')?.model, 'gpt-image-2.5-flare');
});
