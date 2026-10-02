import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BetterAuthDatabaseBackend } from '../src/auth/better-auth-backend.ts';
import { D1BetterAuthBackend } from '../src/auth/better-auth-cloudflare.ts';
import {
  configureBetterAuthBackendFactory,
  resolveBetterAuthAccessRevoker,
  resolveBetterAuthBootstrapEnvironment,
  resolveBetterAuthEnvironment,
  withBetterAuthAccessRevoker,
  withBetterAuthBackend,
} from '../src/auth/better-auth-environment.ts';
import { installationScopeOf, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { AuthControl } from '../src/identity/types.ts';
import { withEnv } from './helpers/env.ts';

const ORIGIN = 'https://chickpea.example.com';
const AUTH_SECRET = 'A'.repeat(43);
const HOSTED = { CHICKPEA_TENANCY: 'installation', CHICKPEA_AUTH_SECRET: AUTH_SECRET };
// Only identity matters here: resolution hands the host's backend over without touching it.
const HOST_BACKEND = { database: {} } as unknown as BetterAuthDatabaseBackend;
const AUTH_DB = { prepare() { throw new Error('not queried'); } };
const ACTIVE_CONTROL = {
  authMode: 'slack_active',
  healthGate: 'normal',
  canonicalAdminOrigin: ORIGIN,
  betterAuthOrganizationId: 'organization-1',
} as AuthControl;

test('a host backend attached to the request env serves Better Auth there, scope or not', async () => {
  const env = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_a' });
  const attached = withBetterAuthBackend(env, HOST_BACKEND);
  assert.notEqual(attached, env);
  assert.ok(Object.isFrozen(attached));
  assert.deepEqual(installationScopeOf(attached), { installationId: 'inst_a' });
  // Scoping after attaching keeps the backend too.
  const scopedLater = scopeInstallationEnv(
    withBetterAuthBackend(HOSTED as Record<string, unknown>, HOST_BACKEND),
    { installationId: 'inst_a' },
  );
  for (const platformEnv of [attached, scopedLater]) {
    const environment = await resolveBetterAuthEnvironment({ control: ACTIVE_CONTROL, platformEnv });
    assert.equal(environment?.backend, HOST_BACKEND);
    assert.equal(environment?.baseURL, ORIGIN);
    assert.equal(environment?.secret, AUTH_SECRET);
  }
  // The env it was attached to is unchanged and still has none.
  assert.equal(await resolveBetterAuthEnvironment({ control: ACTIVE_CONTROL, platformEnv: env }), undefined);
  // Attaching the same backend again changes nothing; another one is refused.
  assert.equal(withBetterAuthBackend(attached, HOST_BACKEND), attached);
  const other = { database: {} } as unknown as BetterAuthDatabaseBackend;
  assert.throws(() => withBetterAuthBackend(attached, other), /already carries another Better Auth backend/);
  assert.throws(() => withBetterAuthBackend(scopedLater, other), /already carries another Better Auth backend/);
});

test('a deployment serving many installations never falls back to a deployment-wide auth database', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const standalone = await resolveBetterAuthBootstrapEnvironment({
    canonicalOrigin: ORIGIN,
    platformEnv: { AUTH_DB, CHICKPEA_AUTH_SECRET: AUTH_SECRET },
  });
  assert.ok(standalone?.backend instanceof D1BetterAuthBackend);
  assert.equal(await resolveBetterAuthBootstrapEnvironment({
    canonicalOrigin: ORIGIN,
    platformEnv: { ...HOSTED, AUTH_DB },
  }), undefined);
  const hosted = await resolveBetterAuthBootstrapEnvironment({
    canonicalOrigin: ORIGIN,
    platformEnv: withBetterAuthBackend({ ...HOSTED, AUTH_DB }, HOST_BACKEND),
  });
  assert.equal(hosted?.backend, HOST_BACKEND);
  assert.equal(hosted?.cloudflareEnv, undefined);
});

test('a host backend still needs the stable auth secret and an active control', async () => {
  const withoutSecret = withBetterAuthBackend({ CHICKPEA_TENANCY: 'installation' }, HOST_BACKEND);
  assert.equal(await resolveBetterAuthBootstrapEnvironment({ canonicalOrigin: ORIGIN, platformEnv: withoutSecret }), undefined);
  const env = withBetterAuthBackend(HOSTED, HOST_BACKEND);
  assert.equal(await resolveBetterAuthEnvironment({
    control: { ...ACTIVE_CONTROL, healthGate: 'recovery_only' } as AuthControl,
    platformEnv: env,
  }), undefined);
  await assert.rejects(
    resolveBetterAuthBootstrapEnvironment({
      canonicalOrigin: ORIGIN,
      platformEnv: withBetterAuthBackend({ CHICKPEA_AUTH_SECRET: 'short' }, HOST_BACKEND),
    }),
    /must encode exactly 32 random bytes/,
  );
});

test('a deactivation under installation tenancy is refused rather than leaving sessions behind', async () => {
  const hosted = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_a' });
  // Without the request's backend, revoking would silently skip sessions and MCP grants.
  await assert.rejects(
    resolveBetterAuthAccessRevoker({ control: ACTIVE_CONTROL, platformEnv: hosted }),
    /access cannot be revoked; nothing was changed/,
  );
  assert.equal(
    await resolveBetterAuthAccessRevoker({ control: ACTIVE_CONTROL, platformEnv: withBetterAuthBackend(hosted, HOST_BACKEND) }),
    HOST_BACKEND,
  );
  // Where Better Auth is not active there is nothing to revoke, hosted or not.
  for (const control of [undefined, { ...ACTIVE_CONTROL, healthGate: 'recovery_only' } as AuthControl,
    { ...ACTIVE_CONTROL, authMode: 'unconfigured' } as AuthControl]) {
    assert.equal(await resolveBetterAuthAccessRevoker({ control, platformEnv: hosted }), undefined);
  }
  // Standalone keeps today's optional path: no secret, no backend, no refusal.
  await withEnv({ CHICKPEA_AUTH_SECRET: undefined }, async () => {
    assert.equal(await resolveBetterAuthAccessRevoker({ control: ACTIVE_CONTROL, platformEnv: {} }), undefined);
  });
});

test('work no request carries gets the host factory\'s backend under tenancy, closed once it settles', async (t) => {
  t.after(() => configureBetterAuthBackendFactory(undefined));
  const alarmEnv = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_a' });
  const opened: Array<{ env: Record<string, unknown>; closed: number }> = [];
  configureBetterAuthBackendFactory((env) => {
    const record = { env, closed: 0 };
    opened.push(record);
    return Object.assign(Object.create(HOST_BACKEND) as BetterAuthDatabaseBackend, {
      close: async () => { record.closed += 1; },
    });
  });
  const seen: unknown[] = [];
  const result = await withBetterAuthAccessRevoker({ control: ACTIVE_CONTROL, platformEnv: alarmEnv }, async (revoker) => {
    seen.push(revoker);
    assert.equal(opened[0]?.closed, 0, 'open while the work runs');
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.env, alarmEnv, 'opened for the installation the work runs in');
  assert.equal(opened[0]!.closed, 1);
  assert.ok(Object.getPrototypeOf(seen[0]) === HOST_BACKEND, 'the work revokes through the opened backend');

  // Closed when the work fails too, and a failed close never masks the work's outcome.
  await assert.rejects(
    withBetterAuthAccessRevoker({ control: ACTIVE_CONTROL, platformEnv: alarmEnv }, async () => { throw new Error('work failed'); }),
    /work failed/,
  );
  assert.equal(opened[1]!.closed, 1);
  configureBetterAuthBackendFactory(() => Object.assign(Object.create(HOST_BACKEND) as BetterAuthDatabaseBackend, {
    close: async () => { throw new Error('close failed'); },
  }));
  const logged = t.mock.method(console, 'error', () => {});
  assert.equal(await withBetterAuthAccessRevoker({ control: ACTIVE_CONTROL, platformEnv: alarmEnv }, async () => 'kept'), 'kept');
  assert.match(String(logged.mock.calls[0]?.arguments.join(' ')), /Closing a Better Auth backend failed: close failed/);
});

test('the factory stands in only for a missing request backend on a deployment serving many installations', async (t) => {
  t.after(() => configureBetterAuthBackendFactory(undefined));
  let calls = 0;
  configureBetterAuthBackendFactory(() => {
    calls += 1;
    return undefined;
  });
  const hosted = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_a' });
  // A request's own backend is used as is.
  assert.equal(
    await withBetterAuthAccessRevoker({ control: ACTIVE_CONTROL, platformEnv: withBetterAuthBackend(hosted, HOST_BACKEND) },
      async (revoker) => revoker),
    HOST_BACKEND,
  );
  // Better Auth not active: nothing to revoke, nothing opened.
  assert.equal(await withBetterAuthAccessRevoker({
    control: { ...ACTIVE_CONTROL, healthGate: 'recovery_only' } as AuthControl, platformEnv: hosted,
  }, async (revoker) => revoker), undefined);
  // Standalone never asks the factory and keeps today's optional path.
  await withEnv({ CHICKPEA_AUTH_SECRET: undefined }, async () => {
    assert.equal(await withBetterAuthAccessRevoker({ control: ACTIVE_CONTROL, platformEnv: {} }, async (revoker) => revoker), undefined);
  });
  assert.equal(calls, 0);
  // A factory that cannot open one leaves the refusal in place.
  await assert.rejects(
    withBetterAuthAccessRevoker({ control: ACTIVE_CONTROL, platformEnv: hosted }, async () => 'changed'),
    /access cannot be revoked; nothing was changed/,
  );
  assert.equal(calls, 1);
  configureBetterAuthBackendFactory(undefined);
  await assert.rejects(
    withBetterAuthAccessRevoker({ control: ACTIVE_CONTROL, platformEnv: hosted }, async () => 'changed'),
    /access cannot be revoked; nothing was changed/,
  );
});
