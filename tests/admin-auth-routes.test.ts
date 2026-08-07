import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { AuthSetupService } from '../src/auth/setup.ts';
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
