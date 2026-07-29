import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OPENAI_SUBSCRIPTION_ENABLED_FLAG,
  openAiSubscriptionCapability,
  requireOpenAiSubscriptionEnabled,
} from '../src/openai-subscription/feature.ts';
import { OpenAiSubscriptionError } from '../src/openai-subscription/errors.ts';

test('Subscription preview defaults off and only exact string 1 enables it', () => {
  const previous = process.env[OPENAI_SUBSCRIPTION_ENABLED_FLAG];
  try {
    delete process.env[OPENAI_SUBSCRIPTION_ENABLED_FLAG];
    assert.deepEqual(openAiSubscriptionCapability(), { enabled: false });
    process.env[OPENAI_SUBSCRIPTION_ENABLED_FLAG] = 'true';
    assert.deepEqual(openAiSubscriptionCapability(), { enabled: false });
    process.env[OPENAI_SUBSCRIPTION_ENABLED_FLAG] = '1';
    assert.deepEqual(openAiSubscriptionCapability(), { enabled: true });
  } finally {
    if (previous === undefined) delete process.env[OPENAI_SUBSCRIPTION_ENABLED_FLAG];
    else process.env[OPENAI_SUBSCRIPTION_ENABLED_FLAG] = previous;
  }
});

test('Cloudflare binding wins and the disabled gate returns a stable safe code', () => {
  const previous = process.env[OPENAI_SUBSCRIPTION_ENABLED_FLAG];
  try {
    process.env[OPENAI_SUBSCRIPTION_ENABLED_FLAG] = '1';
    assert.deepEqual(
      openAiSubscriptionCapability({ [OPENAI_SUBSCRIPTION_ENABLED_FLAG]: '0' }),
      { enabled: false },
    );
    assert.deepEqual(
      openAiSubscriptionCapability({ [OPENAI_SUBSCRIPTION_ENABLED_FLAG]: 1 }),
      { enabled: false },
    );
    assert.throws(
      () => requireOpenAiSubscriptionEnabled({ [OPENAI_SUBSCRIPTION_ENABLED_FLAG]: '0' }),
      (error: unknown) =>
        error instanceof OpenAiSubscriptionError && error.code === 'preview_disabled',
    );
  } finally {
    if (previous === undefined) delete process.env[OPENAI_SUBSCRIPTION_ENABLED_FLAG];
    else process.env[OPENAI_SUBSCRIPTION_ENABLED_FLAG] = previous;
  }
});
