import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IdentityStateError } from '../src/identity/errors.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const NOW = 1_786_000_000_000;

const PASSWORD_CREDENTIAL = {
  algorithm: 'pbkdf2-sha256' as const,
  parameterVersion: 1,
  iterations: 600_000,
  salt: 'c2FsdC1mb3ItdGVzdHM',
  verifier: 'dmVyaWZpZXItZm9yLXRlc3Rz',
};

function passwordSession(suffix: string, at = NOW) {
  return {
    sessionHash: `session-hash-${suffix}`,
    prefix: `prefix_${suffix}`,
    idleExpiresAt: at + 4 * 60 * 60_000,
    absoluteExpiresAt: at + 24 * 60 * 60_000,
  };
}

function ownerInput() {
  return {
    organizationId: 'org_oss',
    provider: 'cloudflare_access',
    issuer: 'https://example.cloudflareaccess.com',
    subject: 'owner-subject',
    verifiedEmail: 'Owner@Example.com',
    displayName: 'Owner',
    at: NOW,
  } as const;
}

test('identity initialization is explicit and idempotent without creating an owner', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  assert.equal(await store.getOrganization(), undefined);

  const first = await store.ensureOrganization({ displayName: 'Chickpea' });
  const second = await store.ensureOrganization({ displayName: 'Ignored later name' });
  assert.deepEqual(second, first);
  assert.equal((await store.listMemberships()).length, 0);
  assert.equal(await store.getOwnerClaim(), undefined);
  store.close();
});

test('matching owner claim creates one immutable binding and owner membership', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const organization = await store.ensureOrganization({ displayName: 'Chickpea' });
  await store.createOwnerClaim({
    organizationId: organization.id,
    email: 'owner@example.com',
  });

  const first = await store.claimOwner({ ...ownerInput(), organizationId: organization.id });
  const replay = await store.claimOwner({ ...ownerInput(), organizationId: organization.id });

  assert.deepEqual(replay, first);
  assert.equal(first.user.primaryEmail, 'owner@example.com');
  assert.equal(first.membership.role, 'owner');
  assert.equal(first.membership.status, 'active');
  assert.equal((await store.listMemberships()).length, 1);
  assert.equal((await store.listExternalIdentities()).length, 1);

  await assert.rejects(
    () => store.claimOwner({ ...ownerInput(), organizationId: organization.id, subject: 'other' }),
    (error: unknown) =>
      error instanceof IdentityStateError && error.code === 'owner_already_claimed',
  );
  store.close();
});

test('last active owner cannot be demoted, suspended, or removed', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const organization = await store.ensureOrganization({ displayName: 'Chickpea' });
  await store.createOwnerClaim({ organizationId: organization.id, email: 'owner@example.com' });
  const claimed = await store.claimOwner({ ...ownerInput(), organizationId: organization.id });

  for (const change of [
    { role: 'admin' as const },
    { status: 'suspended' as const },
    { status: 'removed' as const },
  ]) {
    await assert.rejects(
      () => store.updateMembership({ membershipId: claimed.membership.id, ...change }),
      (error: unknown) =>
        error instanceof IdentityStateError && error.code === 'last_owner_required',
    );
  }
  store.close();
});

test('invitation consumption is exact-email, single-use, revocable, and secret-safe', async () => {
  let now = NOW;
  const store = new SqliteIdentityStore(':memory:', { now: () => now });
  const organization = await store.ensureOrganization({ displayName: 'Chickpea' });
  await store.createOwnerClaim({ organizationId: organization.id, email: 'owner@example.com' });
  const owner = await store.claimOwner({ ...ownerInput(), organizationId: organization.id });
  const invitation = await store.createInvitation({
    organizationId: organization.id,
    email: 'member@example.com',
    role: 'member',
    tokenHash: 'hash-one',
    inviterMembershipId: owner.membership.id,
    expiresAt: NOW + 1_000,
  });

  await assert.rejects(
    () => store.consumeInvitation({
      invitationId: invitation.id,
      tokenHash: 'hash-one',
      provider: 'cloudflare_access',
      issuer: 'https://example.cloudflareaccess.com',
      subject: 'member-subject',
      verifiedEmail: 'wrong@example.com',
      at: now,
    }),
    (error: unknown) =>
      error instanceof IdentityStateError && error.code === 'invitation_email_mismatch',
  );

  const accepted = await store.consumeInvitation({
    invitationId: invitation.id,
    tokenHash: 'hash-one',
    provider: 'cloudflare_access',
    issuer: 'https://example.cloudflareaccess.com',
    subject: 'member-subject',
    verifiedEmail: 'member@example.com',
    at: now,
  });
  assert.equal(accepted.membership.role, 'member');
  await assert.rejects(
    () => store.consumeInvitation({
      invitationId: invitation.id,
      tokenHash: 'hash-one',
      provider: 'cloudflare_access',
      issuer: 'https://example.cloudflareaccess.com',
      subject: 'second-subject',
      verifiedEmail: 'member@example.com',
      at: now,
    }),
    (error: unknown) =>
      error instanceof IdentityStateError && error.code === 'invitation_not_pending',
  );

  const expiring = await store.createInvitation({
    organizationId: organization.id,
    email: 'late@example.com',
    role: 'admin',
    tokenHash: 'hash-old',
    inviterMembershipId: owner.membership.id,
    expiresAt: NOW + 2_000,
  });
  const rotated = await store.resendInvitation({
    invitationId: expiring.id,
    tokenHash: 'hash-new',
    expiresAt: NOW + 4_000,
  });
  assert.equal(rotated.tokenHash, 'hash-new');
  now = NOW + 5_000;
  await assert.rejects(
    () => store.consumeInvitation({
      invitationId: expiring.id,
      tokenHash: 'hash-new',
      provider: 'cloudflare_access',
      issuer: 'https://example.cloudflareaccess.com',
      subject: 'late-subject',
      verifiedEmail: 'late@example.com',
      at: now,
    }),
    (error: unknown) =>
      error instanceof IdentityStateError && error.code === 'invitation_expired',
  );

  const revoked = await store.createInvitation({
    organizationId: organization.id,
    email: 'revoked@example.com',
    role: 'member',
    tokenHash: 'hash-revoked',
    inviterMembershipId: owner.membership.id,
    expiresAt: NOW + 10_000,
  });
  await store.revokeInvitation(revoked.id);
  const exported = await store.exportSummary();
  assert.equal(JSON.stringify(exported).includes('hash-'), false);
  assert.equal(JSON.stringify(exported).includes('tokenHash'), false);
  store.close();
});

test('the same external binding cannot be reassigned through another invitation', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const organization = await store.ensureOrganization({ displayName: 'Chickpea' });
  await store.createOwnerClaim({ organizationId: organization.id, email: 'owner@example.com' });
  const owner = await store.claimOwner({ ...ownerInput(), organizationId: organization.id });
  const invite = await store.createInvitation({
    organizationId: organization.id,
    email: 'alias@example.com',
    role: 'member',
    tokenHash: 'alias-hash',
    inviterMembershipId: owner.membership.id,
    expiresAt: NOW + 10_000,
  });
  await assert.rejects(
    () => store.consumeInvitation({
      invitationId: invite.id,
      tokenHash: 'alias-hash',
      provider: owner.binding.provider,
      issuer: owner.binding.issuer,
      subject: owner.binding.subject,
      verifiedEmail: 'alias@example.com',
      at: NOW,
    }),
    (error: unknown) =>
      error instanceof IdentityStateError && error.code === 'external_identity_conflict',
  );
  store.close();
});

test('password owner setup is atomic, one-time, and secret-safe', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const setup = await store.setupPasswordOwner({
    organizationDisplayName: 'Acme',
    email: 'Owner@Example.com',
    displayName: 'Owner',
    canonicalAdminOrigin: 'https://chickpea.example.com',
    credential: PASSWORD_CREDENTIAL,
    session: passwordSession('owner'),
  });

  assert.equal(setup.user.primaryEmail, 'owner@example.com');
  assert.equal(setup.membership.role, 'owner');
  assert.equal(setup.credential.credentialVersion, 1);
  assert.equal(setup.session.authenticatorKind, 'password');
  assert.equal(setup.session.membershipId, setup.membership.id);
  assert.equal((await store.getOrganization())?.authMode, 'password_active');

  await assert.rejects(
    () => store.setupPasswordOwner({
      organizationDisplayName: 'Other',
      email: 'other@example.com',
      canonicalAdminOrigin: 'https://chickpea.example.com',
      credential: PASSWORD_CREDENTIAL,
      session: passwordSession('other'),
    }),
    (error: unknown) =>
      error instanceof IdentityStateError && error.code === 'password_setup_complete',
  );
  assert.equal((await store.listMemberships()).length, 1);

  const exported = JSON.stringify(await store.exportSummary());
  assert.equal(exported.includes(PASSWORD_CREDENTIAL.salt), false);
  assert.equal(exported.includes(PASSWORD_CREDENTIAL.verifier), false);
  assert.equal(exported.includes(passwordSession('owner').sessionHash), false);
  store.close();
});

test('password invitation enrollment is single-use and creates an independent member', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await store.setupPasswordOwner({
    organizationDisplayName: 'Acme',
    email: 'owner@example.com',
    canonicalAdminOrigin: 'https://chickpea.example.com',
    credential: PASSWORD_CREDENTIAL,
    session: passwordSession('owner'),
  });
  const invitation = await store.createInvitation({
    organizationId: owner.membership.organizationId,
    email: 'member@example.com',
    role: 'member',
    tokenHash: 'invite-hash',
    inviterMembershipId: owner.membership.id,
    expiresAt: NOW + 60_000,
  });

  const member = await store.enrollPasswordInvitation({
    invitationId: invitation.id,
    tokenHash: 'invite-hash',
    displayName: 'Member',
    credential: { ...PASSWORD_CREDENTIAL, salt: 'bWVtYmVyLXNhbHQ' },
    session: passwordSession('member'),
  });
  assert.equal(member.user.primaryEmail, 'member@example.com');
  assert.equal(member.membership.role, 'member');
  assert.notEqual(member.user.id, owner.user.id);

  await assert.rejects(
    () => store.enrollPasswordInvitation({
      invitationId: invitation.id,
      tokenHash: 'invite-hash',
      credential: PASSWORD_CREDENTIAL,
      session: passwordSession('replay'),
    }),
    (error: unknown) =>
      error instanceof IdentityStateError && error.code === 'invitation_not_pending',
  );
  store.close();
});

test('reset consumption rotates credential version, revokes sessions, and rejects replay', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await store.setupPasswordOwner({
    organizationDisplayName: 'Acme',
    email: 'owner@example.com',
    canonicalAdminOrigin: 'https://chickpea.example.com',
    credential: PASSWORD_CREDENTIAL,
    session: passwordSession('before'),
  });
  const reset = await store.createPasswordResetCapability({
    userId: owner.user.id,
    tokenHash: 'reset-hash',
    kind: 'owner_recovery',
    expiresAt: NOW + 60_000,
  });

  const rotated = await store.consumePasswordResetCapability({
    capabilityId: reset.id,
    tokenHash: 'reset-hash',
    credential: { ...PASSWORD_CREDENTIAL, salt: 'cm90YXRlZC1zYWx0' },
    session: passwordSession('after'),
  });
  assert.equal(rotated.credential.credentialVersion, 2);
  assert.equal(rotated.session.credentialVersion, 2);
  assert.equal((await store.findBrowserSessions('prefix_before'))[0]?.revokedAt, NOW);
  assert.equal((await store.findBrowserSessions('prefix_after'))[0]?.revokedAt, null);

  await assert.rejects(
    () => store.consumePasswordResetCapability({
      capabilityId: reset.id,
      tokenHash: 'reset-hash',
      credential: PASSWORD_CREDENTIAL,
      session: passwordSession('again'),
    }),
    (error: unknown) =>
      error instanceof IdentityStateError && error.code === 'password_reset_unavailable',
  );
  store.close();
});
