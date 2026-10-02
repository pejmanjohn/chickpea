import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { createBetterAuth } from '../src/auth/better-auth.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { BetterAuthDirectory } from '../src/auth/better-auth-principal.ts';
import { activateInstallerOwner } from '../src/auth/installer-owner.ts';
import type { SlackOidcProof } from '../src/auth/slack-oidc.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const NOW = 1_786_000_000_000;
const ORIGIN = 'https://hosted.example';
const SECRET = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64url');
const CAPABILITY = 'install-attempt-capability-0123456789abcdef';
const OWNER: SlackOidcProof = {
  slackTeamId: 'TACME', slackUserId: 'UINSTALLER', displayName: 'Acme Installer', eligibility: 'install_grant',
};
const GRANT = { slackTeamId: 'TACME', installerSlackUserId: 'UINSTALLER' };

function hostedStore(organizationId: string, clock = { now: NOW }) {
  return new SqliteIdentityStore(':memory:', {
    now: () => clock.now,
    installation: () => ({ organizationId, installationId: `inst_${organizationId}` }),
  });
}

function code(expected: string) {
  return (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
}

test('the installer becomes the first Owner and is signed in; nobody else can claim it', async () => {
  const identity = hostedStore('org_acme');
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = { backend, baseURL: ORIGIN, secret: SECRET };
  try {
    const activate = (overrides: Partial<Parameters<typeof activateInstallerOwner>[0]> = {}) =>
      activateInstallerOwner({
        identity, environment, proof: OWNER, installGrant: GRANT, capability: CAPABILITY,
        request: new Request(`${ORIGIN}/auth/slack/install/callback`), now: () => NOW, ...overrides,
      });

    await assert.rejects(activate({ installGrant: { slackTeamId: 'TACME', installerSlackUserId: 'USOMEONE' } }),
      code('user_mismatch'));
    await assert.rejects(activate({ installGrant: { slackTeamId: 'TOTHER', installerSlackUserId: 'UINSTALLER' } }),
      code('user_mismatch'));
    assert.equal(await identity.getOwnerClaim(), undefined, 'a refused grant writes nothing');

    // A trailing slash names the same origin.
    const first = await activate({ environment: { ...environment, baseURL: `${ORIGIN}/` } });
    assert.match(first.headers.get('set-cookie') ?? '', /session_token/);
    const claim = (await identity.getOwnerClaim())!;
    assert.equal(claim.status, 'active');
    assert.equal((await identity.getMembership(claim.membershipId!))!.role, 'owner');
    const control = await identity.ensureAuthControl();
    assert.equal(control.authMode, 'slack_active');
    assert.equal(control.canonicalAdminOrigin, ORIGIN);

    // The same Owner, from this or a later install attempt, is signed in again.
    assert.equal((await activate()).ok, true);
    assert.equal((await activate({ capability: 'a-later-install-attempt-0123456789abcdef' })).ok, true);
    assert.equal((await identity.listMemberships()).length, 1);

    await assert.rejects(activate({
      proof: { ...OWNER, slackUserId: 'USECOND' },
      installGrant: { slackTeamId: 'TACME', installerSlackUserId: 'USECOND' },
      capability: 'another-install-attempt-0123456789abcdef',
    }), code('owner_already_claimed'));
    assert.equal((await identity.listMemberships()).length, 1);
    // Not even the Owner is signed in under another Admin origin.
    await assert.rejects(activate({ environment: { ...environment, baseURL: 'https://elsewhere.example' } }),
      /pinned to another Admin origin/);
    // Nor once their membership is suspended (here, as the store reports it).
    const suspended = new Proxy(identity, {
      get(target, property, receiver) {
        if (property !== 'getMembership') return Reflect.get(target, property, receiver);
        return async (id: string) => ({ ...(await target.getMembership(id))!, status: 'suspended' });
      },
    });
    await assert.rejects(activate({ identity: suspended }), code('inactive_user'));
  } finally {
    identity.close();
    backend.close();
  }
});

test('an interrupted activation resumes, a new attempt by the same person replaces it, and nobody else can', async () => {
  const clock = { now: NOW };
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = { backend, baseURL: ORIGIN, secret: SECRET };
  const auth = createBetterAuth(environment);
  const capabilityHash = (capability: string) => createHash('sha256').update(capability).digest('hex');
  const activate = (identity: SqliteIdentityStore, capability: string, proof = OWNER) => activateInstallerOwner({
    identity, environment, proof, capability,
    installGrant: { slackTeamId: proof.slackTeamId, installerSlackUserId: proof.slackUserId },
    request: new Request(`${ORIGIN}/auth/slack/install/callback`), now: () => clock.now,
  });
  // What a crash leaves behind after the reservation, and optionally after
  // reconciling with Better Auth and recording it on the operation.
  const interrupt = async (identity: SqliteIdentityStore, capability: string, through: 'reserve' | 'reconcile' | 'advance', proof = OWNER) => {
    const organization = await identity.ensureOrganization({ displayName: 'Chickpea', slackTeamId: proof.slackTeamId });
    const operation = await identity.reserveInstallerOwner({
      kind: 'first_owner_claim', organizationId: organization.id, chickpeaRole: 'owner',
      expectedSlackTeamId: proof.slackTeamId, expectedSlackUserId: proof.slackUserId,
      capabilityHash: capabilityHash(capability), expiresAt: clock.now + 15 * 60_000,
    });
    if (through === 'reserve') return operation;
    const reconciled = await auth.chickpea.reconcileSlackIdentity({
      slackTeamId: proof.slackTeamId, slackUserId: proof.slackUserId, displayName: proof.displayName,
      organization: { name: organization.displayName, slug: `chickpea-${organization.id}` },
    });
    if (through === 'advance') {
      await identity.advanceAuthOperation({
        operationId: operation.id, capabilityHash: capabilityHash(capability), step: 1,
        betterAuthUserId: reconciled.userId, betterAuthOrganizationId: reconciled.organizationId,
        betterAuthMembershipId: reconciled.membershipId,
      });
    }
    return operation;
  };
  const stores: SqliteIdentityStore[] = [];
  const fresh = (name: string) => { const store = hostedStore(name, clock); stores.push(store); return store; };
  try {
    for (const through of ['reserve', 'reconcile', 'advance'] as const) {
      clock.now = NOW;
      const identity = fresh(`org_resume_${through}`);
      await interrupt(identity, CAPABILITY, through);
      clock.now += 60_000;
      assert.equal((await activate(identity, CAPABILITY)).ok, true, `resumes after a crash past ${through}`);
      assert.equal((await identity.getOwnerClaim())!.status, 'active');
    }

    // The same person's new attempt replaces a live or an expired reservation.
    clock.now = NOW;
    const live = fresh('org_replace_live');
    const abandoned = await interrupt(live, 'first-install-attempt-0123456789abcdef', 'advance');
    assert.equal((await activate(live, 'second-install-attempt-0123456789abcdef')).ok, true);
    assert.notEqual((await live.getOwnerClaim())!.operationId, abandoned.id);
    assert.equal((await live.getAuthOperation(abandoned.id))!.status, 'expired', 'the replaced attempt is dead');
    // Its Owner is signed in again by any later attempt, including the dead one.
    assert.equal((await activate(live, 'first-install-attempt-0123456789abcdef')).ok, true);
    const expired = fresh('org_replace_expired');
    await interrupt(expired, 'stale-install-attempt-0123456789abcdef', 'reserve');
    clock.now = NOW + 16 * 60_000;
    await assert.rejects(activate(expired, 'stale-install-attempt-0123456789abcdef'), code('auth_operation_expired'));
    assert.equal((await activate(expired, 'fresh-install-attempt-0123456789abcdef')).ok, true);

    // Another person's reservation keeps everyone else out, live or expired.
    clock.now = NOW;
    const held = fresh('org_held');
    await interrupt(held, 'holder-install-attempt-0123456789abcdef', 'reserve');
    const other: SlackOidcProof = { slackTeamId: 'TACME', slackUserId: 'UOTHER', displayName: 'Other' };
    await assert.rejects(activate(held, 'other-install-attempt-0123456789abcdef', other), code('owner_claim_conflict'));
    clock.now = NOW + 16 * 60_000;
    await assert.rejects(activate(held, 'other-retry-attempt-0123456789abcdef0', other), code('owner_claim_conflict'));
    // A capability reused for another person never resumes the first person's attempt.
    await assert.rejects(activate(held, 'holder-install-attempt-0123456789abcdef', other), code('auth_operation_conflict'));
    assert.equal(backend.database.prepare("SELECT COUNT(*) AS count FROM account WHERE accountId LIKE '%UOTHER'").get()?.count, 0,
      'a refusal starts nothing in Better Auth');
  } finally {
    for (const store of stores) store.close();
    backend.close();
  }
});

test('each installation has its own Better Auth organization, and an Owner resolves only in theirs', async () => {
  const original = hostedStore('org_acme_1');
  const reinstalled = hostedStore('org_acme_2');
  const beta = hostedStore('org_beta');
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = { backend, baseURL: ORIGIN, secret: SECRET };
  const activate = (identity: SqliteIdentityStore, proof: SlackOidcProof, capability: string) =>
    activateInstallerOwner({
      identity, environment, proof, capability,
      installGrant: { slackTeamId: proof.slackTeamId, installerSlackUserId: proof.slackUserId },
      request: new Request(`${ORIGIN}/auth/slack/install/callback`), now: () => NOW,
    });
  try {
    await activate(original, OWNER, CAPABILITY);
    // The same workspace installing again lands in a new installation.
    await activate(reinstalled, OWNER, 'reinstall-attempt-0123456789abcdef0123');
    // A proof the bot already checked is admitted too.
    await activate(beta, { slackTeamId: 'TBETA', slackUserId: 'UBETA', displayName: 'Beta Owner' },
      'beta-install-attempt-0123456789abcdef');
    const organizationOf = async (identity: SqliteIdentityStore) =>
      (await identity.ensureAuthControl()).betterAuthOrganizationId!;
    assert.notEqual(await organizationOf(original), await organizationOf(reinstalled));

    const directory = async (identity: SqliteIdentityStore) => new BetterAuthDirectory({
      backend, access: identity, organizationId: await organizationOf(identity), canonicalAdminOrigin: ORIGIN,
    });
    const operation = (await original.getAuthOperation((await original.getOwnerClaim())!.operationId))!;
    const betterAuthUser = operation.betterAuthUserId!;
    assert.equal((await (await directory(original)).resolveBetterAuthUser(betterAuthUser))?.membership.role, 'owner');
    assert.equal(await (await directory(beta)).resolveBetterAuthUser(betterAuthUser), undefined,
      "another installation's session never resolves here");
  } finally {
    for (const store of [original, reinstalled, beta]) store.close();
    backend.close();
  }
});
