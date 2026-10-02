import assert from 'node:assert/strict';
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

function request(): Request {
  return new Request(`${ORIGIN}/auth/slack/install/callback`);
}

test('the installer becomes the first Owner and is signed in, and a retry resumes the same claim', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = { backend, baseURL: ORIGIN, secret: SECRET };
  try {
    const activate = (overrides: Partial<Parameters<typeof activateInstallerOwner>[0]> = {}) =>
      activateInstallerOwner({
        identity, environment, proof: OWNER, installGrant: GRANT, capability: CAPABILITY,
        request: request(), now: () => NOW, ...overrides,
      });

    // The grant must name the person who signed in, in the same workspace.
    await assert.rejects(
      activate({ installGrant: { slackTeamId: 'TACME', installerSlackUserId: 'USOMEONE' } }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'user_mismatch',
    );
    await assert.rejects(
      activate({ installGrant: { slackTeamId: 'TOTHER', installerSlackUserId: 'UINSTALLER' } }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'user_mismatch',
    );
    assert.equal(await identity.getOwnerClaim(), undefined, 'a refused grant writes nothing');

    const first = await activate();
    assert.equal(first.ok, true);
    assert.match(first.headers.get('set-cookie') ?? '', /session_token/);
    const claim = (await identity.getOwnerClaim())!;
    assert.equal(claim.status, 'active');
    const membership = (await identity.getMembership(claim.membershipId!))!;
    assert.equal(membership.role, 'owner');
    const control = await identity.ensureAuthControl();
    assert.equal(control.authMode, 'slack_active');
    assert.equal(control.canonicalAdminOrigin, ORIGIN);

    // A retry with the same install attempt signs the same Owner in again.
    const retried = await activate();
    assert.equal(retried.ok, true);
    assert.equal((await identity.getOwnerClaim())!.membershipId, claim.membershipId);
    assert.equal((await identity.listMemberships()).length, 1);

    // Nobody else can claim the installation afterwards, even with their own grant.
    await assert.rejects(activate({
      proof: { ...OWNER, slackUserId: 'USECOND' },
      installGrant: { slackTeamId: 'TACME', installerSlackUserId: 'USECOND' },
      capability: 'another-install-attempt-0123456789abcdef',
    }));
    assert.equal((await identity.listMemberships()).length, 1);
    // An installation is never re-pinned to another Admin origin.
    await assert.rejects(activate({ environment: { ...environment, baseURL: 'https://elsewhere.example' } }),
      /pinned to another Admin origin/);
  } finally {
    identity.close();
    backend.close();
  }
});

test('a signed-in Owner resolves only in the installation that admitted them', async () => {
  const tenantA = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const tenantB = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = { backend, baseURL: ORIGIN, secret: SECRET };
  try {
    await activateInstallerOwner({
      identity: tenantA, environment, proof: OWNER, installGrant: GRANT, capability: CAPABILITY,
      request: request(), now: () => NOW,
    });
    await activateInstallerOwner({
      identity: tenantB, environment,
      proof: { slackTeamId: 'TBETA', slackUserId: 'UBETA', displayName: 'Beta Owner' },
      installGrant: { slackTeamId: 'TBETA', installerSlackUserId: 'UBETA' },
      capability: 'beta-install-attempt-0123456789abcdef', request: request(), now: () => NOW,
    });
    const directory = async (identity: SqliteIdentityStore) => new BetterAuthDirectory({
      backend,
      access: identity,
      organizationId: (await identity.ensureAuthControl()).betterAuthOrganizationId!,
      canonicalAdminOrigin: ORIGIN,
    });
    const ownerA = (await tenantA.resolveBetterAuthIdentity(
      (await tenantA.getAuthOperation((await tenantA.getOwnerClaim())!.operationId))!.betterAuthUserId!,
    ))!;
    const betterAuthUserA = ownerA.binding.betterAuthUserId!;
    assert.equal((await (await directory(tenantA)).resolveBetterAuthUser(betterAuthUserA))?.membership.role, 'owner');
    assert.equal(await (await directory(tenantB)).resolveBetterAuthUser(betterAuthUserA), undefined,
      "another installation's session never resolves here");
  } finally {
    tenantA.close();
    tenantB.close();
    backend.close();
  }
});
