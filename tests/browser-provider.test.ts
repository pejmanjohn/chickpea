import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserbaseProvider } from '../src/browser/browserbase.ts';
import {
  drainContextDeletions,
  PENDING_CONTEXT_DELETIONS_SETTING,
  queueContextDeletions,
} from '../src/browser/context-deletions.ts';
import {
  awaitRecordingDownload,
  BrowserProviderError,
  type BrowserRecordingDownload,
} from '../src/browser/provider.ts';
import {
  fakeBrowserProvider,
  fakeFetch as sharedFakeFetch,
  type FakeFetchCall,
} from './helpers/fake-cdp-socket.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';

const API_KEY = 'bb_live_secret_key_123';

/** Answers each call with a JSON (or text) body and status. */
function fakeFetch(respond: (call: FakeFetchCall) => { status: number; body?: unknown }) {
  return sharedFakeFetch((call) => {
    const { status, body } = respond(call);
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, { status });
  });
}

test('createSession posts browser settings with the API key header and returns the handle', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({
    status: 201,
    body: { id: 'sess-1', connectUrl: 'wss://connect.browserbase.com/?id=sess-1', status: 'RUNNING', contextId: 'ctx-9' },
  }));
  const provider = createBrowserbaseProvider({ apiKey: API_KEY, projectId: 'proj-1', fetch: fetchImpl });
  const handle = await provider.createSession({
    contextId: 'ctx-9',
    persistContext: true,
    recording: true,
    viewport: { width: 1280, height: 800 },
    allowedDomains: ['example.com'],
    keepAlive: false,
    timeoutSeconds: 300,
  });
  assert.deepEqual(handle, { id: 'sess-1', connectUrl: 'wss://connect.browserbase.com/?id=sess-1', contextId: 'ctx-9' });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://api.browserbase.com/v1/sessions');
  assert.equal(call.headers['X-BB-API-Key'], API_KEY);
  assert.deepEqual(call.body, {
    projectId: 'proj-1',
    browserSettings: {
      recordSession: true,
      viewport: { width: 1280, height: 800 },
      context: { id: 'ctx-9', persist: true },
      allowedDomains: ['example.com'],
    },
    keepAlive: false,
    timeout: 300,
  });
});

test('createSession sends logSession only when it is set', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({ status: 201, body: { id: 's', connectUrl: 'wss://x' } }));
  const provider = createBrowserbaseProvider({ apiKey: API_KEY, fetch: fetchImpl });
  await provider.createSession({ recording: false, logSession: false, keepAlive: true });
  assert.deepEqual(calls[0]!.body, { browserSettings: { recordSession: false, logSession: false }, keepAlive: true });
});

test('createSession omits optional fields when not provided', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({ status: 201, body: { id: 's', connectUrl: 'wss://x' } }));
  const provider = createBrowserbaseProvider({ apiKey: API_KEY, fetch: fetchImpl, baseUrl: 'https://bb.test/' });
  const handle = await provider.createSession({});
  assert.deepEqual(handle, { id: 's', connectUrl: 'wss://x' });
  assert.equal(calls[0]!.url, 'https://bb.test/v1/sessions');
  assert.deepEqual(calls[0]!.body, { browserSettings: { recordSession: true } });
});

test('endSession requests release; sessionStatus and liveView map responses', async () => {
  const { calls, fetchImpl } = fakeFetch((call) => {
    if (call.url.endsWith('/debug')) {
      return {
        status: 200,
        body: {
          debuggerFullscreenUrl: 'https://live/full',
          debuggerUrl: 'https://live/dbg',
          wsUrl: 'wss://live/ws',
          pages: [{ id: 'p1', url: 'https://example.com/', title: 'Example', debuggerFullscreenUrl: 'https://live/p1' }],
        },
      };
    }
    if (call.method === 'GET') return { status: 200, body: { id: 'sess-1', status: 'COMPLETED' } };
    return { status: 200, body: { id: 'sess-1', status: 'COMPLETED' } };
  });
  const provider = createBrowserbaseProvider({ apiKey: API_KEY, projectId: 'proj-1', fetch: fetchImpl });
  await provider.endSession('sess-1');
  assert.equal(calls[0]!.url, 'https://api.browserbase.com/v1/sessions/sess-1');
  assert.deepEqual(calls[0]!.body, { status: 'REQUEST_RELEASE' });

  assert.equal(await provider.sessionStatus('sess-1'), 'COMPLETED');
  assert.equal(calls[1]!.method, 'GET');

  const live = await provider.liveView('sess-1');
  assert.deepEqual(live, {
    fullscreenUrl: 'https://live/full',
    url: 'https://live/dbg',
    pages: [{ id: 'p1', url: 'https://example.com/', title: 'Example', fullscreenUrl: 'https://live/p1' }],
  });
});

test('recording downloads: 202 is success, 409 surfaces its status, list maps entries', async () => {
  let postStatus = 409;
  const { calls, fetchImpl } = fakeFetch((call) => {
    if (call.method === 'POST') return { status: postStatus, body: postStatus === 409 ? { message: 'still running' } : '' };
    return {
      status: 200,
      body: [
        { pageId: 'p1', status: 'COMPLETED', downloadUrl: 'https://signed/p1.mp4' },
        { pageId: 'p2', status: 'IN_PROGRESS' },
      ],
    };
  });
  const provider = createBrowserbaseProvider({ apiKey: API_KEY, fetch: fetchImpl });
  await assert.rejects(provider.requestRecordingDownloads('s1'), (error: unknown) => {
    assert.ok(error instanceof BrowserProviderError);
    assert.equal(error.status, 409);
    return true;
  });
  postStatus = 202;
  await provider.requestRecordingDownloads('s1');
  assert.equal(calls[1]!.url, 'https://api.browserbase.com/v1/sessions/s1/recording/downloads');
  assert.deepEqual(await provider.listRecordingDownloads('s1'), [
    { pageId: 'p1', status: 'COMPLETED', downloadUrl: 'https://signed/p1.mp4' },
    { pageId: 'p2', status: 'IN_PROGRESS' },
  ]);
});

test('recording downloads: the live { downloads: [...] } shape maps entries', async () => {
  const { fetchImpl } = fakeFetch(() => ({
    status: 200,
    body: { downloads: [{ pageId: '0', status: 'COMPLETED', downloadUrl: 'https://signed/0.mp4?token=t' }] },
  }));
  const provider = createBrowserbaseProvider({ apiKey: API_KEY, fetch: fetchImpl });
  assert.deepEqual(await provider.listRecordingDownloads('s1'), [
    { pageId: '0', status: 'COMPLETED', downloadUrl: 'https://signed/0.mp4?token=t' },
  ]);
});

test('createContext posts project and the login\'s label as its name', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: { id: 'ctx-1' } }));
  const provider = createBrowserbaseProvider({ apiKey: API_KEY, projectId: 'proj-1', fetch: fetchImpl });
  assert.deepEqual(await provider.createContext({ loginId: 'wl_1', label: 'agent-a' }), { id: 'ctx-1' });
  assert.equal(calls[0]!.url, 'https://api.browserbase.com/v1/contexts');
  assert.deepEqual(calls[0]!.body, { projectId: 'proj-1', name: 'agent-a' });
});

test('deleteContext deletes by id, treats 404 as already gone, and keeps the key out of other failures', async () => {
  const { calls, fetchImpl } = fakeFetch((call) =>
    call.url.endsWith('/gone') ? { status: 404 } : call.url.endsWith('/broken') ? { status: 500, body: `oops ${API_KEY}` } : { status: 204 });
  const provider = createBrowserbaseProvider({ apiKey: API_KEY, fetch: fetchImpl });
  await provider.deleteContext('ctx/1');
  assert.equal(calls[0]!.method, 'DELETE');
  assert.equal(calls[0]!.url, 'https://api.browserbase.com/v1/contexts/ctx%2F1');
  assert.equal(calls[0]!.headers['X-BB-API-Key'], API_KEY);
  await provider.deleteContext('gone');
  await assert.rejects(provider.deleteContext('broken'), (error: unknown) => {
    assert.ok(error instanceof BrowserProviderError);
    assert.equal(error.status, 500);
    assert.ok(!error.message.includes(API_KEY));
    return true;
  });
});

test('errors never contain the API key and truncate the body to 300 characters', async () => {
  const body = `bad key ${API_KEY} ` + 'x'.repeat(1000);
  const { fetchImpl } = fakeFetch(() => ({ status: 401, body }));
  const provider = createBrowserbaseProvider({ apiKey: API_KEY, fetch: fetchImpl });
  await assert.rejects(provider.sessionStatus('s1'), (error: unknown) => {
    assert.ok(error instanceof BrowserProviderError);
    assert.equal(error.status, 401);
    assert.ok(!error.message.includes(API_KEY));
    assert.ok(error.message.includes('[redacted]'));
    const snippet = error.message.split(': ').slice(1).join(': ');
    assert.ok(snippet.length <= 300, `snippet length ${snippet.length}`);
    return true;
  });
});

test('network failures are wrapped without leaking the key', async () => {
  const fetchImpl = (async () => {
    throw new Error(`connect failed for ${API_KEY}`);
  }) as unknown as typeof fetch;
  const provider = createBrowserbaseProvider({ apiKey: API_KEY, fetch: fetchImpl });
  await assert.rejects(provider.createContext({ loginId: 'wl_1', label: 'Billing' }), (error: unknown) => {
    assert.ok(error instanceof BrowserProviderError);
    assert.ok(!error.message.includes(API_KEY));
    return true;
  });
});

/** A fetch that answers only when its request is aborted, as a stalled Browserbase would. */
const stalledFetch = (async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
})) as typeof fetch;

test('every request times out as a provider error without a status, which the deletion queue retries', async () => {
  const provider = createBrowserbaseProvider({ apiKey: API_KEY, fetch: stalledFetch, timeoutMs: 20 });
  for (const call of [() => provider.deleteContext('ctx_slow'), () => provider.endSession('sess_slow')]) {
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(error instanceof BrowserProviderError);
      assert.equal(error.status, undefined);
      assert.match(error.message, /^Browserbase request timed out: (DELETE|POST) \/v1\//);
      return true;
    });
  }
  const store = new SqliteSettingsStore(':memory:');
  try {
    await queueContextDeletions(store, [{ contextId: 'ctx_slow', queuedAt: Date.now() }]);
    await drainContextDeletions({ store, provider: async () => provider });
    assert.deepEqual(JSON.parse((await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING))!)
      .map(({ contextId, attempts }: { contextId: string; attempts: number }) => [contextId, attempts]), [['ctx_slow', 1]]);
  } finally {
    store.close();
  }
});

test('the default bound is 15 seconds', async (t) => {
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 15_000);
    return new AbortController().signal;
  });
  const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { id: 'ctx_new' } }));
  assert.deepEqual(await createBrowserbaseProvider({ apiKey: API_KEY, fetch: fetchImpl }).createContext({ loginId: 'wl_1', label: 'Billing' }), { id: 'ctx_new' });
});

function fakeProvider(script: {
  statuses: string[];
  requestResults: Array<'ok' | 409 | 422>;
  lists: BrowserRecordingDownload[][];
}) {
  const log: string[] = [];
  const next = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]!);
  const { provider } = fakeBrowserProvider({
    sessionStatus: async () => {
      log.push('status');
      return next(script.statuses);
    },
    requestRecordingDownloads: async () => {
      log.push('request');
      const result = next(script.requestResults);
      if (result !== 'ok') throw new BrowserProviderError(`status ${result}`, result);
    },
    listRecordingDownloads: async () => {
      log.push('list');
      return next(script.lists);
    },
  });
  return { provider, log };
}

function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

test('awaitRecordingDownload waits for completion, retries a 409, and polls for a URL', async () => {
  const { provider, log } = fakeProvider({
    statuses: ['RUNNING', 'COMPLETED'],
    requestResults: [409, 'ok'],
    lists: [[], [{ pageId: 'p1', status: 'IN_PROGRESS' }], [{ pageId: 'p1', status: 'COMPLETED', downloadUrl: 'https://signed/p1.mp4' }]],
  });
  const clock = fakeClock();
  const download = await awaitRecordingDownload(provider, 's', { timeoutMs: 60_000, pollMs: 1000, ...clock });
  assert.deepEqual(download, { pageId: 'p1', status: 'COMPLETED', downloadUrl: 'https://signed/p1.mp4' });
  assert.deepEqual(log, ['status', 'status', 'request', 'request', 'list', 'list', 'list']);
});

test('awaitRecordingDownload times out while the session keeps running', async () => {
  const { provider } = fakeProvider({ statuses: ['RUNNING'], requestResults: ['ok'], lists: [[]] });
  const clock = fakeClock();
  await assert.rejects(
    awaitRecordingDownload(provider, 's', { timeoutMs: 5000, pollMs: 1000, ...clock }),
    /Timed out after 5000ms/,
  );
});

test('awaitRecordingDownload times out when no URL appears', async () => {
  const { provider } = fakeProvider({ statuses: ['COMPLETED'], requestResults: ['ok'], lists: [[{ pageId: 'p', status: 'IN_PROGRESS' }]] });
  const clock = fakeClock();
  await assert.rejects(
    awaitRecordingDownload(provider, 's', { timeoutMs: 3000, pollMs: 1000, ...clock }),
    /download not ready/,
  );
});

test('a rate-limited recording request asking for no wait still waits a poll, and gives up at the deadline', async () => {
  const { calls, fetchImpl } = sharedFakeFetch(({ method, url }) => {
    if (method === 'GET' && url.endsWith('/v1/sessions/s')) return Response.json({ id: 's', status: 'COMPLETED' });
    return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
  });
  const provider = createBrowserbaseProvider({ apiKey: API_KEY, fetch: fetchImpl });
  const slept: number[] = [];
  let now = 0;
  await assert.rejects(
    awaitRecordingDownload(provider, 's', {
      timeoutMs: 90_000, pollMs: 2_000, now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; },
    }),
    (error: unknown) => error instanceof BrowserProviderError && error.status === 429 && error.retryAfterMs === 0,
  );
  assert.ok(slept.length > 0 && slept.every((ms) => ms === 2_000), 'each retry waits the poll interval');
  assert.ok(slept.reduce((total, ms) => total + ms, 0) <= 90_000, 'the waits stay inside the recording timeout');
  assert.equal(calls.filter(({ method }) => method === 'POST').length, slept.length + 1, 'one request per wait, and the last');
  assert.equal(slept.length, 45);
});

test('awaitRecordingDownload fails fast on a non-409 request error and on failed downloads', async () => {
  const disabled = fakeProvider({ statuses: ['COMPLETED'], requestResults: [422], lists: [[]] });
  await assert.rejects(
    awaitRecordingDownload(disabled.provider, 's', { timeoutMs: 3000, pollMs: 1000, ...fakeClock() }),
    (error: unknown) => error instanceof BrowserProviderError && error.status === 422,
  );
  const failed = fakeProvider({ statuses: ['COMPLETED'], requestResults: ['ok'], lists: [[{ pageId: 'p', status: 'FAILED' }]] });
  await assert.rejects(
    awaitRecordingDownload(failed.provider, 's', { timeoutMs: 3000, pollMs: 1000, ...fakeClock() }),
    /download failed/,
  );
  const errored = fakeProvider({ statuses: ['ERROR'], requestResults: ['ok'], lists: [[]] });
  await assert.rejects(
    awaitRecordingDownload(errored.provider, 's', { timeoutMs: 3000, pollMs: 1000, ...fakeClock() }),
    /ended with status ERROR/,
  );
});
