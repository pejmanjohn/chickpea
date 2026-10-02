import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';

import type { BetterAuthDatabaseBackend } from '../src/auth/better-auth-backend.ts';
import { withBetterAuthBackend } from '../src/auth/better-auth-environment.ts';
import { InstallationContextError, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { IdentityStateError } from '../src/identity/errors.ts';
import { assignInstallationOwnerByOperator, type OperatorOwnerAssignmentInput } from '../src/identity/hosted-owner-assignment.ts';
import { IdentityStoreLogic } from '../src/identity/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { promisify } from '../src/state/async-facade.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/**
 * The Owner left Slack: a Slack deactivation kept their role and suspended
 * their access, so nobody can act as Owner. The host's operator, having
 * verified a requester out of band, makes that existing, active member
 * Owner, audited as the operator's with their evidence.
 */

const TEAM = 'T_OWNER_LEFT';
const AUTH_SECRET = randomBytes(32).toString('base64url');

async function installation(t: TestContext, options: { ownerLeftSlack?: boolean } = {}) {
  const db = openStateDb(':memory:');
  const logic = new IdentityStoreLogic(db, {
    installation: () => ({ organizationId: 'org_oss', installationId: 'inst_owner_left' }),
  });
  const identity = promisify(logic, { close: () => db.close() }) as unknown as IdentityStore & { close(): void };
  t.after(() => identity.close());
  const owner = await createSlackOwner(identity, { teamId: TEAM, userId: 'U_OWNER' });
  const member = (await identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId: 'U_ADMIN', displayName: 'Admin' }))
    .resolution;
  // The member signed in with Slack once: their Better Auth login is bound.
  db.run('UPDATE identity_slack_bindings SET better_auth_user_id = ? WHERE membership_id = ?', 'ba_user_admin', member.membership.id);
  const other = (await identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId: 'U_OTHER', displayName: 'Other' }))
    .resolution;
  // Slack's user_change: the sole Owner keeps the role, with access suspended.
  if (options.ownerLeftSlack ?? true) {
    await identity.updateMembershipAuthority({
      membershipId: owner.membership.id, status: 'suspended', authenticationSurface: 'slack_event',
      correlationId: 'slack_user_change', reasonCode: 'slack_user_deactivated',
    });
  }
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' } as PlatformEnv, { installationId: 'inst_owner_left' });
  return { db, identity, owner, member, other, env };
}

function request(membershipId: string, overrides: Partial<OperatorOwnerAssignmentInput> = {}): OperatorOwnerAssignmentInput {
  return {
    membershipId, slackTeamId: TEAM, slackUserId: 'U_ADMIN', reasonCode: 'owner_left_slack',
    evidence: 'job:opjob_123:sha256:abc123', correlationId: 'opjob_123', idempotencyKey: 'operator:assign_owner:opjob_123',
    ...overrides,
  };
}

function identityError(code: string) {
  return (error: unknown) => error instanceof IdentityStateError && error.code === code;
}

/** Better Auth signs this installation's people in, through a backend the host attaches. */
async function betterAuthActive(identity: IdentityStore) {
  const control = await identity.ensureAuthControl();
  await identity.updateAuthControl({
    expectedRevision: control.revision, authMode: 'slack_active', healthGate: 'normal',
    canonicalAdminOrigin: 'https://chickpea.example', betterAuthOrganizationId: '11111111-1111-4111-8111-111111111111',
  });
}

test('an operator makes a verified, active member Owner, audited with their evidence, and leaves the old Owner as it was', async (t) => {
  const { identity, owner, member } = await installation(t);
  await betterAuthActive(identity);
  const ended: string[] = [];
  const backend = {
    deleteSessionsForUser: async (userId: string) => { ended.push(userId); return 1; },
    revokeOAuthGrantsForUser: async () => ({ consents: 0, accessTokens: 0, refreshTokens: 0 }),
  } as unknown as BetterAuthDatabaseBackend;
  const hostEnv = withBetterAuthBackend(
    scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation', CHICKPEA_AUTH_SECRET: AUTH_SECRET } as PlatformEnv,
      { installationId: 'inst_owner_left' }),
    backend,
  );
  const ownerBefore = await identity.getMembership(owner.membership.id);
  const token = await identity.createPersonalToken({
    organizationId: member.membership.organizationId, membershipId: member.membership.id,
    userId: member.membership.userId, tokenHash: 'a'.repeat(64), prefix: 'chk_admin', label: 'CLI',
  });

  const assigned = await assignInstallationOwnerByOperator(hostEnv, request(member.membership.id), { identity });
  assert.equal(assigned.changed, true);
  assert.equal(assigned.membership.role, 'owner');
  assert.equal(assigned.membership.status, 'active');
  assert.deepEqual(ended, ['ba_user_admin'], 'the new Owner signs in again, as any role change requires');
  assert.deepEqual(assigned.owners.map(({ id }) => id).sort(), [owner.membership.id, member.membership.id].sort());
  // The previous Owner: same role, same suspended access, untouched.
  assert.deepEqual(await identity.getMembership(owner.membership.id), ownerBefore);
  assert.equal((await identity.getMembershipAccessOverlay(owner.membership.id))?.accessStatus, 'suspended');
  assert.equal((await identity.getPersonalToken(token.id))?.status, 'revoked', 'their personal tokens end too');

  const events = (await identity.listAuditEvents()).filter((event) => event.eventType === 'identity.owner_assigned_by_operator');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actorClass, 'host_operator');
  assert.equal(events[0]!.actorId, null);
  assert.equal(events[0]!.subjectId, member.membership.id);
  assert.equal(events[0]!.reasonCode, 'owner_left_slack');
  assert.deepEqual(JSON.parse(events[0]!.metadataJson), {
    action: 'membership.owner_assigned_by_operator', correlationId: 'opjob_123',
    operatorEvidence: 'job:opjob_123:sha256:abc123', authenticationSurface: 'host_operator',
    role: 'owner', status: 'active', slackUserId: 'U_ADMIN', credentialRevision: null, soleOwnerAccessSuspended: false,
  });

  // A retried job replays: nothing changes again and no session is ended twice.
  const replay = await assignInstallationOwnerByOperator(hostEnv, request(member.membership.id), { identity });
  assert.equal(replay.changed, false);
  assert.deepEqual(ended, ['ba_user_admin']);
  assert.equal((await identity.listAuditEvents()).filter((event) => event.eventType === 'identity.owner_assigned_by_operator').length, 1);
});

test('an operator assigns nobody while an active Owner remains, the one they assigned included', async (t) => {
  const assignments = async (identity: IdentityStore) => (await identity.listAuditEvents())
    .filter((event) => event.eventType === 'identity.owner_assigned_by_operator').length;

  // The Owner never left Slack: they act for the team themselves.
  const live = await installation(t, { ownerLeftSlack: false });
  await assert.rejects(
    assignInstallationOwnerByOperator(live.env, request(live.member.membership.id), { identity: live.identity }),
    identityError('active_owner_present'),
  );
  assert.equal((await live.identity.getMembership(live.member.membership.id))?.role, 'member');
  assert.equal(await assignments(live.identity), 0);

  // Once an operator made one member Owner, that Owner acts; a later job assigns nobody.
  const { identity, member, other, env } = await installation(t);
  assert.equal((await assignInstallationOwnerByOperator(env, request(member.membership.id), { identity })).changed, true);
  await assert.rejects(
    assignInstallationOwnerByOperator(env, request(other.membership.id, {
      slackUserId: 'U_OTHER', correlationId: 'opjob_456', idempotencyKey: 'operator:assign_owner:opjob_456',
    }), { identity }),
    identityError('active_owner_present'),
  );
  assert.equal((await identity.getMembership(other.membership.id))?.role, 'member');
  assert.equal(await assignments(identity), 1);
});

test('an operator cannot make Owner a member the named Slack account is not bound to, nor an inactive one', async (t) => {
  const { identity, member, other, env } = await installation(t);
  await assert.rejects(
    assignInstallationOwnerByOperator(env, request(member.membership.id, { slackUserId: 'U_OTHER' }), { identity }),
    identityError('external_identity_conflict'),
  );
  await assert.rejects(
    assignInstallationOwnerByOperator(env, request(member.membership.id, { evidence: 'not an audit code' }), { identity }),
    identityError('identity_invalid'),
  );
  await identity.updateMembershipAuthority({
    membershipId: other.membership.id, status: 'suspended', authenticationSurface: 'slack_event',
    correlationId: 'slack_user_change', reasonCode: 'slack_user_deactivated',
  });
  await assert.rejects(
    assignInstallationOwnerByOperator(env, request(other.membership.id, { slackUserId: 'U_OTHER' }), { identity }),
    identityError('membership_missing'),
  );
  await assert.rejects(
    assignInstallationOwnerByOperator(env, request('membership_unknown'), { identity }),
    identityError('membership_missing'),
  );
  assert.equal((await identity.getMembership(member.membership.id))?.role, 'member');
  assert.equal((await identity.listAuditEvents()).some((event) => event.eventType === 'identity.owner_assigned_by_operator'), false);
});

test('the operator surface promotes to Owner and nothing else, never through an acting member', async (t) => {
  const { identity, owner, member } = await installation(t);
  const base = {
    membershipId: member.membership.id, authenticationSurface: 'host_operator' as const,
    correlationId: 'opjob_1', reasonCode: 'owner_left_slack', operatorEvidence: 'job:opjob_1',
    slackTeamId: TEAM, slackUserId: 'U_ADMIN',
  };
  await assert.rejects(identity.updateMembershipAuthority({ ...base, role: 'admin' }), identityError('inviter_not_authorized'));
  await assert.rejects(identity.updateMembershipAuthority({ ...base, role: 'owner', status: 'removed' }),
    identityError('inviter_not_authorized'));
  await assert.rejects(identity.updateMembershipAuthority({ ...base, role: 'owner', actorMembershipId: owner.membership.id }),
    identityError('inviter_not_authorized'));
  const { operatorEvidence: _evidence, ...withoutEvidence } = base;
  await assert.rejects(identity.updateMembershipAuthority({ ...withoutEvidence, role: 'owner' }), identityError('identity_invalid'));
  assert.equal((await identity.getMembership(member.membership.id))?.role, 'member');
});

test('nothing changes where Better Auth signs people in and no backend serves the call, and standalone is refused', async (t) => {
  const { identity, member, env } = await installation(t);
  await betterAuthActive(identity);
  const tenancyWithSecret = scopeInstallationEnv(
    { CHICKPEA_TENANCY: 'installation', CHICKPEA_AUTH_SECRET: AUTH_SECRET } as PlatformEnv,
    { installationId: 'inst_owner_left' },
  );
  await assert.rejects(assignInstallationOwnerByOperator(tenancyWithSecret, request(member.membership.id), { identity }),
    /No Better Auth backend serves this request/);
  await assert.rejects(assignInstallationOwnerByOperator(env, request(member.membership.id), { identity }),
    /No Better Auth backend serves this request/);
  assert.equal((await identity.getMembership(member.membership.id))?.role, 'member');
  await assert.rejects(assignInstallationOwnerByOperator({} as PlatformEnv, request(member.membership.id), { identity }),
    InstallationContextError);
});
