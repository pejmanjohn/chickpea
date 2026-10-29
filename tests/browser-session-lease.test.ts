import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { HostedBrowserProvider } from '../src/browser/hosted-provider.ts';
import {
  HOSTED_BROWSER_BUSY_MESSAGE,
  HOSTED_BROWSER_CONTEXT_IN_USE_MESSAGE,
  HOSTED_BROWSER_HOURS_CAP_MESSAGE,
  HOSTED_BROWSER_RUNNING_LIMIT_MESSAGE,
} from '../src/browser/messages.ts';
import { HostedBrowserFailure, HostedBrowserRefusal } from '../src/browser/provider.ts';
import {
  admitBrowserSession,
  attachBrowserSession,
  BROWSER_SECONDS_PREFIX,
  BROWSER_SESSION_LEASES_KEY,
  chargeLapsedBrowserSessionLeases,
  closeBrowserSessionLease,
  maintainBrowserSessionLeases,
  readBrowserSessionUsage,
} from '../src/browser/session-lease.ts';
import { BrowserTurnSession } from '../src/browser/turn-session.ts';
import { configureHostedBrowser, resetHostedBrowserForTests } from '../src/config/hosted-browser.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import { fakeBrowserbase } from './helpers/fake-browserbase.ts';
import { FakeCdpSocket } from './helpers/fake-cdp-socket.ts';

const POLICY = { enabled: true, monthlyBrowserHours: 10, maxRunningBrowsers: 2, sessionsPerMinute: 6 };
const T0 = Date.UTC(2026, 9, 28, 12, 0);
const MONTH = `${BROWSER_SECONDS_PREFIX}2026-10`;

function memoryStore(t: TestContext): SqliteSettingsStore {
  const store = new SqliteSettingsStore(':memory:');
  t.after(() => store.close());
  return store;
}

async function metered(store: SettingsStore): Promise<number> {
  return (await readBrowserSessionUsage({ store, now: T0 })).meteredSeconds;
}

function admit(store: SettingsStore, reservationId: string, extra: { contextId?: string; now?: number; timeoutSeconds?: number; policy?: Partial<typeof POLICY> } = {}) {
  return admitBrowserSession({
    store,
    policy: { ...POLICY, ...extra.policy },
    reservationId,
    ...(extra.contextId ? { contextId: extra.contextId } : {}),
    timeoutSeconds: extra.timeoutSeconds ?? 660,
    now: extra.now ?? T0,
  });
}

test('two admissions racing for the last running browser admit exactly one', async (t) => {
  const store = memoryStore(t);
  await admit(store, 'held');
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });
  const racing: SettingsStore = {
    ...store,
    getSetting: (key) => store.getSetting(key),
    setSetting: (key, value) => store.setSetting(key, value),
    deleteSetting: (key) => store.deleteSetting(key),
    mergeSettingStringSet: (key, values) => store.mergeSettingStringSet(key, values),
    applySettingsPatch: (patch) => store.applySettingsPatch(patch),
    async getSettings(keys) {
      const values = await store.getSettings(keys);
      reads += 1;
      if (reads === 2) release();
      if (reads <= 2) await bothRead;
      return values;
    },
  };
  const outcomes = await Promise.all([admit(racing, 'first', { now: T0 + 1 }), admit(racing, 'second', { now: T0 + 1 })]);
  assert.deepEqual(outcomes.sort(), ['admitted', 'running_limit']);
  assert.equal((await readBrowserSessionUsage({ store, now: T0 })).leases.length, 2);
});

test('a run is metered in whole minutes, at least one, and only once', async (t) => {
  const store = memoryStore(t);
  for (const id of ['short', 'over', 'exact']) {
    await admit(store, id, { policy: { maxRunningBrowsers: 3 } });
    await attachBrowserSession({ store, reservationId: id, sessionId: `sess_${id}`, now: T0 });
  }
  assert.equal(await closeBrowserSessionLease({ store, sessionId: 'sess_short', now: T0 + 5_000 }), 60);
  assert.equal(await closeBrowserSessionLease({ store, sessionId: 'sess_over', now: T0 + 61_000 }), 120);
  assert.equal(await closeBrowserSessionLease({ store, sessionId: 'sess_exact', now: T0 + 120_000 }), 120);
  assert.equal(await closeBrowserSessionLease({ store, sessionId: 'sess_exact', now: T0 + 180_000 }), 0, 'a second close meters nothing');
  assert.equal(await metered(store), 300);
});

test('a session whose Agent never ended it is charged up to its timeout, by the next admission or by maintenance', async (t) => {
  const store = memoryStore(t);
  await admit(store, 'crashed', { timeoutSeconds: 630 });
  await attachBrowserSession({ store, reservationId: 'crashed', sessionId: 'sess_crashed', now: T0 });
  assert.equal(await admit(store, 'next', { now: T0 + 3_600_000 }), 'admitted');
  assert.equal(await metered(store), 660, '10.5 minutes bill as 11');
  const usage = await readBrowserSessionUsage({ store, now: T0 });
  assert.deepEqual(usage.leases.map(({ sessionId }) => sessionId), [undefined], 'the crashed lease is gone');

  const swept = memoryStore(t);
  await admit(swept, 'crashed', { timeoutSeconds: 600 });
  assert.equal(await chargeLapsedBrowserSessionLeases({ store: swept, now: T0 + 599_000 }), 0, 'not before its timeout');
  assert.equal(await chargeLapsedBrowserSessionLeases({ store: swept, now: T0 + 601_000 }), 1);
  assert.equal(await metered(swept), 600);
  assert.equal(await chargeLapsedBrowserSessionLeases({ store: swept, now: T0 + 700_000 }), 0);
  assert.equal(await metered(swept), 600, 'charged once');
});

test('admission refuses at the monthly hours, a context in use, the running limit, and the creations a minute', async (t) => {
  const hours = memoryStore(t);
  await hours.setSetting(MONTH, JSON.stringify({ seconds: 36_000 }));
  assert.equal(await admit(hours, 'a'), 'hours_cap');
  await hours.setSetting(MONTH, JSON.stringify({ seconds: 35_000 }));
  await admit(hours, 'running', { timeoutSeconds: 3_600 });
  assert.equal(await admit(hours, 'b', { now: T0 + 999_000 }), 'admitted');
  assert.equal(await admit(hours, 'c', { now: T0 + 1_000_000 }), 'hours_cap', 'a running session counts toward the hours');

  const context = memoryStore(t);
  await admit(context, 'a', { contextId: 'ctx_1' });
  assert.equal(await admit(context, 'b', { contextId: 'ctx_1' }), 'context_in_use');
  assert.equal(await admit(context, 'c', { contextId: 'ctx_2' }), 'admitted');

  const rate = memoryStore(t);
  for (let index = 0; index < 6; index += 1) {
    await admit(rate, `r${index}`, { policy: { maxRunningBrowsers: 10 } });
    await attachBrowserSession({ store: rate, reservationId: `r${index}`, sessionId: `s${index}`, now: T0 });
    await closeBrowserSessionLease({ store: rate, sessionId: `s${index}`, now: T0 + 1 });
  }
  assert.equal(await admit(rate, 'r7', { now: T0 + 30_000 }), 'rate_limit', 'closed sessions still count for the minute');
  assert.equal(await admit(rate, 'r8', { now: T0 + 60_001 }), 'admitted');
});

function hostedSetup(t: TestContext, policy: Partial<typeof POLICY> = {}, options: Parameters<typeof fakeBrowserbase>[0] = {}) {
  resetHostedBrowserForTests();
  t.after(resetHostedBrowserForTests);
  configureHostedBrowser({ policy: () => ({ ...POLICY, ...policy }), access: () => ({ apiKey: 'bb_live_platform', projectId: 'proj-platform' }) });
  t.mock.method(console, 'warn', () => undefined);
  const store = memoryStore(t);
  const browserbase = fakeBrowserbase(options);
  let clock = T0;
  const provider = () => new HostedBrowserProvider({
    access: { apiKey: 'bb_live_platform', projectId: 'proj-platform' },
    installationId: 'inst_a',
    store,
    fetch: browserbase.fetchImpl,
    now: () => clock,
  });
  return { store, browserbase, provider, advance: (ms: number) => { clock += ms; } };
}

test('each hosted refusal reaches the model as its own text, and nothing is created', async (t) => {
  const cases: Array<[string, (store: SettingsStore) => Promise<void>, Partial<typeof POLICY>, string]> = [
    ['running', async (store) => { await admit(store, 'held'); }, { maxRunningBrowsers: 1 }, HOSTED_BROWSER_RUNNING_LIMIT_MESSAGE],
    ['hours', async (store) => { await store.setSetting(MONTH, JSON.stringify({ seconds: 36_000 })); }, {}, HOSTED_BROWSER_HOURS_CAP_MESSAGE],
    ['rate', async (store) => { await admit(store, 'held'); }, { sessionsPerMinute: 1 }, HOSTED_BROWSER_BUSY_MESSAGE],
    ['context', async (store) => { await admit(store, 'held', { contextId: 'ctx_1' }); }, {}, HOSTED_BROWSER_CONTEXT_IN_USE_MESSAGE],
  ];
  for (const [name, arrange, policy, text] of cases) {
    const { store, browserbase, provider } = hostedSetup(t, policy);
    browserbase.contexts.set('ctx_1', { projectId: 'proj-platform', name: 'chickpea.inst_a.wl_1.00000000' });
    await arrange(store);
    await assert.rejects(provider().createSession({ contextId: 'ctx_1', timeoutSeconds: 660 }), (error: unknown) =>
      error instanceof HostedBrowserRefusal && error.message === text, name);
    assert.ok(!browserbase.requests().includes('POST /v1/sessions'), `${name}: no session is created`);
  }
});

test('a create Browserbase refused releases its lease; one it may have carried out holds it to its timeout', async (t) => {
  const createFails = (answer: () => Response) => ({
    fail: ({ method, url }: { method: string; url: string }) => method === 'POST' && url.endsWith('/v1/sessions') ? answer() : undefined,
  });
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const { store, provider } = hostedSetup(t, {}, createFails(() => new Response('no', { status })));
    await assert.rejects(provider().createSession({ timeoutSeconds: 660 }), HostedBrowserFailure);
    assert.deepEqual((await readBrowserSessionUsage({ store, now: T0 })).leases, [], `${status} holds nothing`);
  }
  const timedOut = () => { throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }); };
  const ambiguous: Array<[string, () => Response]> = [
    ['500', () => new Response('no', { status: 500 })],
    ['503', () => new Response('no', { status: 503 })],
    ['408', () => new Response('no', { status: 408 })],
    ['429', () => new Response('no', { status: 429 })],
    ['network', () => { throw new TypeError('fetch failed'); }],
    ['timeout', timedOut],
    ['no id', () => Response.json({ connectUrl: 'wss://connect.example/' }, { status: 201 })],
  ];
  for (const [name, answer] of ambiguous) {
    const { store, provider } = hostedSetup(t, {}, createFails(answer));
    await assert.rejects(provider().createSession({ timeoutSeconds: 660 }), HostedBrowserFailure, name);
    assert.deepEqual((await readBrowserSessionUsage({ store, now: T0 })).leases, [
      { startedAt: T0, leaseUntil: T0 + 660_000 },
    ], `${name}: held unattached to its timeout`);
    assert.equal(await metered(store), 0, `${name}: metered only once it lapses`);
  }

  const partial = hostedSetup(t, {}, createFails(() => Response.json({ id: 'sess_partial' }, { status: 201 })));
  partial.browserbase.sessions.set('sess_partial', { projectId: 'proj-platform', status: 'RUNNING', userMetadata: { installation: 'inst_a' } });
  await assert.rejects(partial.provider().createSession({ timeoutSeconds: 660 }), HostedBrowserFailure);
  assert.equal(partial.browserbase.sessions.get('sess_partial')!.status, 'COMPLETED', 'a session the answer names is ended');
  assert.deepEqual((await readBrowserSessionUsage({ store: partial.store, now: T0 })).leases, []);
  assert.equal(await metered(partial.store), 60, 'and metered as the provider bills it');
});

test('a hosted session holds its lease from create to end; a failed end does what the provider billed', async (t) => {
  const { store, provider, advance } = hostedSetup(t);
  const wrapper = provider();
  const handle = await wrapper.createSession({ timeoutSeconds: 660 });
  assert.deepEqual((await readBrowserSessionUsage({ store, now: T0 })).leases, [
    { startedAt: T0, leaseUntil: T0 + 660_000, sessionId: handle.id },
  ]);
  advance(90_000);
  await wrapper.endSession(handle.id);
  assert.deepEqual((await readBrowserSessionUsage({ store, now: T0 })).leases, []);
  assert.equal(await metered(store), 120);

  const stuck = hostedSetup(t, {}, {
    fail: ({ method, url }) => method === 'POST' && /\/v1\/sessions\/sess_/.test(url) ? new Response('no', { status: 500 }) : undefined,
  });
  const kept = stuck.provider();
  const open = await kept.createSession({ timeoutSeconds: 660 });
  await assert.rejects(kept.endSession(open.id), HostedBrowserFailure);
  assert.equal((await readBrowserSessionUsage({ store: stuck.store, now: T0 })).leases.length, 1, 'kept until its timeout');
  assert.equal(await metered(stuck.store), 0);
});

test('a release refused because the session already ended meters it to when it ended, not to its timeout', async (t) => {
  const releaseRefused = {
    fail: ({ method, url }: { method: string; url: string }) =>
      method === 'POST' && /\/v1\/sessions\/sess_/.test(url) ? new Response('already stopped', { status: 409 }) : undefined,
  };
  const ended = hostedSetup(t, {}, releaseRefused);
  const wrapper = ended.provider();
  const { id } = await wrapper.createSession({ timeoutSeconds: 660 });
  Object.assign(ended.browserbase.sessions.get(id)!, { status: 'TIMED_OUT', endedAt: new Date(T0 + 150_000).toISOString() });
  ended.advance(400_000);
  await wrapper.endSession(id);
  assert.deepEqual((await readBrowserSessionUsage({ store: ended.store, now: T0 })).leases, []);
  assert.equal(await metered(ended.store), 180, 'two and a half minutes, billed as three');

  const undated = hostedSetup(t, {}, releaseRefused);
  const other = undated.provider();
  const session = await other.createSession({ timeoutSeconds: 660 });
  undated.browserbase.sessions.get(session.id)!.status = 'COMPLETED';
  undated.advance(30_000);
  await other.endSession(session.id);
  assert.equal(await metered(undated.store), 60, 'no end time: metered to now');
});

test('a hand-off session holds its lease for its 600-second window, through detach, until it is ended', async (t) => {
  const { store, provider, advance } = hostedSetup(t);
  const turn = provider();
  const { id: contextId } = await turn.createContext({ loginId: 'wl_1', label: 'Billing' });
  const handoff = new BrowserTurnSession({ provider: turn, connect: async () => FakeCdpSocket.withPage(), now: () => T0, sleep: async () => undefined });
  const { sessionId } = await handoff.openForHandoff({ loginId: 'wl_1', host: 'billing.example.com', contextId });
  await handoff.detach();
  assert.deepEqual((await readBrowserSessionUsage({ store, now: T0 })).leases.map(({ leaseUntil }) => leaseUntil), [T0 + 600_000]);
  advance(240_000);
  await provider().endSession(sessionId);
  assert.deepEqual((await readBrowserSessionUsage({ store, now: T0 })).leases, []);
  assert.equal(await metered(store), 240);
});

test('maintenance on standalone touches no lease row', async (t) => {
  const store = memoryStore(t);
  await maintainBrowserSessionLeases({}, T0);
  assert.equal(await store.getSetting(BROWSER_SESSION_LEASES_KEY), undefined);
});
