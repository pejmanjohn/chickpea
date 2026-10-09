import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  InstallationContextError,
  scopeInstallationEnv,
} from '../src/config/installation-scope.ts';
import {
  HOSTED_SLACK_INSTALLATION_ID,
  WORKSPACE_SLACK_INSTALLATION_ID,
} from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  invalidateSlackInstallationCredentialCache,
  promoteSlackCredentialBundle,
  replaceUnreadableHostedSlackBotBundle,
  resolveSlackInstallationCredentials,
  SlackCredentialRecoveryOnlyError,
  SlackCredentialUnavailableError,
  SlackInstallationCredentialRevisionError,
  stageSlackCredentialBundle,
  writeHostedSlackBotCredentials,
  type ReplaceUnreadableHostedSlackBotBundleInput,
} from '../src/slack/installation-credentials.ts';
import type { CredentialKeyring } from '../src/slack/secret-envelope.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/** The recorded replacement, if any. */
async function replacementAudit(identity: SqliteIdentityStore) {
  return (await identity.listAuditEvents(20)).find((event) =>
    (JSON.parse(event.metadataJson) as { action?: string }).action === 'slack_credentials.hosted_bundle_replaced');
}

/**
 * A hosted installation whose bot-only bundle cannot be read latches
 * recovery_only and loses Slack, Admin and sign-in. Its way out is a bot
 * grant the host verified live from an active Owner, which replaces the
 * unreadable bundle and clears the gate. A deployment keyring that fails to
 * load is the deployment's problem, not each installation's, and latches
 * nothing.
 */

const APP = 'AHOSTED1';
const TEAM = 'TTENANT1';
const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_tenant_a' });

function grant(patch: Partial<ReplaceUnreadableHostedSlackBotBundleInput> = {}): ReplaceUnreadableHostedSlackBotBundleInput {
  return {
    expectedAppId: APP, expectedTeamId: TEAM, installerSlackUserId: 'U1', botToken: 'xoxb-reconnected',
    botUserId: 'UBOT', grantedScopes: ['chat:write'], validatedAt: 1_800_000_000_000,
    correlationId: 'recovery_correlation_1', ...patch,
  };
}

/** A hosted installation with an Owner and a bot bundle written under `keyring`. */
async function installation(t: TestContext, keyring: CredentialKeyring) {
  const identity = new SqliteIdentityStore(':memory:');
  t.after(() => {
    identity.close();
    invalidateSlackInstallationCredentialCache();
  });
  const owner = await createSlackOwner(identity, { teamId: TEAM, userId: 'U1' });
  await writeHostedSlackBotCredentials({ state: identity, keyring }, null, {
    botToken: 'xoxb-original', botUserId: 'UBOT', appId: APP, teamId: TEAM,
    grantedScopes: ['chat:write'], validatedAt: 1_700_000_000_000,
  });
  return { identity, owner };
}

/** Reads the bundle with `keyring`, latching recovery_only when it cannot. */
async function latch(identity: SqliteIdentityStore, keyring: CredentialKeyring) {
  invalidateSlackInstallationCredentialCache();
  await assert.rejects(
    resolveSlackInstallationCredentials(HOSTED_SLACK_INSTALLATION_ID, ENV, { state: identity, keyring, env: ENV }),
    SlackCredentialRecoveryOnlyError,
  );
  assert.equal((await identity.getAuthControl())?.healthGate, 'recovery_only');
}

test('a lost key slot is replaced by the Owner\'s verified grant under the deployment\'s current key', async (t) => {
  const retired = generateCredentialKeyring('key_v1');
  const { identity, owner } = await installation(t, retired);
  // The deployment now holds only a newer key; the bundle's slot is gone.
  const current = generateCredentialKeyring('key_v2');
  await latch(identity, current);
  const before = await identity.getSlackCredentialControl();
  const unreadable = await identity.getActiveSlackCredentialRevision(HOSTED_SLACK_INSTALLATION_ID);

  const promoted = await replaceUnreadableHostedSlackBotBundle({ state: identity, keyring: current, env: ENV }, grant());
  assert.equal(promoted.status, 'active');
  assert.equal(promoted.botUserId, 'UBOT');
  const control = await identity.getSlackCredentialControl();
  assert.equal(control?.currentKeyId, 'key_v2');
  assert.equal(control?.rotationEpoch, (before?.rotationEpoch ?? 0) + 1, 'the epoch moved to the current key');
  assert.equal((await identity.getSlackCredentialRevision(HOSTED_SLACK_INSTALLATION_ID, unreadable!.revision))?.status,
    'tombstoned');
  assert.equal((await identity.getAuthControl())?.healthGate, 'normal', 'the gate is cleared');
  const audit = await replacementAudit(identity);
  assert.equal(audit?.reasonCode, 'key_missing');
  assert.equal(audit?.actorClass, 'slack_install_grant');
  assert.equal(audit?.actorId, owner.membership.id);
  // Slack traffic now resolves the reconnected bot.
  invalidateSlackInstallationCredentialCache();
  const resolved = await resolveSlackInstallationCredentials(
    HOSTED_SLACK_INSTALLATION_ID, ENV, { state: identity, keyring: current, env: ENV });
  assert.equal(resolved.botToken, 'xoxb-reconnected');
  assert.equal(resolved.connectionRevision, promoted.revision);
});

test('a replacement keeps the installing Owner\'s user-group token the host verified with the grant', async (t) => {
  const retired = generateCredentialKeyring('key_v1');
  const { identity } = await installation(t, retired);
  const current = generateCredentialKeyring('key_v2');
  await latch(identity, current);

  await replaceUnreadableHostedSlackBotBundle({ state: identity, keyring: current, env: ENV },
    grant({ userGroupToken: 'xoxp-w16-owner-secret' }));
  invalidateSlackInstallationCredentialCache();
  const resolved = await resolveSlackInstallationCredentials(
    HOSTED_SLACK_INSTALLATION_ID, ENV, { state: identity, keyring: current, env: ENV });
  assert.equal(resolved.botToken, 'xoxb-reconnected');
  assert.equal(resolved.userGroupToken, 'xoxp-w16-owner-secret');
});

test('a bundle that no longer decrypts is replaced under the same key without a rotation', async (t) => {
  const original = generateCredentialKeyring('key_v1');
  const { identity } = await installation(t, original);
  // Same key ID, different material: the envelope fails to open.
  const replaced = { ...generateCredentialKeyring('key_v1') };
  await latch(identity, replaced);
  const before = await identity.getSlackCredentialControl();

  await replaceUnreadableHostedSlackBotBundle({ state: identity, keyring: replaced, env: ENV }, grant());
  const control = await identity.getSlackCredentialControl();
  assert.equal(control?.rotationEpoch, before?.rotationEpoch, 'no rotation');
  assert.equal((await replacementAudit(identity))?.reasonCode, 'decrypt_failed');
  invalidateSlackInstallationCredentialCache();
  assert.equal((await resolveSlackInstallationCredentials(
    HOSTED_SLACK_INSTALLATION_ID, ENV, { state: identity, keyring: replaced, env: ENV })).botToken, 'xoxb-reconnected');
});

test('a replacement interrupted after its promotion is completed by the next grant', async (t) => {
  const original = generateCredentialKeyring('key_v1');
  const { identity } = await installation(t, original);
  const replaced = { ...generateCredentialKeyring('key_v1') };
  await latch(identity, replaced);
  const unreadable = await identity.getActiveSlackCredentialRevision(HOSTED_SLACK_INSTALLATION_ID);
  // The promotion landed; the audit and the gate did not.
  const promoted = await writeHostedSlackBotCredentials({ state: identity, keyring: replaced }, unreadable!.revision, {
    botToken: 'xoxb-promoted', botUserId: 'UBOT', appId: APP, teamId: TEAM,
    grantedScopes: ['chat:write'], validatedAt: 1_800_000_000_000,
  });
  assert.equal((await identity.getAuthControl())?.healthGate, 'recovery_only');

  const kept = await replaceUnreadableHostedSlackBotBundle({ state: identity, keyring: replaced, env: ENV }, grant());
  assert.equal(kept.revision, promoted, 'the readable bundle is kept');
  assert.equal((await identity.getAuthControl())?.healthGate, 'normal');
  assert.equal((await replacementAudit(identity))?.reasonCode, 'replacement_completed');
  invalidateSlackInstallationCredentialCache();
  assert.equal((await resolveSlackInstallationCredentials(
    HOSTED_SLACK_INSTALLATION_ID, ENV, { state: identity, keyring: replaced, env: ENV })).botToken, 'xoxb-promoted');
});

test('a replacement interrupted after moving the epoch replaces the bundle under the current key', async (t) => {
  const retired = generateCredentialKeyring('key_v1');
  const { identity } = await installation(t, retired);
  const current = generateCredentialKeyring('key_v2');
  await latch(identity, current);
  const control = await identity.getSlackCredentialControl();
  await identity.beginSlackCredentialRotation({
    expectedEpoch: control!.rotationEpoch, expectedCurrentKeyId: 'key_v1', nextKeyId: 'key_v2',
  });
  await replaceUnreadableHostedSlackBotBundle({ state: identity, keyring: current, env: ENV }, grant());
  assert.equal((await identity.getSlackCredentialControl())?.rotationEpoch, control!.rotationEpoch + 1, 'moved once');
  assert.equal((await identity.getAuthControl())?.healthGate, 'normal');
  assert.equal((await replacementAudit(identity))?.reasonCode, 'key_missing');
  invalidateSlackInstallationCredentialCache();
  assert.equal((await resolveSlackInstallationCredentials(
    HOSTED_SLACK_INSTALLATION_ID, ENV, { state: identity, keyring: current, env: ENV })).botToken, 'xoxb-reconnected');
});

test('the replacement refuses everything but an unreadable bundle of this app and team, reconnected by an active Owner', async (t) => {
  const retired = generateCredentialKeyring('key_v1');
  const current = generateCredentialKeyring('key_v2');
  const { identity, owner } = await installation(t, retired);
  const dependencies = { state: identity, keyring: current, env: ENV };
  const refused = (reason: RegExp, input = grant()) => assert.rejects(
    replaceUnreadableHostedSlackBotBundle(dependencies, input),
    (error: unknown) => error instanceof SlackInstallationCredentialRevisionError && reason.test(error.message),
  );
  const notOwner = /active Owner/;

  // Outside recovery_only.
  await refused(/not waiting for Slack recovery/);
  await latch(identity, current);
  await assert.rejects(
    replaceUnreadableHostedSlackBotBundle({ ...dependencies, env: {} }, grant()), InstallationContextError);
  await assert.rejects(
    replaceUnreadableHostedSlackBotBundle(dependencies, grant({ correlationId: 'short' })), /correlation/);
  // Another app or team than the bundle's.
  await refused(/another Slack app or workspace/, grant({ expectedAppId: 'AOTHERAPP' }));
  await refused(notOwner, grant({ expectedTeamId: 'TOTHER' }));
  // Someone who is not an active Owner here.
  await refused(notOwner, grant({ installerSlackUserId: 'U2' }));
  const member = await identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId: 'U3', displayName: 'Member' });
  assert.equal(member.resolution.membership.role, 'member');
  await refused(notOwner, grant({ installerSlackUserId: 'U3' }));
  await identity.updateMembershipAuthority({
    membershipId: owner.membership.id, status: 'suspended', authenticationSurface: 'slack_event',
    correlationId: 'EvSuspend', reasonCode: 'slack_user_deactivated', idempotencyKey: 'suspend-owner',
    slackTeamId: TEAM, slackUserId: 'U1', credentialRevision: 'gateway:test',
  });
  await refused(notOwner);
  // Nothing changed on the way.
  assert.equal((await identity.getAuthControl())?.healthGate, 'recovery_only');
  assert.equal((await identity.listLiveSlackCredentialRevisions()).length, 1);
});

test('a gate latched over a readable bundle is cleared without replacing it', async (t) => {
  const keyring = generateCredentialKeyring('key_v1');
  const { identity } = await installation(t, keyring);
  // Latched while a key slot was missing, then the slot came back.
  const control = await identity.ensureAuthControl();
  await identity.updateAuthControl({ expectedRevision: control.revision, healthGate: 'recovery_only' });
  const before = await identity.getActiveSlackCredentialRevision(HOSTED_SLACK_INSTALLATION_ID);
  const kept = await replaceUnreadableHostedSlackBotBundle({ state: identity, keyring, env: ENV }, grant());
  assert.equal(kept.revision, before?.revision);
  assert.equal((await identity.getAuthControl())?.healthGate, 'normal');
  assert.equal((await replacementAudit(identity))?.reasonCode, 'replacement_completed');
  invalidateSlackInstallationCredentialCache();
  assert.equal((await resolveSlackInstallationCredentials(
    HOSTED_SLACK_INSTALLATION_ID, ENV, { state: identity, keyring, env: ENV })).botToken, 'xoxb-original');
});

test('credentials for another workspace or a standalone app in the store are never replaced as recovery', async (t) => {
  // The Owner is this installation's, but the bundle names another workspace.
  const identity = new SqliteIdentityStore(':memory:');
  t.after(() => {
    identity.close();
    invalidateSlackInstallationCredentialCache();
  });
  await createSlackOwner(identity, { teamId: TEAM, userId: 'U1' });
  const retired = generateCredentialKeyring('key_v1');
  await writeHostedSlackBotCredentials({ state: identity, keyring: retired }, null, {
    botToken: 'xoxb-elsewhere', botUserId: 'UBOT', appId: APP, teamId: 'TBUNDLE',
    grantedScopes: ['chat:write'], validatedAt: 1_700_000_000_000,
  });
  const current = generateCredentialKeyring('key_v2');
  await latch(identity, current);
  await assert.rejects(
    replaceUnreadableHostedSlackBotBundle({ state: identity, keyring: current, env: ENV }, grant()),
    /another Slack app or workspace/,
  );

  // A standalone credential in an installation's store is not this installation's to replace.
  const own = await installation(t, retired);
  const standalone = await stageSlackCredentialBundle({ state: own.identity, keyring: retired }, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
    purpose: 'connected_credentials', expectedActiveRevision: null, appId: APP, teamId: TEAM,
    secrets: { signingSecret: 'secret', botToken: 'xoxb-standalone' },
  });
  await promoteSlackCredentialBundle({ state: own.identity, keyring: retired }, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: standalone.revision, expectedActiveRevision: null,
  });
  await latch(own.identity, current);
  await assert.rejects(
    replaceUnreadableHostedSlackBotBundle({ state: own.identity, keyring: current, env: ENV }, grant()),
    /another Slack app or workspace/,
  );
});

test('a deployment keyring that fails to load stops hosted service without latching recovery; standalone still latches', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-keyring-load-'));
  const previous = process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH;
  const broken = join(directory, 'keyring.json');
  writeFileSync(broken, 'not a keyring', { mode: 0o600 });
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = broken;
  t.after(() => {
    if (previous === undefined) delete process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH;
    else process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const hosted = await installation(t, generateCredentialKeyring('key_v1'));
  await assert.rejects(
    resolveSlackInstallationCredentials(HOSTED_SLACK_INSTALLATION_ID, ENV, { state: hosted.identity, env: ENV }),
    SlackCredentialUnavailableError,
  );
  assert.equal((await hosted.identity.getAuthControl())?.healthGate, 'normal', 'the installation is not locked');
  // A caller that passes no env still finds the deployment serving many in its own variables.
  const previousTenancy = process.env.CHICKPEA_TENANCY;
  process.env.CHICKPEA_TENANCY = 'installation';
  try {
    await assert.rejects(
      resolveSlackInstallationCredentials(HOSTED_SLACK_INSTALLATION_ID, undefined, { state: hosted.identity }),
      SlackCredentialUnavailableError,
    );
  } finally {
    if (previousTenancy === undefined) delete process.env.CHICKPEA_TENANCY;
    else process.env.CHICKPEA_TENANCY = previousTenancy;
  }
  assert.equal((await hosted.identity.getAuthControl())?.healthGate, 'normal');

  const standalone = new SqliteIdentityStore(':memory:');
  t.after(() => standalone.close());
  const keyring = generateCredentialKeyring('key_v1');
  const bundle = await stageSlackCredentialBundle({ state: standalone, keyring }, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
    purpose: 'connected_credentials', expectedActiveRevision: null, appId: 'A1', teamId: 'T1',
    secrets: { signingSecret: 'secret', botToken: 'xoxb-standalone' },
  });
  await promoteSlackCredentialBundle({ state: standalone, keyring }, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: bundle.revision, expectedActiveRevision: null,
  });
  invalidateSlackInstallationCredentialCache();
  await assert.rejects(
    resolveSlackInstallationCredentials(WORKSPACE_SLACK_INSTALLATION_ID, undefined, { state: standalone }),
    SlackCredentialRecoveryOnlyError,
  );
  assert.equal((await standalone.getAuthControl())?.healthGate, 'recovery_only');
});
