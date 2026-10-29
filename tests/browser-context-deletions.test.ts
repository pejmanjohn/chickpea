import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { BrowserLoginBinder, type BrowserWebsiteLogin } from '../src/browser/binding.ts';
import { createBrowserbaseProvider } from '../src/browser/browserbase.ts';
import {
  drainContextDeletions,
  PENDING_CONTEXT_DELETIONS_SETTING,
  queueContextDeletions,
} from '../src/browser/context-deletions.ts';
import {
  createWebsiteLogin,
  deleteOrphanWebsiteLoginSecrets,
  deleteWebsiteLogin,
  getWebsiteLogin,
  listWebsiteLogins,
  maintainWebsiteLogins,
  recordWebsiteLoginContext,
  setWebsiteLoginHandoff,
  WEBSITE_LOGINS_SETTING,
  type WebsiteLogin,
} from '../src/browser/logins.ts';
import { BROWSER_LOGIN_REVOKED_MESSAGE } from '../src/browser/messages.ts';
import { BrowserProviderError, HostedBrowserRefusal, type BrowserProvider } from '../src/browser/provider.ts';
import { BrowserTurnSession } from '../src/browser/turn-session.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { fakeBrowserProvider, fakeFetch } from './helpers/fake-cdp-socket.ts';

const NOW = Date.UTC(2026, 9, 28);
const DAY = 24 * 60 * 60 * 1000;
const sweep = (store: SqliteSettingsStore, provider: () => Promise<BrowserProvider | undefined>, at = NOW) =>
  drainContextDeletions({ store, provider, now: () => at });

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
    { contextId: 'ctx_a', handoffSessionId: 'sess_a', queuedAt: NOW - 3 },
    { contextId: 'ctx_b', queuedAt: NOW - 2 },
  ]);
  const ended: string[] = [];
  const deleted: string[] = [];
  let refuse = true;
  const { provider } = fakeBrowserProvider({
    async endSession(id) { ended.push(id); },
    async deleteContext(id) {
      if (id === 'ctx_a' && refuse) throw new Error('provider unavailable');
      if (id === 'ctx_b') await queueContextDeletions(store, [{ contextId: 'ctx_c', queuedAt: NOW - 1 }]);
      deleted.push(id);
    },
  });
  await sweep(store, async () => provider);
  assert.deepEqual(await queue(), [
    { contextId: 'ctx_c', queuedAt: NOW - 1 },
    { contextId: 'ctx_a', queuedAt: NOW - 3, attempts: 1 },
  ], 'what failed is counted and goes behind what was queued meanwhile');

  refuse = false;
  await sweep(store, async () => provider);
  assert.deepEqual(ended, ['sess_a'], 'an ended hand-off is not ended again');
  assert.deepEqual(deleted, ['ctx_b', 'ctx_c', 'ctx_a']);
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
});

test('a hand-off whose release fails is ended once the provider reports it ended, and kept while it runs', async (t) => {
  const { store, queue } = setup(t);
  await queueContextDeletions(store, [
    { contextId: 'ctx_done', handoffSessionId: 'sess_done', queuedAt: NOW - 2 },
    { contextId: 'ctx_open', handoffSessionId: 'sess_open', queuedAt: NOW - 1 },
  ]);
  const deleted: string[] = [];
  const { provider } = fakeBrowserProvider({
    async endSession() { throw new BrowserProviderError('Browserbase POST returned 409', 409); },
    async sessionStatus(id) { return id === 'sess_done' ? 'COMPLETED' : 'RUNNING'; },
    async deleteContext(id) { deleted.push(id); },
  });
  await sweep(store, async () => provider);
  assert.deepEqual(deleted, ['ctx_done'], 'a context goes only once the session that would save into it ended');
  assert.deepEqual((await queue()).map(({ contextId, handoffSessionId }) => [contextId, handoffSessionId]),
    [['ctx_open', 'sess_open']]);
});

test('a login\'s deletion succeeds and leaves its context queued when the provider cannot be resolved', async (t) => {
  const { store, deps, queue } = setup(t);
  const login = await createWebsiteLogin(deps, LOGIN);
  await recordWebsiteLoginContext(store, login.id, 'ctx_saved');
  const warn = t.mock.method(console, 'warn', () => undefined);
  const resolving = async (): Promise<BrowserProvider | undefined> => { throw new Error(`settings unavailable for ${login.id}`); };
  assert.equal(await deleteWebsiteLogin({ store, browserProvider: resolving }, login.id), true);
  assert.deepEqual(await listWebsiteLogins(store), []);
  assert.equal(await store.getEncryptedCredentialRevision(`website_login.${login.id}`), undefined);
  assert.deepEqual((await queue()).map(({ contextId }) => contextId), ['ctx_saved']);
  const logged = JSON.stringify(warn.mock.calls.map((call) => call.arguments));
  assert.match(logged, /left for work maintenance/);
  assert.doesNotMatch(logged, new RegExp(`${login.id}|ctx_saved`));
});

test('a 404 from Browserbase dequeues; any other failure keeps the entry', async (t) => {
  const { store, queue } = setup(t);
  await queueContextDeletions(store, [
    { contextId: 'ctx_gone', handoffSessionId: 'sess_gone', queuedAt: NOW - 2 },
    { contextId: 'ctx_flaky', queuedAt: NOW - 1 },
  ]);
  const { calls, fetchImpl } = fakeFetch((call) =>
    new Response(null, { status: call.url.endsWith('/ctx_flaky') ? 503 : 404 }));
  const provider = createBrowserbaseProvider({ apiKey: 'bb_live_queue_test', fetch: fetchImpl });
  await sweep(store, async () => provider);
  assert.deepEqual(calls.map(({ method, url }) => `${method} ${new URL(url).pathname}`), [
    'POST /v1/sessions/sess_gone',
    'DELETE /v1/contexts/ctx_gone',
    'DELETE /v1/contexts/ctx_flaky',
  ]);
  assert.deepEqual(await queue(), [{ contextId: 'ctx_flaky', queuedAt: NOW - 1, attempts: 1 }]);
});

test('standalone with no browser key keeps the queue for a reconnect; a deployment serving many with no hosted browser keeps it too', async (t) => {
  const { store, queue, provider, deleted } = setup(t);
  const entries = [{ contextId: 'ctx_waiting', queuedAt: Date.now() }];
  await queueContextDeletions(store, entries);
  await assert.rejects(
    maintainWebsiteLogins(scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' }), store),
    HostedBrowserRefusal,
  );
  assert.deepEqual(await queue(), entries);
  await withEnv({ BROWSERBASE_API_KEY: undefined, CHICKPEA_TENANCY: undefined }, () => maintainWebsiteLogins({}, store));
  await withEnv({ BROWSERBASE_API_KEY: undefined, CHICKPEA_TENANCY: undefined }, () => maintainWebsiteLogins({}, store));
  assert.deepEqual(await queue(), entries, 'nothing is dropped or counted while there is no key');

  // The same project connected again: the waiting context goes.
  await drainContextDeletions({ store, provider: async () => provider });
  assert.deepEqual(deleted, ['ctx_waiting']);
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
});

test('entries the provider keeps refusing go behind the rest, so newer ones are still deleted', async (t) => {
  const { store, queue } = setup(t);
  const stuck = Array.from({ length: 25 }, (_, index) => ({ contextId: `ctx_stuck_${index}`, queuedAt: NOW - 100 + index }));
  await queueContextDeletions(store, [...stuck, { contextId: 'ctx_fine', queuedAt: NOW - 50 }]);
  const deleted: string[] = [];
  const { provider } = fakeBrowserProvider({
    async deleteContext(id) {
      if (id.startsWith('ctx_stuck_')) throw new Error('provider refuses');
      deleted.push(id);
    },
  });
  await sweep(store, async () => provider);
  assert.deepEqual(deleted, [], 'the first sweep takes the 25 oldest');
  await sweep(store, async () => provider);
  assert.deepEqual(deleted, ['ctx_fine']);
  const left = await queue() as Array<{ contextId: string; attempts: number }>;
  assert.deepEqual(left.map(({ contextId, attempts }) => `${contextId}:${attempts}`),
    ['ctx_stuck_24:1', ...stuck.slice(0, 24).map(({ contextId }) => `${contextId}:2`)]);
});

test('an entry older than 30 days is dropped with a warning that names nothing, with or without a key', async (t) => {
  const { store, queue } = setup(t);
  const warn = t.mock.method(console, 'warn', () => undefined);
  await queueContextDeletions(store, [
    { contextId: 'ctx_old', handoffSessionId: 'sess_old', queuedAt: NOW - 31 * DAY, attempts: 40 },
    { contextId: 'ctx_recent', queuedAt: NOW - 29 * DAY },
  ]);
  await sweep(store, async () => undefined);
  assert.deepEqual((await queue()).map(({ contextId }) => contextId), ['ctx_recent']);
  const logged = JSON.stringify(warn.mock.calls.map((call) => call.arguments));
  assert.match(logged, /queued for deletion for 30 days were dropped/);
  assert.doesNotMatch(logged, /ctx_|sess_/);

  const refusing = fakeBrowserProvider({ async deleteContext() { throw new Error('provider refuses'); } }).provider;
  await sweep(store, async () => refusing, NOW + 2 * DAY);
  assert.equal(await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
});

test('the row keeps at most 1,000 entries, dropping the oldest with a warning', async (t) => {
  const { store, queue } = setup(t);
  const warn = t.mock.method(console, 'warn', () => undefined);
  await queueContextDeletions(store, Array.from({ length: 1_000 }, (_, index) => ({ contextId: `ctx_${index}`, queuedAt: NOW })));
  assert.equal(warn.mock.callCount(), 0);
  await queueContextDeletions(store, [{ contextId: 'ctx_newest', queuedAt: NOW }]);
  const kept = await queue();
  assert.equal(kept.length, 1_000);
  assert.deepEqual([kept[0]?.contextId, kept.at(-1)?.contextId], ['ctx_1', 'ctx_newest']);
  assert.match(JSON.stringify(warn.mock.calls[0]?.arguments), /queue is full/);
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

test('a context record whose answer is lost after it landed keeps the context; one that never landed queues it', async (t) => {
  const { store, deps, queue } = setup(t);
  const login = await createWebsiteLogin(deps, LOGIN);
  const apply = store.applySettingsPatch.bind(store);
  let landed = true;
  store.applySettingsPatch = async (patch) => {
    if (!patch.set?.some(({ key, value }) => key === `website_login_state.${login.id}` && value.includes('ctx_'))) {
      return apply(patch);
    }
    if (landed) await apply(patch);
    throw new Error('state response lost');
  };
  const { provider } = fakeBrowserProvider({ async createContext() { return { id: landed ? 'ctx_landed' : 'ctx_lost' }; } });

  await assert.rejects(bindIn(deps, login, provider), /state response lost/);
  assert.equal((await getWebsiteLogin(store, login.id))?.contextId, 'ctx_landed');
  assert.deepEqual(await queue(), [], 'the recorded context is not queued for deletion');

  await store.deleteSetting(`website_login_state.${login.id}`);
  landed = false;
  await assert.rejects(bindIn(deps, login, provider), /state response lost/);
  assert.equal((await getWebsiteLogin(store, login.id))?.contextId, undefined);
  assert.deepEqual((await queue()).map(({ contextId }) => contextId), ['ctx_lost']);
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

test('maintenance deletes a secret no login names once it is ten minutes old, and only that', async (t) => {
  const start = Date.now() - 60 * 60 * 1000;
  let clock = start;
  const store = new SqliteSettingsStore(':memory:', () => clock);
  t.after(() => store.close());
  const deps = { store, keyring: generateCredentialKeyring('orphan_sweep_test') };
  const kept = await createWebsiteLogin(deps, LOGIN);
  const orphaned = await createWebsiteLogin(deps, { ...LOGIN, host: 'orphan.example.com' });
  // Its deletion removed the catalog entry and then failed before the secret.
  const failing = Object.create(store) as SqliteSettingsStore;
  failing.getEncryptedCredentialRevision = async () => { throw new Error('realm unavailable'); };
  await assert.rejects(deleteWebsiteLogin({ store: failing }, orphaned.id), /realm unavailable/);
  clock = start + 9 * 60 * 1000;
  const fresh = await createWebsiteLogin(deps, { ...LOGIN, host: 'fresh.example.com' });
  await store.setSetting(WEBSITE_LOGINS_SETTING, JSON.stringify(
    JSON.parse((await store.getSetting(WEBSITE_LOGINS_SETTING))!).filter(({ id }: { id: string }) => id !== fresh.id),
  ));
  const secret = (id: string) => store.getEncryptedCredentialRevision(`website_login.${id}`);

  assert.equal(await deleteOrphanWebsiteLoginSecrets(store, start + 9 * 60 * 1000), 0, 'nothing is ten minutes old yet');
  assert.equal(await deleteOrphanWebsiteLoginSecrets(store, start + 11 * 60 * 1000), 1);
  assert.equal(await secret(orphaned.id), undefined);
  assert.ok(await secret(kept.id), 'a login\'s own secret stays');
  assert.ok(await secret(fresh.id), 'a create that may still be writing its catalog entry is left alone');

  await withEnv({ BROWSERBASE_API_KEY: undefined, CHICKPEA_TENANCY: undefined }, () => maintainWebsiteLogins({}, store));
  assert.equal(await secret(fresh.id), undefined, 'the maintenance sweep runs it, an hour on');
  assert.ok(await secret(kept.id));
});

test('the orphan sweep deletes nothing when the catalog row does not parse, or a rewrap replaced the secret', async (t) => {
  const { store, deps } = setup(t);
  const login = await createWebsiteLogin(deps, LOGIN);
  const later = Date.now() + 60 * 60 * 1000;
  const catalog = (await store.getSetting(WEBSITE_LOGINS_SETTING))!;
  await store.setSetting(WEBSITE_LOGINS_SETTING, '{not json');
  assert.equal(await deleteOrphanWebsiteLoginSecrets(store, later), 0);
  await store.setSetting(WEBSITE_LOGINS_SETTING, JSON.stringify([{ id: login.id, host: 42 }]));
  assert.equal(await deleteOrphanWebsiteLoginSecrets(store, later), 0, 'a malformed entry still names its secret');

  await store.setSetting(WEBSITE_LOGINS_SETTING, '[]');
  const list = store.listEncryptedCredentialRevisions.bind(store);
  const stale = Object.create(store) as SqliteSettingsStore;
  stale.listEncryptedCredentialRevisions = async (prefix) =>
    (await list(prefix)).map((row) => ({ ...row, revision: 'wl_rev_replaced_meanwhile' }));
  assert.equal(await deleteOrphanWebsiteLoginSecrets(stale, later), 0);
  assert.ok(await store.getEncryptedCredentialRevision(`website_login.${login.id}`));
  await store.setSetting(WEBSITE_LOGINS_SETTING, catalog);
});
