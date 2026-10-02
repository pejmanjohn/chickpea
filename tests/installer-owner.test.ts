import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

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
  } finally {
    identity.close();
    backend.close();
  }
});

test('an interrupted activation resumes while live and is replaced by a new attempt after it expires', async () => {
  const clock = { now: NOW };
  const identity = hostedStore('org_acme', clock);
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = { backend, baseURL: ORIGIN, secret: SECRET };
  const activate = (capability: string) => activateInstallerOwner({
    identity, environment, proof: OWNER, installGrant: GRANT, capability,
    request: new Request(`${ORIGIN}/auth/slack/install/callback`), now: () => clock.now,
  });
  // What a crash right after the reservation leaves behind.
  const interrupt = async (capability: string) => identity.reserveInstallerOwner({
    kind: 'first_owner_claim', organizationId: (await identity.ensureOrganization({
      displayName: 'Chickpea', slackTeamId: 'TACME',
    })).id,
    expectedSlackTeamId: 'TACME', expectedSlackUserId: 'UINSTALLER', chickpeaRole: 'owner',
    capabilityHash: createHash('sha256').update(capability).digest('hex'),
    expiresAt: clock.now + 15 * 60_000,
  });
  try {
    await interrupt(CAPABILITY);
    clock.now += 60_000;
    assert.equal((await activate(CAPABILITY)).ok, true, 'a retry inside the window resumes the reservation');
    assert.equal((await identity.getOwnerClaim())!.status, 'active');
  } finally {
    identity.close();
  }

  const expired = hostedStore('org_beta', clock);
  try {
    const stale = 'stale-install-attempt-0123456789abcdef';
    clock.now = NOW;
    const staleReservation = await expired.reserveInstallerOwner({
      kind: 'first_owner_claim',
      organizationId: (await expired.ensureOrganization({ displayName: 'Chickpea', slackTeamId: 'TACME' })).id,
      expectedSlackTeamId: 'TACME', expectedSlackUserId: 'UINSTALLER', chickpeaRole: 'owner',
      capabilityHash: createHash('sha256').update(stale).digest('hex'), expiresAt: NOW + 15 * 60_000,
    });
    clock.now = NOW + 16 * 60_000;
    const retry = (capability: string) => activateInstallerOwner({
      identity: expired, environment, proof: OWNER, installGrant: GRANT, capability,
      request: new Request(`${ORIGIN}/auth/slack/install/callback`), now: () => clock.now,
    });
    await assert.rejects(retry(stale), code('auth_operation_expired'));
    assert.equal((await retry('fresh-install-attempt-0123456789abcdef')).ok, true,
      'a new attempt replaces the stale reservation for the same person');
    const claim = (await expired.getOwnerClaim())!;
    assert.equal(claim.status, 'active');
    assert.notEqual(claim.operationId, staleReservation.id);
  } finally {
    expired.close();
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
