import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { BetterAuthDatabaseBackend } from '../src/auth/better-auth-backend.ts';
import { D1BetterAuthBackend } from '../src/auth/better-auth-cloudflare.ts';
import {
  resolveBetterAuthAccessRevoker,
  resolveBetterAuthBootstrapEnvironment,
  resolveBetterAuthEnvironment,
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

function onCloudflare(t: TestContext): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
}

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
});

test('a deployment serving many installations never falls back to a deployment-wide auth database', async (t) => {
  onCloudflare(t);
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
