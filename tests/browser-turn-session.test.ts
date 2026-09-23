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

const GITHUB = { loginId: 'wl_github', host: 'github.com', contextId: 'ctx-github' };
const PORTAL = { loginId: 'wl_portal', host: 'portal.example.com:8443', contextId: 'ctx-portal' };

test('a bound session loads and persists its login context, limited to the login domain', async () => {
  const { session, created } = setup();
  const opened = await session.ensureFor(GITHUB);
  assert.equal(opened.sessionId, 'sess-1');
  assert.deepEqual(created[0], {
    recording: true,
    viewport: { width: 1280, height: 800 },
    timeoutSeconds: 600 + 60,
    contextId: 'ctx-github',
    persistContext: true,
    allowedDomains: ['github.com'],
  });
  assert.deepEqual(session.binding, GITHUB);
  // The same login reuses the session; ensure() takes whatever is open.
  assert.equal((await session.ensureFor(GITHUB)).sessionId, 'sess-1');
  assert.equal((await session.ensure()).sessionId, 'sess-1');
  assert.equal(created.length, 1);
  await session.close();
});

test('switching between logins or to public ends the open session and shares the budget', async () => {
  const { session, created, ended, closedInfo, advance } = setup();
  await session.ensureFor(GITHUB);
  advance(60_000);
  assert.equal((await session.ensureFor(PORTAL)).sessionId, 'sess-2');
  assert.deepEqual(ended, ['sess-1']);
  // A port never reaches the domain allowlist.
  assert.deepEqual(created[1]?.allowedDomains, ['portal.example.com']);
  assert.equal(created[1]?.timeoutSeconds, 540 + 60);
  advance(30_000);
  assert.equal((await session.ensureFor(undefined)).sessionId, 'sess-3');
  assert.equal(session.binding, undefined);
  assert.equal(created[2]?.contextId, undefined);
  assert.equal(created[2]?.persistContext, undefined);
  assert.deepEqual(ended, ['sess-1', 'sess-2']);
  assert.deepEqual(closedInfo.map(({ seconds }) => seconds), [60, 30]);
  await session.close();
});

test('a hand-off session is kept alive for ten minutes and detach lets it outlive the turn', async () => {
  const { session, created, ended, closedInfo, sockets, advance } = setup();
  await session.ensure();
  const opened = await session.openForHandoff(GITHUB);
  assert.equal(opened.sessionId, 'sess-2');
  assert.deepEqual(ended, ['sess-1']);
  assert.equal(created[1]?.keepAlive, true);
  assert.equal(created[1]?.timeoutSeconds, 600);
  assert.equal(created[1]?.contextId, 'ctx-github');
  advance(5_000);
  assert.deepEqual(await session.detach(), { sessionId: 'sess-2', seconds: 0 });
  assert.equal(session.active, false);
  assert.equal(sockets[1]!.closed, true);
  // Closing afterwards (as the finish hook does) has nothing to end.
  assert.equal(await session.close(), undefined);
  assert.deepEqual(ended, ['sess-1']);
  assert.deepEqual(closedInfo.at(-1), { sessionId: 'sess-2', seconds: 0 });
  assert.equal(await session.detach(), undefined);
});

test('redaction replaces typed secrets and skips values too short to redact safely', () => {
  const { session } = setup();
  session.addRedaction('hunter2!');
  session.addRedaction('287082');
  session.addRedaction('ab');
  assert.equal(session.redact('pw hunter2! code 287082 tab'), 'pw [redacted] code [redacted] tab');
});

test('the policy follows the bound login: read-only unless its grant allows actions', async () => {
  const { session } = setup();
  const check = { loginId: `wl_${'a'.repeat(32)}`, host: 'a.example.com', contextId: 'ctx-a', level: 'check' as const };
  const act = { loginId: `wl_${'b'.repeat(32)}`, host: 'b.example.com', contextId: 'ctx-b', level: 'act' as const };
  assert.deepEqual(session.policy, { readOnly: true });
  await session.ensureFor(check);
  assert.deepEqual(session.policy, { readOnly: true });
  await session.ensureFor(act);
  assert.deepEqual(session.policy, { readOnly: false });
  await session.ensureFor(undefined);
  assert.deepEqual(session.policy, { readOnly: true });
  await session.ensureFor(act);
  await session.close();
  assert.deepEqual(session.policy, { readOnly: true });
});
