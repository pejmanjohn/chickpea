import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeContext, type Api, type Model, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models';
import { resolveModel } from '@flue/runtime/internal';

import { GEMINI_MODELS } from '../src/config/gemini-models.ts';
import {
  decorateGeminiPayloadStreams,
  GEMINI_STORE_OPT_OUT,
  withGeminiPayloadPolicy,
} from '../src/config/gemini-payload.ts';
import {
  installationModelAccessResolver,
  withStatelessModelAccess,
} from '../src/config/installation-model-access.ts';
import { configureModelAccessResolver } from '../src/config/model-access.ts';
import { resolveModelEfforts } from '../src/config/model-effort-capability.ts';
import { activeCatalogCompatibilityError } from '../src/config/model-readiness.ts';
import { registerBuiltinPiProvider } from '../src/config/pi-provider.ts';
import { invalidateProviderKeyCache } from '../src/config/provider-keys.ts';
import { validateProviderApiKey, ProviderKeyRejectedError } from '../src/config/provider-models.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { getBuiltinModel } from '../src/model-catalog/pi-builtin-models.ts';
import { hasCredentialLikeContent, redactCredentialLikeContent } from '../src/security/content-validation.ts';
import { withEnv } from './helpers/env.ts';
import { FAKE_PROVIDER_KEYS, FakeProvidersBackend } from './helpers/fake-providers.ts';

const BASE_URL = 'https://gemini.fake/v1beta';
const REVIEWED = ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

async function withGeminiWire<T>(run: (requests: CapturedRequest[]) => Promise<T>): Promise<T> {
  const requests: CapturedRequest[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers, body: await request.json() as Record<string, unknown> });
    const chunk = {
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = previous;
  }
}

function context() {
  return normalizeContext({ messages: [{ role: 'user' as const, content: 'Say ok.', timestamp: 1 }] });
}

function wireThinking(request: CapturedRequest | undefined): Record<string, unknown> | undefined {
  const generationConfig = request?.body.generationConfig as Record<string, unknown> | undefined;
  return generationConfig?.thinkingConfig as Record<string, unknown> | undefined;
}

async function sentThinking(modelId: keyof typeof GEMINI_MODELS, reasoning: ModelThinkingLevel | undefined) {
  const model = { ...GEMINI_MODELS[modelId], baseUrl: BASE_URL } as Model<Api>;
  const streams = decorateGeminiPayloadStreams(googleGenerativeAIApi());
  return withGeminiWire(async (requests) => {
    const result = await streams.streamSimple(model, context(), {
      apiKey: 'synthetic-gemini-key',
      maxRetries: 0,
      ...(reasoning && reasoning !== 'off' ? { reasoning } : {}),
    }).result();
    assert.equal(result.stopReason, 'stop', result.errorMessage ?? 'the stream ended without stopping');
    assert.equal(requests.length, 1);
    return { thinking: wireThinking(requests[0]), body: requests[0]!.body };
  });
}

test('Gemini 4 Argon sends the requested thinking level and never a token budget', async () => {
  const expected: Array<[ModelThinkingLevel | undefined, string]> = [
    ['low', 'LOW'],
    ['medium', 'MEDIUM'],
    ['high', 'HIGH'],
    ['xhigh', 'HIGH'],
    ['off', 'LOW'],
    [undefined, 'LOW'],
  ];
  for (const [effort, level] of expected) {
    const { thinking } = await sentThinking('gemini-4-argon', effort);
    assert.equal(thinking?.thinkingLevel, level, `effort ${effort ?? 'none'}`);
    assert.equal(thinking?.thinkingBudget, undefined, `effort ${effort ?? 'none'} sends no budget`);
  }
  const { thinking } = await sentThinking('gemini-4-argon', 'high');
  assert.equal(thinking?.includeThoughts, true, 'thought summaries stay on');
});

test('the Gemini models Pi already routes reach Google exactly as Pi builds them', async () => {
  const streams = googleGenerativeAIApi();
  for (const modelId of ['gemini-3.8-flash', 'gemini-3.5-flash-lite'] as const) {
    for (const effort of ['low', 'high', undefined] as const) {
      const model = { ...GEMINI_MODELS[modelId], baseUrl: BASE_URL } as Model<Api>;
      const plain = await withGeminiWire(async (requests) => {
        await streams.streamSimple(model, context(), { apiKey: 'k', maxRetries: 0, ...(effort ? { reasoning: effort } : {}) }).result();
        return requests[0]!.body;
      });
      const { body } = await sentThinking(modelId, effort);
      const { store, ...rest } = body;
      assert.equal(store, false, 'the request-log opt-out is the only addition');
      assert.deepEqual(rest, plain, `${modelId} at ${effort ?? 'no effort'}`);
      assert.equal(wireThinking({ body } as CapturedRequest)?.thinkingBudget, undefined);
    }
  }
});

test('the request-log opt-out ships on and reaches Google as a top-level store: false', async () => {
  assert.equal(GEMINI_STORE_OPT_OUT, true);
  for (const modelId of REVIEWED as (keyof typeof GEMINI_MODELS)[]) {
    const { body } = await sentThinking(modelId, 'medium');
    assert.equal(body.store, false, modelId);
    assert.equal(JSON.stringify(body).match(/"store"/g)?.length, 1, `${modelId} sends store once, at the top level`);
  }

  const payload = { model: 'gemini-3.8-flash', contents: [], config: { thinkingConfig: { thinkingLevel: 'MEDIUM' } } };
  const on = withGeminiPayloadPolicy(payload, GEMINI_MODELS['gemini-3.8-flash'], 'medium', { storeOptOut: true });
  assert.deepEqual((on.config as { httpOptions?: unknown }).httpOptions, { extraBody: { store: false } });
  assert.equal(withGeminiPayloadPolicy(payload, GEMINI_MODELS['gemini-3.8-flash'], 'medium', { storeOptOut: false }), payload);
});

test('the policy composes with a caller payload hook, which runs first', async () => {
  const model = { ...GEMINI_MODELS['gemini-4-argon'], baseUrl: BASE_URL } as Model<Api>;
  const streams = decorateGeminiPayloadStreams(googleGenerativeAIApi());
  const seen = await withGeminiWire(async (requests) => {
    let hooked: Record<string, unknown> | undefined;
    await streams.streamSimple(model, context(), {
      apiKey: 'k',
      maxRetries: 0,
      reasoning: 'medium',
      onPayload: (payload) => {
        hooked = structuredClone(payload) as Record<string, unknown>;
        return { ...(payload as Record<string, unknown>), config: { ...(payload as { config: object }).config, temperature: 0.25 } };
      },
    }).result();
    return { hooked, sent: requests[0]!.body };
  });
  assert.equal((seen.hooked?.config as { thinkingConfig: { thinkingBudget: number } }).thinkingConfig.thinkingBudget, -1,
    'the caller sees the payload Pi built');
  assert.equal((seen.sent.generationConfig as { temperature: number }).temperature, 0.25);
  assert.equal(wireThinking({ body: seen.sent } as CapturedRequest)?.thinkingLevel, 'MEDIUM');
});

test('Chickpea carries Argon only until Pi ships it', () => {
  assert.equal((GOOGLE_MODELS as Record<string, unknown>)['gemini-4-argon'], undefined,
    'Pi now ships Gemini 4 Argon: delete its row in gemini-models.ts and the thinking rewrite in gemini-payload.ts');
});

test('the Google provider registers only the reviewed Gemini models, with their names', () => {
  registerBuiltinPiProvider('google');
  assert.deepEqual(Object.keys(GEMINI_MODELS), REVIEWED);
  for (const id of REVIEWED) {
    const model = resolveModel(`google/${id}`);
    assert.equal(model.api, 'google-generative-ai');
    assert.equal(model.provider, 'google');
    assert.equal(getBuiltinModel('google', id)?.id, id);
  }
  assert.equal(resolveModel('google/gemini-3.5-flash-lite').name, 'Gemini 3.5 Flash-Lite');
  for (const id of ['gemini-2.5-flash', 'gemini-flash-latest', 'gemma-4-31b-it', 'gemini-3.6-flash']) {
    assert.throws(() => resolveModel(`google/${id}`), Error, `${id} is not offered`);
    assert.equal(getBuiltinModel('google', id), undefined);
  }
});

test('each reviewed Gemini model offers low, medium and high effort', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    for (const id of REVIEWED) {
      assert.deepEqual(await resolveModelEfforts(`google/${id}`, { settings }), ['low', 'medium', 'high'], id);
    }
    assert.deepEqual(await resolveModelEfforts('google/gemini-2.5-flash', { settings }), []);
  } finally {
    settings.close();
  }
});

test('a Gemini model outside the reviewed set is refused by name', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    for (const id of REVIEWED) {
      assert.equal(await activeCatalogCompatibilityError(`google/${id}`, 'api_key', settings), undefined, id);
    }
    assert.equal(
      await activeCatalogCompatibilityError('google/gemini-2.5-pro', 'api_key', settings),
      'Chickpea does not offer this Gemini model. Choose Gemini 4 Argon, Gemini 3.8 Flash, or Gemini 3.5 Flash-Lite.',
    );
  } finally {
    settings.close();
  }
});

test('Gemini key validation sends the key in a header, never the URL, and lists the reviewed models', async () => {
  const fake = new FakeProvidersBackend();
  const previous = globalThis.fetch;
  globalThis.fetch = fake.asFetch();
  try {
    await withEnv({ GEMINI_API_URL: BASE_URL }, async () => {
      const models = await validateProviderApiKey('google', FAKE_PROVIDER_KEYS.google);
      assert.deepEqual(models, [
        { id: 'gemini-4-argon', display_name: 'Gemini 4 Argon', context_length: 1_048_576 },
        { id: 'gemini-3.8-flash', display_name: 'Gemini 3.8 Flash', context_length: 1_048_576 },
        { id: 'gemini-3.5-flash-lite', display_name: 'Gemini 3.5 Flash-Lite', context_length: 1_048_576 },
      ]);
      const [call] = fake.callsFor('/v1beta/models');
      assert.equal(call?.method, 'GET');
      assert.equal(call?.url, `${BASE_URL}/models`);
      assert.equal(call?.headers['x-goog-api-key'], FAKE_PROVIDER_KEYS.google);

      await assert.rejects(validateProviderApiKey('google', 'AIza-not-a-key'), (error: unknown) =>
        error instanceof ProviderKeyRejectedError && error.provider === 'google' && error.status === 400 &&
        error.detail === 'API key not valid. Please pass a valid API key.');
      assert.ok(fake.calls.every((sent) => !sent.url.includes('AIza') && !sent.url.includes(FAKE_PROVIDER_KEYS.google)));
    });
  } finally {
    globalThis.fetch = previous;
  }
});

test('a turn on the registered Google provider carries the key in x-goog-api-key and its base URL path', async () => {
  const key = `AQ.Ab${'Q'.repeat(48)}`;
  await withEnv({ GEMINI_API_KEY: key, GEMINI_BASE_URL: BASE_URL }, async () => {
    invalidateProviderKeyCache();
    configureModelAccessResolver(installationModelAccessResolver);
    registerBuiltinPiProvider('google');
    const model = resolveModel('google/gemini-3.8-flash');
    const requests = await withGeminiWire(async (sent) => {
      await withStatelessModelAccess('google/gemini-3.8-flash', { env: undefined, runId: 'gemini-wire', purpose: 'reply' }, async () => {
        const { providerStreamsForModel } = await import('../src/config/pi-provider.ts');
        const result = await providerStreamsForModel(model).streamSimple(model, context(), { maxRetries: 0 }).result();
        assert.equal(result.stopReason, 'stop', result.errorMessage ?? 'the stream ended without stopping');
      });
      return sent;
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, `${BASE_URL}/models/gemini-3.8-flash:streamGenerateContent?alt=sse`);
    assert.equal(requests[0]!.headers.get('x-goog-api-key'), key);
    assert.equal(requests[0]!.url.includes(key), false);
  });
  invalidateProviderKeyCache();
});

test('a Google API key in text counts as a credential and is redacted', () => {
  const key = `AIza${'Sy0_-'.repeat(7)}`;
  assert.equal(key.length, 39);
  assert.equal(hasCredentialLikeContent(`key: ${key}`), true);
  assert.equal(redactCredentialLikeContent(`use ${key} now (${key})`), 'use [credential redacted] now ([credential redacted])');
  assert.equal(hasCredentialLikeContent(`AIza${'x'.repeat(34)}`), false, 'too short to be a key');
});

test('a Google auth key (AQ.) in text counts as a credential and is redacted', () => {
  // The shape AI Studio issues since 2026-05-28: `AQ.` then 50 characters, here 53 in all.
  const key = `AQ.Ab${'8RN6x_q-Z0'.repeat(4)}${'k3'.repeat(4)}`;
  assert.equal(key.length, 53);
  assert.equal(hasCredentialLikeContent(`GEMINI_API_KEY=${key}`), true);
  assert.equal(redactCredentialLikeContent(`use ${key} now (${key}).`), 'use [credential redacted] now ([credential redacted]).');
  assert.equal(hasCredentialLikeContent(`AQ.Ab${'x'.repeat(30)}`), false, 'too short to be a key');
  assert.equal(redactCredentialLikeContent(`AQ.Zz${'9'.repeat(48)}`), '[credential redacted]', 'any auth key after AQ., not only Ab');
  assert.equal(redactCredentialLikeContent(`GEMINI_API_KEY=legacy-gemini-value`), '[credential redacted]');
  assert.equal(hasCredentialLikeContent('Water quality (AQ.Ab) readings'), false);
});
