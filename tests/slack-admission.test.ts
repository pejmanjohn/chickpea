import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { SlackAdmissionService } from '../src/auth/slack-admission.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import type { SlackOidcGateway, SlackOidcProof } from '../src/auth/slack-oidc.ts';
import { mintSetupCapability } from '../src/auth/setup-capability.mjs';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { SlackAppCreationService, openSlackSetupTransaction } from '../src/slack/app-creation.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { buildSlackAppManifest } from '../src/slack/identity-manifest.ts';
import { SlackInstallOAuthService } from '../src/slack/install-oauth.ts';
import { REQUIRED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';

const NOW = 1_786_000_000_000;
const ORIGIN = 'https://chickpea.example';
const REDIRECT = `${ORIGIN}/auth/slack/oidc/callback`;
const BROWSER = 'browser-binding-0123456789abcdefghijklmnopqrstuvwxyz';
const SECRET = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64url');

test('first installer is reserved before Better Auth and becomes the sole exact Owner with session last', async () => {
  const fixture = await installedFixture();
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    let gatewayProofs = 0;
    const service = admissionService(fixture, backend, () => {
      gatewayProofs += 1;
      return { slackTeamId: 'TACME', slackUserId: 'UINSTALLER', displayName: 'Acme Owner' };
    });
    const started = await service.startFirstOwner({
      setupId: fixture.setup.id,
      expectedSetupRevision: fixture.setup.revision,
      browserBinding: BROWSER,
      redirectUri: REDIRECT,
      destination: '/admin/channels',
    });
    const authorization = new URL(started.authorizationUrl);
    assert.equal(authorization.origin + authorization.pathname, 'https://slack.com/openid/connect/authorize');
    assert.equal(authorization.searchParams.get('scope'), 'openid profile email');
    assert.equal(authorization.searchParams.get('team'), 'TACME');
    assert.equal(authorization.searchParams.has('code_challenge'), false);
    assert.equal(authorization.searchParams.get('scope')?.includes('email'), true);
    const attempt = await fixture.identity.getSlackOidcAttempt(started.attemptId);
    assert.ok(attempt);
    assert.equal(attempt.expectedTeamId, 'TACME');
    assert.equal(attempt.expectedSlackUserId, 'UINSTALLER');
    assert.equal(attempt.stateHash, sha256(started.state));
    assert.equal(attempt.nonceHash, sha256(started.nonce));
    assert.equal(attempt.browserHash, sha256(BROWSER));
    assert.doesNotMatch(JSON.stringify(attempt), new RegExp(started.state));
    assert.equal((await fixture.identity.getOwnerClaim()) ?? null, null,
      'Slack proof must precede the singleton authority reservation');

    const completed = await service.callback({
      purpose: 'first_owner', state: started.state, nonce: started.nonce,
      browserBinding: BROWSER, redirectUri: REDIRECT, code: 'oidc-code-secret',
      request: new Request(REDIRECT),
    });
    assert.equal(gatewayProofs, 1);
    assert.equal(completed.destination, '/admin/channels');
    assert.match(completed.sessionResponse.headers.get('set-cookie') ?? '', /better-auth\.session_token=/);
    assert.equal((await fixture.identity.getSlackSetupTransaction(fixture.setup.id))?.state, 'consumed');
    assert.equal((await fixture.identity.getOwnerClaim())?.status, 'active');
    const owner = await fixture.identity.resolveSlackIdentity('TACME', 'UINSTALLER');
    assert.equal(owner?.membership.role, 'owner');
    assert.equal(owner?.membership.status, 'active');
    assert.equal((await fixture.identity.getAuthControl())?.authMode, 'slack_active');
    assert.equal(
      backend.database.prepare('SELECT role FROM member').get()?.role,
      'member',
      'Better Auth membership never carries Chickpea Owner authority',
    );
    assert.equal(backend.database.prepare('SELECT providerId FROM account').get()?.providerId, 'slack');
    assert.match(String(backend.database.prepare('SELECT email FROM user').get()?.email), /@identity\.invalid$/);

    const replay = await service.callback({
      purpose: 'first_owner', state: started.state, nonce: started.nonce,
      browserBinding: BROWSER, redirectUri: REDIRECT, code: 'must-not-reexchange',
      request: new Request(REDIRECT),
    });
    assert.match(replay.sessionResponse.headers.get('set-cookie') ?? '', /better-auth\.session_token=/);
    assert.equal(gatewayProofs, 1, 'lost browser response retries session issuance without re-exchange');
  } finally {
    backend.close();
    fixture.close();
  }
});

test('normal login selects no user and admits only the returned active canonical Slack tuple', async () => {
  const fixture = await installedFixture();
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    const first = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'UINSTALLER', displayName: 'Owner',
    }));
    const ownerStart = await first.startFirstOwner({
      setupId: fixture.setup.id, expectedSetupRevision: fixture.setup.revision,
      browserBinding: BROWSER, redirectUri: REDIRECT,
    });
    await first.callback({
      purpose: 'first_owner', state: ownerStart.state, nonce: ownerStart.nonce,
      browserBinding: BROWSER, redirectUri: REDIRECT, code: 'owner-code',
      request: new Request(REDIRECT),
    });

    const login = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'UUNINVITED', displayName: 'Uninvited',
    }));
    const started = await login.startLogin({
      browserBinding: BROWSER, redirectUri: REDIRECT, destination: '/admin/agents',
    });
    assert.equal((await fixture.identity.getSlackOidcAttempt(started.attemptId))?.expectedSlackUserId, null);
    await assert.rejects(
      () => login.callback({
        purpose: 'login', state: started.state, nonce: started.nonce,
        browserBinding: BROWSER, redirectUri: REDIRECT, code: 'uninvited-code',
        request: new Request(REDIRECT),
      }),
      (error: unknown) => error instanceof Error &&
        'code' in error && error.code === 'user_mismatch',
    );
    assert.equal((await fixture.identity.getSlackOidcAttempt(started.attemptId))?.status, 'failed');
  } finally {
    backend.close();
    fixture.close();
  }
});

test('Sign in with Slack binds a provisioned member to the same tuple and treats email as contact data', async () => {
  const fixture = await installedFixture();
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    const ownerService = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'UINSTALLER', displayName: 'Owner',
    }));
    const ownerStart = await ownerService.startFirstOwner({
      setupId: fixture.setup.id, expectedSetupRevision: fixture.setup.revision,
      browserBinding: BROWSER, redirectUri: REDIRECT,
    });
    await ownerService.callback({
      purpose: 'first_owner', state: ownerStart.state, nonce: ownerStart.nonce,
      browserBinding: BROWSER, redirectUri: REDIRECT, code: 'owner-code',
      request: new Request(REDIRECT),
    });

    const provisioned = await fixture.identity.provisionSlackMember({
      slackTeamId: 'TACME', slackUserId: 'UMEMBER', displayName: 'Member',
      contactEmail: 'before@example.com',
    });
    const originalBindingId = provisioned.resolution.binding.id;
    assert.equal(provisioned.resolution.binding.betterAuthUserId, null);

    const memberService = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'UMEMBER', displayName: 'Member Renamed',
      contactEmail: 'after@example.com',
    }));
    const started = await memberService.startLogin({
      browserBinding: `${BROWSER}-member`, redirectUri: REDIRECT, destination: '/admin/agents',
    });
    const completed = await memberService.callback({
      purpose: 'login', state: started.state, nonce: started.nonce,
      browserBinding: `${BROWSER}-member`, redirectUri: REDIRECT, code: 'member-code',
      request: new Request(REDIRECT),
    });
    assert.equal(completed.destination, '/admin/agents');
    assert.match(completed.sessionResponse.headers.get('set-cookie') ?? '', /better-auth\.session_token=/);

    const bound = (await fixture.identity.resolveSlackIdentity('TACME', 'UMEMBER'))!;
    assert.equal(bound.binding.id, originalBindingId);
    assert.ok(bound.binding.betterAuthUserId);
    assert.ok(bound.binding.betterAuthMembershipId);
    assert.equal(bound.membership.role, 'member');
    assert.equal(bound.user.contactEmail, 'after@example.com');
    assert.equal(
      backend.database.prepare('SELECT COUNT(*) AS count FROM account WHERE accountId = ?')
        .get('slack:TACME:UMEMBER')?.count,
      1,
    );

    const replay = await memberService.callback({
      purpose: 'login', state: started.state, nonce: started.nonce,
      browserBinding: `${BROWSER}-member`, redirectUri: REDIRECT, code: 'must-not-reexchange',
      request: new Request(REDIRECT),
    });
    assert.match(replay.sessionResponse.headers.get('set-cookie') ?? '', /better-auth\.session_token=/);
  } finally {
    backend.close();
    fixture.close();
  }
});

test('an invitation admits only its exact Slack actor and consumes authority before session issuance', async () => {
  const fixture = await installedFixture();
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    const ownerService = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'UINSTALLER', displayName: 'Owner',
    }));
    const ownerStart = await ownerService.startFirstOwner({
      setupId: fixture.setup.id, expectedSetupRevision: fixture.setup.revision,
      browserBinding: BROWSER, redirectUri: REDIRECT,
    });
    await ownerService.callback({
      purpose: 'first_owner', state: ownerStart.state, nonce: ownerStart.nonce,
      browserBinding: BROWSER, redirectUri: REDIRECT, code: 'owner-code',
      request: new Request(REDIRECT),
    });
    const owner = (await fixture.identity.resolveSlackIdentity('TACME', 'UINSTALLER'))!;
    const locator = 'invitation-locator-secret-0123456789abcdef';
    const invitation = await fixture.identity.createInvitation({
      organizationId: owner.membership.organizationId,
      slackTeamId: 'TACME', slackUserId: 'UINVITEE', displayName: 'Invitee', role: 'admin',
      locatorHash: sha256(locator), inviterMembershipId: owner.membership.id,
      expiresAt: fixture.clock.now + 7 * 24 * 60 * 60_000,
    });
    const inviteService = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'UINVITEE', displayName: 'Invited Admin',
    }));
    const started = await inviteService.startInvitation({
      locator,
      browserBinding: `${BROWSER}-invite`,
      redirectUri: REDIRECT,
      destination: '/admin/team',
    });
    const attempt = await fixture.identity.getSlackOidcAttempt(started.attemptId);
    assert.equal(attempt?.purpose, 'invitation');
    assert.equal(attempt?.invitationId, invitation.id);
    assert.equal(attempt?.expectedSlackUserId, 'UINVITEE');
    const completed = await inviteService.callback({
      purpose: 'invitation', state: started.state, nonce: started.nonce,
      browserBinding: `${BROWSER}-invite`, redirectUri: REDIRECT, code: 'invite-code',
      request: new Request(REDIRECT),
    });
    assert.equal(completed.destination, '/admin/team');
    assert.match(completed.sessionResponse.headers.get('set-cookie') ?? '', /better-auth\.session_token=/);
    assert.equal((await fixture.identity.listInvitations()).find((row) => row.id === invitation.id)?.status, 'accepted');
    const admin = await fixture.identity.resolveSlackIdentity('TACME', 'UINVITEE');
    assert.equal(admin?.membership.role, 'admin');
    assert.equal(admin?.membership.status, 'active');
    assert.equal(
      backend.database.prepare('SELECT role FROM member WHERE id = ?').get(admin?.binding.betterAuthMembershipId)?.role,
      'member',
    );
  } finally {
    backend.close();
    fixture.close();
  }
});

test('a removed Admin needs a fresh invitation and exact OIDC reactivates the same binding', async () => {
  const fixture = await installedFixture();
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    const ownerService = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'UINSTALLER', displayName: 'Owner',
    }));
    const ownerStart = await ownerService.startFirstOwner({
      setupId: fixture.setup.id, expectedSetupRevision: fixture.setup.revision,
      browserBinding: BROWSER, redirectUri: REDIRECT,
    });
    await ownerService.callback({
      purpose: 'first_owner', state: ownerStart.state, nonce: ownerStart.nonce,
      browserBinding: BROWSER, redirectUri: REDIRECT, code: 'owner-code',
      request: new Request(REDIRECT),
    });
    const owner = (await fixture.identity.resolveSlackIdentity('TACME', 'UINSTALLER'))!;
    const firstLocator = 'removed-admin-first-locator-0123456789abcdef';
    await fixture.identity.createInvitation({
      organizationId: owner.membership.organizationId,
      slackTeamId: 'TACME', slackUserId: 'UREMOVED', displayName: 'Removed Admin', role: 'admin',
      locatorHash: sha256(firstLocator), inviterMembershipId: owner.membership.id,
      expiresAt: fixture.clock.now + 7 * 24 * 60 * 60_000,
    });
    const adminService = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'UREMOVED', displayName: 'Removed Admin',
    }));
    const firstStart = await adminService.startInvitation({
      locator: firstLocator, browserBinding: `${BROWSER}-removed-first`, redirectUri: REDIRECT,
    });
    await adminService.callback({
      purpose: 'invitation', state: firstStart.state, nonce: firstStart.nonce,
      browserBinding: `${BROWSER}-removed-first`, redirectUri: REDIRECT, code: 'first-admin-code',
      request: new Request(REDIRECT),
    });
    const firstResolution = (await fixture.identity.resolveSlackIdentity('TACME', 'UREMOVED'))!;
    await fixture.identity.updateMembershipAuthority({
      membershipId: firstResolution.membership.id, status: 'removed',
      actorMembershipId: owner.membership.id, authenticationSurface: 'better_auth',
      correlationId: 'remove_admin_test', reasonCode: 'owner_removed_member',
      slackTeamId: 'TACME', slackUserId: 'UREMOVED',
    });
    assert.equal((await fixture.identity.resolveSlackIdentity('TACME', 'UREMOVED'))?.membership.status, 'removed');

    const freshLocator = 'removed-admin-fresh-locator-0123456789abcdef';
    await fixture.identity.createInvitation({
      organizationId: owner.membership.organizationId,
      slackTeamId: 'TACME', slackUserId: 'UREMOVED', displayName: 'Removed Admin', role: 'admin',
      locatorHash: sha256(freshLocator), inviterMembershipId: owner.membership.id,
      expiresAt: fixture.clock.now + 7 * 24 * 60 * 60_000,
    });
    const freshStart = await adminService.startInvitation({
      locator: freshLocator, browserBinding: `${BROWSER}-removed-fresh`, redirectUri: REDIRECT,
    });
    const completed = await adminService.callback({
      purpose: 'invitation', state: freshStart.state, nonce: freshStart.nonce,
      browserBinding: `${BROWSER}-removed-fresh`, redirectUri: REDIRECT, code: 'fresh-admin-code',
      request: new Request(REDIRECT),
    });
    const reactivated = (await fixture.identity.resolveSlackIdentity('TACME', 'UREMOVED'))!;
    assert.ok(completed.sessionResponse.ok);
    assert.equal(reactivated.membership.id, firstResolution.membership.id);
    assert.equal(reactivated.binding.id, firstResolution.binding.id);
    assert.equal(reactivated.membership.role, 'admin');
    assert.equal(reactivated.membership.status, 'active');
  } finally {
    backend.close();
    fixture.close();
  }
});

test('revocation after Better Auth reconciliation tombstones authority and a fresh same-tuple invitation recovers', async () => {
  const fixture = await installedFixture();
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    const ownerService = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'UINSTALLER', displayName: 'Owner',
    }));
    const ownerStart = await ownerService.startFirstOwner({
      setupId: fixture.setup.id, expectedSetupRevision: fixture.setup.revision,
      browserBinding: BROWSER, redirectUri: REDIRECT,
    });
    await ownerService.callback({
      purpose: 'first_owner', state: ownerStart.state, nonce: ownerStart.nonce,
      browserBinding: BROWSER, redirectUri: REDIRECT, code: 'owner-code',
      request: new Request(REDIRECT),
    });
    const sessionCountBeforeInvite = backend.database.prepare('SELECT COUNT(*) AS count FROM session')
      .get()?.count;
    const owner = (await fixture.identity.resolveSlackIdentity('TACME', 'UINSTALLER'))!;
    const firstLocator = 'first-invitation-locator-0123456789abcdef';
    const firstInvite = await fixture.identity.createInvitation({
      organizationId: owner.membership.organizationId,
      slackTeamId: 'TACME', slackUserId: 'URECOVER', displayName: 'Recovering Admin', role: 'admin',
      locatorHash: sha256(firstLocator), inviterMembershipId: owner.membership.id,
      expiresAt: fixture.clock.now + 7 * 24 * 60 * 60_000,
    });
    const service = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'URECOVER', displayName: 'Recovering Admin',
    }));
    const started = await service.startInvitation({
      locator: firstLocator, browserBinding: `${BROWSER}-revoked`, redirectUri: REDIRECT,
    });
    const activate = fixture.identity.activateInvitation.bind(fixture.identity);
    let revokedAfterReconcile = false;
    fixture.identity.activateInvitation = async (input) => {
      if (!revokedAfterReconcile) {
        revokedAfterReconcile = true;
        await fixture.identity.revokeInvitation(firstInvite.id);
      }
      return activate(input);
    };
    await assert.rejects(
      () => service.callback({
        purpose: 'invitation', state: started.state, nonce: started.nonce,
        browserBinding: `${BROWSER}-revoked`, redirectUri: REDIRECT, code: 'revoked-code',
        request: new Request(REDIRECT),
      }),
      (error: unknown) => error instanceof Error && 'code' in error &&
        error.code === 'invitation_unavailable',
    );
    const failedAttempt = await fixture.identity.getSlackOidcAttempt(started.attemptId);
    assert.equal(failedAttempt?.status, 'failed');
    assert.equal((await fixture.identity.getAuthOperation(failedAttempt!.operationId!))?.status, 'tombstoned');
    assert.equal(await fixture.identity.resolveSlackIdentity('TACME', 'URECOVER'), undefined);
    assert.equal(
      backend.database.prepare('SELECT COUNT(*) AS count FROM session').get()?.count,
      sessionCountBeforeInvite,
      'failed invitation admission cannot issue an additional browser session',
    );
    assert.equal(backend.database.prepare('SELECT COUNT(*) AS count FROM account WHERE providerId = ?')
      .get('slack')?.count, 2, 'the inert composite identity remains reusable without email linking');

    fixture.identity.activateInvitation = activate;
    const freshLocator = 'fresh-invitation-locator-0123456789abcdef';
    await fixture.identity.createInvitation({
      organizationId: owner.membership.organizationId,
      slackTeamId: 'TACME', slackUserId: 'URECOVER', displayName: 'Recovering Admin', role: 'admin',
      locatorHash: sha256(freshLocator), inviterMembershipId: owner.membership.id,
      expiresAt: fixture.clock.now + 7 * 24 * 60 * 60_000,
    });
    const fresh = await service.startInvitation({
      locator: freshLocator, browserBinding: `${BROWSER}-fresh`, redirectUri: REDIRECT,
    });
    const completed = await service.callback({
      purpose: 'invitation', state: fresh.state, nonce: fresh.nonce,
      browserBinding: `${BROWSER}-fresh`, redirectUri: REDIRECT, code: 'fresh-code',
      request: new Request(REDIRECT),
    });
    assert.ok(completed.sessionResponse.ok);
    assert.equal((await fixture.identity.resolveSlackIdentity('TACME', 'URECOVER'))?.membership.status, 'active');
  } finally {
    backend.close();
    fixture.close();
  }
});

test('a copied invitation cannot admit a different Slack actor', async () => {
  const fixture = await installedFixture();
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    const ownerService = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'UINSTALLER', displayName: 'Owner',
    }));
    const ownerStart = await ownerService.startFirstOwner({
      setupId: fixture.setup.id, expectedSetupRevision: fixture.setup.revision,
      browserBinding: BROWSER, redirectUri: REDIRECT,
    });
    await ownerService.callback({
      purpose: 'first_owner', state: ownerStart.state, nonce: ownerStart.nonce,
      browserBinding: BROWSER, redirectUri: REDIRECT, code: 'owner-code', request: new Request(REDIRECT),
    });
    const owner = (await fixture.identity.resolveSlackIdentity('TACME', 'UINSTALLER'))!;
    const locator = 'copied-invitation-locator-0123456789abcdef';
    await fixture.identity.createInvitation({
      organizationId: owner.membership.organizationId,
      slackTeamId: 'TACME', slackUserId: 'UINVITED', displayName: 'Invitee', role: 'admin',
      locatorHash: sha256(locator), inviterMembershipId: owner.membership.id,
      expiresAt: fixture.clock.now + 7 * 24 * 60 * 60_000,
    });
    const attacker = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'UATTACKER', displayName: 'Attacker',
    }));
    const started = await attacker.startInvitation({
      locator, browserBinding: `${BROWSER}-attacker`, redirectUri: REDIRECT,
    });
    await assert.rejects(
      () => attacker.callback({
        purpose: 'invitation', state: started.state, nonce: started.nonce,
        browserBinding: `${BROWSER}-attacker`, redirectUri: REDIRECT, code: 'attacker-code',
        request: new Request(REDIRECT),
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'user_mismatch',
    );
    assert.equal(await fixture.identity.resolveSlackIdentity('TACME', 'UATTACKER'), undefined);
    assert.equal(backend.database.prepare('SELECT COUNT(*) AS count FROM account').get()?.count, 1);
  } finally {
    backend.close();
    fixture.close();
  }
});

test('an expired abandoned reservation can be replaced only by a fresh proof for the same installer tuple', async () => {
  const fixture = await installedFixture();
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    const abandoned = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'UINSTALLER', displayName: 'Owner',
    }));
    const started = await abandoned.startFirstOwner({
      setupId: fixture.setup.id, expectedSetupRevision: fixture.setup.revision,
      browserBinding: BROWSER, redirectUri: REDIRECT,
    });
    const leased = await fixture.identity.acquireSlackOidcAttempt({
      stateHash: sha256(started.state), browserHash: sha256(BROWSER), purpose: 'first_owner',
      redirectUri: REDIRECT, leaseExpiresAt: NOW + 10 * 60_000,
    });
    const oldOperation = await fixture.identity.admitSlackOidcAttempt({
      attemptId: leased.id, expectedLeaseGeneration: leased.leaseGeneration,
      capabilityHash: sha256(started.state), slackTeamId: 'TACME', slackUserId: 'UINSTALLER',
      expiresAt: started.expiresAt,
    });
    assert.equal((await fixture.identity.getOwnerClaim())?.operationId, oldOperation.id);

    fixture.clock.now = started.expiresAt + 1;
    const replacement = admissionService(fixture, backend, () => ({
      slackTeamId: 'TACME', slackUserId: 'UINSTALLER', displayName: 'Owner',
    }));
    const replacementStart = await replacement.startFirstOwner({
      setupId: fixture.setup.id, expectedSetupRevision: fixture.setup.revision,
      browserBinding: `${BROWSER}-replacement`, redirectUri: REDIRECT,
    });
    const completed = await replacement.callback({
      purpose: 'first_owner', state: replacementStart.state, nonce: replacementStart.nonce,
      browserBinding: `${BROWSER}-replacement`, redirectUri: REDIRECT, code: 'replacement-code',
      request: new Request(REDIRECT),
    });
    assert.ok(completed.sessionResponse.ok);
    assert.notEqual((await fixture.identity.getOwnerClaim())?.operationId, oldOperation.id);
    assert.equal((await fixture.identity.getAuthOperation(oldOperation.id))?.status, 'expired');
  } finally {
    backend.close();
    fixture.close();
  }
});

function admissionService(
  fixture: Awaited<ReturnType<typeof installedFixture>>,
  backend: NodeBetterAuthBackend,
  proof: () => SlackOidcProof,
): SlackAdmissionService {
  const gateway = {
    authorizationUrl(input: Record<string, string>) {
      const url = new URL('https://slack.com/openid/connect/authorize');
      url.search = new URLSearchParams({
        response_type: 'code', client_id: input.clientId!, scope: 'openid profile email',
        redirect_uri: input.redirectUri!, state: input.state!, nonce: input.nonce!, team: input.teamId!,
      }).toString();
      return url.toString();
    },
    async exchangeAndVerify() { return proof(); },
  } as unknown as SlackOidcGateway;
  return new SlackAdmissionService({
    identity: fixture.identity,
    credentials: fixture.credentials,
    environment: { backend, baseURL: ORIGIN, secret: SECRET },
    gateway,
    now: () => fixture.clock.now,
    randomBytes: (length) => new Uint8Array(length).fill(fixture.randomCounter++),
  });
}

async function installedFixture() {
  const clock = { now: NOW };
  const now = () => clock.now;
  const identity = new SqliteIdentityStore(':memory:', { now });
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const credentials = { state: identity, keyring: generateCredentialKeyring('key_v1') };
  const minted = await mintSetupCapability({ now });
  const opened = await openSlackSetupTransaction(identity, {
    capability: minted.capability, authority: minted, canonicalAdminOrigin: ORIGIN, now,
  });
  const app = await new SlackAppCreationService({
    identity, credentials, now,
    fetch: (async () => json({
      ok: true, app_id: 'A12345678',
      credentials: {
        client_id: '123.456', client_secret: 'client-secret-value', signing_secret: 'signing-secret-value',
      },
    })) as typeof fetch,
  }).create({
    setupId: opened.id, expectedRevision: opened.revision,
    configurationToken: 'xoxe.xoxp-fixture-token',
    manifest: buildSlackAppManifest({ kind: 'control_plane', origin: ORIGIN }),
  });
  const install = new SlackInstallOAuthService({
    identity, credentials, config, settings, now,
    randomBytes: (length) => new Uint8Array(length).fill(7),
    fetch: (async () => json({
      ok: true, access_token: 'xoxb-bot-token', token_type: 'bot',
      scope: REQUIRED_SLACK_BOT_SCOPES.join(','), bot_user_id: 'UBOT', app_id: 'A12345678',
      team: { id: 'TACME', name: 'Acme' }, authed_user: { id: 'UINSTALLER' },
    })) as typeof fetch,
    bootstrap: {
      now,
      authTest: async () => ({
        ok: true, error: undefined, appId: 'A12345678', teamId: 'TACME', teamName: 'Acme',
        botName: 'Chickpea', botUserId: 'UBOT', botId: 'BBOT',
        grantedScopes: [...REQUIRED_SLACK_BOT_SCOPES],
      }),
      botIdentityInfo: async () => ({
        ok: true, error: undefined, displayName: 'Chickpea', avatarUrl: undefined,
        appId: 'A12345678',
      }),
      usersList: async () => ({ ok: true, error: undefined, users: [], nextCursor: undefined, retryAfterMs: undefined }),
      conversationsList: async () => ({ ok: true, error: undefined, channels: [], nextCursor: undefined }),
    },
  });
  const botStart = await install.start({
    setupId: app.id, expectedSetupRevision: app.revision, browserBinding: BROWSER,
    redirectUri: `${ORIGIN}/auth/slack/install/callback`,
  });
  const waiting = await install.callback({
    state: botStart.state, browserBinding: BROWSER,
    redirectUri: `${ORIGIN}/auth/slack/install/callback`, code: 'bot-code',
  });
  assert.equal(waiting.status, 'waiting_events');
  const pending = (await identity.getSlackSetupTransaction(app.id))!;
  await identity.recordSlackEventsProof({
    setupId: pending.id, candidateRevision: pending.botCredentialRevision!,
    identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID, appId: 'A12345678', teamId: 'TACME',
    baseRevision: pending.credentialRevision!, verifiedAt: clock.now,
  });
  const installed = await install.finalizeWaitingInstallation(app.id);
  assert.equal(installed.status, 'bot_installed');
  const setup = (await identity.getSlackSetupTransaction(app.id))!;
  return {
    identity, config, settings, credentials, setup, clock, randomCounter: 10,
    close() { identity.close(); config.close(); settings.close(); },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}
