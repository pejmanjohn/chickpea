import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SettingsStore } from '../src/config/settings-store.ts';
import {
  createOpenAiSubscriptionImagesClient,
} from '../src/openai-subscription/images-client.ts';
import {
  bindOpenAiSubscriptionTransport,
  createBoundOpenAiSubscriptionFetch,
  createOpenAiSubscriptionTransportMarker,
  OPENAI_SUBSCRIPTION_TRANSPORT_MARKER,
  releaseOpenAiSubscriptionTransport,
} from '../src/openai-subscription/transport.ts';
import { OPENAI_SUBSCRIPTION_ENDPOINTS } from '../src/openai-subscription/protocol.ts';
import {
  findImageModel,
  OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID,
  type ImageModelProfile,
} from '../src/model-catalog/image-profiles.ts';
import { resolveImageProvider } from '../src/images/provider.ts';
import { withEnv } from './helpers/env.ts';

const PROFILE = findImageModel(OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID) as ImageModelProfile;
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function store(status: 'connected' | 'disconnected' = 'connected'): SettingsStore {
  return {
    async getSetting(key: string) {
      if (key !== 'openai.subscription.status') return undefined;
      return JSON.stringify({ version: 1, state: status, updatedAt: 1 });
    },
  } as unknown as SettingsStore;
}

function eventStream(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function terminalEvent(output: unknown[]): unknown {
  return {
    type: 'response.completed',
    response: {
      status: 'completed',
      error: null,
      incomplete_details: null,
      output,
    },
  };
}

function successfulEvents(id = 'ig_one', snapshot = false): unknown[] {
  const item = { id, type: 'image_generation_call', status: 'completed', result: PNG_BASE64 };
  return [
    {
      type: 'response.output_item.added',
      item: { id, type: 'image_generation_call', status: 'in_progress' },
    },
    { type: 'response.output_item.done', item },
    terminalEvent(snapshot ? [item] : []),
  ];
}

function capturedSuccessfulEvents(): unknown[] {
  return [
    successfulEvents()[0],
    successfulEvents()[1],
    {
      type: 'response.output_item.added',
      item: { id: 'msg_one', type: 'message', status: 'in_progress' },
    },
    {
      type: 'response.output_item.done',
      item: { id: 'msg_one', type: 'message', status: 'completed' },
    },
    terminalEvent([]),
  ];
}

function credentialsDependencies(overrides: Record<string, unknown> = {}) {
  return {
    resolveCredentials: async () => ({
      accessToken: 'subscription-access-token',
      accountId: 'account_test',
      accountFingerprint: 'fingerprint_test',
    }),
    credentialsAreCurrent: async () => true,
    ...overrides,
  };
}

test('subscription generation uses the credential boundary and reports decoded facts', async () => {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const released: string[] = [];
  let marker = '';
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return eventStream(successfulEvents());
  }) as typeof fetch;
  const client = createOpenAiSubscriptionImagesClient({
    profile: PROFILE,
    settings: store(),
    fetchImpl,
    dependencies: credentialsDependencies({
      bindTransport: (...args: Parameters<typeof bindOpenAiSubscriptionTransport>) => {
        marker = args[1].marker;
        bindOpenAiSubscriptionTransport(...args);
      },
      releaseTransport: (value: string) => {
        released.push(value);
        return releaseOpenAiSubscriptionTransport(value);
      },
    }),
  });

  const result = await client.generate({
    prompt: 'A green chickpea on a neutral background',
    size: 'auto',
    quality: 'auto',
    format: { format: 'jpeg', compression: 80, background: 'auto' },
    deadlineMs: 1_000,
  });

  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.appliedModel, OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID);
  assert.equal(result.appliedSize, '1x1');
  assert.equal(result.appliedFormat, 'png');
  assert.equal(result.images.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(calls[0]?.headers.get('authorization'), 'Bearer subscription-access-token');
  assert.equal(calls[0]?.headers.get('originator'), 'chickpea');
  assert.equal(calls[0]?.headers.has('x-chickpea-subscription-transport'), false);
  assert.equal(calls[0]?.body.model, 'gpt-5.6-terra');
  assert.equal(calls[0]?.body.store, false);
  assert.equal(calls[0]?.body.stream, true);
  assert.deepEqual(calls[0]?.body.tools, [{
    type: 'image_generation',
    model: 'gpt-image-2.5-flare',
    quality: 'low',
    size: '1024x1024',
    output_format: 'png',
  }]);
  assert.deepEqual(released, [marker]);
});

test('unsupported user output controls and multiple outputs fail before credentials or egress', async () => {
  let credentialReads = 0;
  let networkCalls = 0;
  const client = createOpenAiSubscriptionImagesClient({
    profile: PROFILE,
    settings: store(),
    fetchImpl: (async () => {
      networkCalls += 1;
      return eventStream(successfulEvents());
    }) as typeof fetch,
    dependencies: credentialsDependencies({
      resolveCredentials: async () => {
        credentialReads += 1;
        throw new Error('must not read');
      },
    }),
  });
  const base = { prompt: 'one image', format: { format: 'png' as const }, deadlineMs: 100 };

  for (const request of [
    { ...base, size: '1024x1024' },
    { ...base, quality: 'high' as const },
    { ...base, format: { format: 'png' as const, background: 'transparent' as const } },
    { ...base, count: 2 },
  ]) {
    const result = await client.generate(request);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.reason, 'invalid-request');
  }
  assert.equal(credentialReads, 0);
  assert.equal(networkCalls, 0);
});

test('terminal failure or a second image call invalidates the whole streamed response', async () => {
  const streams = [
    [...successfulEvents().slice(0, 2), { type: 'response.incomplete', response: {} }],
    [
      ...successfulEvents().slice(0, 2),
      ...successfulEvents('ig_two').slice(0, 2),
      successfulEvents()[2],
    ],
  ];
  for (const events of streams) {
    const client = createOpenAiSubscriptionImagesClient({
      profile: PROFILE,
      settings: store(),
      fetchImpl: (async () => eventStream(events)) as typeof fetch,
      dependencies: credentialsDependencies(),
    });
    const result = await client.generate({
      prompt: 'one image',
      format: { format: 'png' },
      deadlineMs: 1_000,
    });
    assert.deepEqual(result, { ok: false, reason: 'unreachable', detail: 'invalid_response' });
  }
});

test('an optional nonempty terminal snapshot must repeat the same completed image call', async () => {
  const done = successfulEvents()[1];
  const invalidTerminals = [
    terminalEvent([{ type: 'image_generation_call', status: 'completed', result: PNG_BASE64 }]),
    terminalEvent([{ id: 'ig_one', type: 'image_generation_call', status: 'completed', result: 7 }]),
    terminalEvent([{ id: 'ig_one', type: 'image_generation_call', result: PNG_BASE64 }]),
    terminalEvent([{ id: 'ig_one', type: 'image_generation_call', status: 'failed', result: PNG_BASE64 }]),
    terminalEvent([{ id: 'message_one', type: 'message', status: 'completed' }]),
  ];
  for (const terminal of invalidTerminals) {
    const client = createOpenAiSubscriptionImagesClient({
      profile: PROFILE,
      settings: store(),
      fetchImpl: (async () => eventStream([done, terminal])) as typeof fetch,
      dependencies: credentialsDependencies(),
    });
    const result = await client.generate({
      prompt: 'one image',
      format: { format: 'png' },
      deadlineMs: 1_000,
    });
    assert.deepEqual(result, { ok: false, reason: 'unreachable', detail: 'invalid_response' });
  }

  const matching = createOpenAiSubscriptionImagesClient({
    profile: PROFILE,
    settings: store(),
    fetchImpl: (async () => eventStream(successfulEvents('ig_one', true))) as typeof fetch,
    dependencies: credentialsDependencies(),
  });
  assert.equal((await matching.generate({
    prompt: 'one image',
    format: { format: 'png' },
    deadlineMs: 1_000,
  })).ok, true);

  const imageItem = {
    id: 'ig_one',
    type: 'image_generation_call',
    status: 'completed',
    result: PNG_BASE64,
  };
  const imageAndMessage = createOpenAiSubscriptionImagesClient({
    profile: PROFILE,
    settings: store(),
    fetchImpl: (async () => eventStream([
      successfulEvents()[0],
      successfulEvents()[1],
      terminalEvent([imageItem, { id: 'msg_one', type: 'message', status: 'completed' }]),
    ])) as typeof fetch,
    dependencies: credentialsDependencies(),
  });
  assert.equal((await imageAndMessage.generate({
    prompt: 'one image',
    format: { format: 'png' },
    deadlineMs: 1_000,
  })).ok, true);
});

test('an empty successful terminal requires one explicit completed image done event', async () => {
  const capturedShape = createOpenAiSubscriptionImagesClient({
    profile: PROFILE,
    settings: store(),
    fetchImpl: (async () => eventStream(capturedSuccessfulEvents())) as typeof fetch,
    dependencies: credentialsDependencies(),
  });
  assert.equal((await capturedShape.generate({
    prompt: 'one image',
    format: { format: 'png' },
    deadlineMs: 1_000,
  })).ok, true);

  const addedWithResult = {
    type: 'response.output_item.added',
    item: {
      id: 'ig_one',
      type: 'image_generation_call',
      status: 'in_progress',
      result: PNG_BASE64,
    },
  };
  for (const events of [
    [successfulEvents()[0], terminalEvent([])],
    [addedWithResult, terminalEvent([])],
    [successfulEvents()[1], terminalEvent([]), terminalEvent([])],
    [successfulEvents()[1], {
      type: 'response.completed',
      response: { status: 'completed', error: null, incomplete_details: {}, output: [] },
    }],
    [successfulEvents()[1], {
      type: 'response.completed',
      response: { status: 'completed', error: {}, incomplete_details: null, output: [] },
    }],
    [successfulEvents()[1], {
      type: 'response.completed',
      response: { status: 'incomplete', error: null, incomplete_details: null, output: [] },
    }],
  ]) {
    const client = createOpenAiSubscriptionImagesClient({
      profile: PROFILE,
      settings: store(),
      fetchImpl: (async () => eventStream(events)) as typeof fetch,
      dependencies: credentialsDependencies(),
    });
    assert.deepEqual(await client.generate({
      prompt: 'one image',
      format: { format: 'png' },
      deadlineMs: 1_000,
    }), { ok: false, reason: 'unreachable', detail: 'invalid_response' });
  }
});

test('a stalled body times out and releases only its request binding', async () => {
  const released: string[] = [];
  let bodyCancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    pull: () => new Promise(() => {}),
    cancel() { bodyCancellations += 1; },
  });
  const client = createOpenAiSubscriptionImagesClient({
    profile: PROFILE,
    settings: store(),
    fetchImpl: (async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch,
    dependencies: credentialsDependencies({
      releaseTransport: (marker: string) => {
        released.push(marker);
        return releaseOpenAiSubscriptionTransport(marker);
      },
    }),
  });

  const result = await client.generate({
    prompt: 'one image',
    format: { format: 'png' },
    deadlineMs: 10,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(result, { ok: false, reason: 'timeout', detail: 'deadline_exceeded' });
  assert.equal(released.length, 1);
  assert.equal(bodyCancellations, 1);
});

test('a completed image request does not release a concurrent chat binding', async () => {
  const peerMarker = createOpenAiSubscriptionTransportMarker();
  bindOpenAiSubscriptionTransport({ accessToken: 'peer-token', accountId: 'peer-account' }, {
    marker: peerMarker,
    allowedModels: new Set(['gpt-5.6-terra']),
  });
  try {
    const client = createOpenAiSubscriptionImagesClient({
      profile: PROFILE,
      settings: store(),
      fetchImpl: (async () => eventStream(successfulEvents())) as typeof fetch,
      dependencies: credentialsDependencies(),
    });
    const result = await client.generate({
      prompt: 'one image',
      format: { format: 'png' },
      deadlineMs: 1_000,
    });
    assert.equal(result.ok, true);

    let peerCalls = 0;
    const peerFetch = createBoundOpenAiSubscriptionFetch((async () => {
      peerCalls += 1;
      return eventStream([terminalEvent([])]);
    }) as typeof fetch);
    await peerFetch(OPENAI_SUBSCRIPTION_ENDPOINTS.responses, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OPENAI_SUBSCRIPTION_TRANSPORT_MARKER]: peerMarker,
      },
      body: JSON.stringify({ model: 'gpt-5.6-terra', store: false, stream: true }),
    });
    assert.equal(peerCalls, 1);
  } finally {
    releaseOpenAiSubscriptionTransport(peerMarker);
  }
});

test('provider resolution keeps subscription images independent of API keys', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-must-not-select-this-lane' }, async () => {
    const resolved = await resolveImageProvider(
      OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID,
      undefined,
      store('connected'),
      { fetchImpl: (async () => { throw new Error('not called'); }) as typeof fetch },
    );
    assert.equal(resolved.ok, true);
    assert.ok(resolved.ok);
    assert.equal(resolved.profile.authMethod, 'subscription');
    assert.equal(resolved.client.profile.id, OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID);
  });
});

test('provider resolution rejects subscription images on Cloudflare before network access', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Cloudflare-Workers' },
  });
  let networkCalls = 0;
  try {
    const resolved = await resolveImageProvider(
      OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID,
      undefined,
      store('connected'),
      {
        fetchImpl: (async () => {
          networkCalls += 1;
          throw new Error('not called');
        }) as typeof fetch,
      },
    );
    assert.deepEqual(resolved, {
      ok: false,
      reason: 'misconfigured',
      detail: 'unsupported_runtime',
    });
    assert.equal(networkCalls, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
