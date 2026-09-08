import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WORKSPACE_SLACK_INSTALLATION_ID } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  invalidateSlackInstallationCredentialCache,
  promoteSlackCredentialBundle,
  resolveSlackControlPlaneAppCredentials,
  resolveSlackInstallationCredentials,
  stageSlackCredentialBundle,
  writeSlackInstallationCredentials,
} from '../src/slack/installation-credentials.ts';
import {
  decryptSlackSecretEnvelope,
  encryptSlackSecretEnvelope,
} from '../src/slack/secret-envelope.ts';
import { withEnv } from './helpers/env.ts';

test('Slack credential envelopes authenticate their immutable installation context', async () => {
  const keyring = generateCredentialKeyring('key_primary');
  const context = {
    deploymentId: 'deployment_immutable',
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    identityClass: 'workspace_installation' as const,
    appId: 'AAPP',
    teamId: 'TACME',
    purpose: 'connected_credentials' as const,
    revision: 'revision_1',
  };
  const secrets = { botToken: 'xoxb-secret', signingSecret: 'signing-secret' };
  const envelope = await encryptSlackSecretEnvelope(keyring, context, secrets);
  assert.deepEqual(await decryptSlackSecretEnvelope(keyring, context, envelope), secrets);
  await assert.rejects(
    decryptSlackSecretEnvelope(keyring, { ...context, teamId: 'TOTHER' }, envelope),
  );
  await assert.rejects(
    decryptSlackSecretEnvelope(generateCredentialKeyring('key_other'), context, envelope),
  );
});

test('one encrypted workspace installation is the only runtime credential source', async () => {
  const state = new SqliteIdentityStore(':memory:');
  const keyring = generateCredentialKeyring('key_runtime');
  const dependencies = { state, keyring };
  try {
    const revision = await writeSlackInstallationCredentials(
      dependencies,
      WORKSPACE_SLACK_INSTALLATION_ID,
      null,
      {
        botToken: 'xoxb-state',
        signingSecret: 'state-signing-secret',
        botUserId: 'UBOT',
        appId: 'AAPP',
        teamId: 'TACME',
      },
    );
    await withEnv({
      SLACK_BOT_TOKEN: 'xoxb-conflicting-env',
      SLACK_SIGNING_SECRET: 'conflicting-env-secret',
      SLACK_BOT_USER_ID: 'UENV',
    }, async () => {
      assert.deepEqual(
        await resolveSlackInstallationCredentials(
          WORKSPACE_SLACK_INSTALLATION_ID,
          undefined,
          dependencies,
        ),
        {
          botToken: 'xoxb-state',
          signingSecret: 'state-signing-secret',
          botUserId: 'UBOT',
          connectionRevision: revision,
        },
      );
    });
    await assert.rejects(
      writeSlackInstallationCredentials(
        dependencies,
        'slack_identity_extra',
        null,
        { botToken: 'xoxb-extra', signingSecret: 'extra-signing-secret' },
      ),
      /Unknown Slack installation/,
    );
  } finally {
    invalidateSlackInstallationCredentialCache();
    state.close();
  }
});

test('the connected revision retains the app credentials used by OAuth', async () => {
  const state = new SqliteIdentityStore(':memory:');
  const keyring = generateCredentialKeyring('key_oauth');
  const dependencies = { state, keyring };
  try {
    const app = await stageSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID,
      identityClass: 'workspace_installation',
      purpose: 'app_credentials',
      expectedActiveRevision: null,
      appId: 'AAPP',
      teamId: null,
      manifestFingerprint: 'manifest-v1',
      secrets: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        signingSecret: 'signing-secret',
      },
    });
    await promoteSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID,
      candidateRevision: app.revision,
      expectedActiveRevision: null,
    });
    const connected = await stageSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID,
      identityClass: 'workspace_installation',
      purpose: 'connected_credentials',
      expectedActiveRevision: app.revision,
      appId: 'AAPP',
      teamId: 'TACME',
      botUserId: 'UBOT',
      manifestFingerprint: 'manifest-v1',
      secrets: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        signingSecret: 'signing-secret',
        botToken: 'xoxb-connected',
      },
    });
    await promoteSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID,
      candidateRevision: connected.revision,
      expectedActiveRevision: app.revision,
    });
    assert.deepEqual(await resolveSlackControlPlaneAppCredentials(dependencies), {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      signingSecret: 'signing-secret',
      connectionRevision: connected.revision,
      appId: 'AAPP',
      teamId: 'TACME',
    });
  } finally {
    invalidateSlackInstallationCredentialCache();
    state.close();
  }
});
