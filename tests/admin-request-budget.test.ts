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
import { identityError } from '../src/identity/errors.ts';
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
 * Durable Object round trip. `lacking` names identity operations this store
 * refuses, as an older Durable Object would.
 */
async function signedInAdmin(lacking: readonly string[] = []) {
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
  const older = new Proxy(identity, {
    get(store, property, receiver) {
      if (typeof property === 'string' && lacking.includes(property)) {
        return async () => {
          throw identityError('identity_operation_unsupported', `Unsupported identity operation: ${property}.`);
        };
      }
      return Reflect.get(store, property, receiver);
    },
  });
  const countedIdentity = counted<IdentityStore>(older, calls, 'identity');
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

function tally(calls: string[], include: (call: string) => boolean = () => true): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of calls.filter(include)) counts[call] = (counts[call] ?? 0) + 1;
  return counts;
}

const AUTHENTICATION = {
  // One read for the application's recovery gate, Admin's, Better Auth and authentication.
  'identity.getAuthControl': 1,
  // Binding, organization, user, membership and access overlay together.
  'identity.resolveBetterAuthPrincipal': 1,
  // The authentication and authorization success audits, deferred past the response.
  'identity.recordAuthAudit': 2,
};
const AUTHENTICATION_CALLS = new Set(Object.keys(AUTHENTICATION));

test('an Admin GET reads auth control once and the principal in one identity call', async () => {
  const admin = await signedInAdmin();
  try {
    // The most store calls each route may make, its handler's included.
    // Environment status answers 404 here, as it does on every hosted page load.
    for (const [path, status, budget] of [
      ['/admin/api/providers', 200, 10],
      ['/admin/api/slack-connection', 200, 6],
      ['/admin/api/environment/status', 404, 4],
    ] as const) {
      const { response, calls } = await admin.get(path);
      assert.equal(response.status, status, path);
      assert.deepEqual(tally(calls, (call) => call.startsWith('identity.')), AUTHENTICATION, path);
      // The application gate's read is inside the timing window Admin reports.
      assert.match(response.headers.get('server-timing') ?? '', /\bauthctl;dur=[\d.]+;desc="n=1"/, path);
      assert.ok(calls.length <= budget, `${path} made ${calls.length} store calls: ${calls.join(', ')}`);
    }
  } finally {
    admin.close();
  }
});

test('the Team page adds only its own rate limiting and roster reads to an Admin GET', async () => {
  const admin = await signedInAdmin();
  try {
    const { response, calls } = await admin.get('/admin/api/team');
    assert.equal(response.status, 200);
    assert.deepEqual(tally(calls, (call) => AUTHENTICATION_CALLS.has(call)), AUTHENTICATION);
    assert.deepEqual(tally(calls, (call) => /AuthRate/.test(call)), {
      'identity.getAuthRateLimit': 6,
      'identity.clearAuthRateLimit': 3,
    });
    assert.ok(calls.length <= 18, `/admin/api/team made ${calls.length} store calls: ${calls.join(', ')}`);
  } finally {
    admin.close();
  }
});

test("the application's recovery gate is the one Admin shares its auth control read with", () => {
  const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/auth\/request-auth-control\.ts'/);
  assert.doesNotMatch(source, /\.getAuthControl\s*\(/, 'the application reads auth control only through the shared gate');
});

test('an identity store without the principal operation leaves Admin unavailable, not denied', async () => {
  const admin = await signedInAdmin(['resolveBetterAuthPrincipal']);
  try {
    const { response, calls } = await admin.get('/admin/api/providers');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'authentication_unavailable' });
    assert.deepEqual(calls, ['identity.getAuthControl', 'identity.resolveBetterAuthPrincipal']);
  } finally {
    admin.close();
  }
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
