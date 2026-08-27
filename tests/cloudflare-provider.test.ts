import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type { CloudflareAIBinding } from '@flue/runtime/cloudflare/workers-ai';
import {
  hasProvider,
  resetModelsForTests,
  resolveModel,
} from '@flue/runtime/internal';

import {
  createCloudflareBindingProvider,
  cloudflareBindingProviderOptions,
  registerCloudflareBindingProvider,
} from '../src/cloudflare-provider.ts';
import { setWorkersAiRestPiProvider } from '../src/config/pi-provider.ts';
import { runWithAttachmentModelContext } from '../src/slack/attachment-model-context.ts';

beforeEach(() => resetModelsForTests());
afterEach(() => resetModelsForTests());

test('the Cloudflare-only helper has no registration side effect when merely imported', () => {
  assert.equal(hasProvider('cloudflare'), false);
});

test('the Workers AI binding registration opts out of the default AI Gateway', () => {
  const binding: CloudflareAIBinding = {
    run: async () => ({ response: 'ok' }),
  };

  const options = cloudflareBindingProviderOptions(binding);

  assert.notEqual(options.binding, binding);
  assert.equal(options.gateway, false);
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
  const registeredBinding = cloudflareBindingProviderOptions(binding).binding;
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

test('a caller abort reaches the active Workers AI model request', async () => {
  let receivedSignal: AbortSignal | undefined;
  const binding: CloudflareAIBinding = {
    run: async (_modelId, _inputs, options) => {
      receivedSignal = options?.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        const signal = receivedSignal;
        if (!signal) return;
        signal.addEventListener(
          'abort',
          () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    },
  };
  const registeredBinding = cloudflareBindingProviderOptions(binding).binding;
  const controller = new AbortController();
  const prompt = registeredBinding.run(
    '@cf/zai-org/glm-5.2',
    { messages: [{ role: 'user', content: 'stop' }] },
    { signal: controller.signal },
  );

  controller.abort(new DOMException('routine deadline reached', 'TimeoutError'));

  await assert.rejects(prompt, /routine deadline reached/);
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(receivedSignal?.reason.name, 'TimeoutError');
});

test('the seeded keyless GLM binding preserves a lower requested output limit', async () => {
  let receivedPayload: Record<string, unknown> | undefined;
  const binding: CloudflareAIBinding = {
    run: async (_modelId, inputs) => {
      receivedPayload = inputs;
      return { response: 'ok' };
    },
  };
  const registeredBinding = cloudflareBindingProviderOptions(binding).binding;

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
  const registeredBinding = cloudflareBindingProviderOptions(binding).binding;

  await registeredBinding.run('@cf/openai/gpt-oss-120b', payload);

  assert.equal(receivedPayload, payload);
});

test('the Cloudflare binding registration does not alter the REST Workers AI provider', () => {
  setWorkersAiRestPiProvider({
    baseUrl: 'https://workers-ai.example.invalid/v1',
    apiKey: 'test-key',
    accountId: 'test-account',
    contextWindowFloor: 32_768,
    maxTokens: 2_048,
  });
  registerCloudflareBindingProvider({ run: async () => ({ response: 'ok' }) });

  const model = resolveModel('cloudflare-workers-ai/@cf/zai-org/glm-5.2');

  assert.equal(model.provider, 'cloudflare-workers-ai');
  assert.equal(model.baseUrl, 'https://workers-ai.example.invalid/v1');
  assert.equal(Object.hasOwn(model, 'binding'), false);
  assert.equal(Object.hasOwn(model, 'gateway'), false);
});

test('the Cloudflare binding provider receives the same request-local attachment baseline', async () => {
  let receivedInputs: Record<string, unknown> | undefined;
  const provider = createCloudflareBindingProvider({
    run: async (_modelId, inputs) => {
      receivedInputs = inputs;
      return { response: 'grounded' };
    },
  });
  const model = provider.getModels().find((candidate) => candidate.id === '@cf/zai-org/glm-5.2');
  assert.ok(model);

  await runWithAttachmentModelContext([{
    kind: 'text',
    ordinal: 1,
    fileId: 'FCF',
    filename: 'cloudflare.txt',
    label: 'Attachment 1 - cloudflare.txt',
    representation: 'text_original',
    contentType: 'text/plain',
    text: 'binding-only-evidence',
  }], async () => {
    await provider.streamSimple(model, {
      messages: [{ role: 'user', content: 'Read the attachment.', timestamp: 1 }],
      tools: [],
    }).result();
  });

  assert.match(JSON.stringify(receivedInputs), /binding-only-evidence/);
  assert.match(JSON.stringify(receivedInputs), /Attachment 1 - cloudflare\.txt/);
});
