import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { BetterAuthDirectory, BetterAuthSessionAuthenticator } from '../src/auth/better-auth-principal.ts';
import { activateInstallerOwner } from '../src/auth/installer-owner.ts';
import { signInSlackMember } from '../src/auth/member-sign-in.ts';
import type { SlackOidcProof } from '../src/auth/slack-oidc.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const NOW = 1_786_000_000_000;
const ORIGIN = 'https://hosted.example';
const SECRET = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64url');
const OWNER: SlackOidcProof = { slackTeamId: 'TACME', slackUserId: 'UOWNER', displayName: 'Acme Owner' };
const MEMBER: SlackOidcProof = {
  slackTeamId: 'TACME', slackUserId: 'UMEMBER', displayName: 'Acme Member', contactEmail: 'member@acme.example',
};
const capability = (name: string) => `${name}-sign-in-capability-0123456789abcdef`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function code(expected: string) {
  return (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
}

/** One hosted installation with its first Owner, on a shared Better Auth database. */
async function installation(organizationId: string, backend: NodeBetterAuthBackend, clock = { now: NOW }) {
  const identity = new SqliteIdentityStore(':memory:', {
    now: () => clock.now,
    installation: () => ({ organizationId, installationId: `inst_${organizationId}` }),
  });
  const environment = { backend, baseURL: ORIGIN, secret: SECRET };
  await activateInstallerOwner({
    identity, environment, proof: { ...OWNER, eligibility: 'install_grant' },
    installGrant: { slackTeamId: OWNER.slackTeamId, installerSlackUserId: OWNER.slackUserId },
    capability: capability(`install-${organizationId}`),
    request: new Request(`${ORIGIN}/start/install/callback`), now: () => clock.now,
  });
  const control = await identity.ensureAuthControl();
  const signIn = (proof: SlackOidcProof, name: string, overrides: Partial<Parameters<typeof signInSlackMember>[0]> = {}) =>
    signInSlackMember({
      identity, environment, proof, capability: capability(name),
      request: new Request(`${ORIGIN}/start/callback`), now: () => clock.now, ...overrides,
    });
  // The principal a session cookie resolves to in this installation, if any.
  const principal = async (response: Response) => {
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]!;
    const directory = new BetterAuthDirectory({
      backend, access: identity, organizationId: control.betterAuthOrganizationId!, canonicalAdminOrigin: ORIGIN,
    });
    const authenticator = new BetterAuthSessionAuthenticator({
      backend, directory, organizationId: control.betterAuthOrganizationId!, baseURL: ORIGIN, secret: SECRET,
    });
    return (await authenticator.authenticate(new Request(`${ORIGIN}/admin`, { headers: { cookie } })))?.principal;
  };
  return { identity, environment, signIn, principal };
}

test('a returning Owner and a Slack-provisioned Member sign in to their installation; nobody else does', async () => {
  const backend = new NodeBetterAuthBackend(':memory:');
  const tenant = await installation('org_acme', backend);
  try {
    assert.equal((await tenant.principal(await tenant.signIn(OWNER, 'owner')))?.role, 'owner');

    // Someone who never talked to Chickpea has no membership: refused, nothing created.
    const accounts = () => backend.database.prepare('SELECT COUNT(*) AS count FROM account').get()?.count;
    const before = accounts();
    await assert.rejects(tenant.signIn(MEMBER, 'stranger'), code('user_mismatch'));
    assert.equal(accounts(), before, 'a refusal starts nothing in Better Auth');

    // Their first Slack interaction provisions a Member; their first sign-in binds a browser identity.
    await tenant.identity.provisionSlackMember({ slackTeamId: 'TACME', slackUserId: 'UMEMBER', displayName: 'Acme Member' });
    const first = await tenant.signIn(MEMBER, 'member-first');
    assert.equal((await tenant.principal(first))?.role, 'member');
    const resolution = (await tenant.identity.resolveSlackIdentity('TACME', 'UMEMBER'))!;
    assert.ok(resolution.binding.betterAuthUserId);
    assert.equal(resolution.user.contactEmail, 'member@acme.example');
    // Later sign-ins reuse the active login; no new operation.
    const logins = async () => (await tenant.identity.listAuthOperations('login')).length;
    assert.equal(await logins(), 1);
    assert.equal((await tenant.principal(await tenant.signIn(MEMBER, 'member-again')))?.role, 'member');
    assert.equal(await logins(), 1);

    // A suspended membership is refused like a missing one.
    const owner = (await tenant.identity.resolveSlackIdentity('TACME', 'UOWNER'))!;
    await tenant.identity.updateMembershipAuthority({
      membershipId: resolution.membership.id, status: 'suspended', actorMembershipId: owner.membership.id,
      authenticationSurface: 'better_auth', correlationId: 'suspend_member', reasonCode: 'test_suspension',
    });
    await assert.rejects(tenant.signIn(MEMBER, 'member-suspended'), code('user_mismatch'));

    // A proof the bot never checked is refused before the store is asked.
    await assert.rejects(tenant.signIn({ ...OWNER, eligibility: 'install_grant' }, 'owner-unchecked'), code('inactive_user'));
    // So is another Admin origin than the one the installation pinned.
    await assert.rejects(
      tenant.signIn(OWNER, 'owner-elsewhere', { environment: { ...tenant.environment, baseURL: 'https://elsewhere.example' } }),
      code('stale_revision'),
    );
    await assert.rejects(tenant.signIn(OWNER, 'short', { capability: 'too-short' }), /too short/);
  } finally {
    tenant.identity.close();
    backend.close();
  }
});

test('an interrupted first sign-in never locks the Member out, and its operation binds only while live', async () => {
  const clock = { now: NOW };
  const backend = new NodeBetterAuthBackend(':memory:');
  const tenant = await installation('org_resume', backend, clock);
  try {
    await tenant.identity.provisionSlackMember({ slackTeamId: 'TACME', slackUserId: 'UMEMBER', displayName: 'Acme Member' });
    // A sign-in admitted and then interrupted before its browser identity was bound.
    const interrupted = await tenant.identity.admitSlackLogin({
      capabilityHash: hash(capability('interrupted')), slackTeamId: 'TACME', slackUserId: 'UMEMBER', expiresAt: NOW + 60_000,
    });
    assert.equal(interrupted.status, 'reserved');
    const bind = (operationId: string, name: string, at?: number) => tenant.identity.bindSlackLoginBrowserIdentity({
      operationId, capabilityHash: hash(capability(name)), slackTeamId: 'TACME', slackUserId: 'UMEMBER',
      betterAuthUserId: 'ba_user', betterAuthOrganizationId: 'ba_org', betterAuthMembershipId: 'ba_member',
      ...(at === undefined ? {} : { at }),
    });
    // Another capability, another person, or an expired operation cannot bind it.
    await assert.rejects(bind(interrupted.id, 'someone-else'), code('auth_operation_conflict'));
    await assert.rejects(bind(interrupted.id, 'interrupted', NOW + 60_000), code('auth_operation_expired'));

    // The Member's next sign-in replaces it and succeeds.
    clock.now += 1_000;
    assert.equal((await tenant.principal(await tenant.signIn(MEMBER, 'next')))?.role, 'member');
    assert.equal((await tenant.identity.getAuthOperation(interrupted.id))?.status, 'expired');
    // The Owner's operation is not a login a host may bind.
    const ownerOperation = (await tenant.identity.getOwnerClaim())!.operationId;
    await assert.rejects(bind(ownerOperation, `install-org_resume`), code('auth_operation_conflict'));
  } finally {
    tenant.identity.close();
    backend.close();
  }
});

test('a session from one installation never signs anyone in to another, even of the same workspace', async () => {
  const backend = new NodeBetterAuthBackend(':memory:');
  const acme = await installation('org_acme', backend);
  const beta = await installation('org_beta', backend);
  try {
    // The same Slack person in another installation's store has no membership there.
    await acme.identity.provisionSlackMember({ slackTeamId: 'TACME', slackUserId: 'UMEMBER', displayName: 'Acme Member' });
    const session = await acme.signIn(MEMBER, 'member');
    assert.equal((await acme.principal(session))?.role, 'member');
    assert.equal(await beta.principal(session), undefined);
    await assert.rejects(beta.signIn(MEMBER, 'member-beta'), code('user_mismatch'));
  } finally {
    acme.identity.close();
    beta.identity.close();
    backend.close();
  }
});
