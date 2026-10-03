import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test, type TestContext } from 'node:test';

import { Hono } from 'hono';
import pg from 'pg';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { mapBetterAuthMembership, type BetterAuthMembershipRecord } from '../src/auth/better-auth-backend.ts';
import { withBetterAuthBackend } from '../src/auth/better-auth-environment.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { openPostgresBetterAuthBackend } from '../src/auth/better-auth-postgres.ts';
import { applyPostgresBetterAuthMigrations } from '../src/auth/better-auth-postgres-migrations.ts';
import { hostedLoginFence } from '../src/auth/hosted-login.ts';
import { routeHostedRequest, type HostedLoginRead, type HostedRouting } from '../src/auth/hosted-routing.ts';
import { activateInstallerOwner } from '../src/auth/installer-owner.ts';
import { recoveryOnlyGate, requestAuthControl } from '../src/auth/request-auth-control.ts';
import { resolveInstallationEnv } from '../src/config/installation-lookup.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { identityError } from '../src/identity/errors.ts';
import type { AuthControl, IdentityStore } from '../src/identity/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { startPostgresTestCluster, type PostgresTestClusterStart } from './helpers/postgres-cluster.ts';

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

// Skipped only when CHICKPEA_TEST_POSTGRES_BIN is set empty; a missing server fails.
let postgres: Promise<PostgresTestClusterStart> | undefined;
const cluster = () => postgres ??= startPostgresTestCluster();
after(async () => (await postgres?.catch(() => undefined))?.cluster?.stop());

const HOSTED_ORIGIN = 'https://hosted.example';
const HOSTED = { CHICKPEA_TENANCY: 'installation', CHICKPEA_AUTH_SECRET: SECRET } as PlatformEnv;

/** What a host reads for a user in its one statement, from Better Auth's tables. */
async function readLoginInOneStatement(pool: pg.Pool, betterAuthUserId: string): Promise<HostedLoginRead> {
  const { rows } = await pool.query<{ accountId: string; memberships: unknown[] }>(
    `SELECT a."accountId",
       (SELECT coalesce(json_agg(json_build_object('id', m.id, 'organizationId', m."organizationId",
          'userId', m."userId", 'role', m.role, 'createdAt', m."createdAt")), '[]'::json)
          FROM member AS m WHERE m."userId" = a."userId") AS memberships
     FROM account AS a WHERE a."userId" = $1 AND a."providerId" = 'slack'`,
    [betterAuthUserId],
  );
  return {
    slackAccountIds: rows.map((row) => row.accountId),
    memberships: (rows[0]?.memberships ?? []).map(mapBetterAuthMembership)
      .filter((row): row is BetterAuthMembershipRecord => row !== null),
  };
}

/**
 * A signed-in Owner of one installation on a host serving many: the host's
 * routing on a PostgreSQL Better Auth, then the application's recovery gate
 * and Admin with the env routing returned. Every PostgreSQL statement and
 * every state-store call is counted; on Cloudflare each statement is a round
 * trip to the database, and each store call one to the Durable Object.
 */
async function hostedSignedInAdmin(t: TestContext, options: { hostReadsLogin: boolean }) {
  const running = await cluster();
  if (!running.cluster) {
    t.skip(running.skip);
    return undefined;
  }
  const created = await running.cluster.createDatabase();
  const config = { ...running.cluster.connection, database: created.name };
  const migrator = new pg.Pool({ ...config, max: 1 });
  try {
    await applyPostgresBetterAuthMigrations(migrator);
  } finally {
    await migrator.end();
  }
  const backend = openPostgresBetterAuthBackend(config);
  const environment = { backend, baseURL: HOSTED_ORIGIN, secret: SECRET };
  const installation = { organizationId: 'org_acme', installationId: 'inst_acme' };
  const identity = new SqliteIdentityStore(':memory:', { installation: () => installation });
  const settings = new SqliteSettingsStore(':memory:');
  const config_ = new SqliteConfigStore(':memory:', { agents: [] });
  t.after(async () => {
    identity.close();
    settings.close();
    config_.close();
    await backend.close();
    await created.drop();
  });
  const signedIn = await activateInstallerOwner({
    identity, environment,
    proof: { slackTeamId: 'TACME', slackUserId: 'UOWNER', displayName: 'Owner', eligibility: 'install_grant' },
    installGrant: { slackTeamId: 'TACME', installerSlackUserId: 'UOWNER' },
    capability: 'admin-request-budget-hosted-capability-0123',
    request: new Request(`${HOSTED_ORIGIN}/start/install/callback`),
  });
  const cookie = signedIn.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
  assert.match(cookie, /session_token/);

  const calls: string[] = [];
  const statements: string[] = [];
  const countedIdentity = counted<IdentityStore>(identity, calls, 'identity');
  const routing: HostedRouting<PlatformEnv> = {
    environment,
    installationEnv: (login) => resolveInstallationEnv({
      async find() { return { identity: installation, slackTeamId: 'TACME', status: 'active' }; },
      async listActive() { return []; },
    }, withBetterAuthBackend(HOSTED, backend), { slackTeamId: login.slackTeamId }),
    identity: () => countedIdentity,
    ...(options.hostReadsLogin ? { readLogin: (userId: string) => readLoginInOneStatement(backend.pool as pg.Pool, userId) } : {}),
  };
  const app = new Hono();
  app.use('*', recoveryOnlyGate(() => countedIdentity));
  app.route('/', createAdminRoutes({
    identity: countedIdentity,
    settings: counted(settings, calls, 'settings'),
    store: counted(config_, calls, 'config'),
  }));
  const query = pg.Client.prototype.query;
  t.mock.method(pg.Client.prototype, 'query', function (this: pg.Client, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
    statements.push(String(text).replace(/\s+/g, ' ').trim());
    return (query as (...input: unknown[]) => unknown).apply(this, args);
  });
  // One request as the host serves it, the deferred audit writes included.
  const get = async (path: string, requestCookie = cookie) => {
    calls.length = 0;
    statements.length = 0;
    const request = new Request(`${HOSTED_ORIGIN}${path}`, { headers: { cookie: requestCookie } });
    const routed = await routeHostedRequest(request, routing);
    assert.equal(routed.kind, 'installation', path);
    if (routed.kind !== 'installation') throw new Error('not routed');
    const routingStatements = statements.length;
    const deferred: Promise<unknown>[] = [];
    const response = await app.fetch(request, routed.env, {
      waitUntil: (promise: Promise<unknown>) => { deferred.push(promise); },
      passThroughOnException() {},
      props: {},
    });
    await Promise.all(deferred);
    return { response, routed, calls: [...calls], statements: [...statements], routingStatements };
  };
  return { get, backend, identity, cookie };
}

const HOSTED_AUTHENTICATION = {
  // Routing reads the principal while it checks the binding; Admin reads nothing more of it.
  'identity.resolveBetterAuthPrincipal': 1,
  'identity.getAuthControl': 1,
  'identity.recordAuthAudit': 2,
};

test('a hosted Admin GET reads the session once, in one statement, and the login in one host statement', { timeout: 120_000 }, async (t) => {
  const admin = await hostedSignedInAdmin(t, { hostReadsLogin: true });
  if (!admin) return;
  // Every store call each route makes, routing's and its handler's included: the
  // same as standalone Admin's, since routing's principal read is the only one.
  for (const [path, status, storeCalls] of [
    ['/admin/api/providers', 200, 8],
    ['/admin/api/slack-connection', 200, 6],
    ['/admin/api/environment/status', 404, 4],
  ] as const) {
    const { response, calls, statements, routingStatements } = await admin.get(path);
    assert.equal(response.status, status, path);
    assert.equal(calls.length, storeCalls, `${path}: ${calls.join(', ')}`);
    assert.equal(calls[0], 'identity.resolveBetterAuthPrincipal', `${path}: routing's read comes first`);
    // Better Auth's session with its user (a native join), then the host's read of the login's
    // accounts and memberships. Core's Admin adds no statement of its own.
    assert.equal(statements.length, 2, `${path}: ${statements.join(' | ')}`);
    assert.match(statements[0]!, /from "session" .*left join "user"/i, path);
    assert.match(statements[1]!, /FROM account AS a/, path);
    assert.equal(routingStatements, 2, `${path}: every statement is routing's`);
    assert.deepEqual(tally(calls, (call) => call.startsWith('identity.')), HOSTED_AUTHENTICATION, path);
  }
});

test('without a host read of the login, a hosted Admin GET still reads the session only once', { timeout: 120_000 }, async (t) => {
  const admin = await hostedSignedInAdmin(t, { hostReadsLogin: false });
  if (!admin) return;
  const { response, calls, statements } = await admin.get('/admin/api/providers');
  assert.equal(response.status, 200);
  // The session with its user; Better Auth's account read; the directory's membership read.
  assert.equal(statements.length, 3, statements.join(' | '));
  assert.equal(statements.filter((statement) => /from "session"/i.test(statement)).length, 1);
  assert.match(statements[2]!, /FROM member WHERE "userId" = \$1 AND "organizationId" = \$2/);
  assert.deepEqual(tally(calls, (call) => call.startsWith('identity.')), HOSTED_AUTHENTICATION);
});

test('a hosted session due for refresh is refreshed in routing, and Admin sets its cookie', { timeout: 120_000 }, async (t) => {
  const admin = await hostedSignedInAdmin(t, { hostReadsLogin: true });
  if (!admin) return;
  // Last refreshed two days ago: due (updateAge is one day).
  await admin.backend.pool.query(`UPDATE session SET "expiresAt" = now() + interval '5 days', "updatedAt" = now() - interval '2 days'`);
  const { response, routed, statements } = await admin.get('/admin/api/providers');
  assert.equal(response.status, 200);
  const refreshed = response.headers.getSetCookie().find((value) => value.includes('session_token='));
  assert.ok(refreshed, 'the refreshed session cookie reaches the browser');
  assert.match(refreshed, /Max-Age=604800/);
  assert.equal(statements.filter((statement) => /^update "session"/i.test(statement)).length, 1, statements.join(' | '));
  assert.equal(statements.filter((statement) => /from "session"/i.test(statement)).length, 1, 'the one read of the session');
  if (routed.kind !== 'installation') return;
  assert.deepEqual(hostedLoginFence(routed.env)?.routed?.session?.setCookies, [refreshed]);
  const { rows: [session] } = await admin.backend.pool.query<{ fresh: boolean }>(
    `SELECT "expiresAt" > now() + interval '6 days' AS fresh FROM session`);
  assert.equal(session?.fresh, true);
  // Refreshed once: the next request finds nothing to refresh.
  const next = await admin.get('/admin/api/providers');
  assert.equal(next.response.headers.getSetCookie().length, 0);
  assert.equal(next.statements.length, 2);
});

test('a routed session serves only a request presenting the same cookie', { timeout: 120_000 }, async (t) => {
  const admin = await hostedSignedInAdmin(t, { hostReadsLogin: true });
  if (!admin) return;
  const { routed } = await admin.get('/admin/api/providers');
  if (routed.kind !== 'installation') return;
  // The routed env reused for a request without the cookie authenticates nobody.
  const app = new Hono();
  const identity = admin.identity;
  app.route('/', createAdminRoutes({
    identity,
    settings: new SqliteSettingsStore(':memory:'),
    store: new SqliteConfigStore(':memory:', { agents: [] }),
  }));
  const bare = await app.fetch(new Request(`${HOSTED_ORIGIN}/admin/api/providers`), routed.env);
  assert.equal(bare.status, 401);
  const forged = await app.fetch(new Request(`${HOSTED_ORIGIN}/admin/api/providers`, {
    headers: { cookie: `${admin.cookie.split('=')[0]}=${randomBytes(24).toString('base64url')}` },
  }), routed.env);
  assert.equal(forged.status, 401);
  const same = await app.fetch(new Request(`${HOSTED_ORIGIN}/admin/api/providers`, { headers: { cookie: admin.cookie } }), routed.env);
  assert.equal(same.status, 200);
});
