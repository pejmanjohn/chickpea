import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { digest } from '../src/auth/personal-token.ts';
import type { AdminAuthenticationService, AuthPrincipal, ExternalIdentity } from '../src/auth/types.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityResolution, OrganizationRole } from '../src/identity/types.ts';

const NOW = 1_786_100_000_000;
const ORIGIN = 'https://chickpea.example.com';
const ISSUER = 'https://team.cloudflareaccess.com';

async function fixture() {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const organization = await identity.ensureOrganization({ displayName: 'Chickpea' });
  await identity.createOwnerClaim({ organizationId: organization.id, email: 'owner@example.com' });
  const owner = await identity.claimOwner({
    organizationId: organization.id,
    provider: 'cloudflare_access',
    issuer: ISSUER,
    subject: 'owner-subject',
    verifiedEmail: 'owner@example.com',
    at: NOW,
  });
  await identity.configureAuthProvider({
    organizationId: organization.id,
    kind: 'cloudflare_access',
    state: 'active',
    issuer: ISSUER,
    audience: 'audience-test',
    admissionState: 'action_required',
  });
  await identity.updateOrganizationAuth({
    organizationId: organization.id,
    authMode: 'access_active',
    canonicalAdminOrigin: ORIGIN,
  });
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  return { identity, organization, owner, config, settings };
}

function principal(resolution: IdentityResolution): AuthPrincipal {
  return {
    userId: resolution.user.id,
    membershipId: resolution.membership.id,
    organizationId: resolution.membership.organizationId,
    role: resolution.membership.role,
    authenticatorKind: 'test_access',
    credentialId: `credential_${resolution.membership.id}`,
    correlationId: `request_${resolution.membership.id}`,
    machine: false,
  };
}

function authService(value: AuthPrincipal): AdminAuthenticationService {
  return { async authenticateRequest() { return value; } };
}

function mutation(method: string, body?: unknown) {
  return {
    method,
    headers: {
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function addMember(
  identity: SqliteIdentityStore,
  owner: IdentityResolution,
  email: string,
  role: OrganizationRole,
): Promise<IdentityResolution> {
  const invitation = await identity.createInvitation({
    organizationId: owner.membership.organizationId,
    email,
    role,
    tokenHash: digest(`secret-${email}`),
    inviterMembershipId: owner.membership.id,
    expiresAt: NOW + 10_000,
  });
  return identity.consumeInvitation({
    invitationId: invitation.id,
    tokenHash: digest(`secret-${email}`),
    provider: 'cloudflare_access',
    issuer: ISSUER,
    subject: `subject-${email}`,
    verifiedEmail: email,
    at: NOW,
  });
}

test('Team API creates show-once Chickpea invites without Cloudflare policy work', async () => {
  const f = await fixture();
  const app = createAdminRoutes({
    identity: f.identity,
    store: f.config,
    settings: f.settings,
    authService: authService(principal(f.owner)),
  });
  try {
    const response = await app.request(`${ORIGIN}/admin/api/team/invitations`, mutation('POST', {
      email: 'Teammate@Example.com',
    }));
    assert.equal(response.status, 201);
    const created = await response.json() as {
      invitation: { id: string; email: string; status: string };
      inviteLink: string;
    };
    assert.equal(created.invitation.email, 'teammate@example.com');
    assert.equal(created.invitation.status, 'pending');
    assert.equal('admission' in created.invitation, false);
    assert.match(created.inviteLink, /^https:\/\/chickpea\.example\.com\/join#invite=invitation_/);
    assert.equal(created.inviteLink.includes('?'), false);
    assert.equal(created.inviteLink.includes(digest('')), false);

    const stored = (await f.identity.listInvitations())[0]!;
    assert.equal(stored.role, 'admin');
    assert.equal(stored.tokenHash.length, 64);
    assert.equal(created.inviteLink.includes(stored.tokenHash), false);

    const snapshot = await app.request(`${ORIGIN}/admin/api/team`);
    const body = await snapshot.json() as { invitations: Array<Record<string, unknown>> };
    assert.equal(snapshot.status, 200);
    assert.equal(JSON.stringify(body).includes('tokenHash'), false);
    assert.equal(JSON.stringify(body).includes(stored.tokenHash), false);
  } finally {
    f.config.close(); f.settings.close(); f.identity.close();
  }
});

test('Team API rejects a stale page that still requests the removed member role', async () => {
  const f = await fixture();
  const app = createAdminRoutes({
    identity: f.identity,
    store: f.config,
    settings: f.settings,
    authService: authService(principal(f.owner)),
  });
  try {
    const response = await app.request(`${ORIGIN}/admin/api/team/invitations`, mutation('POST', {
      email: 'teammate@example.com',
      role: 'member',
    }));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'reload_required' });
    assert.equal((await f.identity.listInvitations()).length, 0);
  } finally {
    f.config.close(); f.settings.close(); f.identity.close();
  }
});

test('Admin can manage ordinary roles while only an owner can grant or control owners', async () => {
  const f = await fixture();
  const admin = await addMember(f.identity, f.owner, 'admin@example.com', 'admin');
  const member = await addMember(f.identity, f.owner, 'member@example.com', 'member');
  const adminApp = createAdminRoutes({
    identity: f.identity, store: f.config, settings: f.settings,
    authService: authService(principal(admin)),
  });
  const ownerApp = createAdminRoutes({
    identity: f.identity, store: f.config, settings: f.settings,
    authService: authService(principal(f.owner)),
  });
  try {
    const elevateByAdmin = await adminApp.request(
      `${ORIGIN}/admin/api/team/memberships/${member.membership.id}`,
      mutation('PATCH', { role: 'owner' }),
    );
    assert.equal(elevateByAdmin.status, 403);

    const makeAdmin = await adminApp.request(
      `${ORIGIN}/admin/api/team/memberships/${member.membership.id}`,
      mutation('PATCH', { role: 'admin' }),
    );
    assert.equal(makeAdmin.status, 200);

    const promote = await ownerApp.request(
      `${ORIGIN}/admin/api/team/memberships/${member.membership.id}`,
      mutation('PATCH', { role: 'owner' }),
    );
    assert.equal(promote.status, 200);
    assert.equal((await f.identity.getMembershipForUser(member.user.id))?.role, 'owner');

    const selfDemote = await ownerApp.request(
      `${ORIGIN}/admin/api/team/memberships/${f.owner.membership.id}`,
      mutation('PATCH', { role: 'admin' }),
    );
    assert.equal(selfDemote.status, 200);
    assert.equal((await f.identity.getMembershipForUser(f.owner.user.id))?.role, 'admin');
  } finally {
    f.config.close(); f.settings.close(); f.identity.close();
  }
});

test('Access-authenticated invite acceptance removes the fragment secret from server-visible URLs', async () => {
  const f = await fixture();
  const rawSecret = 'z'.repeat(48);
  const invitation = await f.identity.createInvitation({
    organizationId: f.organization.id,
    email: 'joiner@example.com',
    role: 'member',
    tokenHash: digest(rawSecret),
    inviterMembershipId: f.owner.membership.id,
    expiresAt: NOW + 10_000,
  });
  const external: ExternalIdentity = {
    kind: 'external_identity',
    provider: 'cloudflare_access',
    issuer: ISSUER,
    subject: 'joiner-subject',
    verifiedEmail: 'joiner@example.com',
    credentialId: 'access-joiner',
  };
  const app = createAdminRoutes({
    identity: f.identity,
    store: f.config,
    settings: f.settings,
    recoveryToken: 'r'.repeat(48),
    verifyAccessAssertion: async () => external,
  });
  try {
    const landing = await app.request(`${ORIGIN}/admin/join`, {
      headers: { 'Cf-Access-Jwt-Assertion': 'signed' },
    });
    assert.equal(landing.status, 200);
    const html = await landing.text();
    assert.match(html, /<script src="\/admin\/join\/client\.js" defer><\/script>/);
    assert.match(landing.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal(html.includes(rawSecret), false);

    const accepted = await app.request(`${ORIGIN}/admin/join`, {
      ...mutation('POST', { invitationId: invitation.id, token: rawSecret }),
      headers: {
        ...mutation('POST').headers,
        'Cf-Access-Jwt-Assertion': 'signed',
      },
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { redirect: '/admin/channels' });
    const stored = (await f.identity.listInvitations()).find((row) => row.id === invitation.id)!;
    assert.equal(stored.status, 'accepted');
    assert.equal('admissionState' in stored, false);

    const replay = await app.request(`${ORIGIN}/admin/join`, {
      ...mutation('POST', { invitationId: invitation.id, token: rawSecret }),
      headers: {
        ...mutation('POST').headers,
        'Cf-Access-Jwt-Assertion': 'signed',
      },
    });
    assert.equal(replay.status, 401);
    assert.deepEqual(await replay.json(), { error: 'join_unavailable' });
  } finally {
    f.config.close(); f.settings.close(); f.identity.close();
  }
});

test('Invite join denies mismatched, rotated, and revoked credentials uniformly without creating identity state', async () => {
  const f = await fixture();
  const rawSecret = 'a'.repeat(48);
  const invitation = await f.identity.createInvitation({
    organizationId: f.organization.id,
    email: 'expected@example.com',
    role: 'member',
    tokenHash: digest(rawSecret),
    inviterMembershipId: f.owner.membership.id,
    expiresAt: NOW + 10_000,
  });
  let externalEmail = 'different@example.com';
  const app = createAdminRoutes({
    identity: f.identity,
    store: f.config,
    settings: f.settings,
    recoveryToken: 'r'.repeat(48),
    verifyAccessAssertion: async () => ({
      kind: 'external_identity',
      provider: 'cloudflare_access',
      issuer: ISSUER,
      subject: `subject-${externalEmail}`,
      verifiedEmail: externalEmail,
      credentialId: `credential-${externalEmail}`,
    }),
  });
  const attempt = (token: string) => app.request(`${ORIGIN}/admin/join`, {
    ...mutation('POST', { invitationId: invitation.id, token }),
    headers: {
      ...mutation('POST').headers,
      'Cf-Access-Jwt-Assertion': 'signed',
    },
  });
  try {
    const before = await f.identity.listMemberships();
    const mismatch = await attempt(rawSecret);
    assert.equal(mismatch.status, 401);
    assert.deepEqual(await mismatch.json(), { error: 'join_unavailable' });
    assert.equal((await f.identity.listMemberships()).length, before.length);

    externalEmail = 'expected@example.com';
    await f.identity.resendInvitation({
      invitationId: invitation.id,
      tokenHash: digest('b'.repeat(48)),
      expiresAt: NOW + 20_000,
    });
    const rotated = await attempt(rawSecret);
    assert.equal(rotated.status, 401);
    assert.deepEqual(await rotated.json(), { error: 'join_unavailable' });

    await f.identity.revokeInvitation(invitation.id);
    const revoked = await attempt('b'.repeat(48));
    assert.equal(revoked.status, 401);
    assert.deepEqual(await revoked.json(), { error: 'join_unavailable' });
  } finally {
    f.config.close(); f.settings.close(); f.identity.close();
  }
});

test('Member reaches a minimal account surface and cannot open privileged Admin APIs', async () => {
  const f = await fixture();
  const member = await addMember(f.identity, f.owner, 'member@example.com', 'member');
  const app = createAdminRoutes({
    identity: f.identity, store: f.config, settings: f.settings,
    authService: authService(principal(member)),
  });
  try {
    const admin = await app.request(`${ORIGIN}/admin`);
    assert.equal(admin.status, 303);
    assert.equal(admin.headers.get('location'), '/admin/account');

    const account = await app.request(`${ORIGIN}/admin/account`);
    assert.equal(account.status, 200);
    assert.match(await account.text(), /Open Slack/);

    assert.equal((await app.request(`${ORIGIN}/admin/api/account`)).status, 200);
    assert.equal((await app.request(`${ORIGIN}/admin/api/team`)).status, 403);
    assert.equal((await app.request(`${ORIGIN}/admin/api/agents`)).status, 403);
  } finally {
    f.config.close(); f.settings.close(); f.identity.close();
  }
});
