import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { SlackIdentity } from '../src/config/types.ts';
import {
  SLACK_IDENTITY_PRESENTATION_TTL_MS,
  resolveSlackIdentityExecutionContext,
  SlackIdentityUnavailableError,
  verifySlackIdentityTurnAccess,
} from '../src/slack/identity-execution.ts';
import { writeSlackIdentityCredentials } from '../src/slack/identity-credentials.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { withEnv } from './helpers/env.ts';

const IDENTITY_ID = 'slack_identity_finance';

function identity(overrides: Partial<SlackIdentity> = {}): SlackIdentity {
  return {
    id: IDENTITY_ID,
    ingressKey: 'finance_ingress_0123456789abcdef',
    kind: 'dedicated',
    lifecycle: 'connected',
    teamId: 'T_ACME',
    appId: 'A_FINANCE',
    botUserId: 'U_FINANCE',
    dmState: 'on',
    dmAgentId: 'agent_finance',
    credentialProvenance: 'stored',
    connectionRevision: 1,
    observedDisplayName: 'Finance',
    observedAt: 4_000_000_000_000,
    health: 'healthy',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function turn(): NormalizedSlackTurn {
  return {
    workspaceId: 'T_ACME',
    channelId: 'C_FINANCE',
    eventId: 'E_FINANCE',
    slackIdentityId: IDENTITY_ID,
    text: 'Review this.',
    userId: 'U_REQUESTER',
    messageTs: '1783000000.000200',
    threadTs: '1783000000.000100',
    source: 'app_mention',
    contextMode: 'thread',
  };
}

test('real identity preflight binds the app and classifies Slack authorization failures', async (t) => {
  let authStatus = 200;
  let authBody: Record<string, unknown> = {
    ok: true,
    app_id: 'A_FINANCE',
    team_id: 'T_ACME',
    team: 'Acme Inc',
    user: 'Finance',
    user_id: 'U_FINANCE',
    bot_id: 'B_FINANCE',
  };
  let conversationBody: Record<string, unknown> = {
    ok: true,
    channel: {
      id: 'C_FINANCE',
      name: 'finance',
      is_member: true,
      is_private: true,
      is_archived: false,
      is_frozen: false,
      is_im: false,
      is_mpim: false,
      is_shared: false,
      context_team_id: 'T_ACME',
    },
  };
  const server = createServer((request, response) => {
    if (request.url === '/auth.test') {
      if (authStatus === 429) response.setHeader('retry-after', '3');
      json(response, authStatus, authBody);
      return;
    }
    if (request.url === '/conversations.info') {
      json(response, 200, conversationBody);
      return;
    }
    json(response, 404, { ok: false, error: 'unknown_method' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address() as AddressInfo;
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await writeSlackIdentityCredentials(settings, IDENTITY_ID, null, {
    botToken: 'xoxb-finance',
    signingSecret: 'finance-signing-secret',
    botUserId: 'U_FINANCE',
  });
  const config = { getSlackIdentity: async () => identity() };

  await withEnv({ SLACK_API_URL: `http://127.0.0.1:${address.port}` }, async () => {
    const context = await resolveSlackIdentityExecutionContext(IDENTITY_ID, undefined, {
      config,
      settings,
    });
    assert.equal(context.botUserId, 'U_FINANCE');
    await verifySlackIdentityTurnAccess(context, turn());

    // Slack's documented auth.test response omits app_id. The bootstrap-owned
    // app binding remains valid as long as the live workspace and bot user
    // still match; only an explicit conflicting app_id is a repair condition.
    authBody = {
      ok: true,
      team_id: 'T_ACME',
      team: 'Acme Inc',
      user: 'Finance',
      user_id: 'U_FINANCE',
      bot_id: 'B_FINANCE',
    };
    const documentedAuthContext = await resolveSlackIdentityExecutionContext(
      IDENTITY_ID,
      undefined,
      { config, settings },
    );
    assert.equal(documentedAuthContext.botUserId, 'U_FINANCE');

    conversationBody = { ok: false, error: 'not_in_channel' };
    await assert.rejects(
      () => verifySlackIdentityTurnAccess(context, turn()),
      (error: unknown) => error instanceof SlackIdentityUnavailableError &&
        error.reasonCode === 'not_in_channel' && !error.retryable,
    );

    authBody = {
      ok: true,
      app_id: 'A_OTHER',
      team_id: 'T_ACME',
      user_id: 'U_FINANCE',
      bot_id: 'B_OTHER',
    };
    await assert.rejects(
      () => resolveSlackIdentityExecutionContext(IDENTITY_ID, undefined, { config, settings }),
      (error: unknown) => error instanceof SlackIdentityUnavailableError &&
        error.reasonCode === 'app_identity_mismatch' && !error.retryable,
    );

    authStatus = 429;
    authBody = { ok: false, error: 'ratelimited' };
    await assert.rejects(
      () => resolveSlackIdentityExecutionContext(IDENTITY_ID, undefined, { config, settings }),
      (error: unknown) => error instanceof SlackIdentityUnavailableError &&
        error.reasonCode === 'ratelimited' && error.retryable && error.retryAfterMs === 3_000,
    );

    authStatus = 500;
    authBody = { ok: false, error: 'internal_error' };
    await assert.rejects(
      () => resolveSlackIdentityExecutionContext(IDENTITY_ID, undefined, { config, settings }),
      (error: unknown) => error instanceof SlackIdentityUnavailableError &&
        error.reasonCode === 'internal_error' && error.retryable,
    );

    authStatus = 200;
    authBody = { ok: false, error: 'invalid_auth' };
    await assert.rejects(
      () => resolveSlackIdentityExecutionContext(IDENTITY_ID, undefined, { config, settings }),
      (error: unknown) => error instanceof SlackIdentityUnavailableError &&
        error.reasonCode === 'invalid_auth' && !error.retryable,
    );
  });
});

test('identity presentation refreshes once after its TTL and then stays cached', async (t) => {
  let userInfoCalls = 0;
  const server = createServer((request, response) => {
    if (request.url === '/auth.test') {
      json(response, 200, {
        ok: true,
        app_id: 'A_FINANCE',
        team_id: 'T_ACME',
        user: 'finance',
        user_id: 'U_FINANCE',
        bot_id: 'B_FINANCE',
      });
      return;
    }
    if (request.url === '/users.info') {
      userInfoCalls += 1;
      json(response, 200, {
        ok: true,
        user: {
          id: 'U_FINANCE',
          profile: {
            display_name: 'Finance Renamed',
            image_72: 'https://avatars.slack-edge.com/finance-renamed.png',
            api_app_id: 'A_FINANCE',
          },
        },
      });
      return;
    }
    json(response, 404, { ok: false, error: 'unknown_method' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address() as AddressInfo;
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await writeSlackIdentityCredentials(settings, IDENTITY_ID, null, {
    botToken: 'xoxb-finance',
    signingSecret: 'finance-signing-secret',
    botUserId: 'U_FINANCE',
  });

  const now = 1_800_000_000_000;
  let current = identity({
    observedDisplayName: 'Finance Before Rename',
    observedAt: now - SLACK_IDENTITY_PRESENTATION_TTL_MS - 1,
  });
  let updates = 0;
  const config = {
    getSlackIdentity: async () => current,
    updateSlackIdentity: async (
      _identityId: string,
      expectedRevision: number,
      patch: Partial<SlackIdentity>,
    ) => {
      assert.equal(expectedRevision, current.connectionRevision);
      updates += 1;
      current = {
        ...current,
        ...patch,
        connectionRevision: current.connectionRevision + 1,
        updatedAt: now,
      };
      return current;
    },
  };

  await withEnv({ SLACK_API_URL: `http://127.0.0.1:${address.port}` }, async () => {
    const refreshed = await resolveSlackIdentityExecutionContext(IDENTITY_ID, undefined, {
      config,
      settings,
      now: () => now,
    });
    assert.equal(refreshed.displayName, 'Finance Renamed');
    assert.equal(refreshed.botUserId, 'U_FINANCE');
    assert.equal(userInfoCalls, 1);
    assert.equal(updates, 1);
    assert.equal(current.observedDisplayName, 'Finance Renamed');
    assert.equal(current.observedAt, now);

    const cached = await resolveSlackIdentityExecutionContext(IDENTITY_ID, undefined, {
      config,
      settings,
      now: () => now + 1,
    });
    assert.equal(cached.displayName, 'Finance Renamed');
    assert.equal(userInfoCalls, 1, 'fresh presentation metadata must not call users.info again');
    assert.equal(updates, 1);
  });
});

function json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
