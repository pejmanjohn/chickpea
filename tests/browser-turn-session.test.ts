import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserBudgetExhaustedError, BrowserTurnSession } from '../src/browser/turn-session.ts';
import { FakeCdpSocket, fakeBrowserProvider } from './helpers/fake-cdp-socket.ts';

function setup(overrides: { maxSessionMs?: number; grantsWebsiteLogins?: boolean } = {}) {
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
    ...(overrides.grantsWebsiteLogins === undefined ? {} : { grantsWebsiteLogins: overrides.grantsWebsiteLogins }),
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

test('the secret matcher loads with the first session, and a secret typed in one stays matched in the next', async () => {
  const { session } = setup();
  assert.equal(session.redact('Synthetic-Pass-1234'), 'Synthetic-Pass-1234', 'nothing typed before a session');
  assert.throws(() => session.addRedaction('Synthetic-Pass-1234'), /only into an open browser session/);
  await session.ensure();
  session.addRedaction('Synthetic-Pass-1234');
  await session.close();
  await session.ensure();
  assert.equal(session.redact('Wrong password: Synthetic-Pass-1234'), 'Wrong password: [redacted]');
  assert.equal(session.redactUrl('https://site.example/?p=Synthetic-Pass-1234'), 'https://site.example/?p=[redacted]');
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

test('close ends the session and a later ensure starts a new one within the budget', async () => {
  const { session, created, advance } = setup();
  await session.ensure();
  advance(60_000);
  assert.deepEqual(await session.close(), { sessionId: 'sess-1', seconds: 60 });
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
  assert.equal(created[1]?.recording, false, 'a person signing in is not recorded');
  assert.equal(created[1]?.logSession, false);
  assert.equal(created[0]?.recording, true, 'an Agent session keeps its recording');
  assert.equal(created[0]?.logSession, undefined, 'and the provider keeps its logs');
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

/** The CDP methods a screenshot of the open session's page sends. */
async function screenshotMethods(session: BrowserTurnSession, socket: FakeCdpSocket): Promise<string[]> {
  socket.responders.set('Page.captureScreenshot', () => ({ result: { data: 'iVBORw0KGgo=' } }));
  socket.responders.set('DOMSnapshot.captureSnapshot', () => ({ result: { documents: [], strings: [] } }));
  const from = socket.sent.length;
  const shot = await (await session.ensure()).page.screenshot();
  assert.ok('bytes' in shot);
  return socket.sent.slice(from).map(({ method }) => method);
}

const CHECKED = ['Target.setAutoAttach', 'DOMSnapshot.captureSnapshot', 'Page.captureScreenshot', 'DOMSnapshot.captureSnapshot'];

test('a session in a run that grants no website login takes a screenshot without reading the page', async () => {
  const { session, sockets } = setup({ grantsWebsiteLogins: false });
  await session.ensure();
  assert.deepEqual(await screenshotMethods(session, sockets[0]!), ['Page.captureScreenshot']);
  assert.equal(await (await session.ensure()).page.secretOnPage(), undefined);
  assert.deepEqual(await screenshotMethods(session, sockets[0]!), ['Page.captureScreenshot']);
  await session.close();
});

test('a run that grants a website login, or does not say, checks every picture its sessions take', async () => {
  for (const grantsWebsiteLogins of [true, undefined]) {
    const { session, sockets } = setup(grantsWebsiteLogins === undefined ? {} : { grantsWebsiteLogins });
    await session.ensure();
    assert.deepEqual(await screenshotMethods(session, sockets[0]!), CHECKED, `public, grantsWebsiteLogins ${grantsWebsiteLogins}`);
    await session.ensureFor(GITHUB);
    assert.deepEqual(await screenshotMethods(session, sockets[1]!), CHECKED, `bound, grantsWebsiteLogins ${grantsWebsiteLogins}`);
    await session.close();
  }
  const { session, sockets } = setup({ grantsWebsiteLogins: false });
  await session.ensureFor(GITHUB);
  assert.deepEqual(await screenshotMethods(session, sockets[0]!), ['Page.captureScreenshot'], 'only false skips the check');
  await session.close();
});

test('a session handed to a person to sign in checks its pictures, even in a run that grants no website login', async () => {
  const { session, sockets } = setup({ grantsWebsiteLogins: false });
  await session.ensure();
  assert.deepEqual(await screenshotMethods(session, sockets[0]!), ['Page.captureScreenshot']);
  await session.openForHandoff(GITHUB);
  assert.deepEqual(await screenshotMethods(session, sockets[1]!), CHECKED);
  await session.detach();
});

test('once a secret is typed in a turn, its open session and every later one check their pictures', async () => {
  const { session, sockets } = setup({ grantsWebsiteLogins: false });
  await session.ensure();
  assert.deepEqual(await screenshotMethods(session, sockets[0]!), ['Page.captureScreenshot']);
  session.addRedaction('Synthetic-Pass-1234');
  assert.deepEqual(await screenshotMethods(session, sockets[0]!), CHECKED, 'the open session, from then on');
  await session.close();
  await session.ensure();
  assert.deepEqual(await screenshotMethods(session, sockets[1]!), CHECKED, 'a later session of the same turn');
  await session.close();
});

test('every session refuses downloads at the browser, and a browser that cannot still opens', async (t) => {
  const { session, sockets } = setup();
  await session.ensure();
  const refusal = sockets[0]!.sent.find(({ method }) => method === 'Browser.setDownloadBehavior');
  assert.deepEqual(refusal?.params, { behavior: 'deny' });
  assert.equal(refusal?.sessionId, undefined, 'sent to the browser, not the page');
  await session.close();

  const warn = t.mock.method(console, 'warn', () => undefined);
  const refusing = new BrowserTurnSession({
    provider: fakeBrowserProvider().provider,
    connect: async () => {
      const socket = FakeCdpSocket.withPage();
      socket.responders.set('Browser.setDownloadBehavior', () => ({ error: { code: -32000, message: 'Browser context management is not supported.' } }));
      return socket;
    },
    sleep: async () => undefined,
  });
  assert.equal((await refusing.ensure()).sessionId, 'sess-1');
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [['[chickpea] A browser session could not refuse downloads']]);
  await refusing.close();
});

test('redaction replaces typed secrets, and a value too short to redact inside text only as a whole field', async () => {
  const { session } = setup();
  await session.ensure();
  session.addRedaction('hunter2!');
  session.addRedaction('287082');
  session.addRedaction('ab');
  assert.equal(session.redact('pw hunter2! code 287082 tab'), 'pw [redacted] code [redacted] tab');
  assert.equal(session.redact('ab'), '[redacted]');
  await session.close();
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
