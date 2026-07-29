import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveModel } from '@flue/runtime/internal';
import { getApiProvider } from '@earendil-works/pi-ai/compat';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { listRuntimeModelProviders } from '../src/config/providers.ts';
import { commitOpenAiSubscriptionCredentials } from '../src/openai-subscription/credentials.ts';
import { OpenAiSubscriptionProtocolError } from '../src/openai-subscription/protocol.ts';
import {
  bindOpenAiSubscriptionProvider,
  OPENAI_SUBSCRIPTION_PROVIDER_ID,
  openAiSubscriptionModelSpecifier,
} from '../src/openai-subscription/provider.ts';
import {
  createOpenAiSubscriptionFetchBoundary,
  OPENAI_SUBSCRIPTION_TRANSPORT_MARKER,
} from '../src/openai-subscription/transport.ts';

const NOW = 1_800_000_000_000;
const REQUEST_BODY = JSON.stringify({
  model: 'gpt-5.4',
  store: false,
  stream: true,
  instructions: 'Be helpful.',
  input: [{ role: 'user', content: 'Hello' }],
  text: { verbosity: 'low' },
  include: ['reasoning.encrypted_content'],
  tool_choice: 'auto',
  parallel_tool_calls: true,
});

test('the subscription boundary replaces caller credentials at the exact Codex endpoint', async () => {
  let captured: Request | undefined;
  const boundary = createOpenAiSubscriptionFetchBoundary({
    credentials: () => ({ accessToken: 'live-access-token', accountId: 'account-primary' }),
    randomUUID: () => 'request-session-id',
    fetch: async (input, init) => {
      captured = new Request(input, init);
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  const response = await boundary('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: {
      authorization: 'Bearer caller-token',
      'chatgpt-account-id': 'caller-account',
      originator: 'caller-originator',
      'session-id': 'caller-session',
      'x-client-request-id': 'caller-request-id',
      [OPENAI_SUBSCRIPTION_TRANSPORT_MARKER]: 'v1',
    },
    body: REQUEST_BODY,
  });

  assert.equal(response.status, 200);
  assert.ok(captured);
  assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers.get('authorization'), 'Bearer live-access-token');
  assert.equal(captured.headers.get('chatgpt-account-id'), 'account-primary');
  assert.equal(captured.headers.get('originator'), 'chickpea');
  assert.equal(captured.headers.get('session-id'), 'request-session-id');
  assert.equal(captured.headers.get('x-client-request-id'), 'request-session-id');
  assert.equal(captured.headers.get(OPENAI_SUBSCRIPTION_TRANSPORT_MARKER), null);
  assert.deepEqual(await captured.json(), JSON.parse(REQUEST_BODY));
});

test('the subscription boundary leaves unrelated OpenAI API traffic untouched', async () => {
  let captured: Request | undefined;
  const boundary = createOpenAiSubscriptionFetchBoundary({
    credentials: () => ({ accessToken: 'subscription-token', accountId: 'subscription-account' }),
    fetch: async (input, init) => {
      captured = new Request(input, init);
      return new Response('{}');
    },
  });

  await boundary('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer api-key' },
    body: '{}',
  });

  assert.equal(captured?.headers.get('authorization'), 'Bearer api-key');
  assert.equal(captured?.url, 'https://api.openai.com/v1/responses');
});

test('the subscription boundary fails closed for unmarked, malformed, and redirected requests', async () => {
  const boundary = createOpenAiSubscriptionFetchBoundary({
    credentials: () => ({ accessToken: 'subscription-token', accountId: 'subscription-account' }),
    fetch: async () => new Response('', { status: 302, headers: { location: 'https://example.com/' } }),
  });

  await assert.rejects(
    boundary('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: REQUEST_BODY,
    }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionProtocolError && error.code === 'protocol_drift',
  );
  await assert.rejects(
    boundary('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { [OPENAI_SUBSCRIPTION_TRANSPORT_MARKER]: 'v1' },
      body: JSON.stringify({ ...JSON.parse(REQUEST_BODY), unexpected: true }),
    }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionProtocolError && error.code === 'protocol_drift',
  );
  await assert.rejects(
    boundary('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { [OPENAI_SUBSCRIPTION_TRANSPORT_MARKER]: 'v1' },
      body: REQUEST_BODY,
    }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionProtocolError && error.code === 'protocol_drift',
  );
});

test('provider errors are reduced to bounded failure codes and repeated 401s are reported', async () => {
  let authenticationFailures = 0;
  const boundary = createOpenAiSubscriptionFetchBoundary({
    credentials: () => ({ accessToken: 'subscription-token', accountId: 'subscription-account' }),
    onAuthenticationFailure: async () => { authenticationFailures += 1; },
    fetch: async () => new Response('raw provider secret and internal trace', { status: 401 }),
  });

  const response = await boundary('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: { [OPENAI_SUBSCRIPTION_TRANSPORT_MARKER]: 'v1' },
    body: REQUEST_BODY,
  });
  const safeBody = await response.text();

  assert.equal(response.status, 401);
  assert.equal(authenticationFailures, 1);
  assert.match(safeBody, /auth_reconnect_required/);
  assert.doesNotMatch(safeBody, /raw provider secret|internal trace/);
});

test('the subscription boundary enforces its response-header timeout', async () => {
  const boundary = createOpenAiSubscriptionFetchBoundary({
    credentials: () => ({ accessToken: 'subscription-token', accountId: 'subscription-account' }),
    timeoutMs: 1,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
  });

  await assert.rejects(
    boundary('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { [OPENAI_SUBSCRIPTION_TRANSPORT_MARKER]: 'v1' },
      body: REQUEST_BODY,
    }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionProtocolError && error.code === 'request_timeout',
  );
});

test('the registered wire handler streams through the boundary and ignores caller overrides', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await commitOpenAiSubscriptionCredentials(
    {
      accessToken: 'stream-access',
      refreshToken: 'stream-refresh',
      idToken: undefined,
      expiresAt: NOW + 3_600_000,
      accountId: 'stream-account',
    },
    { settings, now: () => NOW, randomBytes: (length) => new Uint8Array(length).fill(4) },
  );

  let captured: Request | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    captured = new Request(input, init);
    const events = [
      { type: 'response.created', response: { id: 'response_1' } },
      {
        type: 'response.output_item.added',
        item: { type: 'message', id: 'message_1', role: 'assistant', status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added',
        part: { type: 'output_text', text: '', annotations: [] },
      },
      { type: 'response.output_text.delta', delta: 'Hello' },
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          id: 'message_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'response_1',
          status: 'completed',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await bindOpenAiSubscriptionProvider({ settings, now: () => NOW });
  const model = resolveModel(openAiSubscriptionModelSpecifier('gpt-5.4'));
  const api = getApiProvider(model.api);
  assert.ok(api);
  const stream = api.stream(
    model,
    { messages: [{ role: 'user', content: 'Hello', timestamp: NOW }] },
    {
      apiKey: 'caller-api-key',
      sessionId: 'caller-session',
      headers: { authorization: 'Bearer caller-token' },
      onPayload: () => ({ model: 'gpt-4.1', store: true, stream: true }),
    },
  );
  const result = await stream.result();

  assert.equal(result.provider, OPENAI_SUBSCRIPTION_PROVIDER_ID);
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(result.content, [
    { type: 'text', text: 'Hello', textSignature: '{"v":1,"id":"message_1"}' },
  ]);
  assert.equal(captured?.headers.get('authorization'), 'Bearer stream-access');
  assert.equal(captured?.headers.get('chatgpt-account-id'), 'stream-account');
  assert.equal(captured?.headers.get('originator'), 'chickpea');
  assert.notEqual(captured?.headers.get('session-id'), 'caller-session');
  assert.equal((await captured?.clone().json())?.model, 'gpt-5.4');
});

test('malformed subscription streams surface only a bounded adapter error', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await commitOpenAiSubscriptionCredentials(
    {
      accessToken: 'malformed-access',
      refreshToken: 'malformed-refresh',
      idToken: undefined,
      expiresAt: NOW + 3_600_000,
      accountId: 'malformed-account',
    },
    { settings, now: () => NOW, randomBytes: (length) => new Uint8Array(length).fill(5) },
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: raw malformed provider payload\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  await bindOpenAiSubscriptionProvider({ settings, now: () => NOW });
  const model = resolveModel(openAiSubscriptionModelSpecifier('gpt-5.4'));
  const api = getApiProvider(model.api);
  assert.ok(api);
  const result = await api.stream(
    model,
    { messages: [{ role: 'user', content: 'Hello', timestamp: NOW }] },
  ).result();

  assert.equal(result.stopReason, 'error');
  assert.equal(
    result.errorMessage,
    'OpenAI subscription operation failed (provider_unavailable).',
  );
  assert.doesNotMatch(JSON.stringify(result), /raw malformed provider payload/);
});

test('binding the internal provider requires subscription credentials and never falls back to an API key', async (t) => {
  const empty = new SqliteSettingsStore(':memory:');
  t.after(() => empty.close());
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'api-key-must-not-fallback';
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  });

  await assert.rejects(bindOpenAiSubscriptionProvider({ settings: empty }), /auth_reconnect_required/);

  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await commitOpenAiSubscriptionCredentials(
    {
      accessToken: 'subscription-access',
      refreshToken: 'subscription-refresh',
      idToken: undefined,
      expiresAt: NOW + 3_600_000,
      accountId: 'account-primary',
    },
    { settings, now: () => NOW, randomBytes: (length) => new Uint8Array(length).fill(7) },
  );

  await bindOpenAiSubscriptionProvider({ settings, now: () => NOW });
  const resolved = resolveModel(openAiSubscriptionModelSpecifier('gpt-5.4'));

  assert.equal(resolved.provider, OPENAI_SUBSCRIPTION_PROVIDER_ID);
  assert.equal(resolved.api, 'chickpea-openai-subscription-responses');
  assert.equal(resolved.baseUrl, 'https://chatgpt.com/backend-api');
  assert.equal(resolved.contextWindow, 272_000);
  assert.equal(resolved.maxTokens, 128_000);
  assert.equal(resolved.headers, undefined);
  assert.doesNotMatch(JSON.stringify(resolved), /subscription-access|subscription-refresh|account-primary/);

  const listed = listRuntimeModelProviders();
  assert.equal(listed.some((provider) => provider.id === OPENAI_SUBSCRIPTION_PROVIDER_ID), false);
});

test('subscription model specifiers reject models outside the pinned allowlist', () => {
  assert.equal(openAiSubscriptionModelSpecifier('gpt-5.4-mini'), 'openai-subscription/gpt-5.4-mini');
  assert.throws(() => openAiSubscriptionModelSpecifier('gpt-4.1'), /unsupported_model/);
});
