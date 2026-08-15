import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BetterAuthDirectory, BetterAuthSessionAuthenticator } from '../src/auth/better-auth-principal.ts';
import { createBetterAuth, type BetterAuthAdmissionOperation } from '../src/auth/better-auth.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { AuthDeniedError, AuthService } from '../src/auth/service.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

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

    await assert.rejects(
      () => identity.updateMembership({ membershipId: owner.membership.id, status: 'suspended' }),
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
