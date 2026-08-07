import assert from 'node:assert/strict';
import { test } from 'node:test';

import { digest } from '../src/auth/personal-token.ts';
import { IdentityStateError } from '../src/identity/errors.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const NOW = 1_786_000_000_000;

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

test('Chickpea auth control uses optimistic revisions without creating legacy identity', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const initial = await store.ensureAuthControl();
  assert.equal(initial.authMode, 'unconfigured');
  assert.equal(initial.revision, 1);
  assert.equal(await store.getOrganization(), undefined);

  const pinned = await store.updateAuthControl({
    expectedRevision: 1,
    authMode: 'password_active',
    canonicalAdminOrigin: 'https://chickpea.example.com',
    betterAuthOrganizationId: 'ba-org/opaque',
  });
  assert.equal(pinned.revision, 2);
  assert.equal(pinned.betterAuthOrganizationId, 'ba-org/opaque');

  await assert.rejects(
    () => store.updateAuthControl({ expectedRevision: 1, authMode: 'invalid' }),
    (error: unknown) =>
      error instanceof IdentityStateError && error.code === 'auth_control_conflict',
  );
  store.close();
});

test('resumable auth operations advance monotonically and keep opaque Better Auth IDs immutable', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const capabilityHash = 'a'.repeat(64);
  const created = await store.createAuthOperation({
    id: 'operation_setup_1',
    kind: 'owner_setup',
    expectedEmail: 'Owner@Example.com',
    capabilityHash,
    expiresAt: NOW + 60_000,
  });
  assert.equal(created.expectedNormalizedEmail, 'owner@example.com');
  assert.equal(created.step, 0);

  const userCreated = await store.advanceAuthOperation({
    operationId: created.id,
    capabilityHash,
    step: 1,
    betterAuthUserId: 'ba-user/opaque',
  });
  assert.equal(userCreated.step, 1);
  assert.equal(userCreated.betterAuthUserId, 'ba-user/opaque');
  assert.equal(
    (await store.advanceAuthOperation({
      operationId: created.id,
      capabilityHash,
      step: 1,
      betterAuthUserId: 'ba-user/opaque',
    })).step,
    1,
  );
  await assert.rejects(
    () => store.advanceAuthOperation({
      operationId: created.id,
      capabilityHash,
      step: 3,
    }),
    (error: unknown) =>
      error instanceof IdentityStateError && error.code === 'auth_operation_step_invalid',
  );
  await assert.rejects(
    () => store.advanceAuthOperation({
      operationId: created.id,
      capabilityHash,
      step: 2,
      betterAuthUserId: 'different-user',
    }),
    (error: unknown) =>
      error instanceof IdentityStateError && error.code === 'auth_operation_conflict',
  );

  const membershipCreated = await store.advanceAuthOperation({
    operationId: created.id,
    capabilityHash,
    step: 2,
    betterAuthOrganizationId: 'ba-org/opaque',
    betterAuthMembershipId: 'ba-member/opaque',
  });
  assert.equal(membershipCreated.step, 2);
  assert.equal(
    (await store.consumeAuthOperation({
      operationId: created.id,
      capabilityHash,
      expectedStep: 2,
    })).status,
    'consumed',
  );
  await assert.rejects(
    () => store.consumeAuthOperation({
      operationId: created.id,
      capabilityHash,
      expectedStep: 2,
    }),
    (error: unknown) =>
      error instanceof IdentityStateError && error.code === 'auth_operation_unavailable',
  );

  const exported = JSON.stringify(await store.exportSummary());
  assert.equal(exported.includes(capabilityHash), false);
  assert.equal(exported.includes('owner@example.com'), false);
  store.close();
});

test('auth operation listings and membership access overlays stay in Chickpea control state', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  try {
    const first = await store.createAuthOperation({
      kind: 'invitation_enrollment',
      organizationId: 'better-auth-org',
      expectedEmail: 'invitee@example.com',
      capabilityHash: digest('operation-capability-one'),
      expiresAt: NOW + 10_000,
    });
    await store.createAuthOperation({
      kind: 'administrative_reset',
      organizationId: 'better-auth-org',
      expectedEmail: 'invitee@example.com',
      capabilityHash: digest('operation-capability-two'),
      expiresAt: NOW + 10_000,
    });
    assert.deepEqual(
      (await store.listAuthOperations('invitation_enrollment', 'better-auth-org')).map((row) => row.id),
      [first.id],
    );
    const suspended = await store.setMembershipAccessOverlay({
      membershipId: 'better-auth-member',
      organizationId: 'better-auth-org',
      accessStatus: 'suspended',
      expectedVersion: 0,
    });
    assert.equal(suspended.membershipVersion, 1);
    assert.equal((await store.getMembershipAccessOverlay('better-auth-member'))?.accessStatus, 'suspended');
    await assert.rejects(() => store.setMembershipAccessOverlay({
      membershipId: 'better-auth-member',
      organizationId: 'better-auth-org',
      accessStatus: 'active',
      expectedVersion: 0,
    }));
  } finally {
    store.close();
  }
});

test('personal tokens accept explicit opaque directory IDs without cross-store rows', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const token = await store.createPersonalToken({
    organizationId: 'ba-org/opaque',
    userId: 'ba-user/opaque',
    membershipId: 'ba-member/opaque',
    tokenHash: 'b'.repeat(64),
    prefix: 'opaque12',
    label: 'Automation',
  });
  assert.equal(token.organizationId, 'ba-org/opaque');
  assert.equal(token.membershipId, 'ba-member/opaque');

  const session = await store.createBrowserSession({
    organizationId: token.organizationId,
    userId: token.userId,
    membershipId: token.membershipId,
    personalTokenId: token.id,
    sessionHash: 'c'.repeat(64),
    prefix: 'session12',
    expiresAt: NOW + 60_000,
  });
  assert.equal(session.organizationId, 'ba-org/opaque');
  assert.equal(session.membershipId, 'ba-member/opaque');
  store.close();
});
