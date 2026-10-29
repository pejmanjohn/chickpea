import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import { PENDING_CONTEXT_DELETIONS_SETTING } from '../src/browser/context-deletions.ts';
import { censusBrowser, eraseBrowserPass } from '../src/browser/hosted-erasure.ts';
import { HostedBrowserProvider } from '../src/browser/hosted-provider.ts';
import {
  createWebsiteLogin,
  listWebsiteLogins,
  recordWebsiteLoginContext,
  WEBSITE_LOGINS_SETTING,
} from '../src/browser/logins.ts';
import { HostedBrowserRefusal } from '../src/browser/provider.ts';
import { BROWSER_SECONDS_PREFIX, BROWSER_SESSION_LEASES_KEY } from '../src/browser/session-lease.ts';
import { configureHostedBrowser, resetHostedBrowserForTests } from '../src/config/hosted-browser.ts';
import { utcMonthKey } from '../src/config/monthly-counter.ts';
import { InstallationContextError } from '../src/config/installation-scope.ts';
import type { SettingsStore } from '../src/config/settings-store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { promisify } from '../src/state/async-facade.ts';
import {
  censusInstallationBrowser,
  eraseInstallationBrowser,
  installationStateStoreObject,
} from '../src/state/installation-objects.ts';
import { fakeBrowserbase } from './helpers/fake-browserbase.ts';
import { hostedDeployment } from './helpers/installation-objects.ts';

const A = 'inst_erase_a';
const B = 'inst_erase_b';
// Erasure meters on the real clock, so the seeded lease and month follow it.
const NOW = Date.now();
const MONTH = utcMonthKey(new Date(NOW));
const LOGIN = {
  host: 'billing.example.com', label: 'Billing', ownerKind: 'team' as const,
  createdByMembershipId: 'membership_owner', method: 'credentials' as const,
  username: 'ops@example.com', password: 'pw-erasure-sentinel',
};
const own = (suffix: string) => ({ projectId: 'proj-platform', name: `chickpea.${A}.wl_${suffix}.00000000` });

function installation(t: TestContext) {
  const deployment = hostedDeployment([A, B]);
  const a = deployment.installation(A);
  const store = promisify(a.stores.settings, { close: () => undefined }) as unknown as SettingsStore;
  resetHostedBrowserForTests();
  t.after(resetHostedBrowserForTests);
  configureHostedBrowser({
    policy: () => ({ enabled: true, monthlyBrowserHours: 10, maxRunningBrowsers: 2, sessionsPerMinute: 6 }),
    access: () => ({ apiKey: 'bb_live_platform', projectId: 'proj-platform' }),
  });
  t.mock.method(console, 'warn', () => undefined);
  return { a, store, deployment };
}

/** Logins whose contexts sit in every place the store keeps one: recorded, legacy catalog, queued, and a lease. */
async function seed(store: SettingsStore) {
  const deps = { store: store as never, keyring: generateCredentialKeyring('hosted_erasure_test') };
  const recorded = await createWebsiteLogin(deps, LOGIN);
  await recordWebsiteLoginContext(store, recorded.id, 'ctx_recorded');
  const gone = await createWebsiteLogin(deps, { ...LOGIN, host: 'gone.example.com' });
  await recordWebsiteLoginContext(store, gone.id, 'ctx_gone');
  const foreign = await createWebsiteLogin(deps, { ...LOGIN, host: 'mixed.example.com' });
  await recordWebsiteLoginContext(store, foreign.id, 'ctx_foreign');
  const catalog = JSON.parse((await store.getSetting(WEBSITE_LOGINS_SETTING))!) as Array<Record<string, unknown>>;
  catalog.push({ ...catalog[0], id: 'wl_0000000000000000000000000000000a', host: 'legacy.example.com', contextId: 'ctx_legacy' });
  await store.setSetting(WEBSITE_LOGINS_SETTING, JSON.stringify(catalog));
  await store.setSetting(PENDING_CONTEXT_DELETIONS_SETTING, JSON.stringify([
    { contextId: 'ctx_queued', queuedAt: 1 },
    { handoffSessionId: 'sess_listed', queuedAt: 2 },
  ]));
  await store.setSetting(BROWSER_SESSION_LEASES_KEY, JSON.stringify({
    leases: { r1: { startedAt: NOW - 90_000, leaseUntil: NOW + 570_000, sessionId: 'sess_leased', contextId: 'ctx_recorded' } },
    recentCreations: [],
  }));
  await store.setSetting(`${BROWSER_SECONDS_PREFIX}${MONTH}`, JSON.stringify({ seconds: 1_800 }));
}

function seededBrowserbase(t: TestContext) {
  const browserbase = fakeBrowserbase();
  const tagged = (installationId: string) => ({ chickpea: '1', installation: installationId });
  for (const id of ['ctx_recorded', 'ctx_legacy', 'ctx_queued', 'ctx_finished']) browserbase.contexts.set(id, own(id));
  browserbase.contexts.set('ctx_foreign', { projectId: 'proj-platform', name: `chickpea.${B}.wl_1.00000000` });
  browserbase.contexts.set('ctx_b', { projectId: 'proj-platform', name: `chickpea.${B}.wl_2.00000000` });
  browserbase.sessions.set('sess_leased', { projectId: 'proj-platform', status: 'RUNNING', contextId: 'ctx_recorded', userMetadata: tagged(A) });
  browserbase.sessions.set('sess_listed', { projectId: 'proj-platform', status: 'RUNNING', userMetadata: tagged(A) });
  browserbase.sessions.set('sess_finished', { projectId: 'proj-platform', status: 'COMPLETED', contextId: 'ctx_finished', userMetadata: tagged(A) });
  browserbase.sessions.set('sess_b', { projectId: 'proj-platform', status: 'RUNNING', contextId: 'ctx_b', userMetadata: tagged(B) });
  browserbase.sessions.set('sess_other_project', { projectId: 'proj-other', status: 'RUNNING', userMetadata: tagged(A) });
  t.mock.method(globalThis, 'fetch', browserbase.fetchImpl);
  return browserbase;
}

test('a browser census counts recorded and queued contexts, leases and this month\'s time, and nothing else', async (t) => {
  const { a, store } = installation(t);
  await seed(store);
  assert.deepEqual(await censusInstallationBrowser(a.env, A, { now: NOW }), {
    contexts: 4, queued: 1, leases: 1, month: MONTH, meteredSeconds: 1_800,
  });
  await assert.rejects(censusInstallationBrowser(a.env, B), InstallationContextError);
  await assert.rejects(censusInstallationBrowser({}, A), InstallationContextError);
});

test('erasure ends the installation\'s sessions and deletes its contexts, never another installation\'s, and a second pass finds nothing', async (t) => {
  const { a, store } = installation(t);
  await seed(store);
  const browserbase = seededBrowserbase(t);

  assert.deepEqual(await eraseInstallationBrowser(a.env, A), {
    ended: 2, deleted: 4, alreadyGone: 1, foreign: 1, remaining: 0, sessionsListed: 3, listingUnverified: false,
  });
  assert.deepEqual([...browserbase.contexts.keys()].sort(), ['ctx_b', 'ctx_foreign'], 'the foreign context is never deleted');
  assert.equal(browserbase.sessions.get('sess_b')!.status, 'RUNNING');
  assert.equal(browserbase.sessions.get('sess_other_project')!.status, 'RUNNING');
  assert.ok(!browserbase.requests().some((request) => /ctx_b|sess_b|sess_other_project/.test(request) && !request.startsWith('GET')),
    'nothing but a read touched what is not the installation\'s');
  assert.deepEqual((await listWebsiteLogins(store)).flatMap(({ contextId }) => contextId ? [contextId] : []), [], 'every id is cleared');
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
  // The leased session ran 90 seconds: two minutes.
  assert.deepEqual(await censusInstallationBrowser(a.env, A, { now: NOW }), {
    contexts: 0, queued: 0, leases: 0, month: MONTH, meteredSeconds: 1_920,
  });

  assert.deepEqual(await eraseInstallationBrowser(a.env, A), {
    ended: 0, deleted: 0, alreadyGone: 0, foreign: 0, remaining: 0, sessionsListed: 3, listingUnverified: false,
  });
});

test('a context whose delete fails stays recorded for the next pass', async (t) => {
  const { a, store } = installation(t);
  await seed(store);
  const browserbase = seededBrowserbase(t);
  let failing = true;
  t.mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => failing &&
    init?.method === 'DELETE' && String(input).endsWith('/ctx_queued')
    ? new Response('unavailable', { status: 503 })
    : browserbase.fetchImpl(input, init)) as typeof fetch);
  const first = await eraseInstallationBrowser(a.env, A);
  assert.equal(first.remaining, 1);
  assert.match((await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING))!, /ctx_queued/);
  failing = false;
  const second = await eraseInstallationBrowser(a.env, A);
  assert.deepEqual([second.deleted, second.remaining], [1, 0]);
});

test('a context whose session will not stop waits for the next pass, still recorded', async (t) => {
  const { store } = installation(t);
  const deps = { store: store as never, keyring: generateCredentialKeyring('hosted_erasure_test') };
  const login = await createWebsiteLogin(deps, LOGIN);
  await recordWebsiteLoginContext(store, login.id, 'ctx_busy');
  const browserbase = fakeBrowserbase({
    fail: ({ method, url }) => method === 'POST' && url.endsWith('/v1/sessions/sess_stuck') ? Response.json({}) : undefined,
  });
  browserbase.contexts.set('ctx_busy', own('busy'));
  browserbase.sessions.set('sess_stuck', { projectId: 'proj-platform', status: 'RUNNING', contextId: 'ctx_busy', userMetadata: { installation: A } });
  let clock = NOW;
  const pass = await eraseBrowserPass({
    store,
    provider: new HostedBrowserProvider({ access: { apiKey: 'bb_live_platform', projectId: 'proj-platform' }, installationId: A, store, fetch: browserbase.fetchImpl }),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.deepEqual([pass.ended, pass.deleted, pass.remaining], [1, 0, 2], 'the session and its context remain');
  assert.ok(browserbase.contexts.has('ctx_busy'));
  assert.equal((await listWebsiteLogins(store))[0]!.contextId, 'ctx_busy');
});

test('an id whose record does not show its owner stays in the store, counted remaining and never foreign, and nothing is deleted', async (t) => {
  const { store } = installation(t);
  const deps = { store: store as never, keyring: generateCredentialKeyring('hosted_erasure_test') };
  const login = await createWebsiteLogin(deps, LOGIN);
  await recordWebsiteLoginContext(store, login.id, 'ctx_nameless');
  await store.setSetting(PENDING_CONTEXT_DELETIONS_SETTING, JSON.stringify([
    { contextId: 'ctx_projectless', queuedAt: 1 },
    { handoffSessionId: 'sess_no_metadata', queuedAt: 2 },
  ]));
  const browserbase = fakeBrowserbase();
  browserbase.contexts.set('ctx_nameless', { projectId: 'proj-platform' });
  browserbase.contexts.set('ctx_projectless', { name: own('projectless').name });
  browserbase.sessions.set('sess_no_metadata', { projectId: 'proj-platform', status: 'RUNNING' });
  const pass = await eraseBrowserPass({
    store,
    provider: new HostedBrowserProvider({ access: { apiKey: 'bb_live_platform', projectId: 'proj-platform' }, installationId: A, store, fetch: browserbase.fetchImpl }),
    sleep: async () => undefined,
  });
  assert.equal(pass.foreign, 0);
  assert.equal(pass.remaining, 3);
  assert.equal(pass.deleted, 0);
  assert.equal((await listWebsiteLogins(store))[0]!.contextId, 'ctx_nameless');
  assert.match((await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING))!, /ctx_projectless.*sess_no_metadata/);
  assert.deepEqual(browserbase.requests().filter((request) => request.startsWith('DELETE')), []);
  assert.equal(browserbase.sessions.get('sess_no_metadata')!.status, 'RUNNING');
});

test('erasure ends a queued hand-off session the provider does not list, and keeps its entry until that session has ended', async (t) => {
  const { store } = installation(t);
  await store.setSetting(PENDING_CONTEXT_DELETIONS_SETTING, JSON.stringify([
    { handoffSessionId: 'sess_handoff', queuedAt: 1 },
    { contextId: 'ctx_behind', handoffSessionId: 'sess_stuck', queuedAt: 2 },
  ]));
  const browserbase = fakeBrowserbase({
    fail: ({ method, url }) => {
      if (method === 'GET' && new URL(url).pathname === '/v1/sessions') return Response.json([]);
      return method === 'POST' && url.endsWith('/v1/sessions/sess_stuck') ? Response.json({}) : undefined;
    },
  });
  browserbase.contexts.set('ctx_behind', own('behind'));
  browserbase.sessions.set('sess_handoff', { projectId: 'proj-platform', status: 'RUNNING', userMetadata: { installation: A } });
  browserbase.sessions.set('sess_stuck', { projectId: 'proj-platform', status: 'RUNNING', contextId: 'ctx_behind', userMetadata: { installation: A } });
  let clock = NOW;
  const pass = () => eraseBrowserPass({
    store,
    provider: new HostedBrowserProvider({ access: { apiKey: 'bb_live_platform', projectId: 'proj-platform' }, installationId: A, store, fetch: browserbase.fetchImpl }),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const first = await pass();
  assert.equal(browserbase.sessions.get('sess_handoff')!.status, 'COMPLETED', 'ended though nothing lists it');
  assert.deepEqual([first.deleted, first.remaining], [0, 2], 'the stuck session and the context it saves into wait');
  assert.ok(browserbase.contexts.has('ctx_behind'));
  assert.deepEqual(JSON.parse((await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING))!),
    [{ contextId: 'ctx_behind', handoffSessionId: 'sess_stuck', queuedAt: 2 }]);

  browserbase.sessions.get('sess_stuck')!.status = 'COMPLETED';
  const second = await pass();
  assert.deepEqual([second.deleted, second.remaining], [1, 0]);
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
});

test('a lease holding another installation\'s session is dropped unmetered, and that session is never ended', async (t) => {
  const { store } = installation(t);
  await store.setSetting(BROWSER_SESSION_LEASES_KEY, JSON.stringify({
    leases: { r1: { startedAt: NOW - 300_000, leaseUntil: NOW + 300_000, sessionId: 'sess_b' } },
    recentCreations: [],
  }));
  await store.setSetting(`${BROWSER_SECONDS_PREFIX}${MONTH}`, JSON.stringify({ seconds: 600 }));
  const browserbase = fakeBrowserbase();
  browserbase.sessions.set('sess_b', { projectId: 'proj-platform', status: 'RUNNING', userMetadata: { installation: B } });
  const pass = await eraseBrowserPass({ store, provider: hostedProvider(store, browserbase), sleep: async () => undefined });
  assert.equal(pass.foreign, 1);
  assert.equal(browserbase.sessions.get('sess_b')!.status, 'RUNNING');
  assert.deepEqual(await censusBrowser(store, NOW), { contexts: 0, queued: 0, leases: 0, month: MONTH, meteredSeconds: 600 });
});

function hostedProvider(store: SettingsStore, browserbase: ReturnType<typeof fakeBrowserbase>) {
  return new HostedBrowserProvider({ access: { apiKey: 'bb_live_platform', projectId: 'proj-platform' }, installationId: A, store, fetch: browserbase.fetchImpl });
}

test('erasure ends a pending session it finds only by listing, and its context waits while that session runs', async (t) => {
  const { store } = installation(t);
  const browserbase = fakeBrowserbase({
    fail: ({ method, url }) => method === 'POST' && url.endsWith('/v1/sessions/sess_pending') ? Response.json({}) : undefined,
  });
  browserbase.contexts.set('ctx_pending', own('pending'));
  browserbase.sessions.set('sess_pending', { projectId: 'proj-platform', status: 'PENDING', contextId: 'ctx_pending', userMetadata: { installation: A } });
  let clock = NOW;
  const pass = await eraseBrowserPass({ store, provider: hostedProvider(store, browserbase), now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.ok(browserbase.requests().includes('POST /v1/sessions/sess_pending'), 'its end is requested');
  assert.ok(browserbase.contexts.has('ctx_pending'), 'its context is not deleted underneath it');
  assert.deepEqual([pass.ended, pass.deleted, pass.remaining, pass.listingUnverified], [1, 0, 2, false]);
});

test('a session list that does not show whose its sessions are is reported, with one warning that names nothing', async (t) => {
  const answers: Array<[string, () => Response]> = [
    ['not a list', () => Response.json({ items: [{ id: 'sess_x', status: 'RUNNING' }] })],
    ['no metadata', () => Response.json([{ id: 'sess_x', status: 'RUNNING', projectId: 'proj-platform', contextId: 'ctx_x' }])],
    ['no project', () => Response.json([{ id: 'sess_x', status: 'RUNNING', userMetadata: { installation: A } }])],
    ['unreadable entry', () => Response.json([{ projectId: 'proj-platform', userMetadata: { installation: A } }])],
  ];
  for (const [name, answer] of answers) {
    const { store } = installation(t);
    const warn = t.mock.method(console, 'warn', () => undefined);
    const browserbase = fakeBrowserbase({
      fail: ({ method, url }) => method === 'GET' && new URL(url).pathname === '/v1/sessions' ? answer() : undefined,
    });
    browserbase.contexts.set('ctx_x', own('x'));
    const pass = await eraseBrowserPass({ store, provider: hostedProvider(store, browserbase), sleep: async () => undefined });
    assert.equal(pass.listingUnverified, true, name);
    assert.deepEqual([pass.ended, pass.deleted, pass.sessionsListed], [0, 0, 0], `${name}: nothing it lists is acted on`);
    assert.ok(browserbase.contexts.has('ctx_x'), name);
    const logged = warn.mock.calls.map((call) => String(call.arguments[0]));
    assert.deepEqual(logged.filter((line) => line.includes('session_listing_unverified')),
      [JSON.stringify({ component: 'hosted_browser', event: 'session_listing_unverified' })], `${name}: one warning`);
    assert.doesNotMatch(logged.join('\n'), /sess_x|ctx_x|inst_erase/, `${name}: the log names nothing`);
    warn.mock.restore();
  }
});

test('erasure is refused for another installation, by a state store bound to another, and without the host browser port', async (t) => {
  const { a, store, deployment } = installation(t);
  await seed(store);
  const browserbase = seededBrowserbase(t);
  await assert.rejects(eraseInstallationBrowser(a.env, B), InstallationContextError);
  await assert.rejects(eraseInstallationBrowser({}, A), InstallationContextError);
  const stateStore = deployment.object('TAG_STATE', installationStateStoreObject(a.env).name);
  await assert.rejects(
    (stateStore.host.chickpeaHostBrowserErase as (request: { installationId: string }) => Promise<unknown>)({ installationId: B }),
    InstallationContextError,
    'the state store checks the caller\'s installation against its own name',
  );

  a.db.run('UPDATE installation_binding SET installation_id = ?', B);
  await assert.rejects(eraseInstallationBrowser(a.env, A), (error: unknown) =>
    error instanceof InstallationContextError && error.message === 'This state store belongs to another installation.');
  assert.deepEqual(browserbase.requests(), [], 'nothing reached the provider');
  assert.equal((await listWebsiteLogins(store)).filter(({ contextId }) => contextId).length, 4, 'and every id is still recorded');

  resetHostedBrowserForTests();
  await assert.rejects(eraseInstallationBrowser(a.env, A), (error: unknown) =>
    error instanceof HostedBrowserRefusal && error.reason === 'unavailable');
});

test('the state store object serves the browser census and erasure through its host functions', () => {
  const source = readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8');
  const store = source.slice(source.indexOf('export class TagStateStore'));
  for (const method of ['chickpeaHostBrowserCensus', 'chickpeaHostBrowserErase']) {
    assert.match(store, new RegExp(`async ${method}\\(request: ObjectHostRequest[^)]*\\) \\{\\s*return this\\.host\\(\\)\\.${method}\\(request\\);`), method);
  }
});
