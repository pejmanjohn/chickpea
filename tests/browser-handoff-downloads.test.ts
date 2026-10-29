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
import { createWebsiteLogin, getWebsiteLogin, setWebsiteLoginHandoff } from '../src/browser/logins.ts';
import { deleteSessionDownloads, HostedBrowserRefusal, type BrowserProvider } from '../src/browser/provider.ts';
import { BrowserTurnSession } from '../src/browser/turn-session.ts';
import { configureHostedBrowser, resetHostedBrowserForTests } from '../src/config/hosted-browser.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { fakeBrowserbase } from './helpers/fake-browserbase.ts';
import { FakeCdpSocket, fakeFetch } from './helpers/fake-cdp-socket.ts';

const ACCESS = { apiKey: 'bb_live_platform', projectId: 'proj-platform' };
const OWN = { projectId: 'proj-platform', userMetadata: { chickpea: '1', installation: 'inst_a' } };
const LOGIN = {
  host: 'billing.example.com', label: 'Billing', ownerKind: 'team' as const,
  createdByMembershipId: 'membership_owner', method: 'handoff' as const,
};

function setup(t: TestContext, options: Parameters<typeof fakeBrowserbase>[0] = {}) {
  resetHostedBrowserForTests();
  t.after(resetHostedBrowserForTests);
  configureHostedBrowser({
    policy: () => ({ enabled: true, monthlyBrowserHours: 10, maxRunningBrowsers: 2, sessionsPerMinute: 6 }),
    access: () => ACCESS,
  });
  t.mock.method(console, 'warn', () => undefined);
  const store = new SqliteSettingsStore(':memory:');
  t.after(() => store.close());
  const browserbase = fakeBrowserbase(options);
  const hosted = () => new HostedBrowserProvider({ access: ACCESS, installationId: 'inst_a', store, fetch: browserbase.fetchImpl });
  const standalone = () => createBrowserbaseProvider({ apiKey: 'bb_live_own', projectId: 'proj-platform', fetch: browserbase.fetchImpl });
  return { store, browserbase, hosted, standalone };
}

/** A hand-off session the person left with two files downloaded in its live view. */
function handoffWithFiles(browserbase: ReturnType<typeof fakeBrowserbase>, sessionId = 'sess_h') {
  browserbase.sessions.set(sessionId, { ...OWN, status: 'RUNNING' });
  browserbase.files.set(`dl_${sessionId}_1`, { sessionId });
  browserbase.files.set(`dl_${sessionId}_2`, { sessionId });
}

const downloadCalls = (browserbase: ReturnType<typeof fakeBrowserbase>) =>
  browserbase.requests().filter((request) => request.includes('/v1/downloads'));

/** A turn's bind of a login whose hand-off session is still recorded. */
async function bindAfterHandoff(store: SqliteSettingsStore, provider: BrowserProvider) {
  const deps = { store, keyring: generateCredentialKeyring('handoff_downloads_test') };
  const login = await createWebsiteLogin(deps, LOGIN);
  await setWebsiteLoginHandoff(store, login.id, 'sess_h');
  const granted: BrowserWebsiteLogin = { id: login.id, host: login.host, label: login.label, method: login.method, level: 'check' };
  const session = new BrowserTurnSession({ provider, connect: async () => FakeCdpSocket.withPage(), sleep: async () => undefined });
  const binder = new BrowserLoginBinder(session, { granted: [granted], readLive: async () => [granted], dependencies: async () => deps }, async () => undefined);
  await session.ensureFor(await binder.bindingFor(granted, async () => [granted]));
  return login;
}

test('the client lists every page of a session\'s files, only that session\'s, and refuses an entry naming none', async () => {
  const own = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: `dl_${from + index}`, sessionId: 'sess_h' }));
  const { calls, fetchImpl } = fakeFetch(({ url }) => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    const downloads = offset === 0 ? [...own(0, 99), { id: 'dl_other', sessionId: 'sess_other' }] : own(100, 30);
    return Response.json({ downloads, total: 130, limit: 100, offset });
  });
  const client = createBrowserbaseProvider({ apiKey: 'bb_live_own', fetch: fetchImpl });
  const listed = await client.listDownloads('sess_h');
  assert.equal(listed.length, 129);
  assert.ok(!listed.some(({ id }) => id === 'dl_other'), 'another session\'s file is left out');
  assert.deepEqual(calls.map(({ url }) => new URL(url).search), [
    '?sessionId=sess_h&limit=100&offset=0',
    '?sessionId=sess_h&limit=100&offset=100',
  ]);

  const unnamed = createBrowserbaseProvider({
    apiKey: 'bb_live_own',
    fetch: fakeFetch(() => Response.json({ downloads: [{ id: 'dl_1', sessionId: 'sess_h' }, { id: 'dl_2' }] })).fetchImpl,
  });
  await assert.rejects(unnamed.listDownloads('sess_h'), /missing id or sessionId/);
  const result = await deleteSessionDownloads(unnamed, 'sess_h');
  assert.deepEqual(result, { deleted: 0, complete: false }, 'nothing unchecked is deleted');
});

test('a 404 counts as gone, for a file and for a session the provider no longer has', async (t) => {
  // The first file goes between the listing and its delete.
  let files: Map<string, unknown> | undefined;
  const { browserbase, standalone, hosted } = setup(t, {
    fail: ({ method, url }) => {
      if (method !== 'DELETE' || !url.endsWith('/v1/downloads/dl_sess_h_1')) return undefined;
      files!.delete('dl_sess_h_1');
      return new Response(null, { status: 404 });
    },
  });
  files = browserbase.files;
  handoffWithFiles(browserbase);
  assert.deepEqual(await deleteSessionDownloads(standalone(), 'sess_h'), { deleted: 2, complete: true });
  assert.equal(browserbase.files.size, 0);
  assert.deepEqual(await deleteSessionDownloads(hosted(), 'sess_never'), { deleted: 0, complete: true },
    'a session the provider does not have has no files');
});

test('a hand-off\'s two files are deleted when the next bind finishes it, before the next session opens', async (t) => {
  const { store, browserbase, standalone, hosted } = setup(t);
  for (const provider of [standalone, hosted]) {
    browserbase.calls.length = 0;
    handoffWithFiles(browserbase);
    const login = await bindAfterHandoff(store, provider());
    assert.equal(browserbase.files.size, 0, 'both files are gone');
    const requests = browserbase.requests();
    const nextSession = requests.lastIndexOf('POST /v1/sessions');
    assert.ok(requests.lastIndexOf('DELETE /v1/downloads/dl_sess_h_2') < nextSession, 'deleted before the next session opens');
    assert.ok(requests.indexOf('POST /v1/sessions/sess_h') < requests.indexOf('DELETE /v1/downloads/dl_sess_h_1'), 'after the hand-off ended');
    assert.equal((await getWebsiteLogin(store, login.id))!.handoffSessionId, undefined);
    assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
  }
});

test('a hand-off file that cannot be deleted at bind is queued, and the next sweep deletes it', async (t) => {
  let failing = true;
  const { store, browserbase, standalone } = setup(t, {
    fail: ({ method, url }) => failing && method === 'DELETE' && url.includes('/v1/downloads/') ? new Response('no', { status: 503 }) : undefined,
  });
  handoffWithFiles(browserbase);
  const login = await bindAfterHandoff(store, standalone());
  assert.equal((await getWebsiteLogin(store, login.id))!.handoffSessionId, undefined, 'the bind goes ahead');
  assert.deepEqual(JSON.parse((await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING))!).map(({ handoffSessionId }: { handoffSessionId: string }) => handoffSessionId), ['sess_h']);
  assert.equal(browserbase.files.size, 2);
  failing = false;
  await drainContextDeletions({ store, provider: async () => standalone() });
  assert.equal(browserbase.files.size, 0);
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
});

test('the deletion queue deletes a hand-off\'s two files once it ends, and a failed file never holds its context back', async (t) => {
  let failing = false;
  const { store, browserbase, hosted } = setup(t, {
    fail: ({ method, url }) => failing && method === 'DELETE' && url.endsWith('/v1/downloads/dl_sess_h_2') ? new Response('no', { status: 503 }) : undefined,
  });
  handoffWithFiles(browserbase);
  browserbase.contexts.set('ctx_h', { projectId: 'proj-platform', name: 'chickpea.inst_a.wl_1.00000000' });
  const queuedAt = Date.now();
  await queueContextDeletions(store, [{ contextId: 'ctx_h', handoffSessionId: 'sess_h', queuedAt }]);
  await drainContextDeletions({ store, provider: async () => hosted() });
  assert.equal(browserbase.files.size, 0);
  assert.ok(!browserbase.contexts.has('ctx_h'));
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
  const requests = browserbase.requests();
  assert.ok(requests.indexOf('POST /v1/sessions/sess_h') < requests.indexOf('DELETE /v1/downloads/dl_sess_h_1'));

  failing = true;
  handoffWithFiles(browserbase);
  browserbase.contexts.set('ctx_h', { projectId: 'proj-platform', name: 'chickpea.inst_a.wl_1.00000000' });
  await queueContextDeletions(store, [{ contextId: 'ctx_h', handoffSessionId: 'sess_h', queuedAt }]);
  await drainContextDeletions({ store, provider: async () => hosted() });
  assert.ok(!browserbase.contexts.has('ctx_h'), 'the context goes once the session has ended');
  assert.deepEqual([...browserbase.files.keys()], ['dl_sess_h_2']);
  assert.deepEqual(JSON.parse((await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING))!),
    [{ handoffSessionId: 'sess_h', queuedAt, attempts: 1 }], 'only the files are still owed');
  failing = false;
  await drainContextDeletions({ store, provider: async () => hosted() });
  assert.equal(browserbase.files.size, 0);
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
});

test('under tenancy another installation\'s session\'s files are never listed or deleted', async (t) => {
  const { store, browserbase, hosted } = setup(t);
  browserbase.sessions.set('sess_b', { projectId: 'proj-platform', status: 'COMPLETED', userMetadata: { installation: 'inst_b' } });
  browserbase.files.set('dl_b', { sessionId: 'sess_b' });
  const wrapper = hosted();
  await assert.rejects(wrapper.listDownloads('sess_b'), (error: unknown) => error instanceof HostedBrowserRefusal && error.reason === 'ownership');
  await assert.rejects(wrapper.deleteDownload('dl_b'), (error: unknown) => error instanceof HostedBrowserRefusal && error.reason === 'ownership',
    'a file this instance never listed from a session of its own');
  assert.deepEqual(await deleteSessionDownloads(wrapper, 'sess_b'), { deleted: 0, complete: false });

  await queueContextDeletions(store, [{ handoffSessionId: 'sess_b', queuedAt: Date.now() }]);
  await drainContextDeletions({ store, provider: async () => hosted() });
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined, 'the foreign entry is dropped');
  assert.ok(browserbase.files.has('dl_b'));
  assert.deepEqual(downloadCalls(browserbase), [], 'no download listing or deletion reached Browserbase');
});
