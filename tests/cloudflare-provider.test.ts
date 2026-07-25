import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { registerProvider } from '@flue/runtime';
import type { CloudflareAIBinding } from '@flue/runtime/cloudflare';
import {
  hasRegisteredProvider,
  resetProviderRuntime,
  resolveModel,
} from '@flue/runtime/internal';

import { registerCloudflareBindingProvider } from '../src/cloudflare-provider.ts';

beforeEach(() => resetProviderRuntime());
afterEach(() => resetProviderRuntime());

test('the Cloudflare-only helper has no registration side effect when merely imported', () => {
  assert.equal(hasRegisteredProvider('cloudflare'), false);
});

test('the Workers AI binding registration opts out of the default AI Gateway', () => {
  const binding: CloudflareAIBinding = {
    run: async () => ({ response: 'ok' }),
  };

  registerProvider('cloudflare', {
    api: 'cloudflare-ai-binding',
    binding,
  });
  const defaultRoutedModel = resolveModel('cloudflare/@cf/test/default-routed');
  assert.deepEqual(Object.getOwnPropertyDescriptor(defaultRoutedModel, 'gateway')?.value, {
    id: 'default',
  });

  registerCloudflareBindingProvider(binding);
  const model = resolveModel('cloudflare/@cf/test/private');

  assert.equal(model.provider, 'cloudflare');
  assert.equal(model.api, 'cloudflare-ai-binding');
  assert.notEqual(Object.getOwnPropertyDescriptor(model, 'binding')?.value, binding);
  assert.equal(Object.getOwnPropertyDescriptor(model, 'gateway')?.value, undefined);
});

test('the seeded keyless GLM binding explicitly disables server-side thinking', async () => {
  const calls: Array<{
    modelId: string;
    inputs: Record<string, unknown>;
    options: Record<string, unknown> | undefined;
  }> = [];
  const binding: CloudflareAIBinding = {
    run: async (modelId, inputs, options) => {
      calls.push({ modelId, inputs, options });
      return { response: 'ok' };
    },
  };
  registerCloudflareBindingProvider(binding);
  const model = resolveModel('cloudflare/@cf/zai-org/glm-5.2');
  const registeredBinding = Object.getOwnPropertyDescriptor(model, 'binding')
    ?.value as CloudflareAIBinding;
  const options = { returnRawResponse: true };

  await registeredBinding.run(
    '@cf/zai-org/glm-5.2',
    {
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'medium',
      max_completion_tokens: 8_192,
      chat_template_kwargs: { clear_thinking: false },
    },
    options,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.modelId, '@cf/zai-org/glm-5.2');
  assert.deepEqual(calls[0]?.inputs, {
    messages: [{ role: 'user', content: 'hello' }],
    max_completion_tokens: 2_048,
    chat_template_kwargs: {
      clear_thinking: false,
      enable_thinking: false,
    },
  });
  assert.equal(calls[0]?.options?.returnRawResponse, true);
  assert.ok(calls[0]?.options?.signal instanceof AbortSignal);
  assert.equal((calls[0]?.options?.signal as AbortSignal).aborted, false);
});

test('the seeded keyless GLM binding preserves a lower requested output limit', async () => {
  let receivedPayload: Record<string, unknown> | undefined;
  const binding: CloudflareAIBinding = {
    run: async (_modelId, inputs) => {
      receivedPayload = inputs;
      return { response: 'ok' };
    },
  };
  registerCloudflareBindingProvider(binding);
  const model = resolveModel('cloudflare/@cf/zai-org/glm-5.2');
  const registeredBinding = Object.getOwnPropertyDescriptor(model, 'binding')
    ?.value as CloudflareAIBinding;

  await registeredBinding.run('@cf/zai-org/glm-5.2', {
    messages: [],
    max_completion_tokens: 512,
  });

  assert.equal(receivedPayload?.max_completion_tokens, 512);
});

test('the binding payload policy leaves every other Workers AI model unchanged', async () => {
  const payload = { messages: [], reasoning_effort: 'medium' };
  let receivedPayload: Record<string, unknown> | undefined;
  const binding: CloudflareAIBinding = {
    run: async (_modelId, inputs) => {
      receivedPayload = inputs;
      return { response: 'ok' };
    },
  };
  registerCloudflareBindingProvider(binding);
  const model = resolveModel('cloudflare/@cf/openai/gpt-oss-120b');
  const registeredBinding = Object.getOwnPropertyDescriptor(model, 'binding')
    ?.value as CloudflareAIBinding;

  await registeredBinding.run('@cf/openai/gpt-oss-120b', payload);

  assert.equal(receivedPayload, payload);
});

test('the Cloudflare binding registration does not alter the REST Workers AI provider', () => {
  registerProvider('cloudflare-workers-ai', {
    baseUrl: 'https://workers-ai.example.invalid/v1',
    apiKey: 'test-key',
  });
  registerCloudflareBindingProvider({ run: async () => ({ response: 'ok' }) });

  const model = resolveModel('cloudflare-workers-ai/@cf/test/rest');

  assert.equal(model.provider, 'cloudflare-workers-ai');
  assert.equal(model.baseUrl, 'https://workers-ai.example.invalid/v1');
  assert.equal(Object.hasOwn(model, 'binding'), false);
  assert.equal(Object.hasOwn(model, 'gateway'), false);
});
