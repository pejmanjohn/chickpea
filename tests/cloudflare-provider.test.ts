import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Api, Model } from '@earendil-works/pi-ai';

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
import { createWorkersAiRestPiProvider, setWorkersAiRestPiProvider } from '../src/config/pi-provider.ts';
import { WORKERS_AI_DEFAULT_FAVORITES } from '../src/config/provider-models.ts';
import { SEED_CLOUDFLARE_MODEL_ID } from '../src/config/seed.ts';
import { withWorkersAiPayloadPolicy } from '../src/config/workers-ai-payload.ts';
import { runWithAttachmentModelContext } from '../src/slack/attachment-model-context.ts';

beforeEach(() => resetModelsForTests());
afterEach(() => resetModelsForTests());

test('the keyless seed pins a model Workers AI serves on the Free plan', () => {
  // Cloudflare's 2026-07-28 changelog moved glm-5.2 (and kimi-k2.x) behind
  // Workers Paid and lists glm-4.7-flash among the models that stay Free.
  assert.equal(SEED_CLOUDFLARE_MODEL_ID, '@cf/zai-org/glm-4.7-flash');
  assert.equal(WORKERS_AI_DEFAULT_FAVORITES[0], SEED_CLOUDFLARE_MODEL_ID);
  const provider = createCloudflareBindingProvider({ run: async () => ({ response: 'ok' }) });
  assert.ok(provider.getModels().some((candidate) => candidate.id === SEED_CLOUDFLARE_MODEL_ID));
});

test('the Cloudflare-only helper has no registration side effect when merely imported', () => {
  assert.equal(hasProvider('cloudflare'), false);
});

test('the binding provider includes the current reviewed Cloudflare model', () => {
  const provider = createCloudflareBindingProvider({ run: async () => ({ response: 'ok' }) });
  const model = provider.getModels().find(
    (candidate) => candidate.id === '@cf/zai-org/glm-5.3-flash',
  );

  assert.ok(model);
  assert.equal(model.provider, 'cloudflare');
  assert.equal(model.contextWindow, 32_768);
  assert.equal(model.maxTokens, 2_048);
  assert.deepEqual(model.input, ['text', 'image']);
});

test('the Workers AI binding registration opts out of the default AI Gateway', () => {
  const binding: CloudflareAIBinding = {
    run: async () => ({ response: 'ok' }),
  };

  const options = cloudflareBindingProviderOptions(binding);

  assert.notEqual(options.binding, binding);
  assert.equal(options.gateway, false);
});

test('the reviewed keyless GLM bindings explicitly disable server-side thinking', async () => {
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

  for (const modelId of [
    '@cf/zai-org/glm-4.7-flash',
    '@cf/zai-org/glm-5.2',
    '@cf/zai-org/glm-5.3-flash',
  ]) {
    await registeredBinding.run(
      modelId,
      {
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: 'medium',
        max_completion_tokens: 8_192,
        chat_template_kwargs: { clear_thinking: false },
      },
      options,
    );
  }

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]?.modelId, '@cf/zai-org/glm-4.7-flash');
  assert.deepEqual(calls[1]?.modelId, '@cf/zai-org/glm-5.2');
  assert.deepEqual(calls[2]?.modelId, '@cf/zai-org/glm-5.3-flash');
  for (const call of calls) {
    assert.deepEqual(call.inputs, {
      messages: [{ role: 'user', content: 'hello' }],
      max_completion_tokens: 2_048,
      chat_template_kwargs: {
        clear_thinking: false,
        enable_thinking: false,
      },
    });
    assert.equal(call.options?.returnRawResponse, true);
    assert.ok(call.options?.signal instanceof AbortSignal);
    assert.equal((call.options?.signal as AbortSignal).aborted, false);
  }
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

  await registeredBinding.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', payload);

  assert.equal(receivedPayload, payload);
});

for (const method of ['stream', 'streamSimple'] as const) {
  test(`GPT-OSS ${method} has enough output budget to finish thinking and request a tool`, async () => {
    let receivedInputs: Record<string, unknown> | undefined;
    const provider = createCloudflareBindingProvider({
      run: async (_modelId, inputs) => {
        receivedInputs = inputs;
        // Workers AI defaults to 256 tokens when max_tokens is absent. The
        // failing live request exhausted that budget on thinking alone.
        const truncated = Number(inputs.max_tokens ?? 256) <= 256;
        const chunks = [
          { choices: [{ index: 0, delta: { reasoning_content: 'Prepare the requested Agent.' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: truncated ? {} : { tool_calls: [{
            index: 0, id: 'call_create', type: 'function',
            function: { name: 'create_agent', arguments: '{"name":"QA helper"}' },
          }] }, finish_reason: truncated ? 'length' : 'tool_calls' }] },
        ];
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')
          + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const model = provider.getModels().find(({ id }) => id === '@cf/openai/gpt-oss-120b');
    assert.ok(model);
    const result = await provider[method](model, {
      messages: [{ role: 'user', content: 'Create QA helper.', timestamp: 1 }],
      tools: [{ name: 'create_agent', description: 'Create the requested Agent.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }],
    }).result();

    assert.equal(result.stopReason, 'toolUse', 'thinking must not consume the entire implicit 256-token budget');
    assert.ok(result.content.some((block) => block.type === 'toolCall' && block.name === 'create_agent'));
    assert.equal(receivedInputs?.max_tokens, 8_192);
    assert.equal(Object.hasOwn(receivedInputs!, 'max_completion_tokens'), false);
  });
}

test('the GPT-OSS binding maps explicit caller budgets without changing reasoning or options', async () => {
  let receivedInputs: Record<string, unknown> | undefined;
  let receivedOptions: Record<string, unknown> | undefined;
  const binding = cloudflareBindingProviderOptions({ run: async (_modelId, inputs, options) => {
    receivedInputs = inputs;
    receivedOptions = options;
    return { response: 'ok' };
  } }).binding;
  const options = { signal: new AbortController().signal, returnRawResponse: true };
  for (const budget of [512, 16_384]) {
    for (const key of ['max_tokens', 'max_completion_tokens']) {
      const payload = { messages: [], reasoning_effort: 'high', [key]: budget };
      const before = structuredClone(payload);
      await binding.run('@cf/openai/gpt-oss-120b', payload, options);
      assert.deepEqual(receivedInputs, { messages: [], reasoning_effort: 'high', max_tokens: budget });
      assert.deepEqual(payload, before);
      assert.equal(receivedOptions, options);
    }
  }
});

test('GPT-OSS tool-call replay uses non-null assistant content without changing the conversation', async () => {
  const toolCalls = [{ id: 'call_read', type: 'function', function: {
    name: 'read_fixture', arguments: '{"range":"A1:C4"}',
  } }];
  const payload = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read the fixture.' }] },
      { role: 'assistant', content: null, tool_calls: toolCalls, reasoning_content: 'Read it.' },
      { role: 'tool', content: 'synthetic result', tool_call_id: 'call_read' },
    ],
    tools: [{ type: 'function', function: { name: 'read_fixture' } }],
    stream: true,
  };
  const before = structuredClone(payload);
  const options = { returnRawResponse: true, signal: new AbortController().signal };
  let receivedPayload: Record<string, unknown> | undefined;
  let receivedOptions: Record<string, unknown> | undefined;
  const binding = cloudflareBindingProviderOptions({
    run: async (_modelId, inputs, runOptions) => {
      receivedPayload = inputs;
      receivedOptions = runOptions;
      return { response: 'ok' };
    },
  }).binding;

  await binding.run('@cf/openai/gpt-oss-120b', payload, options);

  assert.deepEqual(receivedPayload, {
    ...payload,
    max_tokens: 8_192,
    messages: [payload.messages[0], { ...payload.messages[1], content: '' }, payload.messages[2]],
  });
  assert.deepEqual(payload, before, 'the shared conversation must not be mutated');
  assert.equal(receivedOptions, options, 'preserve abort and streaming options');

  await binding.run('openai/gpt-5.4', payload, options);
  assert.equal(receivedPayload, payload, 'do not rewrite other model protocols');
});

test('the real Flue binding adapter can replay a GPT-OSS tool result without a schema rejection', async () => {
  const binding: CloudflareAIBinding = {
    run: async (_modelId, inputs) => {
      const messages = inputs.messages as Array<Record<string, unknown>>;
      const assistant = messages.find((message) => message.role === 'assistant');
      if (assistant?.content === null) {
        return new Response('Bad input: assistant content must not be null', { status: 400 });
      }
      assert.equal(assistant?.content, '');
      assert.deepEqual(messages.at(-1), {
        role: 'tool', content: 'synthetic result', tool_call_id: 'call_read',
      });
      return new Response(`data: ${JSON.stringify({ choices: [{
        index: 0, delta: { content: 'Fixture read.' }, finish_reason: 'stop',
      }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  registerCloudflareBindingProvider(binding);
  const provider = createCloudflareBindingProvider(binding);
  const model = resolveModel('cloudflare/@cf/openai/gpt-oss-120b');
  const result = await provider.streamSimple(model, {
    messages: [
      { role: 'user', content: 'Read the fixture.', timestamp: 1 },
      {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'toolCall', id: 'call_read', name: 'read_fixture', arguments: {} }],
        stopReason: 'toolUse', timestamp: 2,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
      { role: 'toolResult', toolCallId: 'call_read', toolName: 'read_fixture',
        content: [{ type: 'text', text: 'synthetic result' }], isError: false, timestamp: 3 },
    ],
  }).result();

  assert.equal(result.stopReason, 'stop', result.errorMessage ?? 'tool replay should complete');
  assert.deepEqual(result.content, [{ type: 'text', text: 'Fixture read.' }]);
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

for (const [method, hookStyle] of [
  ['stream', 'none'], ['stream', 'mutating'], ['stream', 'replacement'],
  ['streamSimple', 'none'], ['streamSimple', 'mutating'], ['streamSimple', 'replacement'],
] as const) {
  test(`REST ${method} repairs GPT-OSS tool replay with a ${hookStyle} payload hook`, async () => {
    const provider = createWorkersAiRestPiProvider({
      baseUrl: 'https://workers-ai.example.invalid/v1',
      contextWindowFloor: 32_768,
      maxTokens: 2_048,
    });
    const model = provider.getModels().find(({ id }) => id === '@cf/openai/gpt-oss-120b');
    assert.ok(model);
    let hookPayload: unknown;
    let hookCalls = 0;
    let requests = 0;
    const context = {
      messages: [
        { role: 'user' as const, content: 'Read the fixture.', timestamp: 1 },
        {
          role: 'assistant' as const, api: model.api, provider: model.provider, model: model.id,
          content: [{ type: 'toolCall' as const, id: 'call_read', name: 'read_fixture', arguments: {} }],
          stopReason: 'toolUse' as const, timestamp: 2,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
        { role: 'toolResult' as const, toolCallId: 'call_read', toolName: 'read_fixture',
          content: [{ type: 'text' as const, text: 'synthetic result' }], isError: false, timestamp: 3 },
      ],
    };
    const before = structuredClone(context);
    const result = await provider[method](model, context, {
      apiKey: 'synthetic-key',
      maxRetries: 0,
      ...(hookStyle === 'none' ? {} : { onPayload: async (payload: unknown, hookModel: Model<Api>) => {
        hookCalls += 1;
        assert.equal(hookModel.id, model.id);
        hookPayload = payload;
        if (hookStyle === 'mutating') {
          (payload as Record<string, unknown>).temperature = 0.25;
          return undefined;
        }
        return { ...(payload as Record<string, unknown>), temperature: 0.25 };
      } }),
      fetch: async (input, init) => {
        requests += 1;
        const request = new Request(input, init);
        assert.equal(request.url, 'https://workers-ai.example.invalid/v1/chat/completions');
        const payload = await request.json() as { messages: Array<Record<string, unknown>>; temperature: number };
        const assistant = payload.messages.find(({ role }) => role === 'assistant');
        if (assistant?.content === null) {
          return new Response('Bad input: assistant content must not be null', { status: 400 });
        }
        assert.equal(assistant?.content, '');
        assert.deepEqual(assistant?.tool_calls, [{
          id: 'call_read', type: 'function', function: { name: 'read_fixture', arguments: '{}' },
        }]);
        if (hookStyle !== 'none') {
          assert.equal(payload.temperature, 0.25, 'caller hook must run before normalization');
        }
        return new Response(`data: ${JSON.stringify({ choices: [{
          index: 0, delta: { content: 'Fixture read.' }, finish_reason: 'stop',
        }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      },
    }).result();

    assert.equal(result.stopReason, 'stop', result.errorMessage ?? 'REST tool replay should complete');
    assert.equal(hookCalls, hookStyle === 'none' ? 0 : 1);
    assert.equal(requests, 1);
    assert.deepEqual(context, before);
    if (hookStyle !== 'none') {
      assert.equal((hookPayload as { messages: Array<Record<string, unknown>> }).messages
        .find(({ role }) => role === 'assistant')?.content, null, 'do not mutate the caller payload');
    }
  });
}

test('Workers AI replay policy leaves non-null content and other models byte-identical', () => {
  const toolCalls = [{ id: 'call_read', type: 'function', function: { name: 'read_fixture', arguments: '{}' } }];
  const payload = { messages: [
    { role: 'assistant', content: 'Reading now.', tool_calls: toolCalls },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    { role: 'tool', content: null },
    { role: 'user', content: null },
  ] };
  const before = structuredClone(payload);
  assert.equal(withWorkersAiPayloadPolicy('@cf/openai/gpt-oss-120b', payload), payload);
  assert.deepEqual(payload, before);
  const replay = { messages: [{ role: 'assistant', content: null, tool_calls: toolCalls }] };
  for (const modelId of ['@cf/zai-org/glm-5.2', '@cf/zai-org/glm-5.3-flash', 'openai/gpt-5.4']) {
    assert.equal(withWorkersAiPayloadPolicy(modelId, replay), replay);
  }
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
