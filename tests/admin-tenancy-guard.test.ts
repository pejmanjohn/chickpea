import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import app from '../src/app.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { SLACK_RECOVERY_CALLBACK_PATH } from '../src/slack/app-manifest.ts';

const ORIGIN = 'https://hosted.example';
const HOSTED = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_guard' });

// Every standalone-only surface, by the method that reaches its handler.
const GUARDED: Array<[string, string]> = [
  ['GET', '/admin/setup'], ['POST', '/admin/setup'], ['GET', '/admin/setup/client.js'],
  ['GET', '/admin/setup/gateway-continue.js'], ['GET', '/admin/setup/manual'], ['POST', '/admin/setup/manual'],
  ['GET', '/admin/recovery'], ['POST', '/admin/recovery'],
  ['GET', '/admin/slack-gateway/refresh'], ['POST', '/admin/slack-gateway/refresh'],
  ['POST', '/admin/slack-gateway/reconnect'], ['GET', '/admin/slack-gateway/refresh/finish'],
  ['GET', '/auth/slack/sign-in'], ['GET', '/auth/slack/continue.js'], ['POST', '/auth/slack/oidc/start'],
  ['GET', '/auth/slack/oidc/callback'], ['POST', '/auth/slack/install/start'], ['GET', '/auth/slack/install/callback'],
  ['GET', '/auth/slack/invite'], ['GET', SLACK_RECOVERY_CALLBACK_PATH],
  ['POST', '/internal/deployment/ready'], ['POST', '/internal/deployment/recover-delivery'],
  ['GET', '/internal/environment/authority'], ['GET', '/internal/environment/models'], ['POST', '/internal/environment/seed'],
  ['GET', '/admin/api/chickpea-cutover/preflight'], ['POST', '/admin/api/chickpea-cutover/activate'],
  ['POST', '/auth/chatgpt-plan/handoff'], ['DELETE', '/admin/api/slack-connection'],
];

/** Stores that fail any read, so a response proves where the request stopped. */
function untouchable<T extends object>(): T {
  return new Proxy({} as T, { get(_target, property) {
    if (property === 'then') return undefined;
    throw new Error(`store read: ${String(property)}`);
  } });
}

function adminWith(stores: { identity: IdentityStore; store: SqliteConfigStore; settings: SqliteSettingsStore }) {
  return createAdminRoutes(stores);
}

test('under installation tenancy every standalone-only surface is not found, before any store is read', async () => {
  const routes = createAdminRoutes({ identity: untouchable(), store: untouchable(), settings: untouchable() });
  const variants = (path: string) => [
    path,
    path.replace(/\/admin\/(s|r)/, (_match, letter: string) => `/admin/%${letter.charCodeAt(0).toString(16)}`),
    path.replace('/admin/', '/admin//'),
    `${path}/`,
  ];
  for (const [method, path] of GUARDED) {
    for (const variant of new Set(variants(path))) {
      const response = await routes.request(`${ORIGIN}${variant}`, { method }, HOSTED);
      assert.equal(response.status, 404, `${method} ${variant}`);
      assert.equal(await response.text(), '404 Not Found', `${method} ${variant}`);
    }
  }
  // Everything else gets past the guard (here, to a store read that fails): reading
  // the Slack connection, Admin's pages and APIs.
  for (const [method, path] of [['GET', '/admin/api/slack-connection'], ['GET', '/admin/agents'], ['GET', '/admin/api/team']] as const) {
    assert.equal((await routes.request(`${ORIGIN}${path}`, { method }, HOSTED)).status, 500, `${method} ${path}`);
  }
});

test('on standalone the same surfaces reach their handlers exactly as before', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const store = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const routes = adminWith({ identity, store, settings });
    // What a fresh standalone Admin answers today, guard or not.
    const expected: Record<string, [number, string]> = {
      'GET /admin/setup/client.js': [200, '(function () {'],
      'GET /admin/setup/gateway-continue.js': [200, '(function () {'],
      'GET /auth/slack/continue.js': [200, '(function () {'],
      'GET /admin/slack-gateway/refresh': [503, '{"error":"authentication_unavailable"}'],
      'POST /admin/slack-gateway/refresh': [503, '{"error":"authentication_unavailable"}'],
      'POST /admin/slack-gateway/reconnect': [503, '{"error":"authentication_unavailable"}'],
      'GET /admin/slack-gateway/refresh/finish': [503, '{"error":"authentication_unavailable"}'],
      'GET /admin/api/chickpea-cutover/preflight': [503, '{"error":"authentication_unavailable"}'],
      'POST /admin/api/chickpea-cutover/activate': [503, '{"error":"authentication_unavailable"}'],
      'DELETE /admin/api/slack-connection': [503, '{"error":"authentication_unavailable"}'],
      'GET /internal/environment/authority': [404, '{}'],
      'GET /internal/environment/models': [404, '{}'],
      'POST /internal/environment/seed': [404, '{}'],
    };
    for (const [method, path] of GUARDED) {
      const response = await routes.request(`http://localhost${path}`, { method });
      const [status, body] = expected[`${method} ${path}`] ?? [404, '404 Not Found'];
      assert.equal(response.status, status, `${method} ${path}`);
      assert.ok((await response.text()).startsWith(body), `${method} ${path}`);
    }
    // The rest answer 404 on a fresh standalone install too, but from their own
    // handlers: with a store that fails every read, standalone gets past the guard.
    const failing = createAdminRoutes({ identity: untouchable(), store: untouchable(), settings: untouchable() });
    for (const path of ['/admin/setup', '/admin/recovery', '/auth/slack/sign-in', '/auth/slack/oidc/callback']) {
      assert.equal((await failing.request(`http://localhost${path}`)).status, 500, path);
    }
  } finally {
    identity.close();
    store.close();
    settings.close();
  }
});

test('no installation of a deployment serving many takes gateway deliveries', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const deliveries: unknown[] = [];
  const TAG_STATE = { getByName: () => ({ receiveGatewayHttp: async (input: unknown) => { deliveries.push(input); return { status: 200, body: {} }; } }) };
  const request = (env: Record<string, unknown>) => app.request(`${ORIGIN}/slack/gateway/delivery`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }, env);
  const hosted = await request(scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation', TAG_STATE }, { installationId: 'inst_guard' }));
  assert.equal(hosted.status, 404);
  assert.equal(deliveries.length, 0, 'nothing reached the state store');
});
