import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BetterAuthDirectory, BetterAuthSessionAuthenticator } from '../src/auth/better-auth-principal.ts';
import { createBetterAuth, type BetterAuthAdmissionOperation } from '../src/auth/better-auth.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { AuthDeniedError, AuthService } from '../src/auth/service.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = 1_786_100_000_000;
const ORIGIN = 'https://app.example';
const TEAM = 'T12345678';
const USER = 'U12345678';
const SECRET = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => (index * 41 + 7) % 256))
  .toString('base64url');

test('active Better Auth session resolves only through canonical Slack authority', async () => {
  const backend = new NodeBetterAuthBackend(':memory:');
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  try {
    let admission: BetterAuthAdmissionOperation | null = null;
    const auth = createBetterAuth({
      backend,
      baseURL: ORIGIN,
      secret: SECRET,
      privateSeam: { async resolveAdmissionOperation() { return admission; } },
    });
    const reconciled = await auth.chickpea.reconcileSlackIdentity({
      slackTeamId: TEAM,
      slackUserId: USER,
      displayName: 'Owner',
      organization: {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Chickpea',
        slug: 'chickpea',
      },
    });
    assert.equal(
      backend.database.prepare('SELECT role FROM member WHERE id = ?').get(reconciled.membershipId)?.role,
      'member',
      'Better Auth organization role is permanently member',
    );

    const capabilityHash = 'a'.repeat(64);
    const operation = await identity.createAuthOperation({
      id: 'first_owner', kind: 'first_owner_claim', expectedSlackTeamId: TEAM,
      expectedSlackUserId: USER, chickpeaRole: 'owner', capabilityHash,
      expiresAt: NOW + 60_000,
    });
    await identity.createOwnerClaim({ operationId: operation.id, slackTeamId: TEAM, slackUserId: USER });
    await identity.advanceAuthOperation({
      operationId: operation.id, capabilityHash, step: 1,
      betterAuthUserId: reconciled.userId,
      betterAuthOrganizationId: reconciled.organizationId,
      betterAuthMembershipId: reconciled.membershipId,
    });
    const owner = await identity.claimOwner({
      operationId: operation.id, organizationId: 'org_oss', slackTeamId: TEAM, slackUserId: USER,
      displayName: 'Owner', betterAuthUserId: reconciled.userId,
      betterAuthMembershipId: reconciled.membershipId,
    });
    const control = await identity.getAuthControl();
    assert.ok(control);
    await identity.updateAuthControl({
      expectedRevision: control.revision,
      canonicalAdminOrigin: ORIGIN,
    });
    admission = {
      operationId: operation.id,
      status: 'active',
      chickpeaRole: 'owner',
      slackTeamId: TEAM,
      slackUserId: USER,
      betterAuthUserId: reconciled.userId,
      betterAuthOrganizationId: reconciled.organizationId,
      betterAuthMembershipId: reconciled.membershipId,
    };
    const issued = await auth.chickpea.issueSession(operation.id, new Request(`${ORIGIN}/oauth/finalize`, {
      method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    }));
    const cookie = (issued.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
    assert.ok(cookie);

    const directory = new BetterAuthDirectory({
      backend, access: identity, organizationId: reconciled.organizationId, canonicalAdminOrigin: ORIGIN,
    });
    const service = new AuthService({
      identity,
      sessionAuthenticator: new BetterAuthSessionAuthenticator({
        backend, directory, organizationId: reconciled.organizationId, baseURL: ORIGIN, secret: SECRET,
      }),
    });
    const principal = await service.authenticateRequest(new Request(`${ORIGIN}/admin`, {
      headers: { cookie },
    }));
    assert.deepEqual(
      [principal.userId, principal.membershipId, principal.role, principal.authenticatorKind],
      [owner.user.id, owner.membership.id, 'owner', 'better_auth'],
    );

    const adminSlackUserId = 'U87654321';
    const reconciledAdmin = await auth.chickpea.reconcileSlackIdentity({
      slackTeamId: TEAM,
      slackUserId: adminSlackUserId,
      displayName: 'Admin',
      organization: {
        id: reconciled.organizationId,
        name: 'Chickpea',
        slug: 'chickpea',
      },
    });
    const invitation = await identity.createInvitation({
      organizationId: owner.membership.organizationId,
      slackTeamId: TEAM,
      slackUserId: adminSlackUserId,
      role: 'admin',
      locatorHash: 'd'.repeat(64),
      inviterMembershipId: owner.membership.id,
      expiresAt: NOW + 60_000,
    });
    const admin = await identity.consumeInvitation({
      invitationId: invitation.id,
      locatorHash: 'd'.repeat(64),
      slackTeamId: TEAM,
      slackUserId: adminSlackUserId,
      betterAuthUserId: reconciledAdmin.userId,
      betterAuthMembershipId: reconciledAdmin.membershipId,
    });
    backend.database.prepare('UPDATE member SET role = ? WHERE id = ?')
      .run('owner', reconciledAdmin.membershipId);
    admission = {
      operationId: 'login_admin_tampered',
      status: 'active',
      chickpeaRole: 'admin',
      slackTeamId: TEAM,
      slackUserId: adminSlackUserId,
      betterAuthUserId: reconciledAdmin.userId,
      betterAuthOrganizationId: reconciledAdmin.organizationId,
      betterAuthMembershipId: reconciledAdmin.membershipId,
    };
    const issuedAdmin = await auth.chickpea.issueSession(
      admission.operationId,
      new Request(`${ORIGIN}/oauth/finalize`, {
        method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      }),
    );
    const adminCookie = (issuedAdmin.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
    await assert.rejects(
      () => service.authenticateRequest(new Request(`${ORIGIN}/admin`, {
        headers: { cookie: adminCookie },
      })),
      AuthDeniedError,
      'Better Auth role tampering cannot grant any Chickpea authority',
    );
    assert.equal((await identity.getMembership(admin.membership.id))?.role, 'admin');

    await assert.rejects(
      () => identity.updateMembershipAuthority({
        membershipId: owner.membership.id, status: 'suspended',
        actorMembershipId: owner.membership.id, authenticationSurface: 'better_auth',
        correlationId: 'request_last_owner', reasonCode: 'owner_suspended_member',
      }),
      /At least one active Owner/,
    );
    await identity.setMembershipAccessOverlay({
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      accessStatus: 'suspended',
    });
    await assert.rejects(
      () => service.authenticateRequest(new Request(`${ORIGIN}/admin`, { headers: { cookie } })),
      AuthDeniedError,
    );
  } finally {
    backend.close();
    identity.close();
  }
});

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';

/**
 * A Better Auth user with a membership in ORGANIZATION, and a Chickpea Owner
 * whose binding names whichever Better Auth membership a case chooses.
 */
async function boundMembership() {
  const backend = new NodeBetterAuthBackend(':memory:');
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const reconciled = await createBetterAuth({ backend, baseURL: ORIGIN, secret: SECRET }).chickpea
    .reconcileSlackIdentity({
      slackTeamId: TEAM, slackUserId: USER, displayName: 'Owner',
      organization: { id: ORGANIZATION, name: 'Chickpea', slug: 'chickpea' },
    });
  const sql = (statement: string, ...values: string[]) => backend.database.prepare(statement).run(...values);
  return {
    reconciled,
    sql,
    /** Another Better Auth membership row, shaped like the reconciled one. */
    addMember: (id: string, organizationId: string, userId = reconciled.userId) => sql(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       SELECT ?, ?, ?, 'member', createdAt FROM member WHERE id = ?`,
      id, organizationId, userId, reconciled.membershipId,
    ),
    membershipFor: () => backend.getMembershipForUser(reconciled.userId, ORGANIZATION),
    bind: (betterAuthMembershipId: string) => createSlackOwner(identity, {
      now: NOW, teamId: TEAM, userId: USER, betterAuthUserId: reconciled.userId,
      betterAuthOrganizationId: ORGANIZATION, betterAuthMembershipId,
    }),
    resolve: () => new BetterAuthDirectory({
      backend, access: identity, organizationId: ORGANIZATION, canonicalAdminOrigin: ORIGIN,
    }).resolveBetterAuthUser(reconciled.userId),
    close: () => { backend.close(); identity.close(); },
  };
}

test('a principal resolves only through the Better Auth membership its binding names', async (t) => {
  await t.test('the bound membership in this organization', async () => {
    const fixture = await boundMembership();
    try {
      await fixture.bind(fixture.reconciled.membershipId);
      assert.equal((await fixture.resolve())?.membership.role, 'owner');
    } finally { fixture.close(); }
  });

  await t.test('not a membership of the same person in another organization', async () => {
    const fixture = await boundMembership();
    try {
      fixture.sql(
        `INSERT INTO organization (id, name, slug, createdAt)
         SELECT ?, 'Elsewhere', 'elsewhere', createdAt FROM organization WHERE id = ?`,
        '22222222-2222-4222-8222-222222222222', ORGANIZATION,
      );
      fixture.addMember('member_elsewhere', '22222222-2222-4222-8222-222222222222');
      await fixture.bind('member_elsewhere');
      assert.equal(await fixture.resolve(), undefined);
    } finally { fixture.close(); }
  });

  await t.test("not another person's membership in this organization", async () => {
    const fixture = await boundMembership();
    try {
      fixture.sql(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
         SELECT 'user_someone', 'Someone', 'someone@identity.invalid', 0, createdAt, updatedAt
         FROM "user" WHERE id = ?`,
        fixture.reconciled.userId,
      );
      fixture.addMember('member_someone', ORGANIZATION, 'user_someone');
      await fixture.bind('member_someone');
      assert.equal(await fixture.resolve(), undefined);
    } finally { fixture.close(); }
  });

  await t.test('the bound row when a database without the unique index holds two for the pair', async () => {
    const fixture = await boundMembership();
    try {
      fixture.sql('DROP INDEX "member_organizationId_userId_uidx"');
      fixture.addMember('member_duplicate', ORGANIZATION);
      const found = (await fixture.membershipFor())!.id;
      const bound = found === 'member_duplicate' ? fixture.reconciled.membershipId : 'member_duplicate';
      await fixture.bind(bound);
      assert.equal((await fixture.resolve())?.membership.role, 'owner');
    } finally { fixture.close(); }
  });
});

test('unconfigured and recovery-only controls admit no principal', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  try {
    const service = new AuthService({ identity });
    await assert.rejects(
      () => service.authenticateRequest(new Request(`${ORIGIN}/admin`, {
        headers: { authorization: 'Bearer deployment-token' },
      })),
      AuthDeniedError,
    );
    const control = await identity.ensureAuthControl();
    await identity.updateAuthControl({
      expectedRevision: control.revision,
      healthGate: 'recovery_only',
    });
    await assert.rejects(
      () => service.authenticateRequest(new Request(`${ORIGIN}/admin`)),
      AuthDeniedError,
    );
  } finally {
    identity.close();
  }
});

test('Better Auth backend revokes every browser session for one user', async () => {
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    backend.database.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, ?, ?)`,
    ).run('ba_user_revoke', 'Revoke', 'revoke@identity.invalid', NOW, NOW);
    for (const [id, token] of [
      ['session_one', 'token_one'],
      ['session_two', 'token_two'],
    ] as const) {
      backend.database.prepare(
        `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId, absoluteExpiresAt)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      ).run(id, NOW + 60_000, token, NOW, NOW, 'ba_user_revoke', NOW + 60_000);
    }
    assert.equal(await backend.deleteSessionsForUser('ba_user_revoke'), 2);
    assert.equal(backend.database.prepare('SELECT count(*) AS count FROM session').get()?.count, 0);
  } finally {
    backend.close();
  }
});

test('the service reuses a request-scoped auth control and defers the success audit through the host', async () => {
  const control = {
    installationId: 'installation_test', authMode: 'slack_active' as const, healthGate: 'normal' as const,
    canonicalAdminOrigin: ORIGIN, betterAuthOrganizationId: 'better_auth_org_test',
    revision: 1, createdAt: NOW, updatedAt: NOW,
  };
  const audits: string[] = [];
  let storeReads = 0;
  const identity = {
    getAuthControl: async () => { storeReads += 1; return control; },
    recordAuthAudit: async (input: { event: string; outcome: string }) => { audits.push(`${input.event}:${input.outcome}`); },
  } as unknown as IdentityStore;
  const deferred: Array<() => Promise<void>> = [];
  const service = new AuthService({
    identity,
    sessionAuthenticator: {
      kind: 'test_session',
      authenticate: async () => ({ principal: {
        userId: 'user_1', membershipId: 'membership_1', organizationId: 'org_1', role: 'owner',
        authenticatorKind: 'better_auth', credentialId: 'session_1', correlationId: 'request_1', machine: false,
      } }),
    },
    authControl: async () => control,
    background: async (task) => { deferred.push(task); },
  });

  const principal = await service.authenticateRequest(new Request(`${ORIGIN}/admin`));
  assert.equal(principal.userId, 'user_1');
  // The middleware's read is reused, and the success audit is handed to the host.
  assert.equal(storeReads, 0);
  assert.deepEqual(audits, []);
  assert.equal(deferred.length, 1);
  await deferred[0]!();
  assert.deepEqual(audits, ['authentication:success']);

  // Without a host scheduler the audit is written before the call returns.
  const inline = new AuthService({
    identity,
    sessionAuthenticator: {
      kind: 'test_session',
      authenticate: async () => ({ principal: { ...principal, correlationId: 'request_2' } }),
    },
  });
  await inline.authenticateRequest(new Request(`${ORIGIN}/admin`));
  assert.equal(storeReads, 1);
  assert.deepEqual(audits, ['authentication:success', 'authentication:success']);
});
