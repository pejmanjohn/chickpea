import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { PersonalTokenService } from '../src/auth/personal-token.ts';
import type { ExternalIdentity } from '../src/auth/types.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { withEnv } from './helpers/env.ts';

const LEGACY = 'legacy-shared-admin-token';
const RECOVERY = 'recovery-token-with-more-than-thirty-two-characters';
const ORIGIN = 'https://app.example';
const ISSUER = 'https://paperplanelabs.cloudflareaccess.com';
const OWNER: ExternalIdentity = {
  kind: 'external_identity', provider: 'cloudflare_access', issuer: ISSUER,
  subject: 'owner-subject', verifiedEmail: 'owner@example.com', credentialId: 'assertion',
};

function form(path: string, values: Record<string, string>, cookie?: string): Request {
  const body = new URLSearchParams(values).toString();
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(body.length),
      'sec-fetch-site': 'same-origin',
      ...(cookie ? { cookie } : {}),
    },
    body,
  });
}

test('legacy Admin migration remains retryable until Access activation then cuts off the shared token', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const app = createAdminRoutes({
    identity,
    store: config,
    recoveryToken: RECOVERY,
    verifyAccessAssertion: async () => OWNER,
  });

  await withEnv({ TAG_ADMIN_TOKEN: LEGACY }, async () => {
    const login = await app.request(form('/admin/login', {
      token: LEGACY,
      returnTo: '/admin',
    }));
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/admin/migrate');
    const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
    assert.match(cookie, /^flue_admin=/);
    assert.equal((await app.request(`${ORIGIN}/admin/migrate`, { headers: { cookie } })).status, 200);

    const migration = await app.request(form('/admin/migrate', {
      ownerEmail: OWNER.verifiedEmail,
      recoveryToken: RECOVERY,
      issuer: ISSUER,
      audience: 'a'.repeat(64),
    }, cookie));
    assert.equal(migration.status, 303);
    assert.equal((await identity.getOrganization())?.authMode, 'legacy_shared');
    assert.equal((await identity.listMemberships()).length, 0);

    // A failed or interrupted Access visit does not strand the operator.
    assert.equal((await app.request(`${ORIGIN}/admin/api/agents`, {
      headers: { authorization: `Bearer ${LEGACY}` },
    })).status, 200);
    const retry = await app.request(form('/admin/migrate', {
      ownerEmail: OWNER.verifiedEmail,
      recoveryToken: RECOVERY,
      issuer: ISSUER,
      audience: 'a'.repeat(64),
    }, cookie));
    assert.equal(retry.status, 303);
    assert.equal((await identity.listMemberships()).length, 0);

    assert.equal((await app.request(`${ORIGIN}/admin/setup/verify`)).status, 303);
    assert.equal((await identity.getOrganization())?.authMode, 'access_active');
    assert.equal((await identity.listMemberships()).length, 1);

    const rejectedLegacy = await app.request(`${ORIGIN}/admin/api/agents`, {
      headers: { authorization: `Bearer ${LEGACY}` },
    });
    assert.equal(rejectedLegacy.status, 401);
    assert.equal((await app.request(`${ORIGIN}/admin/api/agents`, {
      headers: { cookie },
    })).status, 401);
  });

  config.close();
  identity.close();
});

test('token mode resolves the same owner and exchanges only a per-person token for a browser session', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const organization = await identity.ensureOrganization({ displayName: 'Chickpea' });
  await identity.createOwnerClaim({ organizationId: organization.id, email: 'owner@example.com' });
  const owner = await identity.claimOwner({
    organizationId: organization.id, provider: 'bootstrap', issuer: 'urn:bootstrap',
    subject: 'owner', verifiedEmail: 'owner@example.com',
  });
  await identity.updateOrganizationAuth({
    organizationId: organization.id,
    authMode: 'token_active',
    canonicalAdminOrigin: ORIGIN,
  });
  const token = await new PersonalTokenService(identity).create(owner.user.id, 'Owner Admin');
  const app = createAdminRoutes({ identity, store: config, recoveryToken: RECOVERY });

  await withEnv({ TAG_ADMIN_TOKEN: undefined }, async () => {
    const login = await app.request(form('/admin/login', {
      token: token.token,
      returnTo: '/admin',
    }));
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/admin');
    assert.match(login.headers.get('set-cookie') ?? '', /^chickpea_session=/);
    assert.doesNotMatch(login.headers.get('set-cookie') ?? '', new RegExp(token.token));
  });

  config.close();
  identity.close();
});
