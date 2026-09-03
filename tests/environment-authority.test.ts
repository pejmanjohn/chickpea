import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { environmentAuthorityResponse } from '../src/admin/environment-authority.ts';
import { createAdminRoutes } from '../src/admin/routes.ts';
import type { GatewayInstallationAuthority } from '../src/slack/gateway/installation-authority.ts';
import type { GatewaySessionStatusSnapshot } from '../src/slack/gateway/session-runner.ts';

const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const TOKEN = Buffer.alloc(32, 10).toString('base64url');
const VERSION = '11111111-2222-3333-4444-555555555555';
const fingerprint = (value: Buffer | string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function fixture() {
  const installation: GatewayInstallationAuthority = {
    protocolVersion: 1, kind: 'installation.status', requestId: 'request',
    binding: { bindingId: 'binding', deploymentId: 'deployment', workspaceId: 'TAMBER',
      appId: 'ASHARED', botUserId: 'UBOT', installedAt: NOW },
    grantedScopes: ['users:read', 'chat:write'], grantedUserScopes: ['usergroups:write'],
    health: 'needs_attention', observedAt: NOW,
  };
  const auth: Record<string, unknown> = { ok: true, team_id: 'TAMBER', user_id: 'UBOT' };
  const session: GatewaySessionStatusSnapshot = {
    healthy: true, phase: 'healthy', detail: null, generation: 2, versionId: VERSION,
  };
  const env: Record<string, unknown> = {
    CHICKPEA_ENV_TARGET: 'amber', CHICKPEA_ENV_AUTHORITY_READ_TOKEN: TOKEN,
    CF_VERSION_METADATA: { id: VERSION },
    CHICKPEA_AUTH_SECRET: Buffer.alloc(32, 1).toString('base64url'),
    CHICKPEA_RECOVERY_TOKEN: Buffer.alloc(32, 2).toString('base64url'),
    CHICKPEA_SETUP_CAPABILITY_DIGEST: Buffer.alloc(32, 3).toString('base64url'),
    CHICKPEA_CREDENTIAL_KEY_CURRENT_ID: 'current',
    CHICKPEA_CREDENTIAL_KEY_CURRENT: Buffer.alloc(32, 4).toString('base64url'),
  };
  const calls: string[] = [];
  const input = {
    authorization: `Bearer ${TOKEN}`, env, now: () => NOW,
    gateway: () => ({
      installationAuthority: async () => { calls.push('installation'); return installation; },
      call: async () => { calls.push('auth.test'); return auth; },
    }),
    session: async () => { calls.push('session'); return session; },
  };
  return { installation, auth, session, env, calls, input };
}

test('environment authority is disabled outside the fixed fleet and requires its separate token', async () => {
  for (const change of [
    { authorization: undefined }, { authorization: 'Bearer wrong' },
    { authorization: `Bearer ${'x'.repeat(43)}` },
    { env: {} }, { env: { ...fixture().env, CHICKPEA_ENV_TARGET: 'production' } },
    { env: { ...fixture().env, CHICKPEA_ENV_TARGET: 'fern' } },
  ]) {
    const f = fixture();
    const response = await environmentAuthorityResponse({ ...f.input, ...change });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(f.calls, []);
  }
  // Exercises the actual route; no Admin sign-in or setup capability bypasses it.
  const app = createAdminRoutes();
  assert.equal((await app.request('http://localhost/internal/environment/authority')).status, 404);
});

test('environment authority projects only actual bindings and fresh Slack/version identity', async () => {
  const f = fixture();
  const response = await environmentAuthorityResponse(f.input);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    schemaVersion: 'chickpea-environment-runtime-authority/v2', target: 'amber',
    observedAt: new Date(NOW).toISOString(),
    secretFingerprints: {
      schemaVersion: 'chickpea-environment-runtime-secret-fingerprints/v2',
      sourceBindings: {
        auth: 'CHICKPEA_AUTH_SECRET', cookie: 'CHICKPEA_AUTH_SECRET',
        signing: 'slack.gateway.deploymentIdentity.v1.deploymentId',
        recovery: 'CHICKPEA_RECOVERY_TOKEN', setup: 'CHICKPEA_SETUP_CAPABILITY_DIGEST',
        encryption: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID+CHICKPEA_CREDENTIAL_KEY_<ID>',
      },
      fingerprints: {
        auth: fingerprint(Buffer.alloc(32, 1)), cookie: fingerprint(Buffer.alloc(32, 1)),
        signing: fingerprint('deployment'), recovery: fingerprint(Buffer.alloc(32, 2)),
        setup: fingerprint(Buffer.alloc(32, 3)), encryption: fingerprint(Buffer.alloc(32, 4)),
      },
    },
    slack: { teamId: 'TAMBER', appId: 'ASHARED', botUserId: 'UBOT', replySenderId: 'UBOT',
      scopes: ['chat:write', 'users:read'] },
    transportAuthority: f.session,
  });
  assert.deepEqual(f.calls, ['installation', 'auth.test', 'session']);
});

test('environment authority fails closed without leaking diagnostics on any authority failure', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.installation.health = 'revoked'; },
    (f: ReturnType<typeof fixture>) => { f.auth.team_id = 'TOTHER'; },
    (f: ReturnType<typeof fixture>) => { f.auth.user_id = 'UOTHER'; },
    (f: ReturnType<typeof fixture>) => { f.auth.app_id = 'AOTHER'; },
    (f: ReturnType<typeof fixture>) => { f.auth.ok = false; },
    (f: ReturnType<typeof fixture>) => { f.session.versionId = 'old'; },
    (f: ReturnType<typeof fixture>) => { f.session.healthy = false; },
    (f: ReturnType<typeof fixture>) => { delete f.env.CF_VERSION_METADATA; },
    (f: ReturnType<typeof fixture>) => { f.env.CHICKPEA_AUTH_SECRET = 'private-invalid-value'; },
    (f: ReturnType<typeof fixture>) => { f.input.gateway = () => { throw new Error('private diagnostic'); }; },
  ]) {
    const f = fixture();
    mutate(f);
    const response = await environmentAuthorityResponse(f.input);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'environment_authority_unavailable' });
  }
});
