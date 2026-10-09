import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { HOSTED_SLACK_INSTALLATION_ID, WORKSPACE_SLACK_INSTALLATION_ID } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  invalidateSlackInstallationCredentialCache,
  prepareSlackCredentialBundle,
  resolveSlackInstallationCredentials,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';

/**
 * A hosted installation may hold the installing Owner's user-group token in
 * its credential bundle, beside the bot token, so Agent archive can
 * deactivate a Slack user group. Only the hosted bundle may hold it.
 */

const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_user_groups' });
const OWNER_TOKEN = 'xoxp-w16-owner-secret';

function hostedInstallation(t: TestContext) {
  const identity = new SqliteIdentityStore(':memory:');
  const keyring = generateCredentialKeyring();
  t.after(() => {
    identity.close();
    invalidateSlackInstallationCredentialCache();
  });
  const credentials = { state: identity, keyring };
  return {
    credentials,
    write: (expectedRevision: string | null, userGroupToken?: string) => writeHostedSlackBotCredentials(
      credentials, expectedRevision, {
        botToken: 'xoxb-w16-bot', botUserId: 'UBOT', appId: 'AHOSTED1', teamId: 'TTENANT1',
        grantedScopes: ['chat:write'], validatedAt: 1_800_000_000_000,
        ...(userGroupToken === undefined ? {} : { userGroupToken }),
      }),
    /** Read from the encrypted store, not the cache a write primes. */
    resolve: () => {
      invalidateSlackInstallationCredentialCache();
      return resolveSlackInstallationCredentials(HOSTED_SLACK_INSTALLATION_ID, ENV, { state: identity, keyring, env: ENV });
    },
  };
}

test('a hosted bundle keeps the installing Owner\'s user-group token beside the bot token, and a reinstall without one drops it', async (t) => {
  const tenant = hostedInstallation(t);
  assert.equal((await tenant.resolve()).userGroupToken, undefined, 'no bundle, no token');

  const granted = await tenant.write(null, OWNER_TOKEN);
  const resolved = await tenant.resolve();
  assert.equal(resolved.botToken, 'xoxb-w16-bot');
  assert.equal(resolved.userGroupToken, OWNER_TOKEN);
  assert.equal(resolved.connectionRevision, granted);

  await tenant.write(granted);
  const bare = await tenant.resolve();
  assert.equal(bare.botToken, 'xoxb-w16-bot');
  assert.equal(bare.userGroupToken, undefined);
});

test('only a hosted bundle holds a user-group token, and only beside its bot token', async (t) => {
  const { credentials } = hostedInstallation(t);
  const prepare = (identityId: string, secrets: Record<string, string>) => prepareSlackCredentialBundle(credentials, {
    identityId, identityClass: 'workspace_installation', purpose: 'connected_credentials',
    expectedActiveRevision: null, appId: 'AHOSTED1', teamId: 'TTENANT1', botUserId: 'UBOT', secrets,
  });

  await assert.rejects(prepare(WORKSPACE_SLACK_INSTALLATION_ID, {
    botToken: 'xoxb-own-app', signingSecret: 'own-app-signing-secret', userGroupToken: OWNER_TOKEN,
  }), /Only a hosted Slack installation bundle holds a user-group token/);
  await prepare(WORKSPACE_SLACK_INSTALLATION_ID, { botToken: 'xoxb-own-app', signingSecret: 'own-app-signing-secret' });

  for (const extra of ['signingSecret', 'clientId', 'clientSecret']) {
    await assert.rejects(prepare(HOSTED_SLACK_INSTALLATION_ID, {
      botToken: 'xoxb-w16-bot', userGroupToken: OWNER_TOKEN, [extra]: 'host-owned-value',
    }), /hosted Slack installation bundle holds only its bot token/, extra);
  }
  await assert.rejects(prepare(HOSTED_SLACK_INSTALLATION_ID, {
    botToken: 'xoxb-w16-bot', userGroupToken: OWNER_TOKEN, refreshToken: 'xoxe-w16',
  }), /unsupported fields/);
  await assert.rejects(prepare(HOSTED_SLACK_INSTALLATION_ID, { userGroupToken: OWNER_TOKEN }),
    /hosted Slack installation bundle holds only its bot token/, 'never without the bot token');

  // The bot token's size bound, not the 4 KiB one for app secrets.
  await prepare(HOSTED_SLACK_INSTALLATION_ID, { botToken: 'xoxb-w16-bot', userGroupToken: `xoxp-${'a'.repeat(16_379)}` });
  await assert.rejects(prepare(HOSTED_SLACK_INSTALLATION_ID, {
    botToken: 'xoxb-w16-bot', userGroupToken: `xoxp-${'a'.repeat(16_380)}`,
  }), /invalid field/);
});
