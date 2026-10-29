import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { BrowserLoginBinder, type BrowserWebsiteLogin } from '../src/browser/binding.ts';
import { createBrowserbaseProvider } from '../src/browser/browserbase.ts';
import {
  drainContextDeletions,
  maintainContextDeletions,
  PENDING_CONTEXT_DELETIONS_SETTING,
  queueContextDeletions,
} from '../src/browser/context-deletions.ts';
import {
  createWebsiteLogin,
  deleteWebsiteLogin,
  getWebsiteLogin,
  listWebsiteLogins,
  recordWebsiteLoginContext,
  setWebsiteLoginHandoff,
  type WebsiteLogin,
} from '../src/browser/logins.ts';
import { BROWSER_LOGIN_REVOKED_MESSAGE } from '../src/browser/messages.ts';
import { BrowserTurnSession } from '../src/browser/turn-session.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { fakeBrowserProvider, fakeFetch } from './helpers/fake-cdp-socket.ts';

const LOGIN = {
  host: 'billing.example.com',
  label: 'Billing',
  ownerKind: 'team' as const,
  createdByMembershipId: 'membership_owner',
  method: 'credentials' as const,
  username: 'ops@example.com',
  password: 'pw-queue-sentinel',
};

function setup(t: TestContext) {
  const store = new SqliteSettingsStore(':memory:');
  t.after(() => store.close());
  const deps = { store, keyring: generateCredentialKeyring('context_deletions_test') };
  const deleted: string[] = [];
  const fake = fakeBrowserProvider({ async deleteContext(id) { deleted.push(id); } });
  const queue = async () => JSON.parse((await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING)) ?? '[]') as
    Array<{ contextId?: string; handoffSessionId?: string }>;
  return { store, deps, deleted, ...fake, queue };
}

test('a crash after the deletion\'s write leaves the context and hand-off queued, and the next sweep deletes them', async (t) => {
  const { store, deps, provider, ended, deleted, queue } = setup(t);
  const login = await createWebsiteLogin(deps, LOGIN);
  await recordWebsiteLoginContext(store, login.id, 'ctx_saved');
  await setWebsiteLoginHandoff(store, login.id, 'sess_handoff');

  // The process dies right after the write that removed the login, before anything reaches the provider.
  const crashing = Object.create(store) as SqliteSettingsStore;
  crashing.getEncryptedCredentialRevision = async () => { throw new Error('evicted'); };
  await assert.rejects(deleteWebsiteLogin({ store: crashing, browserProvider: async () => provider }, login.id), /evicted/);
  assert.deepEqual(await listWebsiteLogins(store), []);
  assert.deepEqual((await queue()).map(({ contextId, handoffSessionId }) => [contextId, handoffSessionId]),
    [['ctx_saved', 'sess_handoff']]);
  assert.deepEqual([ended, deleted], [[], []]);

  await drainContextDeletions({ store, provider: async () => provider });
  assert.deepEqual(ended, ['sess_handoff'], 'the hand-off ends before its context goes');
  assert.deepEqual(deleted, ['ctx_saved']);
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
  await drainContextDeletions({ store, provider: async () => provider });
  assert.deepEqual([ended, deleted], [['sess_handoff'], ['ctx_saved']], 'a second sweep has nothing to do');
});

test('with a provider, deleting a login deletes its context at once and leaves nothing queued', async (t) => {
  const { store, deps, provider, deleted } = setup(t);
  const login = await createWebsiteLogin(deps, LOGIN);
  await recordWebsiteLoginContext(store, login.id, 'ctx_saved');
  assert.equal(await deleteWebsiteLogin({ ...deps, browserProvider: async () => provider }, login.id), true);
  assert.deepEqual(deleted, ['ctx_saved']);
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
});

test('a sweep keeps what failed, less the steps that finished, and keeps what was queued meanwhile', async (t) => {
  const { store, queue } = setup(t);
  await queueContextDeletions(store, [
    { contextId: 'ctx_a', handoffSessionId: 'sess_a', queuedAt: 1 },
    { contextId: 'ctx_b', queuedAt: 2 },
  ]);
  const ended: string[] = [];
  const deleted: string[] = [];
  let refuse = true;
  const { provider } = fakeBrowserProvider({
    async endSession(id) { ended.push(id); },
    async deleteContext(id) {
      if (id === 'ctx_a' && refuse) throw new Error('provider unavailable');
      if (id === 'ctx_b') await queueContextDeletions(store, [{ contextId: 'ctx_c', queuedAt: 3 }]);
      deleted.push(id);
    },
  });
  await drainContextDeletions({ store, provider: async () => provider });
  assert.deepEqual(await queue(), [{ contextId: 'ctx_a', queuedAt: 1 }, { contextId: 'ctx_c', queuedAt: 3 }]);

  refuse = false;
  await drainContextDeletions({ store, provider: async () => provider });
  assert.deepEqual(ended, ['sess_a'], 'an ended hand-off is not ended again');
  assert.deepEqual(deleted, ['ctx_b', 'ctx_a', 'ctx_c']);
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
});

test('a 404 from Browserbase dequeues; any other failure keeps the entry', async (t) => {
  const { store, queue } = setup(t);
  await queueContextDeletions(store, [
    { contextId: 'ctx_gone', handoffSessionId: 'sess_gone', queuedAt: 1 },
    { contextId: 'ctx_flaky', queuedAt: 2 },
  ]);
  const { calls, fetchImpl } = fakeFetch((call) =>
    new Response(null, { status: call.url.endsWith('/ctx_flaky') ? 503 : 404 }));
  const provider = createBrowserbaseProvider({ apiKey: 'bb_live_queue_test', fetch: fetchImpl });
  await drainContextDeletions({ store, provider: async () => provider });
  assert.deepEqual(calls.map(({ method, url }) => `${method} ${new URL(url).pathname}`), [
    'POST /v1/sessions/sess_gone',
    'DELETE /v1/contexts/ctx_gone',
    'DELETE /v1/contexts/ctx_flaky',
  ]);
  assert.deepEqual(await queue(), [{ contextId: 'ctx_flaky', queuedAt: 2 }]);
});

test('standalone with no browser key drops the queue; a deployment serving many leaves it for its host', async (t) => {
  const { store, queue } = setup(t);
  const entries = [{ contextId: 'ctx_unreachable', queuedAt: 1 }];
  await queueContextDeletions(store, entries);
  await maintainContextDeletions(scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' }), store);
  assert.deepEqual(await queue(), entries);
  await withEnv({ BROWSERBASE_API_KEY: undefined, CHICKPEA_TENANCY: undefined }, () => maintainContextDeletions({}, store));
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
});

/** One turn's bind of `login`, on its own session. */
function bindIn(deps: ReturnType<typeof setup>['deps'], login: WebsiteLogin, provider: BrowserTurnSession['provider']) {
  const granted: BrowserWebsiteLogin = { id: login.id, host: login.host, label: login.label, method: login.method, level: 'check' };
  const session = new BrowserTurnSession({ provider, connect: async () => { throw new Error('not opened'); } });
  const binder = new BrowserLoginBinder(session, {
    granted: [granted],
    readLive: async () => [granted],
    dependencies: async () => deps,
  }, async () => undefined);
  return binder.bindingFor(granted, async () => [granted]);
}

test('two binds racing on one login record exactly one context and queue the other', async (t) => {
  const { store, deps, queue } = setup(t);
  const login = await createWebsiteLogin(deps, LOGIN);
  let created = 0;
  let bothCreated!: () => void;
  const raced = new Promise<void>((resolve) => { bothCreated = resolve; });
  const { provider } = fakeBrowserProvider({
    async createContext() {
      created += 1;
      const id = `ctx_race_${created}`;
      if (created === 2) bothCreated();
      await raced;
      return { id };
    },
  });
  const [first, second] = await Promise.all([
    bindIn(deps, login, provider),
    bindIn(deps, login, provider),
  ]);
  const recorded = (await getWebsiteLogin(store, login.id))!.contextId!;
  assert.deepEqual([first.contextId, second.contextId], [recorded, recorded], 'both sessions use the recorded one');
  assert.deepEqual((await queue()).map(({ contextId }) => contextId),
    ['ctx_race_1', 'ctx_race_2'].filter((id) => id !== recorded));
});

test('a bind whose login was deleted meanwhile queues the context it created and fails', async (t) => {
  const { store, deps, queue } = setup(t);
  const login = await createWebsiteLogin(deps, LOGIN);
  const { provider } = fakeBrowserProvider({
    async createContext() {
      await deleteWebsiteLogin({ store }, login.id);
      return { id: 'ctx_orphan' };
    },
  });
  await assert.rejects(bindIn(deps, login, provider), (error: Error) => error.message === BROWSER_LOGIN_REVOKED_MESSAGE);
  assert.deepEqual((await queue()).map(({ contextId }) => contextId), ['ctx_orphan']);
  assert.equal(await store.getSetting(`website_login_state.${login.id}`), undefined, 'no state row outlives the login');
});
