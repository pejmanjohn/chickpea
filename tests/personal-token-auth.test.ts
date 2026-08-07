import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthDeniedError } from '../src/auth/service.ts';
import { PersonalTokenService } from '../src/auth/personal-token.ts';
import { TokenSessionService } from '../src/auth/token-session.ts';
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
