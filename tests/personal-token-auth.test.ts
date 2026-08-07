import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthDeniedError } from '../src/auth/service.ts';
import { digest, PersonalTokenService } from '../src/auth/personal-token.ts';
import { TokenSessionService } from '../src/auth/token-session.ts';
import type { HumanIdentityDirectory, Membership } from '../src/identity/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const NOW = 1_786_100_000_000;

async function ownerStore() {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const organization = await identity.ensureOrganization({ displayName: 'Chickpea' });
  await identity.createOwnerClaim({ organizationId: organization.id, email: 'owner@example.com' });
  const owner = await identity.claimOwner({
    organizationId: organization.id,
    provider: 'bootstrap', issuer: 'urn:chickpea:bootstrap', subject: 'owner',
    verifiedEmail: 'owner@example.com', at: NOW,
  });
  return { identity, owner };
}

test('personal tokens are show-once, independently revocable, and never stored raw', async () => {
  const { identity, owner } = await ownerStore();
  let sequence = 0;
  const tokens = new PersonalTokenService(identity, {
    now: () => NOW,
    randomBytes: (length) => new Uint8Array(length).fill(++sequence),
  });
  const first = await tokens.create(owner.user.id, 'Laptop');
  const second = await tokens.create(owner.user.id, 'Automation');
  assert.match(first.token, /^chp_pat_/);
  assert.notEqual(first.token, second.token);
  assert.equal(JSON.stringify(await identity.exportSummary()).includes(first.token), false);

  const principal = await tokens.authenticate(first.token, true);
  assert.equal(principal.membershipId, owner.membership.id);
  assert.equal(principal.machine, true);
  await tokens.revoke(first.record.id);
  await assert.rejects(() => tokens.authenticate(first.token, true), AuthDeniedError);
  assert.equal((await tokens.authenticate(second.token, true)).userId, owner.user.id);
  identity.close();
});

test('token sessions recheck expiry, source token, and membership on every request', async () => {
  const { identity, owner } = await ownerStore();
  let now = NOW;
  let sequence = 10;
  const randomBytes = (length: number) => new Uint8Array(length).fill(++sequence);
  const tokens = new PersonalTokenService(identity, { now: () => now, randomBytes });
  const sessions = new TokenSessionService(identity, { now: () => now, randomBytes });
  const created = await tokens.create(owner.user.id, 'Browser');
  const session = await sessions.create(created.record, owner.membership.id);
  const principal = await sessions.authenticate(session.token);
  assert.equal(principal.machine, false);
  assert.equal(principal.userId, owner.user.id);

  await tokens.revoke(created.record.id);
  await assert.rejects(() => sessions.authenticate(session.token), AuthDeniedError);

  const replacement = await tokens.create(owner.user.id, 'Replacement');
  const nextSession = await sessions.create(replacement.record, owner.membership.id);
  const backupInvite = await identity.createInvitation({
    organizationId: owner.membership.organizationId, email: 'backup@example.com', role: 'owner',
    tokenHash: 'backup-session-owner', inviterMembershipId: owner.membership.id,
    expiresAt: NOW + 10_000,
  });
  await identity.consumeInvitation({
    invitationId: backupInvite.id, tokenHash: 'backup-session-owner', provider: 'bootstrap',
    issuer: 'urn:chickpea:bootstrap', subject: 'backup-owner',
    verifiedEmail: 'backup@example.com', at: NOW,
  });
  await identity.updateMembership({ membershipId: owner.membership.id, status: 'suspended' });
  await assert.rejects(() => sessions.authenticate(nextSession.token), AuthDeniedError);

  await identity.updateMembership({ membershipId: owner.membership.id, status: 'active' });
  const expiring = await sessions.create(replacement.record, owner.membership.id, 1_000);
  now += 1_001;
  await assert.rejects(() => sessions.authenticate(expiring.token), AuthDeniedError);
  identity.close();
});

test('personal tokens use their pinned membership through a provider-neutral directory', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const token = 'chp_pat_abcdefghijkl_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';
  const user = {
    id: 'better-user', primaryEmail: 'owner@example.com', displayName: 'Owner',
    createdAt: NOW, updatedAt: NOW,
  };
  const membership: Membership = {
    id: 'better-member', organizationId: 'better-org', userId: user.id,
    role: 'owner', status: 'active', createdAt: NOW, updatedAt: NOW,
  };
  const directory: HumanIdentityDirectory = {
    async getOrganization() { return undefined; },
    async listMemberships() { return [membership]; },
    async getUser(id) { return id === user.id ? user : undefined; },
    async findUserByEmail(email) { return email === user.primaryEmail ? user : undefined; },
    async getMembership(id) { return id === membership.id ? membership : undefined; },
    async getMembershipForUser(id, organizationId) {
      return id === user.id && (!organizationId || organizationId === membership.organizationId)
        ? membership
        : undefined;
    },
  };
  const record = await identity.createPersonalToken({
    organizationId: membership.organizationId,
    membershipId: membership.id,
    userId: user.id,
    label: 'Automation',
    prefix: 'abcdefghijkl',
    tokenHash: digest(token),
  });
  const tokens = new PersonalTokenService(identity, { directory, now: () => NOW });
  const principal = await tokens.authenticate(token, true);
  assert.equal(principal.membershipId, membership.id);
  assert.equal(principal.organizationId, membership.organizationId);

  membership.status = 'suspended';
  await assert.rejects(() => tokens.authenticate(token, true), AuthDeniedError);
  assert.equal((await identity.getPersonalToken(record.id))?.lastUsedAt, NOW);
  identity.close();
});
