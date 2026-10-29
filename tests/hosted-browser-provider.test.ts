import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { BrowserLoginBinder, type BrowserWebsiteLogin } from '../src/browser/binding.ts';
import { createBrowserbaseProvider } from '../src/browser/browserbase.ts';
import {
  drainContextDeletions,
  PENDING_CONTEXT_DELETIONS_SETTING,
  queueContextDeletions,
} from '../src/browser/context-deletions.ts';
import { HostedBrowserProvider } from '../src/browser/hosted-provider.ts';
import { createWebsiteLogin, getWebsiteLogin, recordWebsiteLoginContext, type WebsiteLogin } from '../src/browser/logins.ts';
import {
  HOSTED_BROWSER_BUSY_MESSAGE,
  HOSTED_BROWSER_UNAVAILABLE_MESSAGE,
} from '../src/browser/messages.ts';
import {
  awaitRecordingDownload,
  BrowserProviderError,
  HostedBrowserFailure,
  HostedBrowserRefusal,
  type BrowserProvider,
} from '../src/browser/provider.ts';
import { openRecordingDownload } from '../src/browser/tools.ts';
import { BrowserTurnSession } from '../src/browser/turn-session.ts';
import { configureHostedBrowser, resetHostedBrowserForTests } from '../src/config/hosted-browser.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { fakeBrowserbase } from './helpers/fake-browserbase.ts';
import { FakeCdpSocket, fakeBrowserProvider } from './helpers/fake-cdp-socket.ts';

const INSTALLATION = 'inst_a';
const ACCESS = { apiKey: 'bb_live_platform_key', projectId: 'proj-platform' };
const POLICY = { enabled: true, monthlyBrowserHours: 10, maxRunningBrowsers: 2, sessionsPerMinute: 6 };
const LOGIN = {
  host: 'billing.example.com', label: 'Billing', ownerKind: 'team' as const,
  createdByMembershipId: 'membership_owner', method: 'credentials' as const,
  username: 'ops@example.com', password: 'pw-hosted-sentinel',
};

function setup(t: TestContext, options: Parameters<typeof fakeBrowserbase>[0] & { policy?: () => typeof POLICY } = {}) {
  resetHostedBrowserForTests();
  t.after(resetHostedBrowserForTests);
  configureHostedBrowser({ policy: options.policy ?? (() => POLICY), access: () => ACCESS });
  const store = new SqliteSettingsStore(':memory:');
  t.after(() => store.close());
  const browserbase = fakeBrowserbase(options);
  const logged: string[] = [];
  t.mock.method(console, 'warn', (line: string) => { logged.push(line); });
  const provider = () => new HostedBrowserProvider({ access: ACCESS, installationId: INSTALLATION, store, fetch: browserbase.fetchImpl });
  return { store, browserbase, provider, logged };
}

function refused(reason: HostedBrowserRefusal['reason']) {
  return (error: unknown) => error instanceof HostedBrowserRefusal && error.reason === reason &&
    error.message === HOSTED_BROWSER_UNAVAILABLE_MESSAGE;
}

/** A record that does not show its owner fails as the provider would, to be tried again; it is never refused as another's. */
function unverified(error: unknown) {
  return error instanceof HostedBrowserFailure && error.status === undefined && error.message === HOSTED_BROWSER_UNAVAILABLE_MESSAGE;
}

/** One turn's bind of `login`, on its own session. */
function bindIn(store: SqliteSettingsStore, login: WebsiteLogin, provider: BrowserProvider) {
  const deps = { store, keyring: generateCredentialKeyring('hosted_provider_test') };
  const granted: BrowserWebsiteLogin = { id: login.id, host: login.host, label: login.label, method: login.method, level: 'check' };
  const session = new BrowserTurnSession({ provider, connect: async () => FakeCdpSocket.withPage(), sleep: async () => undefined });
  const binder = new BrowserLoginBinder(session, { granted: [granted], readLive: async () => [granted], dependencies: async () => deps }, async () => undefined);
  return { session, binding: binder.bindingFor(granted, async () => [granted]) };
}

test('a hosted session carries its installation and no provider logs, and a context is named for its owner', async (t) => {
  const { store, browserbase, provider } = setup(t);
  const login = await createWebsiteLogin({ store, keyring: generateCredentialKeyring('hosted_provider_test') }, LOGIN);
  const wrapper = provider();
  const { session, binding } = bindIn(store, login, wrapper);
  await session.ensureFor(await binding);
  const [createContext, createSession] = browserbase.calls.filter(({ method }) => method === 'POST');
  assert.equal(createContext!.url, 'https://api.browserbase.com/v1/contexts');
  assert.equal((createContext!.body as { projectId: string }).projectId, 'proj-platform');
  assert.match((createContext!.body as { name: string }).name, new RegExp(`^chickpea\\.inst_a\\.${login.id}\\.[0-9a-f]{8}$`));
  assert.doesNotMatch(JSON.stringify(createContext!.body), /Billing/, 'the tenant-written label never names a shared context');
  const body = createSession!.body as Record<string, any>;
  assert.deepEqual(body.userMetadata, { chickpea: '1', installation: INSTALLATION });
  assert.equal(body.browserSettings.logSession, false);
  assert.equal(body.browserSettings.recordSession, true, 'an Agent session keeps its recording receipt');
  assert.equal(body.projectId, 'proj-platform');
  assert.deepEqual(browserbase.requests().filter((request) => request.startsWith('GET')), [],
    'a context and a session this instance made need no ownership read');

  const again = await wrapper.createContext({ loginId: login.id, label: login.label });
  assert.notEqual(browserbase.contexts.get(again.id)!.name, (createContext!.body as { name: string }).name,
    'each context of one login gets its own name, so a stranded one never blocks the next');
});

test('a context named for another installation, or kept in another project, never loads or is deleted', async (t) => {
  const { browserbase, provider } = setup(t);
  browserbase.contexts.set('ctx_b', { projectId: 'proj-platform', name: 'chickpea.inst_b.wl_1.00000000' });
  browserbase.contexts.set('ctx_prefix', { projectId: 'proj-platform', name: 'chickpea.inst_ab.wl_1.00000000' });
  browserbase.contexts.set('ctx_case', { projectId: 'proj-platform', name: 'chickpea.INST_A.wl_1.00000000' });
  browserbase.contexts.set('ctx_label', { projectId: 'proj-platform', name: 'Billing' });
  browserbase.contexts.set('ctx_project', { projectId: 'proj-other', name: 'chickpea.inst_a.wl_1.00000000' });
  browserbase.contexts.set('ctx_project_nameless', { projectId: 'proj-other' });
  browserbase.contexts.set('ctx_nameless', { projectId: 'proj-platform' });
  browserbase.contexts.set('ctx_projectless', { name: 'chickpea.inst_a.wl_1.00000000' });
  for (const id of ['ctx_b', 'ctx_prefix', 'ctx_case', 'ctx_label', 'ctx_project', 'ctx_project_nameless']) {
    const wrapper = provider();
    await assert.rejects(wrapper.createSession({ contextId: id, persistContext: true }), refused('ownership'), id);
    await assert.rejects(wrapper.deleteContext(id), refused('ownership'), id);
    assert.ok(browserbase.contexts.has(id), `${id} is never deleted`);
  }
  for (const id of ['ctx_nameless', 'ctx_projectless']) {
    const wrapper = provider();
    await assert.rejects(wrapper.createSession({ contextId: id, persistContext: true }), unverified, id);
    await assert.rejects(wrapper.deleteContext(id), unverified, id);
    assert.ok(browserbase.contexts.has(id), `${id} is never deleted`);
  }
  assert.deepEqual(browserbase.requests().filter((request) => !request.startsWith('GET /v1/contexts/')), [],
    'nothing but the ownership reads reached the provider');
});

test('a session another instance made is used only when its record names this project and installation, once per instance', async (t) => {
  const { browserbase, provider } = setup(t);
  browserbase.sessions.set('sess_own', { projectId: 'proj-platform', status: 'RUNNING', userMetadata: { chickpea: '1', installation: INSTALLATION } });
  browserbase.sessions.set('sess_b', { projectId: 'proj-platform', status: 'RUNNING', userMetadata: { chickpea: '1', installation: 'inst_b' } });
  browserbase.sessions.set('sess_project', { projectId: 'proj-other', status: 'RUNNING', userMetadata: { installation: INSTALLATION } });
  browserbase.sessions.set('sess_untagged', { projectId: 'proj-platform', status: 'RUNNING', userMetadata: {} });
  browserbase.sessions.set('sess_no_metadata', { projectId: 'proj-platform', status: 'RUNNING' });
  browserbase.sessions.set('sess_no_project', { status: 'RUNNING', userMetadata: { installation: INSTALLATION } });
  const calls: Array<[string, (wrapper: BrowserProvider, id: string) => Promise<unknown>]> = [
    ['endSession', (wrapper, id) => wrapper.endSession(id)],
    ['sessionStatus', (wrapper, id) => wrapper.sessionStatus(id)],
    ['liveView', (wrapper, id) => wrapper.liveView(id)],
    ['requestRecordingDownloads', (wrapper, id) => wrapper.requestRecordingDownloads(id)],
    ['listRecordingDownloads', (wrapper, id) => wrapper.listRecordingDownloads(id)],
  ];
  for (const [name, call] of calls) {
    for (const id of ['sess_b', 'sess_project', 'sess_untagged', 'sess_no_metadata', 'sess_no_project']) {
      const before = browserbase.calls.length;
      const foreign = id === 'sess_b' || id === 'sess_project';
      await assert.rejects(call(provider(), id), foreign ? refused('ownership') : unverified, `${name} ${id}`);
      assert.deepEqual(browserbase.requests().slice(before), [`GET /v1/sessions/${id}`], `${name} ${id} reads only the record`);
    }
  }
  for (const [id, session] of browserbase.sessions) {
    if (id !== 'sess_own') assert.equal(session.status, 'RUNNING', `${id} is never ended`);
  }

  const wrapper = provider();
  assert.equal(await wrapper.sessionStatus('sess_own'), 'RUNNING');
  await wrapper.liveView('sess_own');
  await wrapper.endSession('sess_own');
  assert.deepEqual(browserbase.requests().slice(-3), [
    'GET /v1/sessions/sess_own',
    'GET /v1/sessions/sess_own/debug',
    'POST /v1/sessions/sess_own',
  ], 'the ownership read answers the status, and its verdict holds for the instance');
});

test('a recorded context the provider no longer has is forgotten and replaced once', async (t) => {
  const { store, browserbase, provider } = setup(t);
  const login = await createWebsiteLogin({ store, keyring: generateCredentialKeyring('hosted_provider_test') }, LOGIN);
  await recordWebsiteLoginContext(store, login.id, 'ctx_restored');
  const { session, binding } = bindIn(store, login, provider());
  const bound = await binding;
  await session.ensureFor(bound);
  assert.notEqual(bound.contextId, 'ctx_restored');
  assert.equal((await getWebsiteLogin(store, login.id))!.contextId, bound.contextId);
  assert.deepEqual(browserbase.requests(), [
    'GET /v1/contexts/ctx_restored',
    'POST /v1/contexts',
    'POST /v1/sessions',
  ]);
});

test('the deletion queue drops what the wrapper finds another installation\'s, deleting and ending none of it', async (t) => {
  const { store, browserbase, provider } = setup(t);
  browserbase.contexts.set('ctx_b', { projectId: 'proj-platform', name: 'chickpea.inst_b.wl_1.00000000' });
  browserbase.contexts.set('ctx_a', { projectId: 'proj-platform', name: 'chickpea.inst_a.wl_1.00000000' });
  browserbase.sessions.set('sess_b', { projectId: 'proj-platform', status: 'RUNNING', userMetadata: { installation: 'inst_b' } });
  await queueContextDeletions(store, [
    { contextId: 'ctx_b', handoffSessionId: 'sess_b', queuedAt: Date.now() },
    { contextId: 'ctx_a', queuedAt: Date.now() },
  ]);
  await drainContextDeletions({ store, provider: async () => provider() });
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
  assert.ok(browserbase.contexts.has('ctx_b'));
  assert.equal(browserbase.sessions.get('sess_b')!.status, 'RUNNING');
  assert.ok(!browserbase.contexts.has('ctx_a'), 'the installation\'s own context is deleted');
});

test('the deletion queue keeps what the wrapper cannot judge, deleting and ending none of it', async (t) => {
  const { store, browserbase, provider, logged } = setup(t);
  browserbase.contexts.set('ctx_nameless', { projectId: 'proj-platform' });
  browserbase.contexts.set('ctx_a', { projectId: 'proj-platform', name: 'chickpea.inst_a.wl_1.00000000' });
  browserbase.sessions.set('sess_no_metadata', { projectId: 'proj-platform', status: 'RUNNING' });
  const queuedAt = Date.now();
  await queueContextDeletions(store, [
    { contextId: 'ctx_nameless', queuedAt },
    { contextId: 'ctx_a', handoffSessionId: 'sess_no_metadata', queuedAt },
  ]);
  await drainContextDeletions({ store, provider: async () => provider() });
  assert.deepEqual(JSON.parse((await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING))!), [
    { contextId: 'ctx_nameless', queuedAt, attempts: 1 },
    { contextId: 'ctx_a', handoffSessionId: 'sess_no_metadata', queuedAt, attempts: 1 },
  ]);
  assert.deepEqual(browserbase.requests().filter((request) => !request.startsWith('GET ')), [], 'nothing is deleted or ended');
  assert.ok(browserbase.contexts.has('ctx_a'), 'a context waits for the hand-off session it sits behind');
  assert.ok(logged.some((line) => JSON.parse(line).event === 'ownership_unverified'));
  assert.ok(!logged.some((line) => JSON.parse(line).event === 'ownership_refused'));
});

test('provider failures reach the model as fixed texts, the body only nowhere, the status only in the log', async (t) => {
  const body = 'upstream said bb_live_platform_key sess_secret ops@example.com';
  const { provider, logged } = setup(t, {
    fail: ({ method, url }) => method === 'POST' && url.endsWith('/v1/sessions')
      ? new Response(body, { status: 429, headers: { 'retry-after': '7' } })
      : url.includes('/v1/contexts/') ? new Response(body, { status: 500 }) : undefined,
  });
  await assert.rejects(provider().createSession({}), (error: unknown) => {
    assert.ok(error instanceof HostedBrowserFailure);
    assert.equal(error.message, HOSTED_BROWSER_BUSY_MESSAGE);
    assert.deepEqual([error.status, error.retryAfterMs], [429, 7_000]);
    return true;
  });
  await assert.rejects(provider().createSession({ contextId: 'ctx_any' }), (error: unknown) =>
    error instanceof HostedBrowserFailure && error.message === HOSTED_BROWSER_UNAVAILABLE_MESSAGE);
  assert.deepEqual(logged.map((line) => JSON.parse(line)), [
    { component: 'hosted_browser', event: 'provider_failed', operation: 'create_session', status: 429 },
    { component: 'hosted_browser', event: 'provider_failed', operation: 'get_context', status: 500 },
  ]);
});

test('a 429 on an ownership read is the busy text', async (t) => {
  const { provider } = setup(t, {
    fail: ({ method }) => method === 'GET' ? new Response('slow down', { status: 429 }) : undefined,
  });
  await assert.rejects(provider().sessionStatus('sess_any'), (error: unknown) =>
    error instanceof HostedBrowserFailure && error.message === HOSTED_BROWSER_BUSY_MESSAGE);
  await assert.rejects(provider().createSession({ contextId: 'ctx_any' }), (error: unknown) =>
    error instanceof HostedBrowserFailure && error.message === HOSTED_BROWSER_BUSY_MESSAGE);
});

test('the host\'s off switch holds mid-turn: no session or context is created once the policy is off', async (t) => {
  let enabled = true;
  const { browserbase, provider } = setup(t, { policy: () => ({ ...POLICY, enabled }) });
  const wrapper = provider();
  await wrapper.createSession({});
  enabled = false;
  await assert.rejects(wrapper.createSession({}), refused('off'));
  await assert.rejects(wrapper.createContext({ loginId: 'wl_1', label: 'Billing' }), refused('off'));
  assert.deepEqual(browserbase.requests(), ['POST /v1/sessions']);
});

test('sending a recording again reuses a finished download, and a rate-limited request waits as asked', async () => {
  const listed: string[] = [];
  let requests = 0;
  const reuse = fakeBrowserProvider({
    async listRecordingDownloads(id) {
      listed.push(id);
      return [{ pageId: 'p1', status: 'COMPLETED', downloadUrl: 'https://recordings.example/r.mp4' }];
    },
    async requestRecordingDownloads() { requests += 1; },
  });
  const fetched: string[] = [];
  await openRecordingDownload(reuse.provider, 'sess_done', {
    fetch: (async (url: string) => { fetched.push(url); return new Response(new Uint8Array(8)); }) as typeof fetch,
  });
  assert.deepEqual([listed, requests, fetched], [['sess_done'], 0, ['https://recordings.example/r.mp4']]);

  let clock = 0;
  const slept: number[] = [];
  let ready = false;
  const limited = fakeBrowserProvider({
    async listRecordingDownloads() {
      return ready ? [{ pageId: 'p1', status: 'COMPLETED', downloadUrl: 'https://recordings.example/r.mp4' }] : [];
    },
    async requestRecordingDownloads() {
      if (slept.length === 0) throw new HostedBrowserFailure(429, 20_000);
      ready = true;
    },
  });
  const download = await awaitRecordingDownload(limited.provider, 'sess_done', {
    timeoutMs: 90_000, pollMs: 2_000, reuseReady: true,
    now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  assert.equal(download.downloadUrl, 'https://recordings.example/r.mp4');
  assert.deepEqual(slept, [20_000]);

  clock = 0;
  slept.length = 0;
  const tooLong = fakeBrowserProvider({
    async requestRecordingDownloads() { throw new HostedBrowserFailure(429, 120_000); },
  });
  await assert.rejects(awaitRecordingDownload(tooLong.provider, 'sess_done', {
    timeoutMs: 90_000, pollMs: 2_000, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; },
  }), (error: unknown) => error instanceof BrowserProviderError && error.message === HOSTED_BROWSER_BUSY_MESSAGE);
  assert.deepEqual(slept, [], 'a wait past the recording timeout is not started');
});

test('standalone sends Browserbase exactly what it did: label-named contexts, no metadata, no ownership reads', async (t) => {
  const store = new SqliteSettingsStore(':memory:');
  t.after(() => store.close());
  const browserbase = fakeBrowserbase({ projectId: 'proj-own' });
  const client = createBrowserbaseProvider({ apiKey: 'bb_live_own', projectId: 'proj-own', fetch: browserbase.fetchImpl });
  const login = await createWebsiteLogin({ store, keyring: generateCredentialKeyring('hosted_provider_test') }, LOGIN);
  const first = bindIn(store, login, client);
  await first.session.ensureFor(await first.binding);
  await first.session.close();
  const second = bindIn(store, login, client);
  await second.session.ensureFor(await second.binding);
  await second.session.openForHandoff(await second.binding);
  const sessionBody = (contextId: string) => ({
    browserSettings: {
      recordSession: true, viewport: { width: 1280, height: 800 },
      context: { id: contextId, persist: true }, allowedDomains: ['billing.example.com'],
    },
    projectId: 'proj-own',
    timeout: 660,
  });
  assert.deepEqual(browserbase.calls.map(({ method, url, body }) => [method, new URL(url).pathname, body]), [
    ['POST', '/v1/contexts', { projectId: 'proj-own', name: 'Billing' }],
    ['POST', '/v1/sessions', sessionBody('ctx_1')],
    ['POST', '/v1/sessions/sess_2', { status: 'REQUEST_RELEASE' }],
    ['POST', '/v1/sessions', sessionBody('ctx_1')],
    ['POST', '/v1/sessions/sess_3', { status: 'REQUEST_RELEASE' }],
    ['POST', '/v1/sessions', {
      browserSettings: {
        recordSession: false, logSession: false, viewport: { width: 1280, height: 800 },
        context: { id: 'ctx_1', persist: true },
      },
      projectId: 'proj-own', keepAlive: true, timeout: 600,
    }],
  ]);
});
