import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { AuthSetupService } from '../src/auth/setup.ts';
import { createBetterAuth } from '../src/auth/better-auth.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { digest } from '../src/auth/personal-token.ts';
import { nativePasswordPrimitive } from '../src/auth/password.ts';
import type { ExternalIdentity } from '../src/auth/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const RECOVERY = 'recovery-token-with-more-than-thirty-two-characters';
const ISSUER = 'https://example.cloudflareaccess.com';
const AUDIENCE = 'a'.repeat(64);
const ORIGIN = 'https://app.example';
const OWNER: ExternalIdentity = {
  kind: 'external_identity',
  provider: 'cloudflare_access',
  issuer: ISSUER,
  subject: 'owner-subject',
  verifiedEmail: 'owner@example.com',
  credentialId: 'access_assertion',
};

function formRequest(path: string, values: Record<string, string>, origin = ORIGIN): Request {
  const body = new URLSearchParams(values).toString();
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(new TextEncoder().encode(body).byteLength),
      'sec-fetch-site': 'same-origin',
      'cf-connecting-ip': '203.0.113.10',
    },
    body,
  });
}

function originlessSameOriginFormRequest(path: string, values: Record<string, string>): Request {
  const body = new URLSearchParams(values).toString();
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(new TextEncoder().encode(body).byteLength),
      'sec-fetch-site': 'same-origin',
      'cf-connecting-ip': '203.0.113.10',
    },
    body,
  });
}

test('public setup accepts recovery proof only in a capped body then activates through Access', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const app = createAdminRoutes({
    identity,
    recoveryToken: RECOVERY,
    verifyAccessAssertion: async (_request, _config, purpose) => {
      assert.equal(purpose, 'activation');
      return OWNER;
    },
  });

  const setupPage = await app.request(`${ORIGIN}/admin/setup`);
  assert.equal(setupPage.status, 200);
  assert.doesNotMatch(await setupPage.text(), new RegExp(RECOVERY));

  const wrong = await app.request(formRequest('/admin/setup', {
    ownerEmail: OWNER.verifiedEmail,
    recoveryToken: 'wrong',
    issuer: ISSUER,
    audience: AUDIENCE,
  }));
  assert.equal(wrong.status, 401);
  assert.equal(await identity.getOrganization(), undefined);

  const configured = await app.request(formRequest('/admin/setup', {
    ownerEmail: OWNER.verifiedEmail,
    recoveryToken: RECOVERY,
    issuer: ISSUER,
    audience: AUDIENCE,
  }));
  assert.equal(configured.status, 303);
  assert.equal(configured.headers.get('location'), '/admin/setup/verify');
  assert.equal((await identity.getOrganization())?.authMode, 'access_pending');

  const activated = await app.request(`${ORIGIN}/admin/setup/verify`);
  assert.equal(activated.status, 303);
  assert.equal(activated.headers.get('location'), '/admin/ready');
  assert.equal((await identity.getOrganization())?.authMode, 'access_active');
  assert.equal((await identity.listMemberships())[0]?.role, 'owner');

  const ready = await app.request(`${ORIGIN}/admin/ready`);
  assert.equal(ready.status, 401);

  const replay = await app.request(`${ORIGIN}/admin/setup`);
  assert.equal(replay.status, 303);
  assert.equal(replay.headers.get('location'), '/admin');
  identity.close();
});

test('setup stays hidden without recovery configuration and caps unauthenticated bodies', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  assert.equal((await createAdminRoutes({ identity }).request(`${ORIGIN}/admin/setup`)).status, 404);
  assert.equal((await createAdminRoutes({ identity, recoveryToken: 'too-short' })
    .request(`${ORIGIN}/admin/setup`)).status, 503);

  const app = createAdminRoutes({ identity, recoveryToken: RECOVERY });
  const body = `ownerEmail=${'a'.repeat(9_000)}`;
  const oversized = await app.request(new Request(`${ORIGIN}/admin/setup`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(body.length),
    },
    body,
  }));
  assert.equal(oversized.status, 413);
  assert.equal(await identity.getOrganization(), undefined);
  identity.close();
});

test('Access-protected setup accepts an originless same-origin form but no weaker fallback', async () => {
  const values = {
    ownerEmail: OWNER.verifiedEmail,
    recoveryToken: RECOVERY,
    issuer: ISSUER,
    audience: AUDIENCE,
  };
  const acceptedIdentity = new SqliteIdentityStore(':memory:');
  const accepted = createAdminRoutes({ identity: acceptedIdentity, recoveryToken: RECOVERY });
  assert.equal((await accepted.request(originlessSameOriginFormRequest('/admin/setup', values))).status, 303);
  assert.equal((await acceptedIdentity.getOrganization())?.authMode, 'access_pending');
  acceptedIdentity.close();

  for (const fetchSite of ['same-site', 'cross-site', undefined]) {
    const identity = new SqliteIdentityStore(':memory:');
    const app = createAdminRoutes({ identity, recoveryToken: RECOVERY });
    const body = new URLSearchParams(values).toString();
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(new TextEncoder().encode(body).byteLength),
    };
    if (fetchSite) headers['sec-fetch-site'] = fetchSite;
    const denied = await app.request(new Request(`${ORIGIN}/admin/setup`, {
      method: 'POST', headers, body,
    }));
    assert.equal(denied.status, 401);
    assert.equal(await identity.getOrganization(), undefined);
    identity.close();
  }
});

test('recovery requires issuer-backed owner proof, same-origin body, and the offline credential', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const setup = new AuthSetupService(identity, { recoveryToken: RECOVERY });
  await setup.beginAccessSetup({ recoveryToken: RECOVERY, ownerEmail: OWNER.verifiedEmail });
  await setup.configureAccess({
    recoveryToken: RECOVERY,
    issuer: ISSUER,
    audience: AUDIENCE,
    canonicalAdminOrigin: ORIGIN,
  });
  await setup.activateAccess(OWNER);
  const app = createAdminRoutes({
    identity,
    recoveryToken: RECOVERY,
    verifyAccessAssertion: async (_request, _config, purpose) => {
      assert.equal(purpose, 'recovery');
      return OWNER;
    },
  });

  assert.equal((await app.request(`${ORIGIN}/admin/recovery`)).status, 200);
  const denied = await app.request(formRequest('/admin/recovery', {
    operation: 'audience',
    recoveryToken: RECOVERY,
    audience: 'b'.repeat(64),
  }, 'https://evil.example'));
  assert.equal(denied.status, 401);
  assert.equal((await identity.getAuthProviderConfig('cloudflare_access'))?.audience, AUDIENCE);

  const repaired = await app.request(formRequest('/admin/recovery', {
    operation: 'audience',
    recoveryToken: RECOVERY,
    audience: 'b'.repeat(64),
  }));
  assert.equal(repaired.status, 303);
  assert.equal((await identity.getAuthProviderConfig('cloudflare_access'))?.audience, 'b'.repeat(64));
  identity.close();
});

test('password-mode admin requests use Better Auth sessions without legacy fallback', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  const password = nativePasswordPrimitive();
  const secret = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1))
    .toString('base64url');
  const privateAuth = createBetterAuth({
    backend,
    baseURL: ORIGIN,
    secret,
    password,
    allowSignUp: true,
  });
  const signup = await privateAuth.handler(jsonRequest('/api/auth/sign-up/email', {
    email: 'owner@example.com', name: 'Owner', password: 'several unrelated words 5729',
  }));
  assert.equal(signup.status, 200, await signup.clone().text());
  const body = await signup.json() as { user: { id: string } };
  backend.database.prepare(
    'INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)',
  ).run('better-org', 'Chickpea', 'chickpea', Date.now());
  backend.database.prepare(
    'INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)',
  ).run('better-member', 'better-org', body.user.id, 'owner', Date.now());
  const control = await identity.ensureAuthControl();
  await identity.updateAuthControl({
    expectedRevision: control.revision,
    authMode: 'password_active',
    canonicalAdminOrigin: ORIGIN,
    betterAuthOrganizationId: 'better-org',
  });
  const app = createAdminRoutes({
    identity,
    recoveryToken: RECOVERY,
    betterAuthEnvironment: {
      backend,
      baseURL: ORIGIN,
      secret,
      password,
      recoveryToken: RECOVERY,
    },
  });
  const cookie = (signup.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';

  const account = await app.request(`${ORIGIN}/admin/account`, { headers: { cookie } });
  assert.equal(account.status, 200, await account.clone().text());
  assert.match(await account.text(), /owner@example\.com/);
  assert.equal((await app.request(`${ORIGIN}/admin/account`)).status, 401);

  const team = await app.request(`${ORIGIN}/admin/api/team`, { headers: { cookie } });
  assert.equal(team.status, 200, await team.clone().text());
  assert.match(await team.text(), /better-member/);

  const crossOrigin = await app.request(`${ORIGIN}/admin/api/team/invitations`, {
    method: 'POST',
    headers: {
      cookie,
      origin: 'https://attacker.example',
      'content-type': 'application/json',
      'sec-fetch-site': 'cross-site',
    },
    body: JSON.stringify({ email: 'member@example.com', role: 'member' }),
  });
  assert.equal(crossOrigin.status, 403);

  const pat = 'chp_pat_abcdefghijkl_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';
  await identity.createPersonalToken({
    userId: body.user.id,
    membershipId: 'better-member',
    organizationId: 'better-org',
    tokenHash: digest(pat),
    prefix: 'abcdefghijkl',
    label: 'Automation',
  });
  const machineTeam = await app.request(`${ORIGIN}/admin/api/team`, {
    headers: { authorization: `Bearer ${pat}` },
  });
  assert.equal(machineTeam.status, 403);
  backend.close();
  identity.close();
});

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  const encoded = JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(encoded)),
      'sec-fetch-site': 'same-origin',
    },
    body: encoded,
  });
}
