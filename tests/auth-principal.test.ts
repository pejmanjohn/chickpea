import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthDeniedError, AuthService } from '../src/auth/service.ts';
import type { Authenticator } from '../src/auth/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const NOW = 1_786_100_000_000;

test('external authenticators normalize into active internal principals', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const organization = await identity.ensureOrganization({ displayName: 'Chickpea' });
  await identity.createOwnerClaim({ organizationId: organization.id, email: 'owner@example.com' });
  const owner = await identity.claimOwner({
    organizationId: organization.id,
    provider: 'test_oidc',
    issuer: 'https://issuer.example',
    subject: 'subject-owner',
    verifiedEmail: 'owner@example.com',
    at: NOW,
  });
  const backupInvite = await identity.createInvitation({
    organizationId: organization.id, email: 'backup@example.com', role: 'owner',
    tokenHash: 'backup-owner-hash', inviterMembershipId: owner.membership.id,
    expiresAt: NOW + 10_000,
  });
  await identity.consumeInvitation({
    invitationId: backupInvite.id, tokenHash: 'backup-owner-hash', provider: 'test_oidc',
    issuer: 'https://issuer.example', subject: 'backup-owner',
    verifiedEmail: 'backup@example.com', at: NOW,
  });
  const authenticator: Authenticator = {
    kind: 'test_oidc',
    async authenticate() {
      return {
        kind: 'external_identity',
        provider: 'test_oidc',
        issuer: 'https://issuer.example',
        subject: 'subject-owner',
        verifiedEmail: 'owner@example.com',
        credentialId: 'assertion_test',
      };
    },
  };
  const service = new AuthService({ identity, authenticators: [authenticator] });
  const principal = await service.authenticateRequest(new Request('https://app.example/admin'));
  assert.equal(principal.userId, owner.user.id);
  assert.equal(principal.membershipId, owner.membership.id);
  assert.equal(principal.role, 'owner');
  assert.equal(principal.authenticatorKind, 'test_oidc');

  await identity.updateMembership({ membershipId: owner.membership.id, status: 'suspended' });
  await assert.rejects(
    () => service.authenticateRequest(new Request('https://app.example/admin')),
    (error: unknown) => error instanceof AuthDeniedError,
  );
  identity.close();
});

test('unknown external identities receive a uniform denial without persistence', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  await identity.ensureOrganization({ displayName: 'Chickpea' });
  const service = new AuthService({
    identity,
    authenticators: [{
      kind: 'test_oidc',
      async authenticate() {
        return {
          kind: 'external_identity', provider: 'test_oidc', issuer: 'https://issuer.example',
          subject: 'unknown', verifiedEmail: 'unknown@example.com', credentialId: 'assertion_unknown',
        };
      },
    }],
  });
  await assert.rejects(
    () => service.authenticateRequest(new Request('https://app.example/admin')),
    (error: unknown) => error instanceof AuthDeniedError && error.message === 'Authentication unavailable.',
  );
  assert.equal((await identity.listMemberships()).length, 0);
  assert.equal((await identity.listExternalIdentities()).length, 0);
  identity.close();
});
