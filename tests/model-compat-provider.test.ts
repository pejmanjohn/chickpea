import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveModel } from '@flue/runtime/internal';
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type Context,
  type Model,
} from '@earendil-works/pi-ai';

import {
  resolveRuntimeModel,
  canonicalRuntimeModel,
  RuntimeModelReadinessError,
} from '../src/config/runtime-model.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  configureModelAccessResolver,
  resetModelAccessForTests,
  withModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import { BUNDLED_MODEL_CATALOG, catalogModelForLane, materializeCatalogModel } from '../src/model-catalog/index.ts';
import {
  ANTHROPIC_COMPAT_PROVIDER_ID,
  ANTHROPIC_COMPAT_API,
  createModelCompatibilityStream,
  OPENAI_PLATFORM_COMPAT_API,
  OPENAI_PLATFORM_COMPAT_PROVIDER_ID,
  registerCapturedModelCompatibilityProvider,
  registerModelCompatibilityApis,
} from '../src/model-compat/provider.ts';
import { registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import type { ProviderKeyId } from '../src/config/provider-key-ids.ts';

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

test('compatibility provider registration gives Flue bounded, credential-free metadata under internal ids', async () => {
  registerModelCompatibilityApis();
  for (const id of [OPENAI_PLATFORM_COMPAT_PROVIDER_ID, ANTHROPIC_COMPAT_PROVIDER_ID]) {
    const resolution = await registeredPiProvider(id)!.auth.apiKey!.resolve({} as never);
    assert.deepEqual(resolution?.auth, {}, `${id} carries no key; each request takes the run's access`);
  }

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
    normalizeContext(context),
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
    (adapterContext?.messages.find((message) => message.role === 'assistant') as AssistantMessage | undefined)?.provider,
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

// Defect caught: a hosted catalog's Anthropic alias reaches the provider
// proxy under its own API name, so the proxy's message-thread switch skips
// it, and the catalog model it sends opens a server-side thread.
test('a hosted Anthropic alias with a session id opens no message thread', async (t) => {
  resetModelAccessForTests();
  t.after(resetModelAccessForTests);
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-compat-thread-test' }) });
  const entry = BUNDLED_MODEL_CATALOG.find((candidate) => candidate.lanes.anthropic_api_key);
  assert.ok(entry, 'the bundled catalog has an Anthropic entry');
  const hosted = { ...materializeCatalogModel(entry, 'anthropic_api_key'), id: 'claude-hosted-only', name: 'Hosted only' };
  assert.equal(hosted.baseUrl, 'https://api.anthropic.com', 'the endpoint where pi-ai turns threads on by default');
  const alias = registerCapturedModelCompatibilityProvider({
    provider: 'anthropic', revision: 851, sha256: 'c'.repeat(64), models: [hosted],
  });
  assert.ok(alias);
  const provider = registeredPiProvider(alias.providerId);
  const model = provider?.getModels().find((candidate) => candidate.id === hosted.id);
  assert.ok(provider && model);

  const sse = (event: Record<string, unknown>) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
  const answer = [
    sse({ type: 'message_start', message: {
      id: 'msg_compat', type: 'message', role: 'assistant', model: hosted.id, content: [],
      usage: { input_tokens: 4, output_tokens: 1 },
    } }),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }),
    sse({ type: 'message_stop' }),
  ].join('');
  const grant: ModelAccessGrant = {
    installationId: 'inst_compat_thread', providerId: 'anthropic', runId: 'run_compat_thread', fundingSource: 'customer',
    credentialRefId: 'cred_anthropic', credentialVersion: 1,
  };
  for (const simple of [true, false]) {
    let sent: { betas: string[]; body: Record<string, unknown> } | undefined;
    const network: typeof fetch = async (_input, init) => {
      sent = {
        betas: (new Headers(init?.headers).get('anthropic-beta') ?? '').split(',').map((beta) => beta.trim()),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(answer, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    };
    const context = normalizeContext({ systemPrompt: 'Synthetic.', messages: [{ role: 'user', content: 'Hello.', timestamp: 1 }] });
    const options = { fetch: network, maxRetries: 0, sessionId: 'agent_thread' };
    const reply: AssistantMessage = await withModelAccess(grant, {}, 'reply', (): Promise<AssistantMessage> =>
      (simple ? provider.streamSimple(model, context, options) : provider.stream(model, context, options)).result());
    assert.equal(reply.stopReason, 'stop');
    assert.ok(sent, 'pi-ai sent the request');
    assert.equal('thread' in sent.body, false);
    assert.equal(sent.betas.some((beta) => beta.startsWith('message-threads-')), false);
    assert.equal((sent.body.messages as unknown[]).length, 1, 'the whole conversation is sent');
  }
});

test('runtime routing is native-first, lane-isolated, and explicit for unsupported built-ins', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const applied: string[] = [];
  const dependencies = {
    settings,
    requireProviderKey: async (id: ProviderKeyId) => {
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
      model: 'openai/gpt-5.6-sol',
      providerAuthRoute: 'openai_api_key',
    },
  );
  assert.deepEqual(
    await resolveRuntimeModel('agent', 'anthropic/claude-haiku-4-5', dependencies),
    { model: 'anthropic/claude-haiku-4-5' },
  );
  assert.deepEqual(
    await resolveRuntimeModel('agent', 'anthropic/claude-opus-5', dependencies),
    { model: 'anthropic/claude-opus-5' },
  );
  await assert.rejects(
    () => resolveRuntimeModel('agent', 'openai/gpt-not-reviewed', dependencies),
    /not supported by this Chickpea release/i,
  );
  await assert.rejects(
    () => resolveRuntimeModel('agent', 'anthropic/claude-not-reviewed', dependencies),
    /not supported by this Chickpea release/i,
  );
  assert.deepEqual(applied, ['openai', 'openai', 'anthropic', 'anthropic', 'openai', 'anthropic']);
  assert.equal(
    canonicalRuntimeModel(`${OPENAI_PLATFORM_COMPAT_PROVIDER_ID}/gpt-5.6-sol`),
    'openai/gpt-5.6-sol',
  );
  assert.equal(
    canonicalRuntimeModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/claude-opus-5`),
    'anthropic/claude-opus-5',
  );
});

test('a supported model with no configured provider returns static repair metadata', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());

  await assert.rejects(
    () => resolveRuntimeModel('agent', 'openai/gpt-5.6-sol', {
      settings,
      resolveProviderKey: async () => ({ apiKey: undefined, source: 'missing' }),
    }),
    (error: unknown) => error instanceof RuntimeModelReadinessError &&
      error.status === 'provider_setup_required' &&
      error.providerId === 'openai' &&
      error.repairPath === '/admin/settings#model-providers',
  );
});
