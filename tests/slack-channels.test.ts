import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import {
  WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  type CustomAgentConfig,
} from '../src/config/types.ts';
import { invalidateSlackChannelsCache } from '../src/slack/channels.ts';
import {
  invalidateStoredSlackCredentials,
  invalidateStoredSlackPublicUrl,
  readStoredSlackTeamInfo,
  readSlackConnectionRevision,
  resolveSlackCredentials,
  resolveSlackPublicUrl,
  SLACK_SETTING_KEYS,
} from '../src/slack/credentials.ts';
import { writeSlackIdentityCredentials } from '../src/slack/identity-credentials.ts';
import { renderSlackConfigureLink } from '../src/slack/message-format.ts';
import { recordPendingSlackChallenge } from '../src/slack/identity-handshake.ts';
import { FakeSlackBackend, type FakeSlackBackendConfig } from './parity/fake-slack.ts';
import { withEnv } from './helpers/env.ts';
import { loopbackListenSkipReason } from './helpers/listen.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const ADMIN_TOKEN = 'channels-admin-token';

// Keep the wizard/channels tests hermetic against the developer's shell — no
// ambient Slack creds should affect encrypted credential resolution.
const NO_SLACK_ENV: NodeJS.ProcessEnv = {
  SLACK_BOT_TOKEN: undefined,
  SLACK_SIGNING_SECRET: undefined,
  SLACK_BOT_USER_ID: undefined,
  SLACK_API_URL: undefined,
  SLACK_TAG_PUBLIC_URL: undefined,
};

function auth(): Record<string, string> {
  return testAdminHeaders(ADMIN_TOKEN);
}

function agent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: 'agent_channels',
    revision: 1,
    name: 'Channels Agent',
    instructions: 'Answer with channel context.',
    enabled: true,
    model: 'local-stub/channels',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...overrides,
  };
}

function appWith(settings: SqliteSettingsStore, store?: SqliteConfigStore): Hono {
  const app = new Hono();
  app.route('/', createAdminRoutes({ settings, store, ...testAdminAuthority(ADMIN_TOKEN) }));
  return app;
}

async function connectSlack(
  settings: SqliteSettingsStore,
  input: {
    botToken?: string;
    signingSecret?: string;
    botUserId?: string;
    appId?: string;
    teamId?: string;
    teamName?: string;
  } = {},
): Promise<void> {
  await writeSlackIdentityCredentials(
    settings,
    WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    null,
    {
      botToken: input.botToken ?? 'xoxb-acme',
      signingSecret: input.signingSecret ?? 'acme-signing-secret',
      botUserId: input.botUserId ?? 'UACME',
      appId: input.appId ?? 'A0ACME',
      teamId: input.teamId ?? 'TACME',
    },
  );
  if (input.teamName) {
    await settings.setSetting(SLACK_SETTING_KEYS.teamName, input.teamName);
  }
}

function getJson(app: Hono, path: string): Promise<Response> {
  return Promise.resolve(app.request(path, { headers: auth() }));
}

function putAssignment(app: Hono, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request('/admin/api/assignments', {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** Run `fn` with a fake Slack backend on loopback and SLACK_API_URL pointed at it. */
async function withFake(
  config: FakeSlackBackendConfig,
  fn: (backend: FakeSlackBackend) => Promise<void>,
): Promise<void> {
  const backend = new FakeSlackBackend(config);
  const fake = await backend.listen();
  try {
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: `${fake.url}/api/` }, async () => {
      await fn(backend);
    });
  } finally {
    await fake.close();
    invalidateStoredSlackCredentials();
    invalidateSlackChannelsCache();
  }
}

// --- 1. Team persistence + backfill -----------------------------------------

test('wizard POST persists the connected team id + name, and the connection GET exposes them', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) return t.skip(skip);

  await withFake(
    {
      slack: {
        identity: {
          appId: 'A0ACME', teamId: 'TACME', teamName: 'Acme Inc', botUserId: 'U0BOT',
        },
      },
    },
    async () => {
      const settings = new SqliteSettingsStore(':memory:');
      const store = new SqliteConfigStore(':memory:');
      try {
        const app = appWith(settings, store);
        const timestamp = String(Math.floor(Date.now() / 1_000));
        const challengeBody = JSON.stringify({
          type: 'url_verification',
          challenge: 'channels-wizard-proof',
          api_app_id: 'A0ACME',
          team_id: 'TACME',
        });
        const signature = `v0=${createHmac('sha256', 'acme-secret')
          .update(`v0:${timestamp}:${challengeBody}`)
          .digest('hex')}`;
        const identity = await store.getSlackIdentity('slack_identity_default');
        const challenged = await recordPendingSlackChallenge(settings, identity, {
          rawBody: challengeBody,
          timestamp,
          signature,
        });
        assert.equal(challenged.accepted, true);
        const saved = await app.request('/admin/api/slack-connection', {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ botToken: 'xoxb-acme', signingSecret: 'acme-secret' }),
        });
        assert.equal(saved.status, 200, await saved.clone().text());
        const savedBody = (await saved.json()) as Record<string, unknown>;
        assert.equal(savedBody.teamId, 'TACME');
        assert.equal(savedBody.team, 'Acme Inc');

        assert.equal((await readStoredSlackTeamInfo(undefined, settings)).teamId, 'TACME');
        assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.teamName), 'Acme Inc');

        const conn = await getJson(app, '/admin/api/slack-connection');
        const connBody = (await conn.json()) as Record<string, unknown>;
        assert.equal(connBody.teamId, 'TACME');
        assert.equal(connBody.teamName, 'Acme Inc');
      } finally {
        store.close();
        settings.close();
      }
    },
  );
});

test('encrypted workspace credentials rotate atomically and disconnect tombstones the live revision', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) return t.skip(skip);

  await withFake(
    {
      slack: {
        identity: {
          appId: 'A0ACME', teamId: 'TACME', teamName: 'Acme Inc', botUserId: 'U0BOT',
        },
      },
    },
    async () => {
      const settings = new SqliteSettingsStore(':memory:');
      const store = new SqliteConfigStore(':memory:');
      try {
        const app = appWith(settings, store);
        const timestamp = String(Math.floor(Date.now() / 1_000));
        const challengeBody = JSON.stringify({
          type: 'url_verification',
          challenge: 'channels-rotation-proof',
          api_app_id: 'A0ACME',
          team_id: 'TACME',
        });
        const signature = `v0=${createHmac('sha256', 'acme-secret')
          .update(`v0:${timestamp}:${challengeBody}`)
          .digest('hex')}`;
        const identity = await store.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
        assert.equal((await recordPendingSlackChallenge(settings, identity, {
          rawBody: challengeBody, timestamp, signature,
        })).accepted, true);

        const first = await app.request('/admin/api/slack-connection', {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ botToken: 'xoxb-acme-v1', signingSecret: 'acme-secret' }),
        });
        assert.equal(first.status, 200, await first.clone().text());
        const firstRevision = await readSlackConnectionRevision(settings);
        assert.ok(firstRevision);

        const rotated = await app.request('/admin/api/slack-connection', {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ botToken: 'xoxb-acme-v2', signingSecret: 'acme-secret' }),
        });
        assert.equal(rotated.status, 200, await rotated.clone().text());
        const active = await resolveSlackCredentials(undefined, settings);
        assert.equal(active.botToken, 'xoxb-acme-v2');
        assert.notEqual(await readSlackConnectionRevision(settings), firstRevision);

        await settings.setSetting(SLACK_SETTING_KEYS.publicUrl, 'https://chickpea.example');
        const disconnected = await app.request('/admin/api/slack-connection', {
          method: 'DELETE', headers: auth(),
        });
        assert.equal(disconnected.status, 200, await disconnected.clone().text());
        assert.deepEqual(await resolveSlackCredentials(undefined, settings), {
          botToken: undefined,
          signingSecret: undefined,
          botUserId: undefined,
        });
        assert.deepEqual(await readStoredSlackTeamInfo(undefined, settings), {
          teamId: undefined,
          teamName: undefined,
        });
        assert.equal(
          await settings.getSetting(SLACK_SETTING_KEYS.publicUrl),
          'https://chickpea.example',
        );
      } finally {
        store.close();
        settings.close();
      }
    },
  );
});

test('team info comes from the canonical encrypted revision without an auth.test backfill', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) return t.skip(skip);

  await withFake(
    { slack: { identity: { teamId: 'TOLD', teamName: 'Legacy Co' } } },
    async (backend) => {
      const settings = new SqliteSettingsStore(':memory:');
      try {
        await connectSlack(settings, {
          botToken: 'xoxb-old', signingSecret: 'old-secret',
          teamId: 'TOLD', teamName: 'Legacy Co',
        });
        const app = appWith(settings);

        const channels = await getJson(app, '/admin/api/slack-channels');
        const body = (await channels.json()) as Record<string, unknown>;
        // The proxy resolved (and returned) the workspace identity...
        assert.equal(body.teamId, 'TOLD');
        assert.equal(body.teamName, 'Legacy Co');
        // The team ID is public metadata on the same revision as the bot grant.
        assert.equal((await readStoredSlackTeamInfo(undefined, settings)).teamId, 'TOLD');
        assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.teamName), 'Legacy Co');
        assert.equal(backend.callsOfMethod('auth.test').length, 0);
      } finally {
        settings.close();
      }
    },
  );
});

// --- 2. Channels proxy ------------------------------------------------------

test('channels proxy cursor-paginates, merges, and name-sorts the workspace channels', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) return t.skip(skip);

  await withFake(
    {
      slack: {
        identity: { teamId: 'TACME', teamName: 'Acme Inc' },
        conversationsListPageSize: 2,
        channels: [
          { id: 'C3', name: 'zeta', isPrivate: false, isMember: true },
          { id: 'C1', name: 'alpha', isPrivate: true, isMember: false },
          { id: 'C2', name: 'mike', isPrivate: false, isMember: true },
          { id: 'C5', name: 'echo', isPrivate: false, isMember: false },
          { id: 'C4', name: 'bravo', isPrivate: true, isMember: true },
        ],
      },
    },
    async (backend) => {
      const settings = new SqliteSettingsStore(':memory:');
      try {
        await connectSlack(settings, { teamName: 'Acme Inc' });
        const app = appWith(settings);

        const response = await getJson(app, '/admin/api/slack-channels');
        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          channels: Array<{ id: string; name: string; isPrivate: boolean; isMember: boolean }>;
          teamId: string;
          teamName: string;
          truncated: boolean;
        };
        // All five channels, name-sorted, with the private/member flags mapped.
        assert.deepEqual(
          body.channels.map((channel) => channel.name),
          ['alpha', 'bravo', 'echo', 'mike', 'zeta'],
        );
        const alpha = body.channels.find((channel) => channel.id === 'C1');
        assert.deepEqual(alpha, { id: 'C1', name: 'alpha', isPrivate: true, isMember: false });
        assert.equal(body.truncated, false);
        assert.equal(body.teamId, 'TACME');
        // 5 channels at pageSize 2 → three conversations.list pages.
        assert.equal(backend.callsOfMethod('conversations.list').length, 3);
      } finally {
        settings.close();
      }
    },
  );
});

test('channels proxy caches within the TTL and ?refresh=1 bypasses the cache', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) return t.skip(skip);

  await withFake(
    {
      slack: {
        identity: { teamId: 'TACME', teamName: 'Acme Inc' },
        channels: [{ id: 'C1', name: 'first', isMember: true }],
      },
    },
    async (backend) => {
      invalidateSlackChannelsCache();
      const settings = new SqliteSettingsStore(':memory:');
      try {
        await connectSlack(settings, { botToken: 'xoxb-cache' });
        const app = appWith(settings);

        const first = (await (await getJson(app, '/admin/api/slack-channels')).json()) as {
          channels: Array<{ name: string }>;
        };
        assert.deepEqual(first.channels.map((c) => c.name), ['first']);
        const callsAfterFirst = backend.callsOfMethod('conversations.list').length;

        // The workspace changed under us, but a cached read must not see it.
        backend.configure({ slack: { channels: [
          { id: 'C1', name: 'first', isMember: true },
          { id: 'C2', name: 'second', isMember: true },
        ] } });

        const cached = (await (await getJson(app, '/admin/api/slack-channels')).json()) as {
          channels: Array<{ name: string }>;
        };
        assert.deepEqual(cached.channels.map((c) => c.name), ['first']);
        assert.equal(backend.callsOfMethod('conversations.list').length, callsAfterFirst);

        // ?refresh=1 bypasses and re-fetches.
        const refreshed = (await (
          await getJson(app, '/admin/api/slack-channels?refresh=1')
        ).json()) as { channels: Array<{ name: string }> };
        assert.deepEqual(refreshed.channels.map((c) => c.name), ['first', 'second']);
        assert.ok(backend.callsOfMethod('conversations.list').length > callsAfterFirst);
      } finally {
        settings.close();
      }
    },
  );
});

test('channels proxy returns 409 slack_not_configured when no bot token resolves', async () => {
  await withEnv(NO_SLACK_ENV, async () => {
    const settings = new SqliteSettingsStore(':memory:');
    try {
      const app = appWith(settings);
      const response = await getJson(app, '/admin/api/slack-channels');
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'slack_not_configured' });
    } finally {
      settings.close();
    }
  });
});

// --- 3. Assignment PUT validation matrix ------------------------------------

test('assignment PUT rejects a channel from a different workspace with a naming message', async () => {
  await withEnv(NO_SLACK_ENV, async () => {
    const settings = new SqliteSettingsStore(':memory:');
    const store = new SqliteConfigStore(':memory:', { agents: [agent()], assignments: [] });
    try {
      // Canonical encrypted revision metadata makes the mismatch check local.
      await connectSlack(settings, { teamName: 'Acme Inc' });
      const app = appWith(settings, store);

      const response = await putAssignment(app, {
        workspaceId: 'TOTHER',
        channelId: 'C_ELSEWHERE',
        agentId: 'agent_channels',
        enabled: true,
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.error, 'workspace_mismatch');
      assert.equal(body.connectedTeamId, 'TACME');
      assert.equal(body.connectedTeamName, 'Acme Inc');
      assert.match(String(body.message), /Acme Inc/);
      assert.match(String(body.message), /TACME/);
      assert.match(String(body.message), /TOTHER/);
      // Nothing was written.
      assert.equal((await store.listAssignments()).length, 0);
    } finally {
      settings.close();
      store.close();
    }
  });
});

test('assignment PUT rejects a channel Slack cannot find with a channel_not_found message', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) return t.skip(skip);

  await withFake(
    {
      slack: {
        identity: { teamId: 'TACME', teamName: 'Acme Inc' },
        channels: [{ id: 'C_REAL', name: 'real-channel', isMember: true }],
      },
    },
    async () => {
      const settings = new SqliteSettingsStore(':memory:');
      const store = new SqliteConfigStore(':memory:', { agents: [agent()], assignments: [] });
      try {
        await connectSlack(settings, { teamName: 'Acme Inc' });
        const app = appWith(settings, store);

        const response = await putAssignment(app, {
          workspaceId: 'TACME',
          channelId: 'C_TYPO',
          agentId: 'agent_channels',
          enabled: true,
        });
        assert.equal(response.status, 400);
        const body = (await response.json()) as Record<string, unknown>;
        assert.equal(body.error, 'channel_not_found');
        assert.match(String(body.message), /C_TYPO/);
        assert.equal((await store.listAssignments()).length, 0);
      } finally {
        settings.close();
        store.close();
      }
    },
  );
});

test('assignment PUT adopts Slack authoritative name and passes membership through', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) return t.skip(skip);

  await withFake(
    {
      slack: {
        identity: { teamId: 'TACME', teamName: 'Acme Inc' },
        // Private + not-member: Slack forbids self-join, so this isolates the
        // name-adoption + membership-passthrough contract with no join in the
        // way (the public auto-join path is proven by the F2 tests below).
        channels: [{ id: 'C_REAL', name: 'canonical-name', isPrivate: true, isMember: false }],
      },
    },
    async (backend) => {
      const settings = new SqliteSettingsStore(':memory:');
      const store = new SqliteConfigStore(':memory:', { agents: [agent()], assignments: [] });
      try {
        await connectSlack(settings);
        const app = appWith(settings, store);

        const response = await putAssignment(app, {
          workspaceId: 'TACME',
          channelId: 'C_REAL',
          agentId: 'agent_channels',
          enabled: true,
          channelLabel: 'whatever-the-user-typed',
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          channel: { label?: string };
          isMember?: boolean;
          joined?: boolean;
        };
        // Slack's authoritative name wins over the typed label...
        assert.equal(body.channel.label, 'canonical-name');
        // ...and membership is surfaced for the UI's invite reminder...
        assert.equal(body.isMember, false);
        // ...and no self-join was attempted for a private channel.
        assert.equal(backend.callsOfMethod('conversations.join').length, 0);
        assert.equal('joined' in body, false);
      } finally {
        settings.close();
        store.close();
      }
    },
  );
});

test('assignment PUT auto-joins a public not-member channel and reports joined:true', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) return t.skip(skip);

  await withFake(
    {
      slack: {
        identity: { teamId: 'TACME', teamName: 'Acme Inc' },
        channels: [{ id: 'C_PUB', name: 'public-room', isPrivate: false, isMember: false }],
      },
    },
    async (backend) => {
      const settings = new SqliteSettingsStore(':memory:');
      const store = new SqliteConfigStore(':memory:', { agents: [agent()], assignments: [] });
      try {
        await connectSlack(settings);
        const app = appWith(settings, store);

        const response = await putAssignment(app, {
          workspaceId: 'TACME',
          channelId: 'C_PUB',
          agentId: 'agent_channels',
          enabled: true,
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { isMember?: boolean; joined?: boolean };
        // The bot self-joined, so membership flips true and joined is surfaced.
        assert.equal(body.isMember, true);
        assert.equal(body.joined, true);
        assert.equal(backend.callsOfMethod('conversations.join').length, 1);
        assert.equal((await store.listAssignments()).length, 1);
      } finally {
        settings.close();
        store.close();
      }
    },
  );
});

test('assignment PUT never self-joins a private channel and keeps the invite reminder', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) return t.skip(skip);

  await withFake(
    {
      slack: {
        identity: { teamId: 'TACME', teamName: 'Acme Inc' },
        channels: [{ id: 'C_PRIV', name: 'secret-room', isPrivate: true, isMember: false }],
      },
    },
    async (backend) => {
      const settings = new SqliteSettingsStore(':memory:');
      const store = new SqliteConfigStore(':memory:', { agents: [agent()], assignments: [] });
      try {
        await connectSlack(settings);
        const app = appWith(settings, store);

        const response = await putAssignment(app, {
          workspaceId: 'TACME',
          channelId: 'C_PRIV',
          agentId: 'agent_channels',
          enabled: true,
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { isMember?: boolean; joined?: boolean };
        // Private: Slack forbids self-join, so membership stays false, no join
        // was even attempted, and joined is absent (the UI keeps its reminder).
        assert.equal(body.isMember, false);
        assert.equal('joined' in body, false);
        assert.equal(backend.callsOfMethod('conversations.join').length, 0);
        assert.equal((await store.listAssignments()).length, 1);
      } finally {
        settings.close();
        store.close();
      }
    },
  );
});

test('assignment PUT saves gracefully when conversations.join hits missing_scope', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) return t.skip(skip);

  await withFake(
    {
      slack: {
        identity: { teamId: 'TACME', teamName: 'Acme Inc' },
        channels: [{ id: 'C_PUB', name: 'public-room', isPrivate: false, isMember: false }],
        // An install that predates the channels:join scope: the join call is
        // rejected, but the save must still succeed and the reminder still show.
        conversationsJoinError: 'missing_scope',
      },
    },
    async (backend) => {
      const settings = new SqliteSettingsStore(':memory:');
      const store = new SqliteConfigStore(':memory:', { agents: [agent()], assignments: [] });
      try {
        await connectSlack(settings);
        const app = appWith(settings, store);

        const response = await putAssignment(app, {
          workspaceId: 'TACME',
          channelId: 'C_PUB',
          agentId: 'agent_channels',
          enabled: true,
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { isMember?: boolean; joined?: boolean };
        // The join was attempted and rejected: membership stays false, joined is
        // absent, and the assignment still persisted.
        assert.equal(body.isMember, false);
        assert.equal('joined' in body, false);
        assert.equal(backend.callsOfMethod('conversations.join').length, 1);
        assert.equal((await store.listAssignments()).length, 1);
      } finally {
        settings.close();
        store.close();
      }
    },
  );
});

test('assignment PUT skips Slack validation for wildcard ids even when connected', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) return t.skip(skip);

  await withFake(
    { slack: { identity: { teamId: 'TACME', teamName: 'Acme Inc' }, channels: [] } },
    async (backend) => {
      const settings = new SqliteSettingsStore(':memory:');
      const store = new SqliteConfigStore(':memory:', { agents: [agent()], assignments: [] });
      try {
        await connectSlack(settings);
        const app = appWith(settings, store);

        const response = await putAssignment(app, {
          workspaceId: '*',
          channelId: '*',
          agentId: 'agent_channels',
          enabled: true,
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { assignment: unknown; isMember?: boolean };
        assert.equal('isMember' in body, false);
        // A wildcard is a scope rule, not a channel — Slack is never consulted.
        assert.equal(backend.callsOfMethod('conversations.info').length, 0);
        assert.equal((await store.listAssignments()).length, 1);
      } finally {
        settings.close();
        store.close();
      }
    },
  );
});

test('assignment PUT keeps offline behavior when no Slack connection exists', async () => {
  await withEnv(NO_SLACK_ENV, async () => {
    const settings = new SqliteSettingsStore(':memory:');
    const store = new SqliteConfigStore(':memory:', { agents: [agent()], assignments: [] });
    try {
      const app = appWith(settings, store);
      const response = await putAssignment(app, {
        workspaceId: 'T_DEV',
        channelId: 'C_DEV',
        agentId: 'agent_channels',
        enabled: true,
        channelLabel: 'dev-typed-label',
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        channel: { label?: string };
        isMember?: boolean;
      };
      // No connection → no override, no membership field: exactly the old shape.
      assert.equal(body.channel.label, 'dev-typed-label');
      assert.equal('isMember' in body, false);
    } finally {
      settings.close();
      store.close();
    }
  });
});

// --- 4. Team identity is bound to the active encrypted revision -------------

test('conflicting env credentials cannot override the active revision workspace', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) return t.skip(skip);

  await withFake(
    { slack: { identity: { teamId: 'TENV', teamName: 'Env Co' } } },
    async () => {
      await withEnv({
        SLACK_BOT_TOKEN: 'xoxb-env',
        SLACK_SIGNING_SECRET: 'env-signing-secret',
        SLACK_BOT_USER_ID: 'UENV',
      }, async () => {
        const settings = new SqliteSettingsStore(':memory:');
        const store = new SqliteConfigStore(':memory:', {
          agents: [agent()],
          assignments: [],
        });
        try {
          await connectSlack(settings, { teamName: 'Acme Inc' });
          const app = appWith(settings, store);

          // Public team metadata and the bot grant come from one revision.
          const channels = await getJson(app, '/admin/api/slack-channels');
          const body = (await channels.json()) as Record<string, unknown>;
          assert.equal(body.teamId, 'TACME');
          assert.equal(body.teamName, 'Acme Inc');
          assert.equal((await readStoredSlackTeamInfo(undefined, settings)).teamId, 'TACME');

          // The guard continues to enforce the revision-bound workspace.
          const response = await putAssignment(app, {
            workspaceId: 'TENV',
            channelId: 'C_ELSEWHERE',
            agentId: 'agent_channels',
            enabled: true,
          });
          assert.equal(response.status, 400);
          const rejected = (await response.json()) as Record<string, unknown>;
          assert.equal(rejected.error, 'workspace_mismatch');
          assert.equal(rejected.connectedTeamId, 'TACME');
        } finally {
          settings.close();
          store.close();
        }
      });
    },
  );
});

// --- 5. Public URL resolution feeds the reply-footer "Configure" link --------

test('resolveSlackPublicUrl prefers env, falls back to the stored origin, else undefined', async () => {
  await withEnv({ SLACK_TAG_PUBLIC_URL: undefined }, async () => {
    const settings = new SqliteSettingsStore(':memory:');
    invalidateStoredSlackPublicUrl();
    try {
      // Neither set → no link: the footer renders the bare "Configure" word.
      assert.equal(await resolveSlackPublicUrl(undefined, settings), undefined);
      assert.equal(
        renderSlackConfigureLink(await resolveSlackPublicUrl(undefined, settings), {
          agentId: 'agent_default',
        }),
        'Configure',
      );

      // A stored origin (what the admin pins on a button deploy) → the footer
      // renders the mrkdwn <url|Configure> deep link.
      await settings.setSetting(SLACK_SETTING_KEYS.publicUrl, 'https://tag.example.workers.dev');
      assert.equal(
        await resolveSlackPublicUrl(undefined, settings),
        'https://tag.example.workers.dev',
      );
      assert.equal(
        renderSlackConfigureLink(await resolveSlackPublicUrl(undefined, settings), {
          agentId: 'agent_default',
        }),
        '<https://tag.example.workers.dev/admin?agent=agent_default|Configure>',
      );

      // Env wins outright, even over a stored value.
      await withEnv({ SLACK_TAG_PUBLIC_URL: 'https://pinned.example/' }, async () => {
        assert.equal(await resolveSlackPublicUrl(undefined, settings), 'https://pinned.example');
      });
    } finally {
      settings.close();
      invalidateStoredSlackPublicUrl();
    }
  });
});

test('an authenticated admin request cannot rewrite slack.publicUrl from its Host header', async () => {
  await withEnv({ ...NO_SLACK_ENV }, async () => {
    const settings = new SqliteSettingsStore(':memory:');
    invalidateStoredSlackPublicUrl();
    try {
      const app = appWith(settings);
      const response = await app.request('http://tag.example.test/admin/api/agents', {
        headers: auth(),
      });
      assert.equal(response.status, 200);
      assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.publicUrl), undefined);
    } finally {
      settings.close();
      invalidateStoredSlackPublicUrl();
    }
  });
});
