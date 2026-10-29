import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { browserCapabilityForTurn } from '../src/browser/capability.ts';
import { queueContextDeletions } from '../src/browser/context-deletions.ts';
import { maintainWebsiteLogins } from '../src/browser/logins.ts';
import { HOSTED_BROWSER_UNAVAILABLE_MESSAGE } from '../src/browser/messages.ts';
import { HostedBrowserRefusal } from '../src/browser/provider.ts';
import { BROWSER_ENV_VARS, BROWSER_SETTING_KEYS, resolveBrowserProvider } from '../src/browser/settings.ts';
import { configureHostedBrowser, resetHostedBrowserForTests } from '../src/config/hosted-browser.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import { withEnv } from './helpers/env.ts';
import { fakeFetch } from './helpers/fake-cdp-socket.ts';

const ENV_KEY = 'bb_live_deployment_variable_key';
const STORED_KEY = 'bb_live_tenant_stored_key_0000';
const PLATFORM_KEY = 'bb_live_platform_key_000000000';
const HOSTED = scopeInstallationEnv(
  { CHICKPEA_TENANCY: 'installation', [BROWSER_ENV_VARS.apiKey]: ENV_KEY, [BROWSER_ENV_VARS.projectId]: 'proj-env' },
  { installationId: 'inst_gate_a' },
);
const POLICY = { enabled: true, monthlyBrowserHours: 10, maxRunningBrowsers: 2, sessionsPerMinute: 6 };

/** A tenant store holding its own Browserbase key, recording every key read. */
async function tenantStore(t: TestContext) {
  const store = new SqliteSettingsStore(':memory:');
  t.after(() => store.close());
  await store.setSetting(BROWSER_SETTING_KEYS.apiKey, STORED_KEY);
  await store.setSetting(BROWSER_SETTING_KEYS.projectId, 'proj-stored');
  const read: string[] = [];
  const spied: SettingsStore = {
    getSetting: async (key) => { read.push(key); return store.getSetting(key); },
    getSettings: async (keys) => { read.push(...keys); return store.getSettings(keys); },
    setSetting: (key, value) => store.setSetting(key, value),
    deleteSetting: (key) => store.deleteSetting(key),
    applySettingsPatch: (patch) => store.applySettingsPatch(patch),
    mergeSettingStringSet: (key, values) => store.mergeSettingStringSet(key, values),
  };
  return { store: spied, browserKeysRead: () => read.filter((key) => key.startsWith('browser.browserbase.')) };
}

function platform(t: TestContext, policy: typeof POLICY = POLICY) {
  resetHostedBrowserForTests();
  t.after(resetHostedBrowserForTests);
  configureHostedBrowser({ policy: () => policy, access: () => ({ apiKey: PLATFORM_KEY, projectId: 'proj-platform' }) });
}

/** Browserbase, answering whatever the wrapper asks; every call's key is recorded. */
function browserbase(t: TestContext) {
  const fake = fakeFetch(({ method, url }) => {
    const path = new URL(url).pathname;
    if (method === 'POST' && path === '/v1/sessions') {
      return Response.json({ id: 'sess_hosted', connectUrl: 'wss://connect.example/' });
    }
    if (method === 'GET' && path.startsWith('/v1/contexts/')) {
      return Response.json({ id: path.split('/').at(-1), projectId: 'proj-platform', name: 'chickpea.inst_gate_a.wl_x.00000000' });
    }
    return new Response(null, { status: 204 });
  });
  t.mock.method(globalThis, 'fetch', fake.fetchImpl);
  return { keys: () => fake.calls.map((call) => call.headers['X-BB-API-Key']), calls: fake.calls };
}

test('under tenancy the browser is offered only with the host port configured and its policy on, and no tenant key is read', async (t) => {
  const { store, browserKeysRead } = await tenantStore(t);
  resetHostedBrowserForTests();
  t.after(resetHostedBrowserForTests);
  assert.equal(await browserCapabilityForTurn(store, HOSTED), undefined, 'no port');
  platform(t, { ...POLICY, enabled: false });
  assert.equal(await browserCapabilityForTurn(store, HOSTED), undefined, 'policy off');
  platform(t);
  assert.deepEqual(await browserCapabilityForTurn(store, HOSTED), { provider: 'browserbase' });
  assert.deepEqual(browserKeysRead(), []);
  await withEnv({ CHICKPEA_TENANCY: undefined, [BROWSER_ENV_VARS.apiKey]: undefined }, async () => {
    assert.deepEqual(await browserCapabilityForTurn(store, {}), { provider: 'browserbase' }, 'standalone reads its stored key');
  });
  assert.ok(browserKeysRead().length > 0);
});

test('under tenancy every provider is the wrapper on the host key, never a deployment variable or a stored key', async (t) => {
  const { store, browserKeysRead } = await tenantStore(t);
  platform(t);
  const { keys, calls } = browserbase(t);

  const provider = await resolveBrowserProvider(store, HOSTED);
  await provider!.createSession({ timeoutSeconds: 120 });
  await queueContextDeletions(store, [{ contextId: 'ctx_queued', queuedAt: Date.now() }]);
  await maintainWebsiteLogins(HOSTED, store);

  assert.ok(calls.some(({ method, url }) => method === 'DELETE' && url.endsWith('/v1/contexts/ctx_queued')), 'the queue drained');
  assert.ok(keys().length > 0);
  assert.deepEqual([...new Set(keys())], [PLATFORM_KEY]);
  assert.deepEqual(browserKeysRead(), []);
});

test('under tenancy with no host port nothing falls back: the provider is refused and the queue stays', async (t) => {
  const { store, browserKeysRead } = await tenantStore(t);
  resetHostedBrowserForTests();
  const { calls } = browserbase(t);
  await assert.rejects(resolveBrowserProvider(store, HOSTED), (error: unknown) =>
    error instanceof HostedBrowserRefusal && error.message === HOSTED_BROWSER_UNAVAILABLE_MESSAGE);
  await queueContextDeletions(store, [{ contextId: 'ctx_kept', queuedAt: Date.now() }]);
  await assert.rejects(maintainWebsiteLogins(HOSTED, store), HostedBrowserRefusal);
  assert.match((await store.getSetting('browser.pendingContextDeletions'))!, /ctx_kept/);
  assert.deepEqual(calls, []);
  assert.deepEqual(browserKeysRead(), []);
});

test('only the standalone branch of resolveBrowserProvider and the hosted wrapper build a Browserbase client', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
  const builders = sources(root)
    .filter((file) => /createBrowserbaseProvider\b/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file))
    .sort();
  assert.deepEqual(builders, ['browser/browserbase.ts', 'browser/hosted-provider.ts', 'browser/settings.ts']);
  const settings = readFileSync(join(root, 'browser/settings.ts'), 'utf8');
  const resolver = settings.slice(settings.indexOf('export async function resolveBrowserProvider('));
  assert.ok(
    resolver.indexOf('deploymentServesManyInstallations(env)') < resolver.indexOf('resolveBrowserSettings('),
    'the tenancy branch returns before any setting is read',
  );
  const readers = sources(root)
    .filter((file) => /resolveBrowserSettings\(/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file))
    .sort();
  assert.deepEqual(readers, ['admin/routes.ts', 'browser/capability.ts', 'browser/settings.ts'],
    'Admin reads them only under /admin/api/browser, which is standalone-only');
});
