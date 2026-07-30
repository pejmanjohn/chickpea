import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveModel } from '@flue/runtime/internal';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from '@earendil-works/pi-ai';

import { resolveRuntimeModel, canonicalRuntimeModel } from '../src/config/runtime-model.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { catalogModelForLane } from '../src/model-catalog/index.ts';
import {
  ANTHROPIC_COMPAT_PROVIDER_ID,
  ANTHROPIC_COMPAT_API,
  bindModelCompatibilityProvider,
  createModelCompatibilityStream,
  OPENAI_PLATFORM_COMPAT_API,
  OPENAI_PLATFORM_COMPAT_PROVIDER_ID,
} from '../src/model-compat/provider.ts';

function assistant(provider: string, model: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'test-api',
    provider,
    model,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1,
  };
}

test('compatibility provider registration gives Flue bounded metadata under internal ids', () => {
  bindModelCompatibilityProvider('openai', 'test-openai-key');
  bindModelCompatibilityProvider('anthropic', 'test-anthropic-key');

  const openAi = resolveModel(`${OPENAI_PLATFORM_COMPAT_PROVIDER_ID}/gpt-5.6-terra`);
  assert.equal(openAi.provider, OPENAI_PLATFORM_COMPAT_PROVIDER_ID);
  assert.equal(openAi.api, OPENAI_PLATFORM_COMPAT_API);
  assert.equal(openAi.contextWindow, 272_000);
  assert.equal(openAi.maxTokens, 128_000);

  const anthropic = resolveModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/claude-sonnet-5`);
  assert.equal(anthropic.provider, ANTHROPIC_COMPAT_PROVIDER_ID);
  assert.equal(anthropic.api, ANTHROPIC_COMPAT_API);
  assert.equal(anthropic.contextWindow, 1_000_000);
  assert.equal(anthropic.maxTokens, 128_000);
});

test('the compatibility stream reconstructs the canonical model and rewrites history/output identities', async () => {
  const revisionedProvider = 'chickpea-openai-platform-r42-deadbeef';
  const revisionedApi = 'chickpea-openai-platform-responses-r42-deadbeef';
  const resolverCalls: string[] = [];
  let adapterModel: Model<string> | undefined;
  let adapterContext: Context | undefined;
  const source = createAssistantMessageEventStream();
  const output = assistant('openai', 'gpt-5.6-sol');
  const incomingModel: Model<string> = {
    id: 'gpt-5.6-sol',
    name: 'zero metadata',
    api: revisionedApi,
    provider: revisionedProvider,
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  };
  const context: Context = {
    systemPrompt: 'system',
    messages: [assistant(revisionedProvider, 'gpt-5.6-sol')],
    tools: [],
  };

  const stream = createModelCompatibilityStream(
    incomingModel,
    context,
    { apiKey: 'test-key' },
    false,
    {
      route: { provider: 'openai', lane: 'openai_api_key' },
      resolveModel: (canonicalModel, lane) => {
        resolverCalls.push(`${canonicalModel}:${lane}`);
        return catalogModelForLane(canonicalModel, lane, { nativeFirst: false });
      },
      openAiStream: (model, mappedContext) => {
        adapterModel = model;
        adapterContext = mappedContext;
        queueMicrotask(() => {
          source.push({ type: 'start', partial: output });
          source.push({ type: 'done', reason: 'stop', message: output });
          source.end();
        });
        return source;
      },
    },
  );

  const events = [];
  for await (const event of stream) events.push(event);

  assert.equal(adapterModel?.provider, 'openai');
  assert.equal(adapterModel?.api, 'openai-responses');
  assert.equal(adapterModel?.reasoning, true);
  assert.deepEqual(adapterModel?.input, ['text', 'image']);
  assert.deepEqual(resolverCalls, ['openai/gpt-5.6-sol:openai_api_key']);
  assert.equal(
    (adapterContext?.messages[0] as AssistantMessage | undefined)?.provider,
    'openai',
  );
  assert.equal(events[0]?.type, 'start');
  if (events[0]?.type === 'start') {
    assert.equal(events[0].partial.provider, revisionedProvider);
    assert.equal(events[0].partial.api, revisionedApi);
  }
  assert.equal(events[1]?.type, 'done');
  if (events[1]?.type === 'done') {
    assert.equal(events[1].message.provider, revisionedProvider);
    assert.equal(events[1].message.api, revisionedApi);
  }
});

test('runtime routing is native-first, lane-isolated, and explicit for unsupported built-ins', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const applied: string[] = [];
  const dependencies = {
    settings,
    applyProviderKey: async (id: 'anthropic' | 'openai' | 'openrouter') => {
      applied.push(id);
    },
  };

  assert.deepEqual(
    await resolveRuntimeModel('agent', 'openai/gpt-5.4', dependencies),
    { model: 'openai/gpt-5.4', providerAuthRoute: 'openai_api_key' },
  );
  assert.deepEqual(
    await resolveRuntimeModel('agent', 'openai/gpt-5.6-sol', dependencies),
    {
      model: `${OPENAI_PLATFORM_COMPAT_PROVIDER_ID}/gpt-5.6-sol`,
      providerAuthRoute: 'openai_api_key',
    },
  );
  assert.deepEqual(
    await resolveRuntimeModel('agent', 'anthropic/claude-haiku-4-5', dependencies),
    { model: 'anthropic/claude-haiku-4-5' },
  );
  assert.deepEqual(
    await resolveRuntimeModel('agent', 'anthropic/claude-opus-5', dependencies),
    { model: `${ANTHROPIC_COMPAT_PROVIDER_ID}/claude-opus-5` },
  );
  await assert.rejects(
    () => resolveRuntimeModel('agent', 'openai/gpt-not-reviewed', dependencies),
    /not supported by this Chickpea release/i,
  );
  await assert.rejects(
    () => resolveRuntimeModel('agent', 'anthropic/claude-not-reviewed', dependencies),
    /not supported by this Chickpea release/i,
  );
  assert.deepEqual(applied, ['openai', 'openai', 'anthropic', 'anthropic']);
  assert.equal(
    canonicalRuntimeModel(`${OPENAI_PLATFORM_COMPAT_PROVIDER_ID}/gpt-5.6-sol`),
    'openai/gpt-5.6-sol',
  );
  assert.equal(
    canonicalRuntimeModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/claude-opus-5`),
    'anthropic/claude-opus-5',
  );
});
