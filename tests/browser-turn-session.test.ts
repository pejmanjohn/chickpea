import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserBudgetExhaustedError, BrowserTurnSession } from '../src/browser/turn-session.ts';
import { FakeCdpSocket, fakeBrowserProvider } from './helpers/fake-cdp-socket.ts';

function setup(overrides: { maxSessionMs?: number } = {}) {
  let clock = 1_000_000;
  const sockets: FakeCdpSocket[] = [];
  const closedInfo: Array<{ sessionId: string; seconds: number }> = [];
  const fake = fakeBrowserProvider();
  const session = new BrowserTurnSession({
    provider: fake.provider,
    connect: async () => {
      const socket = FakeCdpSocket.withPage();
      sockets.push(socket);
      return socket;
    },
    now: () => clock,
    sleep: async () => undefined,
    ...(overrides.maxSessionMs === undefined ? {} : { maxSessionMs: overrides.maxSessionMs }),
    onClosed: async (info) => {
      closedInfo.push(info);
    },
  });
  return { session, sockets, closedInfo, ...fake, advance: (ms: number) => { clock += ms; } };
}

test('ensure creates one recorded session lazily and reuses it', async () => {
  const { session, created, sockets } = setup();
  assert.equal(session.active, false);
  assert.equal(created.length, 0);
  const [first, second] = await Promise.all([session.ensure(), session.ensure()]);
  assert.equal(created.length, 1);
  assert.equal(sockets.length, 1);
  assert.equal(first.page, second.page);
  assert.equal(first.sessionId, 'sess-1');
  assert.equal(first.page.sessionId, 'page-1');
  assert.deepEqual(created[0], {
    recording: true,
    viewport: { width: 1280, height: 800 },
    timeoutSeconds: 600 + 60,
  });
  assert.equal(session.active, true);
  assert.equal(session.sessionId, 'sess-1');
  assert.equal(session.startedAt, 1_000_000);
  assert.deepEqual(session.policy, { readOnly: true });
  await session.close();
});

test('close is idempotent, ends the session once, and reports its duration', async () => {
  const { session, ended, closedInfo, sockets, advance } = setup();
  assert.equal(await session.close(), undefined);
  await session.ensure();
  advance(42_400);
  const [a, b] = await Promise.all([session.close(), session.close()]);
  assert.deepEqual(a, { sessionId: 'sess-1', seconds: 42 });
  assert.deepEqual(b, a);
  assert.equal(await session.close(), undefined);
  assert.deepEqual(ended, ['sess-1']);
  assert.deepEqual(closedInfo, [{ sessionId: 'sess-1', seconds: 42 }]);
  assert.equal(sockets[0]!.closed, true);
  assert.equal(session.active, false);
});

test('release ends the session and a later ensure starts a new one within the budget', async () => {
  const { session, created, advance } = setup();
  await session.ensure();
  advance(60_000);
  assert.deepEqual(await session.release(), { sessionId: 'sess-1', seconds: 60 });
  const next = await session.ensure();
  assert.equal(next.sessionId, 'sess-2');
  // The second session only gets the remaining budget plus the grace minute.
  assert.equal(created[1]!.timeoutSeconds, 540 + 60);
  await session.close();
});

test('the per-turn budget refuses more browsing once it is used up', async () => {
  const { session, ended, advance } = setup({ maxSessionMs: 60_000 });
  await session.ensure();
  advance(61_000);
  await assert.rejects(session.ensure(), BrowserBudgetExhaustedError);
  assert.deepEqual(ended, ['sess-1']);
  await assert.rejects(session.ensure(), /1-minute browser budget/);
});

test('a failed connection ends the paid session instead of leaking it', async () => {
  const fake = fakeBrowserProvider();
  const session = new BrowserTurnSession({
    provider: fake.provider,
    connect: async () => {
      throw new Error('Browser connection was refused (HTTP 403)');
    },
  });
  await assert.rejects(session.ensure(), /refused/);
  assert.deepEqual(fake.ended, ['sess-1']);
  assert.equal(session.active, false);
});

test('a failing usage callback does not break close', async () => {
  const fake = fakeBrowserProvider();
  const session = new BrowserTurnSession({
    provider: fake.provider,
    connect: async () => FakeCdpSocket.withPage(),
    onClosed: async () => {
      throw new Error('store down');
    },
  });
  await session.ensure();
  const info = await session.close();
  assert.equal(info?.sessionId, 'sess-1');
});
