import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { activateInstallerOwner } from '../src/auth/installer-owner.ts';
import { recoveryOnlyGate, requestAuthControl } from '../src/auth/request-auth-control.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { AuthControl, IdentityStore } from '../src/identity/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const ORIGIN = 'https://admin.example';
const SECRET = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 11)).toString('base64url');

/** Records every store method called through `target`, by `prefix.method`. */
function counted<T extends object>(target: T, calls: string[], prefix: string): T {
  return new Proxy(target, {
    get(store, property, receiver) {
      const value = Reflect.get(store, property, receiver) as unknown;
      if (typeof value !== 'function' || property === 'close') return value;
      return (...args: unknown[]) => {
        calls.push(`${prefix}.${String(property)}`);
        return (value as (...input: unknown[]) => unknown).apply(store, args);
      };
    },
  });
}

/**
 * A signed-in Owner on the application's request path: its recovery gate,
 * then Admin. Every state-store call is counted; on Cloudflare each is a
 * Durable Object round trip.
 */
async function signedInAdmin() {
  const identity = new SqliteIdentityStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = { backend, baseURL: ORIGIN, secret: SECRET };
  const signedIn = await activateInstallerOwner({
    identity, environment,
    proof: { slackTeamId: 'TACME', slackUserId: 'UOWNER', displayName: 'Owner', eligibility: 'install_grant' },
    installGrant: { slackTeamId: 'TACME', installerSlackUserId: 'UOWNER' },
    capability: 'admin-request-budget-capability-0123456789',
    request: new Request(`${ORIGIN}/auth/slack/install/callback`),
  });
  const cookie = signedIn.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
  assert.match(cookie, /session_token/);
  const calls: string[] = [];
  const countedIdentity = counted<IdentityStore>(identity, calls, 'identity');
  const app = new Hono();
  app.use('*', recoveryOnlyGate(() => countedIdentity));
  app.route('/', createAdminRoutes({
    identity: countedIdentity,
    settings: counted(settings, calls, 'settings'),
    store: counted(config, calls, 'config'),
    betterAuthEnvironment: environment,
  }));
  // Each request's own calls, the deferred audit writes included.
  const get = async (path: string) => {
    calls.length = 0;
    const deferred: Promise<unknown>[] = [];
    const response = await app.request(`${ORIGIN}${path}`, { headers: { cookie } }, undefined, {
      waitUntil: (promise: Promise<unknown>) => { deferred.push(promise); },
      passThroughOnException() {},
      props: {},
    });
    await Promise.all(deferred);
    return { response, calls: [...calls] };
  };
  const close = () => {
    identity.close();
    settings.close();
    config.close();
    backend.close();
  };
  return { identity, get, close };
}

test('an Admin GET reads auth control once, for the application gate and Admin alike', async () => {
  const admin = await signedInAdmin();
  try {
    for (const path of ['/admin/api/providers', '/admin/api/team', '/admin/api/slack-connection']) {
      const { response, calls } = await admin.get(path);
      assert.equal(response.status, 200, path);
      assert.equal(calls.filter((call) => call === 'identity.getAuthControl').length, 1, path);
    }
  } finally {
    admin.close();
  }
});

test("the application's recovery gate is the one Admin shares its auth control read with", () => {
  const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  assert.match(source, /app\.use\('\*', recoveryOnlyGate\(/);
  assert.doesNotMatch(source, /getAuthControl\(\)/, 'no other auth control read on the request path');
});

test('recovery-only answers not found for an Admin request after one auth control read', async () => {
  const admin = await signedInAdmin();
  try {
    const control = (await admin.identity.getAuthControl())!;
    await admin.identity.updateAuthControl({ expectedRevision: control.revision, healthGate: 'recovery_only' });
    const { response, calls } = await admin.get('/admin/api/providers');
    assert.equal(response.status, 404);
    assert.deepEqual(calls, ['identity.getAuthControl']);
  } finally {
    admin.close();
  }
});

test('one request shares its auth control read; a failed read is retried, and each request reads again', async () => {
  const control = { authMode: 'slack_active', healthGate: 'normal' } as AuthControl;
  let reads = 0;
  let fail = true;
  const read = async () => {
    reads += 1;
    if (fail) {
      fail = false;
      throw new Error('store unavailable');
    }
    return control;
  };
  const app = new Hono();
  app.get('/', async (c) => {
    await assert.rejects(requestAuthControl(c, read), /store unavailable/);
    const [first, second] = await Promise.all([requestAuthControl(c, read), requestAuthControl(c, read)]);
    assert.equal(first, control);
    assert.equal(second, control);
    return c.json({ reads });
  });
  assert.deepEqual(await (await app.request('https://admin.example/')).json(), { reads: 2 });
  fail = true;
  reads = 0;
  assert.deepEqual(await (await app.request('https://admin.example/')).json(), { reads: 2 });
});
