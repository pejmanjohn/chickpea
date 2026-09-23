import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserbaseProvider } from '../src/browser/browserbase.ts';
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

test('createContext posts project and name', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: { id: 'ctx-1' } }));
  const provider = createBrowserbaseProvider({ apiKey: API_KEY, projectId: 'proj-1', fetch: fetchImpl });
  assert.deepEqual(await provider.createContext('agent-a'), { id: 'ctx-1' });
  assert.equal(calls[0]!.url, 'https://api.browserbase.com/v1/contexts');
  assert.deepEqual(calls[0]!.body, { projectId: 'proj-1', name: 'agent-a' });
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
  await assert.rejects(provider.createContext(), (error: unknown) => {
    assert.ok(error instanceof BrowserProviderError);
    assert.ok(!error.message.includes(API_KEY));
    return true;
  });
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
