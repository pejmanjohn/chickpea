import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../src/config/types.ts';
import {
  isTransientSlackApiError,
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

test('Slack transient classification covers raw transport and named service failures', async () => {
  const cases: ReadonlyArray<{
    name: string;
    error: string | undefined;
    transient: boolean;
  }> = [
    { name: 'network', error: 'slack_network_error', transient: true },
    { name: 'request timeout', error: 'slack_request_timeout', transient: true },
    { name: 'non-JSON response', error: 'slack_non_json_response', transient: true },
    { name: 'rate limit', error: 'ratelimited', transient: true },
    { name: 'synthetic 500', error: 'slack_http_500', transient: true },
    { name: 'synthetic 599', error: 'slack_http_599', transient: true },
    { name: 'Slack internal error', error: 'internal_error', transient: true },
    { name: 'Slack fatal error', error: 'fatal_error', transient: true },
    { name: 'Slack unavailable', error: 'service_unavailable', transient: true },
    { name: 'Slack request timeout', error: 'request_timeout', transient: true },
    { name: 'invalid token control', error: 'invalid_auth', transient: false },
    { name: 'missing scope control', error: 'missing_scope', transient: false },
    { name: 'missing error control', error: undefined, transient: false },
  ];

  for (const entry of cases) {
    assert.equal(
      isTransientSlackApiError(entry.error),
      entry.transient,
      entry.name,
    );
  }
});

test('Slack truth helpers preserve named JSON and synthetic transient failures', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const scenarios: ReadonlyArray<{
      name: string;
      response: () => Promise<Response>;
      expectedError: string;
    }> = [
      {
        name: 'named JSON 500',
        response: async () => Response.json(
          { ok: false, error: 'internal_error' },
          { status: 500 },
        ),
        expectedError: 'internal_error',
      },
      {
        name: 'synthetic JSON 503',
        response: async () => Response.json({ ok: false }, { status: 503 }),
        expectedError: 'slack_http_503',
      },
      {
        name: 'rate limit',
        response: async () => Response.json(
          { ok: false },
          { status: 429, headers: { 'retry-after': '2' } },
        ),
        expectedError: 'ratelimited',
      },
      {
        name: 'non-JSON response',
        response: async () => new Response('temporarily unavailable'),
        expectedError: 'slack_non_json_response',
      },
      {
        name: 'network failure',
        response: async () => {
          throw new TypeError('network down');
        },
        expectedError: 'slack_network_error',
      },
    ];

    for (const scenario of scenarios) {
      globalThis.fetch = scenario.response;
      const result = await slackIdentityAuthTest(`xoxb-${scenario.name}`);
      assert.equal(result.ok, false, scenario.name);
      assert.equal(result.error, scenario.expectedError, scenario.name);
      assert.equal(isTransientSlackApiError(result.error), true, scenario.name);
    }

    globalThis.fetch = async () => Response.json({ ok: false, error: 'invalid_auth' });
    const invalid = await slackIdentityAuthTest('xoxb-invalid');
    assert.equal(invalid.error, 'invalid_auth');
    assert.equal(isTransientSlackApiError(invalid.error), false);
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
