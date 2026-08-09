import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../src/config/types.ts';
import {
  slackBotIdentityInfo,
  slackConversationsList,
  slackIdentityAuthTest,
} from '../src/slack/credentials.ts';
import {
  invalidateSlackIdentityCredentialCache,
  resolveSlackIdentityCredentials,
  writeSlackIdentityCredentials,
} from '../src/slack/identity-credentials.ts';
import { withEnv } from './helpers/env.ts';

test('bounded Slack identity helpers degrade when Slack never settles', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () => new Promise<Response>(() => {});

    const startedAt = Date.now();
    const identity = await slackBotIdentityInfo('xoxb-timeout', 'U_BOT', { timeoutMs: 20 });
    assert.equal(identity.ok, false);
    assert.equal(identity.error, 'slack_request_timeout');
    assert.ok(Date.now() - startedAt < 250, 'deadline should bound a fetch that never settles');

    const auth = await slackIdentityAuthTest('xoxb-timeout', { timeoutMs: 20 });
    assert.equal(auth.ok, false);
    assert.equal(auth.error, 'slack_request_timeout');

    const channels = await slackConversationsList('xoxb-timeout', { timeoutMs: 20 });
    assert.equal(channels.ok, false);
    assert.equal(channels.error, 'slack_request_timeout');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('identity credential resolution preserves the default path and isolates dedicated revisions', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const financeRevision = await writeSlackIdentityCredentials(
      settings,
      'slack_identity_finance',
      null,
      {
        botToken: 'xoxb-finance-v1',
        signingSecret: 'finance-secret-v1',
        botUserId: 'U_FINANCE',
      },
    );
    const supportRevision = await writeSlackIdentityCredentials(
      settings,
      'slack_identity_support',
      null,
      {
        botToken: 'xoxb-support',
        signingSecret: 'support-secret',
        botUserId: 'U_SUPPORT',
      },
    );

    await withEnv(
      {
        SLACK_BOT_TOKEN: 'xoxb-default-env',
        SLACK_SIGNING_SECRET: 'default-env-secret',
        SLACK_BOT_USER_ID: 'U_DEFAULT_ENV',
      },
      async () => {
        assert.deepEqual(
          await resolveSlackIdentityCredentials(
            WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
            undefined,
            settings,
          ),
          {
            botToken: 'xoxb-default-env',
            signingSecret: 'default-env-secret',
            botUserId: 'U_DEFAULT_ENV',
            connectionRevision: null,
          },
        );
        assert.deepEqual(
          await resolveSlackIdentityCredentials(
            'slack_identity_finance',
            undefined,
            settings,
          ),
          {
            botToken: 'xoxb-finance-v1',
            signingSecret: 'finance-secret-v1',
            botUserId: 'U_FINANCE',
            connectionRevision: financeRevision,
          },
        );
      },
    );

    const financeRevision2 = await writeSlackIdentityCredentials(
      settings,
      'slack_identity_finance',
      financeRevision,
      {
        botToken: 'xoxb-finance-v2',
        signingSecret: 'finance-secret-v2',
        botUserId: 'U_FINANCE',
      },
    );
    assert.deepEqual(
      await resolveSlackIdentityCredentials('slack_identity_finance', undefined, settings),
      {
        botToken: 'xoxb-finance-v2',
        signingSecret: 'finance-secret-v2',
        botUserId: 'U_FINANCE',
        connectionRevision: financeRevision2,
      },
    );
    assert.equal(
      (
        await resolveSlackIdentityCredentials(
          'slack_identity_support',
          undefined,
          settings,
        )
      ).connectionRevision,
      supportRevision,
    );
    assert.equal(
      (
        await resolveSlackIdentityCredentials(
          'slack_identity_support',
          undefined,
          settings,
        )
      ).botToken,
      'xoxb-support',
    );
  } finally {
    invalidateSlackIdentityCredentialCache(settings);
    settings.close();
  }
});
