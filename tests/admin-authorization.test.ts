import assert from 'node:assert/strict';
import { test } from 'node:test';

import { permissionForRole, requirePermission } from '../src/auth/permissions.ts';
import { validateMutationProvenance } from '../src/auth/request-provenance.ts';
import { AuthService } from '../src/auth/service.ts';
import { PersonalTokenService } from '../src/auth/personal-token.ts';
import { TokenSessionService } from '../src/auth/token-session.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

function principal(role: AuthPrincipal['role'], machine = false): AuthPrincipal {
  return {
    userId: `user_${role}`, membershipId: `membership_${role}`, organizationId: 'org_oss',
    role, authenticatorKind: 'personal_token', credentialId: `token_${role}`,
    correlationId: 'request_test', machine,
  };
}

test('role permissions match owner, admin, and member boundaries', () => {
  assert.equal(permissionForRole('owner').has('auth.manage'), true);
  assert.equal(permissionForRole('owner').has('team.manage_owners'), true);
  assert.equal(permissionForRole('admin').has('admin.configure'), true);
  assert.equal(permissionForRole('admin').has('team.manage'), true);
  assert.equal(permissionForRole('admin').has('auth.manage'), false);
  assert.deepEqual([...permissionForRole('member')].sort(), ['account.view', 'slack.handoff']);
  assert.doesNotThrow(() => requirePermission(principal('admin'), 'admin.configure'));
  assert.throws(() => requirePermission(principal('member'), 'admin.configure'), /forbidden/i);
});

test('browser mutations require pinned origin, JSON, bounded bodies, and same-site fetch', () => {
  const options = { canonicalOrigin: 'https://app.example', maxBodyBytes: 1_024 };
  const valid = new Request('https://app.example/admin/api/team', {
    method: 'POST',
    headers: {
      origin: 'https://app.example', 'content-type': 'application/json',
      'content-length': '20', 'sec-fetch-site': 'same-origin',
    },
  });
  assert.equal(validateMutationProvenance(valid, principal('owner'), options).ok, true);

  for (const request of [
    new Request(valid, { headers: { ...Object.fromEntries(valid.headers), origin: 'https://evil.example' } }),
    new Request(valid, { headers: { ...Object.fromEntries(valid.headers), 'content-type': 'text/plain' } }),
    new Request(valid, { headers: { ...Object.fromEntries(valid.headers), 'content-length': '2048' } }),
    new Request(valid, { headers: { ...Object.fromEntries(valid.headers), 'sec-fetch-site': 'cross-site' } }),
  ]) {
    assert.equal(validateMutationProvenance(request, principal('owner'), options).ok, false);
  }

  const machine = new Request('https://app.example/admin/api/team', { method: 'POST' });
  assert.equal(validateMutationProvenance(machine, principal('owner', true), options).ok, true);
  assert.equal(validateMutationProvenance(machine, { ...principal('owner'), authenticatorKind: 'slack' }, options).ok, false);
});

test('Admin routes accept normalized principals and reject member or Slack identifiers', async () => {
  const now = 1_786_100_000_000;
  let sequence = 20;
  const randomBytes = (length: number) => new Uint8Array(length).fill(++sequence);
  const identity = new SqliteIdentityStore(':memory:', { now: () => now });
  const organization = await identity.ensureOrganization({ displayName: 'Chickpea' });
  await identity.createOwnerClaim({ organizationId: organization.id, email: 'owner@example.com' });
  const owner = await identity.claimOwner({
    organizationId: organization.id, provider: 'bootstrap', issuer: 'urn:bootstrap',
    subject: 'owner', verifiedEmail: 'owner@example.com', at: now,
  });
  const invite = await identity.createInvitation({
    organizationId: organization.id, email: 'member@example.com', role: 'member',
    tokenHash: 'member-route-hash', inviterMembershipId: owner.membership.id,
    expiresAt: now + 10_000,
  });
  const member = await identity.consumeInvitation({
    invitationId: invite.id, tokenHash: 'member-route-hash', provider: 'bootstrap',
    issuer: 'urn:bootstrap', subject: 'member', verifiedEmail: 'member@example.com', at: now,
  });
  await identity.updateOrganizationAuth({
    organizationId: organization.id,
    authMode: 'token_active',
    canonicalAdminOrigin: 'https://app.example',
  });
  const personalTokens = new PersonalTokenService(identity, { now: () => now, randomBytes });
  const tokenSessions = new TokenSessionService(identity, { now: () => now, randomBytes });
  const authService = new AuthService({ identity, personalTokens, tokenSessions });
  const ownerToken = await personalTokens.create(owner.user.id, 'Owner API');
  const memberToken = await personalTokens.create(member.user.id, 'Member API');
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const app = createAdminRoutes({ authService, identity, store: config });

  assert.equal((await app.request('/admin/api/agents')).status, 401);
  assert.equal((await app.request('/admin/api/agents', {
    headers: { authorization: `Bearer ${ownerToken.token}` },
  })).status, 200);
  assert.equal((await app.request('/admin/api/agents', {
    headers: { authorization: `Bearer ${memberToken.token}` },
  })).status, 403);
  assert.equal((await app.request('/admin/api/agents', {
    headers: { 'x-slack-user-id': 'U_ADMIN', 'x-agent-id': 'agent_admin' },
  })).status, 401);

  const login = await app.request('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(ownerToken.token)}`,
  });
  assert.equal(login.status, 303);
  assert.match(login.headers.get('set-cookie') ?? '', /chickpea_session=/);
  config.close();
  identity.close();
});
