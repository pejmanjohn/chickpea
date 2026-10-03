import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { createBetterAuth, type BetterAuthAdmissionOperation } from '../src/auth/better-auth.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

test('unconfigured admin is fail-closed and shared/deployment credentials are inert', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const app = createAdminRoutes({ identity });
    for (const headers of [
      {},
      { authorization: 'Bearer deployment-token' },
      { 'cf-access-jwt-assertion': 'edge-assertion' },
    ]) {
      const response = await app.request('https://app.example/admin', { headers });
      assert.equal(response.status, 503);
      assert.equal(response.headers.has('set-cookie'), false);
    }
  } finally {
    identity.close();
  }
});

test('recovery-only hides normal Admin and Slack actor handoff routes', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    await identity.ensureAuthControl({ healthGate: 'recovery_only' });
    const app = createAdminRoutes({ identity });
    for (const path of ['/admin', '/admin/api/agents', '/admin/slack-actor']) {
      assert.equal((await app.request(`https://app.example${path}`)).status, 404, path);
    }
  } finally {
    identity.close();
  }
});

test('Sign out ends the Better Auth session and lands on Slack sign-in; a cross-site post ends nothing', async () => {
  const origin = 'https://app.example';
  const secret = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => (index * 29 + 3) % 256)).toString('base64url');
  const backend = new NodeBetterAuthBackend(':memory:');
  const identity = new SqliteIdentityStore(':memory:');
  const store = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    let admission: BetterAuthAdmissionOperation | null = null;
    const auth = createBetterAuth({
      backend, baseURL: origin, secret,
      privateSeam: { async resolveAdmissionOperation() { return admission; } },
    });
    const reconciled = await auth.chickpea.reconcileSlackIdentity({
      slackTeamId: 'T12345678', slackUserId: 'U12345678', displayName: 'Owner',
      organization: { id: '11111111-1111-4111-8111-111111111111', name: 'Chickpea', slug: 'chickpea' },
    });
    const owner = await createSlackOwner(identity, {
      betterAuthUserId: reconciled.userId,
      betterAuthOrganizationId: reconciled.organizationId,
      betterAuthMembershipId: reconciled.membershipId,
    });
    const control = (await identity.getAuthControl())!;
    await identity.updateAuthControl({
      expectedRevision: control.revision, canonicalAdminOrigin: origin,
      betterAuthOrganizationId: reconciled.organizationId,
    });
    await identity.updateOrganizationAuth({
      organizationId: owner.membership.organizationId, authMode: 'slack_active', canonicalAdminOrigin: origin,
    });
    admission = {
      operationId: 'login_owner', status: 'active', chickpeaRole: 'owner',
      slackTeamId: 'T12345678', slackUserId: 'U12345678',
      betterAuthUserId: reconciled.userId,
      betterAuthOrganizationId: reconciled.organizationId,
      betterAuthMembershipId: reconciled.membershipId,
    };
    const issued = await auth.chickpea.issueSession(admission.operationId, new Request(`${origin}/oauth/finalize`, {
      method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin' },
    }));
    const cookie = (issued.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    assert.ok(cookie);
    const app = createAdminRoutes({
      store, settings, identity, betterAuthEnvironment: { backend, baseURL: origin, secret },
    });
    const signedIn = async () => (await app.request(`${origin}/admin/api/agents`, { headers: { cookie } })).status;
    const signOut = (headers: Record<string, string>) => app.request(`${origin}/admin/logout`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: '',
    });
    assert.equal(await signedIn(), 200);

    const crossSite = await signOut({ origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    assert.equal(await signedIn(), 200, 'a cross-site post leaves the session alone');

    const signedOut = await signOut({ origin, 'sec-fetch-site': 'same-origin' });
    assert.equal(signedOut.status, 303);
    assert.equal(signedOut.headers.get('location'), '/auth/slack/sign-in?destination=%2Fadmin');
    assert.match(signedOut.headers.getSetCookie().join('\n'), /session_token=;[^\n]*Max-Age=0/i);
    assert.equal(await signedIn(), 401, 'the old cookie no longer signs anyone in');
    const page = await app.request(`${origin}/admin`, { headers: { cookie } });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/auth/slack/sign-in?destination=%2Fadmin');
    // Sign out again from a tab whose session already ended: sign-in, not a JSON error.
    const again = await signOut({ origin, 'sec-fetch-site': 'same-origin' });
    assert.equal(again.status, 303);
    assert.equal(again.headers.get('location'), '/auth/slack/sign-in?destination=%2Fadmin');
  } finally {
    settings.close();
    store.close();
    identity.close();
    backend.close();
  }
});
