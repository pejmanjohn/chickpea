import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpClient, CdpError, connectCdpSocket } from '../src/browser/cdp.ts';
import { FakeCdpSocket } from './helpers/fake-cdp-socket.ts';

test('send correlates responses by id even when they arrive out of order', async () => {
  const socket = new FakeCdpSocket();
  socket.responders.set('A.first', () => ({ noReply: true }));
  socket.responders.set('A.second', () => ({ noReply: true }));
  const client = new CdpClient(socket);
  const first = client.send('A.first', { n: 1 });
  const second = client.send('A.second', { n: 2 }, 'sess-1');
  assert.deepEqual(socket.sent, [
    { id: 1, method: 'A.first', params: { n: 1 } },
    { id: 2, method: 'A.second', params: { n: 2 }, sessionId: 'sess-1' },
  ]);
  socket.deliver({ id: 2, result: { value: 'two' } });
  socket.deliver({ id: 1, result: { value: 'one' } });
  assert.deepEqual(await first, { value: 'one' });
  assert.deepEqual(await second, { value: 'two' });
  client.close();
});

test('send rejects with CdpError on protocol errors', async () => {
  const socket = new FakeCdpSocket();
  socket.responders.set('Bad.method', () => ({ error: { code: -32601, message: "'Bad.method' wasn't found" } }));
  const client = new CdpClient(socket);
  await assert.rejects(client.send('Bad.method'), (error: unknown) => {
    assert.ok(error instanceof CdpError);
    assert.equal(error.code, -32601);
    assert.equal(error.method, 'Bad.method');
    assert.match(error.message, /wasn't found/);
    return true;
  });
  client.close();
});

test('send times out and ignores a late reply', async () => {
  const socket = new FakeCdpSocket();
  socket.responders.set('Slow.call', () => ({ noReply: true }));
  const client = new CdpClient(socket);
  await assert.rejects(client.send('Slow.call', {}, undefined, 20), /timed out after 20ms/);
  socket.deliver({ id: 1, result: {} });
  client.close();
});

test('pending calls reject when the socket closes, and later sends fail fast', async () => {
  const socket = new FakeCdpSocket();
  socket.responders.set('Hang.call', () => ({ noReply: true }));
  const client = new CdpClient(socket);
  const pending = client.send('Hang.call');
  socket.remoteClose();
  await assert.rejects(pending, /closed during Hang\.call/);
  assert.equal(client.isClosed, true);
  await assert.rejects(client.send('Other.call'), /closed before Other\.call/);
});

test('close() closes the socket and resolves waiters with null', async () => {
  const socket = new FakeCdpSocket();
  const client = new CdpClient(socket);
  const waiting = client.waitForEvent('Page.loadEventFired', 's1', 10_000);
  client.close();
  assert.equal(await waiting, null);
  assert.deepEqual(socket.closedWith, { code: 1000, reason: 'done' });
});

test('waitForEvent filters by sessionId and returns null on timeout; on() delivers events', async () => {
  const socket = new FakeCdpSocket();
  const client = new CdpClient(socket);
  const seen: string[] = [];
  const off = client.on('Page.loadEventFired', (event) => seen.push(event.sessionId ?? 'browser'));
  const waiting = client.waitForEvent('Page.loadEventFired', 's2', 1000);
  socket.emitEvent('Page.loadEventFired', { timestamp: 1 }, 's1');
  socket.emitEvent('Page.loadEventFired', { timestamp: 2 }, 's2');
  const event = await waiting;
  assert.deepEqual(event, { method: 'Page.loadEventFired', params: { timestamp: 2 }, sessionId: 's2' });
  off();
  socket.emitEvent('Page.loadEventFired', {}, 's3');
  assert.deepEqual(seen, ['s1', 's2']);
  assert.equal(await client.waitForEvent('Never.fired', undefined, 10), null);
  const controller = new AbortController();
  const aborted = client.waitForEvent('Never.fired', undefined, 10_000, controller.signal);
  controller.abort();
  assert.equal(await aborted, null);
  client.close();
});

test('attachFirstPage picks the first page target and attaches flattened', async () => {
  const socket = new FakeCdpSocket();
  socket.responders.set('Target.getTargets', () => ({
    result: {
      targetInfos: [
        { targetId: 'sw-1', type: 'service_worker' },
        { targetId: 'page-1', type: 'page' },
        { targetId: 'page-2', type: 'page' },
      ],
    },
  }));
  socket.responders.set('Target.attachToTarget', () => ({ result: { sessionId: 'flat-1' } }));
  const client = new CdpClient(socket);
  assert.equal(await client.attachFirstPage(), 'flat-1');
  assert.deepEqual(socket.sent[1], { id: 2, method: 'Target.attachToTarget', params: { targetId: 'page-1', flatten: true } });
  client.close();
});

test('attachFirstPage throws a clear error without a page target', async () => {
  const socket = new FakeCdpSocket();
  socket.responders.set('Target.getTargets', () => ({ result: { targetInfos: [{ targetId: 'b', type: 'browser' }] } }));
  const client = new CdpClient(socket);
  await assert.rejects(client.attachFirstPage(), /no open page/);
  client.close();
});

test('connectCdpSocket uses the fetch Upgrade handshake on Cloudflare Workers', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Cloudflare-Workers' }, configurable: true });
  try {
    let accepted = false;
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fakeWs = { accept: () => { accepted = true; }, send() {}, close() {}, addEventListener() {} };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
      return Object.assign(new Response(null, { status: 200 }), { webSocket: fakeWs });
    }) as typeof fetch;
    const socket = await connectCdpSocket('wss://connect.browserbase.com/?signingKey=abc', { fetch: fetchImpl });
    assert.equal(socket, fakeWs);
    assert.equal(accepted, true);
    assert.deepEqual(requests, [{ url: 'https://connect.browserbase.com/?signingKey=abc', headers: { Upgrade: 'websocket' } }]);

    const refused = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(connectCdpSocket('wss://x', { fetch: refused }), /refused \(HTTP 403\)/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});
