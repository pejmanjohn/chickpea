import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import {
  invalidateSlackBotUserIdCache,
  resolveBotUserId,
} from '../src/channels/slack.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { SlackIdentity } from '../src/config/types.ts';
import {
  invalidateStoredSlackCredentials,
  primeStoredSlackCredentials,
  resolveSlackCredentials,
  resolveSlackTeamInfo,
  slackTokenFingerprint,
  SLACK_SETTING_KEYS,
} from '../src/slack/credentials.ts';
import {
  resolveSlackIdentityCredentials,
  slackIdentityCredentialSettingKeys,
  writeSlackIdentityCredentials,
} from '../src/slack/identity-credentials.ts';
import {
  beginSlackIdentityConnection,
  cancelSlackIdentityConnection,
  completeSlackIdentityConnection,
  refreshSlackIdentityHealth,
  type SlackIdentityBootstrapDeps,
  SlackIdentityBootstrapError,
  validateSlackIdentityBotInstallation,
} from '../src/slack/identity-bootstrap.ts';
import {
  MAX_PENDING_SLACK_CHALLENGE_BYTES,
  recordPendingSlackChallenge,
  readPendingSlackChallenge,
  verifyPendingSlackChallenge,
} from '../src/slack/identity-handshake.ts';
import {
  buildSlackIdentityManifest,
  slackManifestPrefillUrl,
} from '../src/slack/identity-manifest.ts';
import slackAppManifest from '../slack-app-manifest.json' with { type: 'json' };
import { withEnv } from './helpers/env.ts';
import { loopbackListenSkipReason } from './helpers/listen.ts';
import { captureSlackIdentityOperationalEvents } from './helpers/slack-identity-observability.ts';

const ADMIN_TOKEN = 'wizard-admin-token';

test('dedicated Slack manifests parameterize only identity fields and retain lifecycle events', () => {
  const requestUrl =
    'https://chickpea.acme.test/channels/slack/events/identity_ingress_finance_0123456789abcdef';
  const manifest = buildSlackIdentityManifest(slackAppManifest, {
    appName: 'Finance Copilot',
    botDisplayName: 'Finance',
    requestUrl,
  });

  assert.equal(manifest.$schema, undefined);
  assert.equal(manifest.display_information.name, 'Finance Copilot');
  assert.equal(manifest.features.bot_user.display_name, 'Finance');
  assert.equal(manifest.settings.event_subscriptions.request_url, requestUrl);
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes('app_uninstalled'));
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes('tokens_revoked'));
  assert.deepEqual(
    manifest.features.app_home,
    slackAppManifest.features.app_home,
    'the canonical app-home contract must be preserved',
  );
  assert.deepEqual(
    manifest.oauth_config,
    slackAppManifest.oauth_config,
    'dedicated apps must inherit the canonical scopes',
  );

  const prefill = new URL(slackManifestPrefillUrl(manifest));
  assert.equal(`${prefill.origin}${prefill.pathname}`, 'https://api.slack.com/apps');
  assert.equal(prefill.searchParams.get('new_app'), '1');
  assert.deepEqual(
    JSON.parse(prefill.searchParams.get('manifest_json') ?? '{}'),
    manifest,
  );
});

test('dedicated Slack manifest names enforce Slack limits before generation', () => {
  const base = {
    appName: 'Finance',
    botDisplayName: 'Finance',
    requestUrl: 'https://chickpea.acme.test/channels/slack/events/safe_identity_key',
  };
  assert.throws(
    () => buildSlackIdentityManifest(slackAppManifest, { ...base, appName: 'x'.repeat(36) }),
    /35 characters or fewer/,
  );
  assert.throws(
    () => buildSlackIdentityManifest(slackAppManifest, { ...base, botDisplayName: 'x'.repeat(81) }),
    /80 characters or fewer/,
  );
  assert.throws(
    () => buildSlackIdentityManifest(slackAppManifest, { ...base, requestUrl: 'http://unsafe.test/events' }),
    /HTTPS/,
  );
});

function pendingIdentity(overrides: Partial<SlackIdentity> = {}): SlackIdentity {
  return {
    id: 'slack_identity_finance',
    ingressKey: 'finance_ingress_0123456789abcdef',
    kind: 'dedicated',
    lifecycle: 'setup_incomplete',
    dmState: 'on',
    dmAgentId: 'agent_default',
    credentialProvenance: 'none',
    connectionRevision: 0,
    health: 'unknown',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function signedChallenge(
  secret: string,
  options: { challenge?: string; timestamp?: number } = {},
): { rawBody: string; signature: string; timestamp: string } {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1_000));
  const rawBody = JSON.stringify({
    type: 'url_verification',
    challenge: options.challenge ?? 'challenge-finance',
  });
  return {
    rawBody,
    timestamp,
    signature: `v0=${createHmac('sha256', secret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex')}`,
  };
}

function validDedicatedSlackDeps() {
  return {
    authTest: async () => ({
      ok: true,
      error: undefined,
      appId: 'A0FINANCE',
      teamId: 'T_ACME',
      teamName: 'Acme Inc',
      botName: 'finance',
      botUserId: 'U_FINANCE',
      botId: 'B_FINANCE',
    }),
    botIdentityInfo: async () => ({
      ok: true,
      error: undefined,
      displayName: 'Finance',
      avatarUrl: 'https://avatars.slack-edge.com/finance.png',
      appId: 'A0FINANCE',
    }),
  };
}

// The wizard tests must not see ambient Slack credentials from the developer's
// shell — clear the whole family for the duration of each test.
const NO_SLACK_ENV: NodeJS.ProcessEnv = {
  SLACK_BOT_TOKEN: undefined,
  SLACK_SIGNING_SECRET: undefined,
  SLACK_BOT_USER_ID: undefined,
  SLACK_API_URL: undefined,
  SLACK_TAG_ALLOW_DMS: undefined,
  SLACK_TAG_UNASSIGNED_HINT: undefined,
  SLACK_TAG_WELCOME_ON_JOIN: undefined,
  SLACK_TAG_AMBIENT_PARTICIPATION: undefined,
  // requestOrigin() honors SLACK_TAG_PUBLIC_URL as an operator pin; clear it so
  // the request-derived origin tests are hermetic against the dev shell.
  SLACK_TAG_PUBLIC_URL: undefined,
};

function signedSlackEvent(
  secret: string,
  payload: Record<string, unknown>,
  timestamp = Math.floor(Date.now() / 1_000),
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(payload);
  const timestampText = String(timestamp);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestampText,
      'x-slack-signature': `v0=${createHmac('sha256', secret)
        .update(`v0:${timestampText}:${body}`)
        .digest('hex')}`,
    },
  };
}

async function identityIngressApp(): Promise<Hono> {
  const { channel } = await import('../src/channels/slack.ts');
  const app = new Hono();
  app.route('/channels/slack', channel.route());
  return app;
}

function appWith(settings: SettingsStore, store?: SqliteConfigStore): Hono {
  const app = new Hono();
  app.route('/', createAdminRoutes({
    settings,
    adminToken: ADMIN_TOKEN,
    ...(store ? { store } : {}),
  }));
  return app;
}

function auth(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

async function postCreds(app: Hono, body: unknown): Promise<Response> {
  return app.request('/admin/api/slack-connection', {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Minimal fake Slack Web API answering auth.test and, optionally, users.info. */
function listenFakeSlack(
  authTestBody: Record<string, unknown>,
  usersInfoBody?: Record<string, unknown> | ReadonlyArray<Record<string, unknown>>,
): Promise<{
  server: Server;
  baseUrl: string;
  authHeaders: string[];
}> {
  const authHeaders: string[] = [];
  const usersInfoBodies = usersInfoBody
    ? (Array.isArray(usersInfoBody) ? [...usersInfoBody] : [usersInfoBody])
    : [];
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/auth.test')) {
      authHeaders.push(req.headers.authorization ?? '');
      res.end(JSON.stringify(authTestBody));
      return;
    }
    if (req.url?.endsWith('/users.info')) {
      const nextUsersInfoBody = usersInfoBodies.shift();
      if (nextUsersInfoBody) {
        authHeaders.push(req.headers.authorization ?? '');
        res.end(JSON.stringify(nextUsersInfoBody));
        return;
      }
    }
    res.statusCode = 404;
    res.end('{"ok":false,"error":"unknown_method"}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/api/`, authHeaders });
    });
  });
}

function listenTokenAwareFakeSlack(userIds: Readonly<Record<string, string>>): Promise<{
  server: Server;
  baseUrl: string;
  authHeaders: string[];
}> {
  const authHeaders: string[] = [];
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (!req.url?.endsWith('/auth.test')) {
      res.statusCode = 404;
      res.end('{"ok":false,"error":"unknown_method"}');
      return;
    }
    const authorization = req.headers.authorization ?? '';
    authHeaders.push(authorization);
    const token = authorization.replace(/^Bearer\s+/, '');
    res.end(JSON.stringify({ ok: true, user_id: userIds[token] }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/api/`, authHeaders });
    });
  });
}

function listenIdentityAdmissionSlack(): Promise<{
  server: Server;
  baseUrl: string;
  authHeaders: string[];
  setMember(value: boolean): void;
}> {
  const authHeaders: string[] = [];
  let member = true;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    authHeaders.push(req.headers.authorization ?? '');
    if (req.url?.endsWith('/users.info')) {
      res.end(JSON.stringify({
        ok: true,
        user: { id: 'U_MEMBER', team_id: 'T_ACME' },
      }));
      return;
    }
    if (req.url?.endsWith('/conversations.info')) {
      res.end(JSON.stringify({
        ok: true,
        channel: {
          id: 'C_FINANCE',
          name: 'finance',
          context_team_id: 'T_ACME',
          is_member: member,
        },
      }));
      return;
    }
    if (req.url?.endsWith('/auth.test')) {
      res.end(JSON.stringify({
        ok: true,
        app_id: 'A0FINANCE',
        team_id: 'T_ACME',
        user_id: 'U_FINANCE',
      }));
      return;
    }
    if (req.url?.endsWith('/chat.postMessage')) {
      res.end(JSON.stringify({ ok: true, channel: 'C_FINANCE', ts: '1782770400.009000' }));
      return;
    }
    res.end('{"ok":true}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/api/`,
        authHeaders,
        setMember(value) {
          member = value;
        },
      });
    });
  });
}

/** Fake auth.test whose response can be held open to exercise update races. */
function listenControlledFakeSlack(authTestBody: Record<string, unknown>): Promise<{
  server: Server;
  baseUrl: string;
  authStarted: Promise<void>;
  releaseAuth(): void;
}> {
  const { promise: authStarted, resolve: markStarted } = Promise.withResolvers<void>();
  const { promise: released, resolve: releaseAuth } = Promise.withResolvers<void>();
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (!req.url?.endsWith('/auth.test')) {
      res.statusCode = 404;
      res.end('{"ok":false,"error":"unknown_method"}');
      return;
    }
    markStarted();
    void released.then(() => res.end(JSON.stringify(authTestBody)));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/api/`,
        authStarted,
        releaseAuth,
      });
    });
  });
}

async function withCloudflareUserAgent<T>(run: () => Promise<T>): Promise<T> {
  const prototype = Object.getPrototypeOf(globalThis.navigator) as object;
  const original = Object.getOwnPropertyDescriptor(prototype, 'userAgent');
  Object.defineProperty(prototype, 'userAgent', {
    configurable: true,
    enumerable: true,
    value: 'Cloudflare-Workers',
  });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(prototype, 'userAgent', original);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

test('slack-connection endpoints are 404 when TAG_ADMIN_TOKEN is unset (fail-closed gate)', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = new Hono();
    app.route('/', createAdminRoutes({ settings, adminToken: undefined }));
    const get = await app.request('/admin/api/slack-connection', { headers: auth() });
    assert.equal(get.status, 404);
    const post = await postCreds(app, { botToken: 'xoxb-x', signingSecret: 's' });
    assert.equal(post.status, 404);
    const testConnection = await app.request('/admin/api/slack-connection/test', {
      method: 'POST',
      headers: auth(),
    });
    assert.equal(testConnection.status, 404);
    const identity = await app.request('/admin/api/slack-identity', { headers: auth() });
    assert.equal(identity.status, 404);
    const disconnect = await app.request('/admin/api/slack-connection', {
      method: 'DELETE',
      headers: auth(),
    });
    assert.equal(disconnect.status, 404);
    const getBehavior = await app.request('/admin/api/slack-behavior', { headers: auth() });
    assert.equal(getBehavior.status, 404);
    const putBehavior = await app.request('/admin/api/slack-behavior', {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ allowDms: false }),
    });
    assert.equal(putBehavior.status, 404);
  } finally {
    settings.close();
  }
});

test('Slack identity returns the live bot name, avatar, and exact app settings link', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl, authHeaders } = await listenFakeSlack(
    {
      ok: true,
      app_id: 'A0CHICKPEA',
      team_id: 'T_CURRENT',
      user_id: 'U_CURRENT_BOT',
    },
    {
      ok: true,
      user: {
        id: 'U_CURRENT_BOT',
        name: 'chickpea',
        profile: {
          display_name: 'Chickpea Helper',
          real_name: 'Chickpea',
          image_512: 'https://avatars.slack-edge.com/2026-07-28/chickpea_512.png',
          api_app_id: 'A0CHICKPEA',
        },
      },
    },
  );
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-current');
    await settings.setSetting(SLACK_SETTING_KEYS.botUserId, 'U_CURRENT_BOT');
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await appWith(settings).request('/admin/api/slack-identity', {
        headers: auth(),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        displayName: 'Chickpea Helper',
        avatarUrl: 'https://avatars.slack-edge.com/2026-07-28/chickpea_512.png',
        botUserId: 'U_CURRENT_BOT',
        appId: 'A0CHICKPEA',
        consoleUrl: 'https://api.slack.com/apps/A0CHICKPEA/general',
      });
      assert.deepEqual(authHeaders, ['Bearer xoxb-current']);
    });
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
    await closeServer(server);
  }
});

test('Slack identity resolves the bot user live when no bot user id is configured', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl, authHeaders } = await listenFakeSlack(
    {
      ok: true,
      app_id: 'A0FALLBACK',
      user_id: 'U_FALLBACK_BOT',
    },
    {
      ok: true,
      user: {
        id: 'U_FALLBACK_BOT',
        name: 'chickpea',
        profile: { display_name: 'Chickpea', image_72: 'https://avatars.slack-edge.com/fallback.png' },
      },
    },
  );
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-fallback');
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await appWith(settings).request('/admin/api/slack-identity', {
        headers: auth(),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.botUserId, 'U_FALLBACK_BOT');
      assert.equal(body.appId, 'A0FALLBACK');
      assert.equal(body.consoleUrl, 'https://api.slack.com/apps/A0FALLBACK/general');
      assert.deepEqual(authHeaders, ['Bearer xoxb-fallback', 'Bearer xoxb-fallback']);
    });
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
    await closeServer(server);
  }
});

test('Slack identity resolves the documented explicit-empty bot user ID without changing event credentials', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl, authHeaders } = await listenFakeSlack(
    { ok: true, app_id: 'A0EMPTY1', user_id: 'U_EMPTY_ID' },
    {
      ok: true,
      user: {
        id: 'U_EMPTY_ID',
        profile: { display_name: 'Chickpea from Slack', image_72: 'https://avatars.slack-edge.com/empty.png' },
      },
    },
  );
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-empty-id');
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl, SLACK_BOT_USER_ID: '' }, async () => {
      const response = await appWith(settings).request('/admin/api/slack-identity', { headers: auth() });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        displayName: 'Chickpea from Slack',
        avatarUrl: 'https://avatars.slack-edge.com/empty.png',
        botUserId: 'U_EMPTY_ID',
        appId: 'A0EMPTY1',
        consoleUrl: 'https://api.slack.com/apps/A0EMPTY1/general',
      });
      assert.deepEqual(authHeaders, ['Bearer xoxb-empty-id', 'Bearer xoxb-empty-id']);
      assert.equal(process.env.SLACK_BOT_USER_ID, '');
      assert.equal((await resolveSlackCredentials()).botUserId, '');
    });
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
    await closeServer(server);
  }
});

test('Slack identity retries a stale saved bot ID without persisting the replacement', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl, authHeaders } = await listenFakeSlack(
    { ok: true, app_id: 'A0REPLACED', user_id: 'U_REPLACED' },
    [
      { ok: false, error: 'user_not_found' },
      {
        ok: true,
        user: {
          id: 'U_REPLACED',
          profile: { display_name: 'Replacement Chickpea', image_512: 'https://avatars.slack-edge.com/replaced.png' },
        },
      },
    ],
  );
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-stale');
    await settings.setSetting(SLACK_SETTING_KEYS.botUserId, 'U_STALE');
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await appWith(settings).request('/admin/api/slack-identity', { headers: auth() });
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.botUserId, 'U_REPLACED');
      assert.equal(body.consoleUrl, 'https://api.slack.com/apps/A0REPLACED/general');
      assert.deepEqual(authHeaders, ['Bearer xoxb-stale', 'Bearer xoxb-stale', 'Bearer xoxb-stale']);
      assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.botUserId), 'U_STALE');
    });
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
    await closeServer(server);
  }
});

test('Slack identity recovers an exact settings link when a stored bot profile omits its app ID', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl, authHeaders } = await listenFakeSlack(
    { ok: true, app_id: 'A0LINKRECOVERY', user_id: 'U_LINK' },
    {
      ok: true,
      user: {
        id: 'U_LINK',
        profile: { display_name: 'Link Chickpea', image_72: 'https://avatars.slack-edge.com/link.png' },
      },
    },
  );
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-link');
    await settings.setSetting(SLACK_SETTING_KEYS.botUserId, 'U_LINK');
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await appWith(settings).request('/admin/api/slack-identity', { headers: auth() });
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.appId, 'A0LINKRECOVERY');
      assert.equal(body.consoleUrl, 'https://api.slack.com/apps/A0LINKRECOVERY/general');
      assert.deepEqual(authHeaders, ['Bearer xoxb-link', 'Bearer xoxb-link']);
      assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.botUserId), 'U_LINK');
    });
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
    await closeServer(server);
  }
});

test('Slack identity sanitizes presentation URLs and degrades to the generic settings link', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenFakeSlack(
    { ok: false, error: 'ratelimited' },
    {
      ok: true,
      user: {
        id: 'U_PRESENTATION',
        profile: {
          display_name: 'Chickpea',
          image_512: 'javascript:alert(1)',
          api_app_id: 'not/an/app-id',
        },
      },
    },
  );
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-presentation');
    await settings.setSetting(SLACK_SETTING_KEYS.botUserId, 'U_PRESENTATION');
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await appWith(settings).request('/admin/api/slack-identity', { headers: auth() });
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.avatarUrl, null);
      assert.equal(body.appId, null);
      assert.equal(body.consoleUrl, 'https://api.slack.com/apps');
    });
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
    await closeServer(server);
  }
});

test('Slack identity normalizes users.info failures to its safe unavailable envelope', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenFakeSlack(
    { ok: true, user_id: 'U_FAILURE' },
    { ok: false, error: 'missing_scope' },
  );
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-failure');
    await settings.setSetting(SLACK_SETTING_KEYS.botUserId, 'U_FAILURE');
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await appWith(settings).request('/admin/api/slack-identity', { headers: auth() });
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: 'slack_identity_unavailable',
        message: 'Slack identity could not be loaded.',
      });
    });
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
    await closeServer(server);
  }
});

test('Slack identity requires a configured bot token', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await withEnv(NO_SLACK_ENV, async () => {
      const response = await appWith(settings).request('/admin/api/slack-identity', {
        headers: auth(),
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'slack_not_configured' });
    });
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
  }
});

test('connection test validates the current resolved bot token without mutating settings', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl, authHeaders } = await listenFakeSlack({
    ok: true,
    team_id: 'T_CURRENT',
    team: 'Current Team',
    user: 'chickpea',
    user_id: 'U_CURRENT_BOT',
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-current');
    await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Previously Saved Team');
    await settings.setSetting(SLACK_SETTING_KEYS.publicUrl, 'https://saved.example');
    await withEnv(
      { ...NO_SLACK_ENV, SLACK_API_URL: baseUrl, SLACK_BOT_TOKEN: 'xoxb-env-current' },
      async () => {
        const app = appWith(settings);
        const response = await app.request('/admin/api/slack-connection/test', {
          method: 'POST',
          headers: auth(),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          ok: true,
          teamId: 'T_CURRENT',
          teamName: 'Current Team',
          botName: 'chickpea',
          botUserId: 'U_CURRENT_BOT',
        });

        // Testing is observational: it must not backfill or overwrite any
        // connection metadata, even when auth.test returns newer values.
        assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.botToken), 'xoxb-current');
        assert.equal(
          await settings.getSetting(SLACK_SETTING_KEYS.teamName),
          'Previously Saved Team',
        );
        assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.teamId), undefined);
        assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.botUserId), undefined);
        assert.equal(
          await settings.getSetting(SLACK_SETTING_KEYS.publicUrl),
          'https://saved.example',
        );
        assert.deepEqual(authHeaders, ['Bearer xoxb-env-current']);
      },
    );
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
    await closeServer(server);
  }
});

test('connection test distinguishes missing, Slack-rejected, and unreachable credentials', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }

  const settings = new SqliteSettingsStore(':memory:');
  try {
    await withEnv(NO_SLACK_ENV, async () => {
      const app = appWith(settings);
      const missing = await app.request('/admin/api/slack-connection/test', {
        method: 'POST',
        headers: auth(),
      });
      assert.equal(missing.status, 409);
      assert.deepEqual(await missing.json(), { error: 'slack_not_configured' });
    });

    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-bad');
    const rejectedSlack = await listenFakeSlack({ ok: false, error: 'invalid_auth' });
    try {
      await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: rejectedSlack.baseUrl }, async () => {
        const app = appWith(settings);
        const rejected = await app.request('/admin/api/slack-connection/test', {
          method: 'POST',
          headers: auth(),
        });
        assert.equal(rejected.status, 422);
        assert.deepEqual(await rejected.json(), {
          error: 'slack_auth_failed',
          detail: 'invalid_auth',
        });
      });
    } finally {
      await closeServer(rejectedSlack.server);
    }

    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: 'http://127.0.0.1:9/api/' }, async () => {
      const app = appWith(settings);
      const unreachable = await app.request('/admin/api/slack-connection/test', {
        method: 'POST',
        headers: auth(),
      });
      assert.equal(unreachable.status, 502);
      assert.deepEqual(await unreachable.json(), { error: 'slack_unreachable' });
    });
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
  }
});

test('disconnect deletes only stored Slack connection identity and immediately clears the cache', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  try {
    await withEnv(NO_SLACK_ENV, async () => {
      await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-stored');
      await settings.setSetting(SLACK_SETTING_KEYS.signingSecret, 'stored-secret');
      await settings.setSetting(SLACK_SETTING_KEYS.botUserId, 'U_STORED');
      await settings.setSetting(SLACK_SETTING_KEYS.teamId, 'T_STORED');
      await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Stored Team');
      await settings.setSetting(SLACK_SETTING_KEYS.teamTokenFingerprint, 'fingerprint');
      await settings.setSetting(SLACK_SETTING_KEYS.publicUrl, 'https://chickpea.example');

      // Warm the isolate cache so the DELETE must actively replace stale
      // credentials rather than merely deleting persistent rows.
      primeStoredSlackCredentials({
        botToken: 'xoxb-stored',
        signingSecret: 'stored-secret',
        botUserId: 'U_STORED',
      });

      const app = appWith(settings, config);
      const response = await app.request('/admin/api/slack-connection', {
        method: 'DELETE',
        headers: auth(),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        connected: false,
        slackAppUninstalled: false,
        slackAppRevoked: false,
        configurationPreserved: true,
        message:
          'Disconnected Chickpea locally. The Slack app was not uninstalled or revoked, and profiles, channel assignments, transcripts, and the public URL were preserved.',
      });

      for (const key of [
        SLACK_SETTING_KEYS.botToken,
        SLACK_SETTING_KEYS.signingSecret,
        SLACK_SETTING_KEYS.botUserId,
        SLACK_SETTING_KEYS.teamId,
        SLACK_SETTING_KEYS.teamName,
        SLACK_SETTING_KEYS.teamTokenFingerprint,
      ]) {
        assert.equal(await settings.getSetting(key), undefined, `${key} must be deleted`);
      }
      assert.equal(
        await settings.getSetting(SLACK_SETTING_KEYS.publicUrl),
        'https://chickpea.example',
      );

      // No explicit store: this reads the isolate cache primed by DELETE. It
      // must report disconnected immediately, not after the 60-second TTL.
      const resolved = await resolveSlackCredentials();
      assert.deepEqual(resolved, {
        botToken: undefined,
        signingSecret: undefined,
        botUserId: undefined,
      });
      assert.deepEqual(
        (await config.listSlackIdentityAuditEvents()).map(({ eventType }) => eventType),
        ['slack_identity.credentials_disconnected'],
      );
    });
  } finally {
    invalidateStoredSlackCredentials();
    config.close();
    settings.close();
  }
});

test('workspace disconnect is blocked while even a retired identity retains credentials', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  try {
    await withEnv(NO_SLACK_ENV, async () => {
      await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-default');
      await settings.setSetting(SLACK_SETTING_KEYS.signingSecret, 'default-secret');
      const { dmAgentId: _retiredDmAgentId, ...retiredIdentity } = pendingIdentity({
        lifecycle: 'retired',
        teamId: 'T_ACME',
        appId: 'A0FINANCE',
        botUserId: 'U_FINANCE',
        credentialProvenance: 'stored',
        health: 'disconnected',
        retiredAt: Date.now(),
      });
      const identity = await config.createSlackIdentity({
        ...retiredIdentity,
        dmState: 'off',
      });
      await writeSlackIdentityCredentials(settings, identity.id, null, {
        botToken: 'xoxb-finance',
        signingSecret: 'finance-secret',
        botUserId: 'U_FINANCE',
      });

      const response = await appWith(settings, config).request(
        '/admin/api/slack-connection',
        { method: 'DELETE', headers: auth() },
      );
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: 'slack_dedicated_identities_connected',
        message:
          'Cancel or retire every credentialed dedicated Slack identity before disconnecting @Chickpea.',
        identities: [{ id: identity.id, name: 'slack_identity_finance' }],
      });
      assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.botToken), 'xoxb-default');
      assert.equal(
        (await resolveSlackIdentityCredentials(identity.id, undefined, settings)).botToken,
        'xoxb-finance',
      );
    });
  } finally {
    config.close();
    settings.close();
  }
});

test('disconnect is read-only unless both effective wire credentials come from storage', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-stored');
    await settings.setSetting(SLACK_SETTING_KEYS.signingSecret, 'stored-secret');
    const app = appWith(settings);

    await withEnv(
      { ...NO_SLACK_ENV, SLACK_BOT_TOKEN: 'xoxb-env', SLACK_SIGNING_SECRET: 'env-secret' },
      async () => {
        const response = await app.request('/admin/api/slack-connection', {
          method: 'DELETE',
          headers: auth(),
        });
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: 'slack_connection_read_only' });
      },
    );
    assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.botToken), 'xoxb-stored');
    assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.signingSecret), 'stored-secret');

    await withEnv(NO_SLACK_ENV, async () => {
      await settings.deleteSetting(SLACK_SETTING_KEYS.signingSecret);
      const response = await app.request('/admin/api/slack-connection', {
        method: 'DELETE',
        headers: auth(),
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'slack_connection_read_only' });
      assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.botToken), 'xoxb-stored');
    });
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
  }
});

test('disconnect keeps credentials and the live cache intact when atomic deletion fails', async () => {
  const persisted = new SqliteSettingsStore(':memory:');
  const failing: SettingsStore = {
    getSetting: (key) => persisted.getSetting(key),
    getSettings: (keys) => persisted.getSettings(keys),
    setSetting: (key, value) => persisted.setSetting(key, value),
    deleteSetting: async () => {
      throw new Error('single-key deletion must not be used');
    },
    applySettingsPatch: async () => {
      throw new Error('atomic settings patch unavailable');
    },
    mergeSettingStringSet: (key, values) => persisted.mergeSettingStringSet(key, values),
  };
  try {
    await withEnv(NO_SLACK_ENV, async () => {
      await persisted.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-still-live');
      await persisted.setSetting(SLACK_SETTING_KEYS.signingSecret, 'still-live-secret');
      await persisted.setSetting(SLACK_SETTING_KEYS.teamId, 'T_STILL_LIVE');
      primeStoredSlackCredentials({
        botToken: 'xoxb-still-live',
        signingSecret: 'still-live-secret',
        botUserId: undefined,
      });

      const response = await appWith(failing).request('/admin/api/slack-connection', {
        method: 'DELETE',
        headers: auth(),
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'internal_error' });
      assert.equal(await persisted.getSetting(SLACK_SETTING_KEYS.botToken), 'xoxb-still-live');
      assert.equal(
        await persisted.getSetting(SLACK_SETTING_KEYS.signingSecret),
        'still-live-secret',
      );
      assert.equal(await persisted.getSetting(SLACK_SETTING_KEYS.teamId), 'T_STILL_LIVE');

      const resolved = await resolveSlackCredentials();
      assert.equal(resolved.botToken, 'xoxb-still-live');
      assert.equal(resolved.signingSecret, 'still-live-secret');
    });
  } finally {
    invalidateStoredSlackCredentials();
    persisted.close();
  }
});

test('disconnect returns a conflict without erasing a rotation that wins the CAS', async () => {
  const persisted = new SqliteSettingsStore(':memory:');
  let raced = false;
  const racing: SettingsStore = {
    getSetting: (key) => persisted.getSetting(key),
    getSettings: (keys) => persisted.getSettings(keys),
    setSetting: (key, value) => persisted.setSetting(key, value),
    deleteSetting: (key) => persisted.deleteSetting(key),
    applySettingsPatch: async (patch) => {
      if (!raced) {
        raced = true;
        const rotatedRevision = 'revision-rotated';
        await persisted.applySettingsPatch({
          expected: { key: SLACK_SETTING_KEYS.connectionRevision, value: 'revision-old' },
          set: [
            { key: SLACK_SETTING_KEYS.connectionRevision, value: rotatedRevision },
            { key: SLACK_SETTING_KEYS.botToken, value: 'xoxb-rotated' },
            { key: SLACK_SETTING_KEYS.signingSecret, value: 'secret-rotated' },
          ],
        });
        primeStoredSlackCredentials(
          {
            botToken: 'xoxb-rotated',
            signingSecret: 'secret-rotated',
            botUserId: undefined,
          },
          rotatedRevision,
        );
      }
      return persisted.applySettingsPatch(patch);
    },
    mergeSettingStringSet: (key, values) => persisted.mergeSettingStringSet(key, values),
  };
  try {
    await persisted.setSetting(SLACK_SETTING_KEYS.connectionRevision, 'revision-old');
    await persisted.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-old');
    await persisted.setSetting(SLACK_SETTING_KEYS.signingSecret, 'secret-old');

    await withEnv(NO_SLACK_ENV, async () => {
      const response = await appWith(racing).request('/admin/api/slack-connection', {
        method: 'DELETE',
        headers: auth(),
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: 'slack_connection_changed',
        message: 'Slack connection changed before it could be disconnected. Try again.',
      });
      assert.deepEqual(await resolveSlackCredentials(), {
        botToken: 'xoxb-rotated',
        signingSecret: 'secret-rotated',
        botUserId: undefined,
      });
    });
    assert.deepEqual(
      await persisted.getSettings([
        SLACK_SETTING_KEYS.connectionRevision,
        SLACK_SETTING_KEYS.botToken,
        SLACK_SETTING_KEYS.signingSecret,
      ]),
      ['revision-rotated', 'xoxb-rotated', 'secret-rotated'],
    );
  } finally {
    invalidateStoredSlackCredentials();
    persisted.close();
  }
});

test('Cloudflare isolates re-check the durable connection revision before reusing credentials', async () => {
  const values = new Map<string, string>([
    [SLACK_SETTING_KEYS.connectionRevision, 'revision-1'],
    [SLACK_SETTING_KEYS.botToken, 'xoxb-old'],
    [SLACK_SETTING_KEYS.signingSecret, 'old-secret'],
    [SLACK_SETTING_KEYS.botUserId, 'U_OLD'],
  ]);
  const revisionReads: string[] = [];
  const snapshots: string[][] = [];
  const stub = {
    settingGet: async (key: string) => {
      revisionReads.push(key);
      return { ok: true as const, value: values.get(key) ?? null };
    },
    settingGetMany: async (keys: readonly string[]) => {
      snapshots.push([...keys]);
      return { ok: true as const, value: keys.map((key) => values.get(key) ?? null) };
    },
  };
  const platformEnv = { TAG_STATE: { getByName: () => stub } };

  try {
    await withEnv(NO_SLACK_ENV, async () => {
      await withCloudflareUserAgent(async () => {
        invalidateStoredSlackCredentials();
        assert.deepEqual(await resolveSlackCredentials(platformEnv as never), {
          botToken: 'xoxb-old',
          signingSecret: 'old-secret',
          botUserId: 'U_OLD',
        });

        // Simulate a disconnect committed by another Worker isolate.
        values.set(SLACK_SETTING_KEYS.connectionRevision, 'revision-2');
        values.delete(SLACK_SETTING_KEYS.botToken);
        values.delete(SLACK_SETTING_KEYS.signingSecret);
        values.delete(SLACK_SETTING_KEYS.botUserId);

        assert.deepEqual(await resolveSlackCredentials(platformEnv as never), {
          botToken: undefined,
          signingSecret: undefined,
          botUserId: undefined,
        });
      });
    });
    assert.deepEqual(revisionReads, [SLACK_SETTING_KEYS.connectionRevision]);
    assert.equal(snapshots.length, 2);
  } finally {
    invalidateStoredSlackCredentials();
  }
});

test('fallback bot-user identity is cached per bot token across rotations', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const fake = await listenTokenAwareFakeSlack({
    'xoxb-one': 'U_ONE',
    'xoxb-two': 'U_TWO',
  });
  try {
    invalidateSlackBotUserIdCache();
    await withEnv(
      {
        ...NO_SLACK_ENV,
        SLACK_API_URL: fake.baseUrl,
        SLACK_BOT_TOKEN: 'xoxb-one',
        SLACK_STATE_DB_PATH: ':memory:',
      },
      async () => assert.equal(await resolveBotUserId(undefined), 'U_ONE'),
    );
    await withEnv(
      {
        ...NO_SLACK_ENV,
        SLACK_API_URL: fake.baseUrl,
        SLACK_BOT_TOKEN: 'xoxb-two',
        SLACK_STATE_DB_PATH: ':memory:',
      },
      async () => assert.equal(await resolveBotUserId(undefined), 'U_TWO'),
    );
    assert.deepEqual(fake.authHeaders, ['Bearer xoxb-one', 'Bearer xoxb-two']);
  } finally {
    invalidateSlackBotUserIdCache();
    invalidateStoredSlackCredentials();
    await closeServer(fake.server);
  }
});

test('Slack behavior settings default on, persist booleans, and report provenance', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await withEnv(NO_SLACK_ENV, async () => {
      const app = appWith(settings);
      const defaults = await app.request('/admin/api/slack-behavior', { headers: auth() });
      assert.equal(defaults.status, 200);
      assert.deepEqual(await defaults.json(), {
        allowDms: { value: true, source: 'default' },
        unassignedHint: { value: true, source: 'default' },
        welcomeOnJoin: { value: true, source: 'default' },
        ambientParticipation: { value: true, source: 'default' },
        progressiveStreaming: { value: false, source: 'default' },
        nativeTasks: { value: false, source: 'default' },
      });

      const saved = await app.request('/admin/api/slack-behavior', {
        method: 'PUT',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({
          allowDms: false,
          welcomeOnJoin: false,
          nativeTasks: true,
          progressiveStreaming: true,
        }),
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(await saved.json(), {
        allowDms: { value: false, source: 'stored' },
        unassignedHint: { value: true, source: 'default' },
        welcomeOnJoin: { value: false, source: 'stored' },
        ambientParticipation: { value: true, source: 'default' },
        progressiveStreaming: { value: true, source: 'stored' },
        nativeTasks: { value: true, source: 'stored' },
      });
    });
  } finally {
    settings.close();
  }
});

test('Slack behavior multi-key updates use one atomic settings patch', async () => {
  const persisted = new SqliteSettingsStore(':memory:');
  let patchCalls = 0;
  const atomicOnly: SettingsStore = {
    getSetting: (key) => persisted.getSetting(key),
    getSettings: (keys) => persisted.getSettings(keys),
    setSetting: async () => {
      throw new Error('multi-key behavior updates must not write settings individually');
    },
    deleteSetting: (key) => persisted.deleteSetting(key),
    applySettingsPatch: async (patch) => {
      patchCalls += 1;
      return persisted.applySettingsPatch(patch);
    },
    mergeSettingStringSet: (key, values) => persisted.mergeSettingStringSet(key, values),
  };
  try {
    await withEnv(NO_SLACK_ENV, async () => {
      const app = appWith(atomicOnly);
      const saved = await app.request('/admin/api/slack-behavior', {
        method: 'PUT',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ allowDms: false, welcomeOnJoin: false }),
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(await saved.json(), {
        allowDms: { value: false, source: 'stored' },
        unassignedHint: { value: true, source: 'default' },
        welcomeOnJoin: { value: false, source: 'stored' },
        ambientParticipation: { value: true, source: 'default' },
        progressiveStreaming: { value: false, source: 'default' },
        nativeTasks: { value: false, source: 'default' },
      });
      assert.equal(patchCalls, 1);
    });
  } finally {
    persisted.close();
  }
});

test('Slack behavior env overrides are read-only and PUT is atomic', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await withEnv(
      { ...NO_SLACK_ENV, SLACK_TAG_ALLOW_DMS: 'false', SLACK_TAG_WELCOME_ON_JOIN: '0' },
      async () => {
        const app = appWith(settings);
        const current = await app.request('/admin/api/slack-behavior', { headers: auth() });
        assert.deepEqual(await current.json(), {
          allowDms: { value: false, source: 'env' },
          unassignedHint: { value: true, source: 'default' },
          welcomeOnJoin: { value: false, source: 'env' },
          ambientParticipation: { value: true, source: 'default' },
          progressiveStreaming: { value: false, source: 'default' },
          nativeTasks: { value: false, source: 'default' },
        });

        const conflict = await app.request('/admin/api/slack-behavior', {
          method: 'PUT',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ allowDms: true, unassignedHint: false }),
        });
        assert.equal(conflict.status, 409);
        assert.deepEqual(await conflict.json(), {
          error: 'slack_setting_read_only',
          settings: ['allowDms'],
        });

        // No partial write: the otherwise-writable sibling remains default.
        assert.equal(
          (await (await app.request('/admin/api/slack-behavior', { headers: auth() })).json() as {
            unassignedHint: { source: string };
          }).unassignedHint.source,
          'default',
        );
      },
    );
  } finally {
    settings.close();
  }
});

test('blank Slack behavior env placeholders do not lock browser-managed settings', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await withEnv(
      {
        ...NO_SLACK_ENV,
        SLACK_TAG_ALLOW_DMS: '',
        SLACK_TAG_UNASSIGNED_HINT: '   ',
      },
      async () => {
        const app = appWith(settings);
        const current = await app.request('/admin/api/slack-behavior', { headers: auth() });
        assert.deepEqual(await current.json(), {
          allowDms: { value: true, source: 'default' },
          unassignedHint: { value: true, source: 'default' },
          welcomeOnJoin: { value: true, source: 'default' },
          ambientParticipation: { value: true, source: 'default' },
          progressiveStreaming: { value: false, source: 'default' },
          nativeTasks: { value: false, source: 'default' },
        });

        const saved = await app.request('/admin/api/slack-behavior', {
          method: 'PUT',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ allowDms: false, unassignedHint: false }),
        });
        assert.equal(saved.status, 200);
        assert.deepEqual(await saved.json(), {
          allowDms: { value: false, source: 'stored' },
          unassignedHint: { value: false, source: 'stored' },
          welcomeOnJoin: { value: true, source: 'default' },
          ambientParticipation: { value: true, source: 'default' },
          progressiveStreaming: { value: false, source: 'default' },
          nativeTasks: { value: false, source: 'default' },
        });
      },
    );
  } finally {
    settings.close();
  }
});

test('Slack behavior PUT rejects empty, unknown, and non-boolean bodies', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await withEnv(NO_SLACK_ENV, async () => {
      const app = appWith(settings);
      for (const body of [{}, { surprise: true }, { allowDms: 'false' }, undefined]) {
        const response = await app.request('/admin/api/slack-behavior', {
          method: 'PUT',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400, JSON.stringify(body));
      }
    });
  } finally {
    settings.close();
  }
});

test('wizard GET reports missing credentials and substitutes the request origin into the manifest link', async () => {
  await withEnv(NO_SLACK_ENV, async () => {
    const settings = new SqliteSettingsStore(':memory:');
    try {
      const app = appWith(settings);
      const response = await app.request('https://tag.example.workers.dev/admin/api/slack-connection', {
        headers: auth(),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        connected: boolean;
        credentials: Record<string, string>;
        requestUrl: string;
        manifestUrl: string;
      };
      assert.deepEqual(body.credentials, {
        botToken: 'missing',
        signingSecret: 'missing',
        botUserId: 'missing',
      });
      assert.equal(body.connected, false);
      assert.equal(body.requestUrl, 'https://tag.example.workers.dev/channels/slack/events');

      const manifestUrl = new URL(body.manifestUrl);
      assert.equal(`${manifestUrl.origin}${manifestUrl.pathname}`, 'https://api.slack.com/apps');
      assert.equal(manifestUrl.searchParams.get('new_app'), '1');
      const manifest = JSON.parse(manifestUrl.searchParams.get('manifest_json') ?? '{}') as {
        $schema?: string;
        display_information: { name: string };
        features: { agent_view?: unknown; assistant_view?: unknown };
        settings: {
          event_subscriptions: { request_url: string; bot_events: string[] };
          interactivity: { is_enabled: boolean };
        };
      };
      // The one substitution that removes the copy-the-URL setup step.
      assert.equal(manifest.settings.event_subscriptions.request_url, body.requestUrl);
      // Editor-tooling key must not leak into Slack's manifest import.
      assert.equal(manifest.$schema, undefined);
      assert.equal(manifest.display_information.name, 'Chickpea');
      assert.ok(manifest.features.agent_view);
      assert.equal(manifest.features.assistant_view, undefined);
      assert.ok(manifest.settings.event_subscriptions.bot_events.includes('app_context_changed'));
      assert.equal(manifest.settings.interactivity.is_enabled, false);
    } finally {
      settings.close();
    }
  });
});

test('wizard GET honors x-forwarded-proto/host when deriving the events URL', async () => {
  await withEnv(NO_SLACK_ENV, async () => {
    const settings = new SqliteSettingsStore(':memory:');
    try {
      const app = appWith(settings);
      const response = await app.request('http://127.0.0.1:8787/admin/api/slack-connection', {
        headers: {
          ...auth(),
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'chickpea.acme.workers.dev',
        },
      });
      const body = (await response.json()) as { requestUrl: string; manifestUrl: string };
      assert.equal(body.requestUrl, 'https://chickpea.acme.workers.dev/channels/slack/events');
      assert.ok(body.manifestUrl.includes(encodeURIComponent(body.requestUrl)));
    } finally {
      settings.close();
    }
  });
});

test('wizard GET reports env-configured credentials as read-only env sources', async () => {
  await withEnv(
    {
      ...NO_SLACK_ENV,
      SLACK_BOT_TOKEN: 'xoxb-env',
      SLACK_SIGNING_SECRET: 'env-secret',
      SLACK_BOT_USER_ID: 'U_ENV',
    },
    async () => {
      const settings = new SqliteSettingsStore(':memory:');
      try {
        const app = appWith(settings);
        const response = await app.request('/admin/api/slack-connection', { headers: auth() });
        const body = (await response.json()) as {
          connected: boolean;
          credentials: Record<string, string>;
        };
        assert.deepEqual(body.credentials, {
          botToken: 'env',
          signingSecret: 'env',
          botUserId: 'env',
        });
        assert.equal(body.connected, true);
      } finally {
        settings.close();
      }
    },
  );
});

test('wizard POST validates via auth.test, persists creds + bot user id, and the resolver serves them', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenFakeSlack({
    ok: true,
    team: 'Acme Inc',
    user: 'tag',
    user_id: 'U_TAG_BOT',
  });
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  try {
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const app = appWith(settings, config);
      const response = await postCreds(app, {
        botToken: 'xoxb-pasted',
        signingSecret: 'pasted-secret',
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.team, 'Acme Inc');
      assert.equal(body.botName, 'tag');
      assert.equal(body.botUserId, 'U_TAG_BOT');
      // The signing secret cannot be validated here — the response says when
      // it is proven instead.
      assert.match(String(body.note), /first signed/i);

      assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.botToken), 'xoxb-pasted');
      assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.signingSecret), 'pasted-secret');
      assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.botUserId), 'U_TAG_BOT');

      const statuses = await app.request('/admin/api/slack-connection', { headers: auth() });
      const statusBody = (await statuses.json()) as {
        connected: boolean;
        credentials: Record<string, string>;
      };
      assert.deepEqual(statusBody.credentials, {
        botToken: 'stored',
        signingSecret: 'stored',
        botUserId: 'stored',
      });
      assert.equal(statusBody.connected, true);

      // The resolver (the thing signature verification and the WebClient
      // consume) now serves the stored triple...
      const resolved = await resolveSlackCredentials(undefined, settings);
      assert.equal(resolved.botToken, 'xoxb-pasted');
      assert.equal(resolved.signingSecret, 'pasted-secret');
      assert.equal(resolved.botUserId, 'U_TAG_BOT');
      assert.deepEqual(
        (await config.listSlackIdentityAuditEvents()).map(({ eventType }) => eventType),
        ['slack_identity.credentials_connected'],
      );
    });

    // ...and env values keep per-key precedence over the same store.
    await withEnv(
      { ...NO_SLACK_ENV, SLACK_BOT_TOKEN: 'xoxb-env-wins', SLACK_SIGNING_SECRET: 'env-secret-wins' },
      async () => {
        const resolved = await resolveSlackCredentials(undefined, settings);
        assert.equal(resolved.botToken, 'xoxb-env-wins');
        assert.equal(resolved.signingSecret, 'env-secret-wins');
        // The env bot token wins, so the STORED bot user id (saved with the
        // stored token) is NOT adopted: with no env SLACK_BOT_USER_ID this
        // falls through to the auth.test probe (undefined), never binding a
        // different bot's id to the env token.
        assert.equal(resolved.botUserId, undefined);
      },
    );
  } finally {
    invalidateStoredSlackCredentials();
    config.close();
    settings.close();
    await closeServer(server);
  }
});

test('wizard rotation replaces the whole connection record and clears omitted metadata', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenFakeSlack({ ok: true });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.connectionRevision, 'revision-old');
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-old');
    await settings.setSetting(SLACK_SETTING_KEYS.signingSecret, 'secret-old');
    await settings.setSetting(SLACK_SETTING_KEYS.botUserId, 'U_OLD');
    await settings.setSetting(SLACK_SETTING_KEYS.teamId, 'T_OLD');
    await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Old Team');
    await settings.setSetting(SLACK_SETTING_KEYS.teamTokenFingerprint, 'old-fingerprint');
    primeStoredSlackCredentials(
      { botToken: 'xoxb-old', signingSecret: 'secret-old', botUserId: 'U_OLD' },
      'revision-old',
    );

    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      assert.deepEqual(await resolveSlackCredentials(), {
        botToken: 'xoxb-old',
        signingSecret: 'secret-old',
        botUserId: 'U_OLD',
      });
      const response = await postCreds(appWith(settings), {
        botToken: 'xoxb-new',
        signingSecret: 'secret-new',
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await resolveSlackCredentials(), {
        botToken: 'xoxb-new',
        signingSecret: 'secret-new',
        botUserId: undefined,
      });
    });

    const [revision, token, secret, botUserId, teamId, teamName, fingerprint] =
      await settings.getSettings([
        SLACK_SETTING_KEYS.connectionRevision,
        SLACK_SETTING_KEYS.botToken,
        SLACK_SETTING_KEYS.signingSecret,
        SLACK_SETTING_KEYS.botUserId,
        SLACK_SETTING_KEYS.teamId,
        SLACK_SETTING_KEYS.teamName,
        SLACK_SETTING_KEYS.teamTokenFingerprint,
      ]);
    assert.notEqual(revision, 'revision-old');
    assert.ok(revision);
    assert.deepEqual(
      [token, secret, botUserId, teamId, teamName, fingerprint],
      ['xoxb-new', 'secret-new', undefined, undefined, undefined, undefined],
    );
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
    await closeServer(server);
  }
});

test('wizard rotation leaves the prior connection and cache intact when the atomic write fails', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenFakeSlack({
    ok: true,
    team_id: 'T_NEW',
    team: 'New Team',
    user_id: 'U_NEW',
  });
  const persisted = new SqliteSettingsStore(':memory:');
  const failing: SettingsStore = {
    getSetting: (key) => persisted.getSetting(key),
    getSettings: (keys) => persisted.getSettings(keys),
    setSetting: (key, value) => persisted.setSetting(key, value),
    deleteSetting: (key) => persisted.deleteSetting(key),
    applySettingsPatch: async () => {
      throw new Error('atomic rotation unavailable');
    },
    mergeSettingStringSet: (key, values) => persisted.mergeSettingStringSet(key, values),
  };
  try {
    await persisted.setSetting(SLACK_SETTING_KEYS.connectionRevision, 'revision-old');
    await persisted.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-old');
    await persisted.setSetting(SLACK_SETTING_KEYS.signingSecret, 'secret-old');
    await persisted.setSetting(SLACK_SETTING_KEYS.teamId, 'T_OLD');
    primeStoredSlackCredentials(
      { botToken: 'xoxb-old', signingSecret: 'secret-old', botUserId: undefined },
      'revision-old',
    );

    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await postCreds(appWith(failing), {
        botToken: 'xoxb-new',
        signingSecret: 'secret-new',
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'internal_error' });
    });
    assert.deepEqual(
      await persisted.getSettings([
        SLACK_SETTING_KEYS.connectionRevision,
        SLACK_SETTING_KEYS.botToken,
        SLACK_SETTING_KEYS.signingSecret,
        SLACK_SETTING_KEYS.teamId,
      ]),
      ['revision-old', 'xoxb-old', 'secret-old', 'T_OLD'],
    );
    const resolved = await resolveSlackCredentials();
    assert.equal(resolved.botToken, 'xoxb-old');
    assert.equal(resolved.signingSecret, 'secret-old');
  } finally {
    invalidateStoredSlackCredentials();
    persisted.close();
    await closeServer(server);
  }
});

test('a delayed wizard rotation cannot recreate a connection after disconnect wins', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const controlled = await listenControlledFakeSlack({
    ok: true,
    team_id: 'T_NEW',
    team: 'New Team',
    user_id: 'U_NEW',
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-old');
    await settings.setSetting(SLACK_SETTING_KEYS.signingSecret, 'secret-old');
    const app = appWith(settings);

    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: controlled.baseUrl }, async () => {
      const pendingRotation = postCreds(app, {
        botToken: 'xoxb-new',
        signingSecret: 'secret-new',
      });
      await controlled.authStarted;

      const disconnected = await app.request('/admin/api/slack-connection', {
        method: 'DELETE',
        headers: auth(),
      });
      assert.equal(disconnected.status, 200);

      controlled.releaseAuth();
      const staleRotation = await pendingRotation;
      assert.equal(staleRotation.status, 409);
      assert.deepEqual(await staleRotation.json(), {
        error: 'slack_connection_changed',
        message: 'Slack connection changed while credentials were being validated. Try again.',
      });
    });

    const [revision, token, secret, teamId] = await settings.getSettings([
      SLACK_SETTING_KEYS.connectionRevision,
      SLACK_SETTING_KEYS.botToken,
      SLACK_SETTING_KEYS.signingSecret,
      SLACK_SETTING_KEYS.teamId,
    ]);
    assert.ok(revision, 'disconnect leaves a revision tombstone');
    assert.deepEqual([token, secret, teamId], [undefined, undefined, undefined]);
  } finally {
    controlled.releaseAuth();
    invalidateStoredSlackCredentials();
    settings.close();
    await closeServer(controlled.server);
  }
});

test('a delayed team-info backfill cannot restore stale metadata after disconnect', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const controlled = await listenControlledFakeSlack({
    ok: true,
    team_id: 'T_OLD',
    team: 'Old Team',
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.connectionRevision, 'revision-old');
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-old');
    await settings.setSetting(SLACK_SETTING_KEYS.signingSecret, 'secret-old');
    const app = appWith(settings);

    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: controlled.baseUrl }, async () => {
      const pendingBackfill = resolveSlackTeamInfo(undefined, settings);
      await controlled.authStarted;

      const disconnected = await app.request('/admin/api/slack-connection', {
        method: 'DELETE',
        headers: auth(),
      });
      assert.equal(disconnected.status, 200);

      controlled.releaseAuth();
      assert.deepEqual(await pendingBackfill, { teamId: undefined, teamName: undefined });
    });
    assert.deepEqual(
      await settings.getSettings([
        SLACK_SETTING_KEYS.botToken,
        SLACK_SETTING_KEYS.signingSecret,
        SLACK_SETTING_KEYS.teamId,
        SLACK_SETTING_KEYS.teamName,
        SLACK_SETTING_KEYS.teamTokenFingerprint,
      ]),
      [undefined, undefined, undefined, undefined, undefined],
    );
  } finally {
    controlled.releaseAuth();
    invalidateStoredSlackCredentials();
    settings.close();
    await closeServer(controlled.server);
  }
});

test('a successful team-info backfill removes a stale team name omitted by Slack', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenFakeSlack({
    ok: true,
    team_id: 'T_NEW',
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.connectionRevision, 'revision-current');
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-current');
    await settings.setSetting(SLACK_SETTING_KEYS.teamId, 'T_STALE');
    await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Stale Team');
    await settings.setSetting(SLACK_SETTING_KEYS.teamTokenFingerprint, 'stale-fingerprint');

    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      assert.deepEqual(await resolveSlackTeamInfo(undefined, settings), {
        teamId: 'T_NEW',
        teamName: undefined,
      });
    });
    assert.deepEqual(
      await settings.getSettings([
        SLACK_SETTING_KEYS.teamId,
        SLACK_SETTING_KEYS.teamName,
        SLACK_SETTING_KEYS.teamTokenFingerprint,
      ]),
      ['T_NEW', undefined, slackTokenFingerprint('xoxb-current')],
    );
  } finally {
    settings.close();
    await closeServer(server);
  }
});

test('wizard POST stores nothing when Slack rejects the token', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenFakeSlack({ ok: false, error: 'invalid_auth' });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const app = appWith(settings);
      const response = await postCreds(app, { botToken: 'xoxb-bad', signingSecret: 'secret' });
      assert.equal(response.status, 422);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.error, 'slack_auth_failed');
      assert.equal(body.detail, 'invalid_auth');
      assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.botToken), undefined);
      assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.signingSecret), undefined);
    });
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
    await closeServer(server);
  }
});

test('wizard POST rejects a missing/empty credential body without calling Slack', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    // No SLACK_API_URL fake is running: reaching auth.test would fail loudly,
    // so a 400 here proves validation short-circuits before any network call.
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: 'http://127.0.0.1:9' }, async () => {
      const app = appWith(settings);
      assert.equal((await postCreds(app, { botToken: 'xoxb-x' })).status, 400);
      assert.equal((await postCreds(app, { botToken: '', signingSecret: '' })).status, 400);
      assert.equal((await postCreds(app, undefined)).status, 400);
      // Whitespace-only clears the schema's min-length but must still 400: it
      // would otherwise store empty and resolve back as 'missing'.
      assert.equal((await postCreds(app, { botToken: '   ', signingSecret: '\t' })).status, 400);
      assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.botToken), undefined);
    });
  } finally {
    settings.close();
  }
});

test('events route fails closed (401) when no signing secret is configured anywhere', async () => {
  await withEnv({ ...NO_SLACK_ENV, TAG_DB_PATH: ':memory:', SLACK_STATE_DB_PATH: undefined }, async () => {
    invalidateStoredSlackCredentials();
    const { channel } = await import('../src/channels/slack.ts');
    const route = channel.routes.find((r) => r.path === '/events');
    assert.ok(route, 'channel must expose the /events route');
    // Minimal structural context: the gate only touches c.env and c.json
    // before it 401s (never reaching @flue/slack's verifier).
    const fakeContext = {
      env: undefined,
      json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
    };
    const response = (await route.handler(
      fakeContext as never,
      undefined as never,
    )) as Response;
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'slack_not_configured' });
  });
});

test('events route echoes a url_verification challenge before any signing secret exists (bootstrap)', async () => {
  await withEnv(
    { ...NO_SLACK_ENV, TAG_DB_PATH: ':memory:', SLACK_STATE_DB_PATH: undefined },
    async () => {
      invalidateStoredSlackCredentials();
      const { channel } = await import('../src/channels/slack.ts');
      const route = channel.routes.find((r) => r.path === '/events');
      assert.ok(route, 'channel must expose the /events route');
      const json = (body: unknown, status?: number) =>
        Response.json(body, { status: status ?? 200 });

      // A challenge body with no secret configured is accepted ONCE so a
      // manifest-created app can verify its request URL before the wizard runs.
      const challengeCtx = {
        env: undefined,
        req: { json: async () => ({ type: 'url_verification', challenge: 'abc123' }) },
        json,
      };
      const ok = (await route.handler(challengeCtx as never, undefined as never)) as Response;
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { challenge: 'abc123' });

      // A NON-challenge event with no secret still fails closed.
      const eventCtx = {
        env: undefined,
        req: { json: async () => ({ type: 'event_callback', event: { type: 'app_mention' } }) },
        json,
      };
      const denied = (await route.handler(eventCtx as never, undefined as never)) as Response;
      assert.equal(denied.status, 401);
      assert.deepEqual(await denied.json(), { error: 'slack_not_configured' });
    },
  );
});

test('scoped identity ingress records one bounded pending challenge and rejects secretless events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-slack-identity-ingress-pending-'));
  const path = join(directory, 'state.db');
  try {
    await withEnv(
      { ...NO_SLACK_ENV, TAG_DB_PATH: path, SLACK_STATE_DB_PATH: path },
      async () => {
        const config = new SqliteConfigStore(path);
        const settings = new SqliteSettingsStore(path);
        try {
          const identity = await config.createSlackIdentity(pendingIdentity());
          const app = await identityIngressApp();
          const challenge = signedSlackEvent('future-secret', {
            type: 'url_verification',
            challenge: 'challenge-finance',
          });
          const url = `/channels/slack/events/${identity.ingressKey}`;
          const captured = await captureSlackIdentityOperationalEvents(async () => {
            const accepted = await app.request(url, {
              method: 'POST',
              headers: challenge.headers,
              body: challenge.body,
            });
            assert.equal(accepted.status, 200, await accepted.clone().text());
            assert.deepEqual(await accepted.json(), { challenge: 'challenge-finance' });
            assert.equal(
              (await readPendingSlackChallenge(settings, identity.id))?.rawBody,
              challenge.body,
            );

            const duplicate = await app.request(url, {
              method: 'POST',
              headers: challenge.headers,
              body: challenge.body,
            });
            assert.equal(duplicate.status, 429);

            const event = signedSlackEvent('future-secret', {
              type: 'event_callback',
              api_app_id: 'A0FINANCE',
              team_id: 'T_ACME',
              event_id: 'Ev_SECRETLESS',
              event: { type: 'app_mention' },
            });
            const denied = await app.request(url, {
              method: 'POST',
              headers: event.headers,
              body: event.body,
            });
            assert.equal(denied.status, 401);

            const unknown = await app.request(
              '/channels/slack/events/unknown_ingress_0123456789abcdef',
              {
                method: 'POST',
                headers: challenge.headers,
                body: challenge.body,
              },
            );
            assert.equal(unknown.status, 401);

            const oversized = await app.request(url, {
              method: 'POST',
              headers: {
                ...challenge.headers,
                'content-length': String(MAX_PENDING_SLACK_CHALLENGE_BYTES + 1),
              },
              body: challenge.body,
            });
            assert.equal(oversized.status, 413);
          });
          assert.ok(captured.events.some((event) =>
            event.operation === 'setup_handshake' && event.outcome === 'accepted'));
          assert.ok(captured.events.some((event) =>
            event.operation === 'setup_handshake' && event.outcome === 'rejected'));
          assert.doesNotMatch(captured.serialized, /challenge-finance|future-secret/);
        } finally {
          config.close();
          settings.close();
        }
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('scoped identity ingress records a retried challenge after credentials are stored', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-slack-identity-ingress-retry-'));
  const path = join(directory, 'state.db');
  try {
    await withEnv(
      { ...NO_SLACK_ENV, TAG_DB_PATH: path, SLACK_STATE_DB_PATH: path },
      async () => {
        const config = new SqliteConfigStore(path);
        const settings = new SqliteSettingsStore(path);
        try {
          const identity = await config.createSlackIdentity(pendingIdentity({
            lifecycle: 'credentials_pending',
            teamId: 'T_ACME',
            appId: 'A0FINANCE',
            botUserId: 'U_FINANCE',
            credentialProvenance: 'stored',
            connectionRevision: 1,
            health: 'healthy',
          }));
          await writeSlackIdentityCredentials(settings, identity.id, null, {
            botToken: 'xoxb-finance',
            signingSecret: 'finance-secret',
            botUserId: 'U_FINANCE',
          });
          const app = await identityIngressApp();
          const url = `/channels/slack/events/${identity.ingressKey}`;
          const challenge = signedSlackEvent('finance-secret', {
            type: 'url_verification',
            challenge: 'challenge-finance-retry',
          });

          const accepted = await app.request(url, {
            method: 'POST',
            headers: challenge.headers,
            body: challenge.body,
          });
          assert.equal(accepted.status, 200, await accepted.clone().text());
          assert.deepEqual(await accepted.json(), { challenge: 'challenge-finance-retry' });
          assert.equal(
            (await readPendingSlackChallenge(settings, identity.id))?.rawBody,
            challenge.body,
          );

          const event = signedSlackEvent('finance-secret', {
            type: 'event_callback',
            api_app_id: 'A0FINANCE',
            team_id: 'T_ACME',
            event_id: 'Ev_PENDING_RETRY',
            event: { type: 'app_mention' },
          });
          const denied = await app.request(url, {
            method: 'POST',
            headers: event.headers,
            body: event.body,
          });
          assert.equal(denied.status, 401);

          const connected = await completeSlackIdentityConnection({
            config,
            settings,
            identityId: identity.id,
            expectedRevision: identity.connectionRevision,
          });
          assert.equal(connected.lifecycle, 'connected');
          assert.equal(await readPendingSlackChallenge(settings, identity.id), undefined);
        } finally {
          config.close();
          settings.close();
        }
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('scoped ingress verifies the selected identity secret and binds app plus workspace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-slack-identity-ingress-bound-'));
  const path = join(directory, 'state.db');
  try {
    await withEnv(
      { ...NO_SLACK_ENV, TAG_DB_PATH: path, SLACK_STATE_DB_PATH: path },
      async () => {
        const config = new SqliteConfigStore(path);
        const settings = new SqliteSettingsStore(path);
        try {
          const identity = await config.createSlackIdentity(
            pendingIdentity({
              lifecycle: 'connected',
              teamId: 'T_ACME',
              appId: 'A0FINANCE',
              botUserId: 'U_FINANCE',
              credentialProvenance: 'stored',
              health: 'healthy',
            }),
          );
          await writeSlackIdentityCredentials(settings, identity.id, null, {
            botToken: 'xoxb-finance',
            signingSecret: 'finance-secret',
            botUserId: 'U_FINANCE',
          });
          await config.updateAgent('agent_default', { slackIdentityId: identity.id });
          await config.putAssignment({
            workspaceId: 'T_ACME',
            channelId: 'C_FINANCE',
            agentId: 'agent_default',
            enabled: true,
          });
          const app = await identityIngressApp();
          const url = `/channels/slack/events/${identity.ingressKey}`;
          const basePayload = {
            type: 'event_callback',
            api_app_id: 'A0FINANCE',
            team_id: 'T_ACME',
            event_id: 'Ev_FINANCE',
            event: {
              type: 'app_mention',
              user: 'U_MEMBER',
              text: '<@U_FINANCE> hello',
              ts: '1782770400.000100',
              event_ts: '1782770400.000100',
              channel: 'C_FINANCE',
            },
          };

          const wrongSecret = signedSlackEvent('other-secret', basePayload);
          assert.equal(
            (await app.request(url, {
              method: 'POST',
              headers: wrongSecret.headers,
              body: wrongSecret.body,
            })).status,
            401,
          );

          const wrongApp = signedSlackEvent('finance-secret', {
            ...basePayload,
            api_app_id: 'A_OTHER',
          });
          assert.equal(
            (await app.request(url, {
              method: 'POST',
              headers: wrongApp.headers,
              body: wrongApp.body,
            })).status,
            401,
          );

          const wrongTeam = signedSlackEvent('finance-secret', {
            ...basePayload,
            team_id: 'T_OTHER',
          });
          assert.equal(
            (await app.request(url, {
              method: 'POST',
              headers: wrongTeam.headers,
              body: wrongTeam.body,
            })).status,
            401,
          );

          const valid = signedSlackEvent('finance-secret', basePayload);
          const validResponse = await app.request(url, {
              method: 'POST',
              headers: valid.headers,
              body: valid.body,
            });
          assert.equal(validResponse.status, 200, await validResponse.clone().text());

        } finally {
          config.close();
          settings.close();
        }
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a cached scoped ingress router adopts signing-secret rotation without a restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-slack-identity-ingress-rotation-'));
  const path = join(directory, 'state.db');
  try {
    await withEnv(
      { ...NO_SLACK_ENV, TAG_DB_PATH: path, SLACK_STATE_DB_PATH: path },
      async () => {
        const config = new SqliteConfigStore(path);
        const settings = new SqliteSettingsStore(path);
        try {
          const identity = await config.createSlackIdentity(pendingIdentity({
            lifecycle: 'connected',
            teamId: 'T_ACME',
            appId: 'A0FINANCE',
            botUserId: 'U_FINANCE',
            credentialProvenance: 'stored',
            health: 'healthy',
          }));
          await writeSlackIdentityCredentials(settings, identity.id, null, {
            botToken: 'xoxb-finance-v1',
            signingSecret: 'finance-secret-v1',
            botUserId: 'U_FINANCE',
          });
          const app = await identityIngressApp();
          const url = `/channels/slack/events/${identity.ingressKey}`;
          const payload = (eventId: string) => ({
            type: 'event_callback',
            api_app_id: 'A0FINANCE',
            team_id: 'T_ACME',
            event_id: eventId,
            event: { type: 'assistant_thread_started' },
          });

          const v1 = signedSlackEvent('finance-secret-v1', payload('Ev_ROTATION_V1'));
          assert.equal((await app.request(url, {
            method: 'POST',
            headers: v1.headers,
            body: v1.body,
          })).status, 200);

          const currentCredentials = await resolveSlackIdentityCredentials(
            identity.id,
            undefined,
            settings,
          );
          await writeSlackIdentityCredentials(
            settings,
            identity.id,
            currentCredentials.connectionRevision,
            {
              botToken: 'xoxb-finance-v2',
              signingSecret: 'finance-secret-v2',
              botUserId: 'U_FINANCE',
            },
          );

          const v2 = signedSlackEvent('finance-secret-v2', payload('Ev_ROTATION_V2'));
          assert.equal((await app.request(url, {
            method: 'POST',
            headers: v2.headers,
            body: v2.body,
          })).status, 200, 'the same router must load and accept the v2 secret');

          const staleV1 = signedSlackEvent('finance-secret-v1', payload('Ev_ROTATION_STALE'));
          assert.equal((await app.request(url, {
            method: 'POST',
            headers: staleV1.headers,
            body: staleV1.body,
          })).status, 401, 'the same router must stop accepting the v1 secret');
        } finally {
          config.close();
          settings.close();
        }
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a verified non-selected identity exits before claims, Work, or Slack API reads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-slack-identity-non-selected-'));
  const path = join(directory, 'state.db');
  try {
    await withEnv(
      {
        ...NO_SLACK_ENV,
        TAG_DB_PATH: path,
        SLACK_STATE_DB_PATH: path,
        SLACK_API_URL: 'http://127.0.0.1:9/api/',
      },
      async () => {
        const config = new SqliteConfigStore(path);
        const settings = new SqliteSettingsStore(path);
        try {
          const identity = await config.createSlackIdentity(pendingIdentity({
            lifecycle: 'connected',
            teamId: 'T_ACME',
            appId: 'A0FINANCE',
            botUserId: 'U_FINANCE',
            credentialProvenance: 'stored',
            health: 'healthy',
          }));
          await config.updateAgent('agent_default', { slackIdentityId: identity.id });
          await config.putAssignment({
            workspaceId: 'T_ACME',
            channelId: 'C_FINANCE',
            agentId: 'agent_default',
            enabled: true,
          });
          await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-default');
          await settings.setSetting(SLACK_SETTING_KEYS.signingSecret, 'default-secret');
          await settings.setSetting(SLACK_SETTING_KEYS.botUserId, 'U_DEFAULT');

          const app = await identityIngressApp();
          const event = signedSlackEvent('default-secret', {
            type: 'event_callback',
            api_app_id: 'A_DEFAULT',
            team_id: 'T_ACME',
            event_id: 'Ev_WRONG_IDENTITY',
            event: {
              type: 'app_mention',
              user: 'U_MEMBER',
              text: '<@U_DEFAULT> hello',
              ts: '1782770400.000200',
              event_ts: '1782770400.000200',
              channel: 'C_FINANCE',
            },
          });
          const captured = await captureSlackIdentityOperationalEvents(async () => {
            const response = await app.request('/channels/slack/events', {
              method: 'POST',
              headers: event.headers,
              body: event.body,
            });
            assert.equal(response.status, 200, await response.clone().text());
            await new Promise<void>((resolve) => setImmediate(resolve));
          });

          assert.ok(captured.events.some((event) =>
            event.operation === 'fanout_ignored' &&
            event.failureClass === 'non_selected_identity' &&
            event.fallbackPrevented === true));

          const db = new DatabaseSync(path);
          try {
            assert.equal(db.prepare('SELECT COUNT(*) AS count FROM slack_claims').get()?.count, 0);
            assert.equal(db.prepare('SELECT COUNT(*) AS count FROM turn_jobs').get()?.count, 0);
            assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runs').get()?.count, 0);
          } finally {
            db.close();
          }
        } finally {
          config.close();
          settings.close();
        }
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a connected selected dedicated identity is admitted only while it is in the channel', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const fake = await listenIdentityAdmissionSlack();
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-slack-identity-multi-'));
  const path = join(directory, 'state.db');
  try {
    await withEnv(
      {
        ...NO_SLACK_ENV,
        TAG_DB_PATH: path,
        SLACK_STATE_DB_PATH: path,
        SLACK_API_URL: fake.baseUrl,
      },
      async () => {
        const config = new SqliteConfigStore(path);
        const settings = new SqliteSettingsStore(path);
        try {
          const identity = await config.createSlackIdentity(pendingIdentity({
            lifecycle: 'connected',
            teamId: 'T_ACME',
            appId: 'A0FINANCE',
            botUserId: 'U_FINANCE',
            credentialProvenance: 'stored',
            health: 'healthy',
          }));
          await writeSlackIdentityCredentials(settings, identity.id, null, {
            botToken: 'xoxb-finance',
            signingSecret: 'finance-secret',
            botUserId: 'U_FINANCE',
          });
          await config.updateAgent('agent_default', {
            slackIdentityId: identity.id,
            model: 'local-stub/identity-admission',
          });
          await config.putAssignment({
            workspaceId: 'T_ACME',
            channelId: 'C_FINANCE',
            agentId: 'agent_default',
            enabled: true,
          });
          const app = await identityIngressApp();
          const url = `/channels/slack/events/${identity.ingressKey}`;
          const event = (eventId: string, ts: string) => signedSlackEvent('finance-secret', {
            type: 'event_callback',
            api_app_id: 'A0FINANCE',
            team_id: 'T_ACME',
            event_id: eventId,
            event: {
              type: 'app_mention',
              user: 'U_MEMBER',
              text: '<@U_FINANCE> hello',
              ts,
              event_ts: ts,
              channel: 'C_FINANCE',
            },
          });

          const selected = event('Ev_MULTI_SELECTED', '1782770400.000300');
          const selectedResponse = await app.request(url, {
            method: 'POST',
            headers: selected.headers,
            body: selected.body,
          });
          assert.equal(selectedResponse.status, 200, await selectedResponse.clone().text());

          let admitted:
            | { status: string; recovery_reason: string | null; turn_json: string }
            | undefined;
          for (let attempt = 0; attempt < 50 && !admitted; attempt += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            const db = new DatabaseSync(path);
            try {
              const row = db.prepare(
                `SELECT status, recovery_reason, turn_json
                 FROM turn_jobs WHERE id = 'msg:C_FINANCE:1782770400.000300'`,
              ).get() as
                | { status: string; recovery_reason: string | null; turn_json: string }
                | undefined;
              if (row) admitted = row;
            } finally {
              db.close();
            }
          }
          assert.notEqual(admitted?.status, 'recovery_required');
          assert.equal(admitted?.recovery_reason, null);
          assert.equal(JSON.parse(admitted?.turn_json ?? '{}').slackIdentityId, identity.id);

          fake.setMember(false);
          const nonMember = event('Ev_MULTI_NOT_MEMBER', '1782770400.000400');
          const nonMemberResponse = await app.request(url, {
            method: 'POST',
            headers: nonMember.headers,
            body: nonMember.body,
          });
          assert.equal(nonMemberResponse.status, 200, await nonMemberResponse.clone().text());
          await new Promise<void>((resolve) => setTimeout(resolve, 25));

          fake.setMember(true);
          const beforeDisconnectCalls = fake.authHeaders.length;
          const current = await config.getSlackIdentity(identity.id);
          await config.updateSlackIdentity(identity.id, current.connectionRevision, {
            lifecycle: 'degraded',
            health: 'unauthorized',
            healthDetail: 'tokens_revoked',
          });
          const disconnected = event('Ev_MULTI_DISCONNECTED', '1782770400.000500');
          const disconnectedResponse = await app.request(url, {
            method: 'POST',
            headers: disconnected.headers,
            body: disconnected.body,
          });
          assert.equal(
            disconnectedResponse.status,
            200,
            await disconnectedResponse.clone().text(),
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 25));

          const db = new DatabaseSync(path);
          try {
            assert.equal(db.prepare('SELECT COUNT(*) AS count FROM turn_jobs').get()?.count, 1);
            assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runs').get()?.count, 1);
          } finally {
            db.close();
          }
          assert.ok(fake.authHeaders.length >= 2);
          assert.deepEqual(new Set(fake.authHeaders), new Set(['Bearer xoxb-finance']));
          assert.equal(fake.authHeaders.length, beforeDisconnectCalls);
        } finally {
          config.close();
          settings.close();
        }
      },
    );
  } finally {
    await closeServer(fake.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('scoped identity DMs use each app DM Profile and honor per-identity DMs off', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const fake = await listenIdentityAdmissionSlack();
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-slack-identity-dm-routing-'));
  const path = join(directory, 'state.db');
  try {
    await withEnv(
      {
        ...NO_SLACK_ENV,
        TAG_DB_PATH: path,
        SLACK_STATE_DB_PATH: path,
        SLACK_API_URL: fake.baseUrl,
        SLACK_TAG_LEDGER_CANARY_CHANNELS: 'T_ACME/D_FINANCE,T_ACME/D_LEGAL,T_ACME/D_SILENT',
      },
      async () => {
        const config = new SqliteConfigStore(path);
        const settings = new SqliteSettingsStore(path);
        try {
          const baseAgent = await config.getAgent('agent_default');
          await config.updateAgent(baseAgent.id, { model: 'local-stub/identity-dms' });
          await config.createAgent({
            ...baseAgent,
            id: 'agent_legal',
            name: 'Legal',
            model: 'local-stub/identity-dms',
          });
          await config.createAgent({
            ...baseAgent,
            id: 'agent_silent',
            name: 'Silent',
            model: 'local-stub/identity-dms',
          });

          const finance = await config.createSlackIdentity(pendingIdentity({
            id: 'slack_identity_finance',
            ingressKey: 'finance_dm_ingress_0123456789abcdef',
            lifecycle: 'connected',
            teamId: 'T_ACME',
            appId: 'A0FINANCE',
            botUserId: 'U_FINANCE',
            dmAgentId: 'agent_default',
            credentialProvenance: 'stored',
            health: 'healthy',
          }));
          const legal = await config.createSlackIdentity(pendingIdentity({
            id: 'slack_identity_legal',
            ingressKey: 'legal_dm_ingress_0123456789abcdef',
            lifecycle: 'connected',
            teamId: 'T_ACME',
            appId: 'A0LEGAL',
            botUserId: 'U_LEGAL',
            dmAgentId: 'agent_legal',
            credentialProvenance: 'stored',
            health: 'healthy',
          }));
          const silentDraft = pendingIdentity({
            id: 'slack_identity_silent',
            ingressKey: 'silent_dm_ingress_0123456789abcdef',
            lifecycle: 'connected',
            teamId: 'T_ACME',
            appId: 'A0SILENT',
            botUserId: 'U_SILENT',
            dmState: 'off',
            credentialProvenance: 'stored',
            health: 'healthy',
          });
          delete silentDraft.dmAgentId;
          const silent = await config.createSlackIdentity(silentDraft);

          await config.updateAgent('agent_default', { slackIdentityId: finance.id });
          await config.updateAgent('agent_legal', { slackIdentityId: legal.id });
          await config.updateAgent('agent_silent', { slackIdentityId: silent.id });
          for (const [identity, botToken, signingSecret] of [
            [finance, 'xoxb-finance', 'finance-dm-secret'],
            [legal, 'xoxb-legal', 'legal-dm-secret'],
            [silent, 'xoxb-silent', 'silent-dm-secret'],
          ] as const) {
            await writeSlackIdentityCredentials(settings, identity.id, null, {
              botToken,
              signingSecret,
              botUserId: identity.botUserId!,
            });
          }

          const app = await identityIngressApp();
          const sendDm = async (
            identity: SlackIdentity,
            signingSecret: string,
            eventId: string,
            channel: string,
            ts: string,
          ) => {
            const request = signedSlackEvent(signingSecret, {
              type: 'event_callback',
              api_app_id: identity.appId,
              team_id: 'T_ACME',
              event_id: eventId,
              event: {
                type: 'message',
                user: 'U_MEMBER',
                text: 'hello',
                ts,
                event_ts: ts,
                channel,
                channel_type: 'im',
              },
            });
            return app.request(`/channels/slack/events/${identity.ingressKey}`, {
              method: 'POST',
              headers: request.headers,
              body: request.body,
            });
          };

          assert.equal((await sendDm(
            finance,
            'finance-dm-secret',
            'Ev_DM_FINANCE',
            'D_FINANCE',
            '1782770400.001000',
          )).status, 200);
          assert.equal((await sendDm(
            legal,
            'legal-dm-secret',
            'Ev_DM_LEGAL',
            'D_LEGAL',
            '1782770400.002000',
          )).status, 200);
          assert.equal((await sendDm(
            silent,
            'silent-dm-secret',
            'Ev_DM_SILENT',
            'D_SILENT',
            '1782770400.003000',
          )).status, 200);

          let admitted: Array<{
            turn_json: string;
            assignment_json: string;
            execution_authority: string;
          }> = [];
          for (let attempt = 0; attempt < 100 && admitted.length < 2; attempt += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            const db = new DatabaseSync(path);
            try {
              admitted = db.prepare(
                'SELECT turn_json, assignment_json, execution_authority FROM turn_jobs ORDER BY enqueued_at',
              ).all() as Array<{
                turn_json: string;
                assignment_json: string;
                execution_authority: string;
              }>;
            } finally {
              db.close();
            }
          }
          assert.deepEqual(
            admitted.map((row) => {
              const turn = JSON.parse(row.turn_json) as { slackIdentityId: string };
              const assignment = JSON.parse(row.assignment_json) as { agentId: string };
              return [turn.slackIdentityId, assignment.agentId];
            }),
            [
              [finance.id, 'agent_default'],
              [legal.id, 'agent_legal'],
            ],
          );
          assert.deepEqual(
            admitted.map(({ execution_authority: authority }) => authority),
            ['ledger', 'ledger'],
          );
          for (let attempt = 0; attempt < 100 && fake.authHeaders.length < 4; attempt += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(
            fake.authHeaders.length >= 4,
            'both admitted DM handlers must finish their Slack authorization and acknowledgment reads',
          );
          assert.deepEqual(
            new Set(fake.authHeaders),
            new Set(['Bearer xoxb-finance', 'Bearer xoxb-legal']),
            'the identity with DMs off must exit before Slack authorization reads',
          );
        } finally {
          config.close();
          settings.close();
        }
      },
    );
  } finally {
    await closeServer(fake.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('verified lifecycle events update only the receiving identity and uninstall outranks revocation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-slack-identity-lifecycle-'));
  const path = join(directory, 'state.db');
  try {
    await withEnv(
      { ...NO_SLACK_ENV, TAG_DB_PATH: path, SLACK_STATE_DB_PATH: path },
      async () => {
        const config = new SqliteConfigStore(path);
        const settings = new SqliteSettingsStore(path);
        try {
          const identity = await config.createSlackIdentity(pendingIdentity({
            lifecycle: 'connected',
            teamId: 'T_ACME',
            appId: 'A0FINANCE',
            botUserId: 'U_FINANCE',
            credentialProvenance: 'stored',
            health: 'healthy',
          }));
          await writeSlackIdentityCredentials(settings, identity.id, null, {
            botToken: 'xoxb-finance',
            signingSecret: 'finance-secret',
            botUserId: 'U_FINANCE',
          });
          const app = await identityIngressApp();
          const url = `/channels/slack/events/${identity.ingressKey}`;
          const lifecycleEvent = (
            type: 'tokens_revoked' | 'app_uninstalled',
            eventId: string,
          ) => signedSlackEvent('finance-secret', {
            type: 'event_callback',
            api_app_id: 'A0FINANCE',
            team_id: 'T_ACME',
            event_id: eventId,
            event: { type },
          });

          const revoked = lifecycleEvent('tokens_revoked', 'Ev_REVOKED');
          assert.equal((await app.request(url, {
            method: 'POST',
            headers: revoked.headers,
            body: revoked.body,
          })).status, 200);
          let current = await config.getSlackIdentity(identity.id);
          assert.equal(current.health, 'unauthorized');
          assert.equal(current.healthDetail, 'tokens_revoked');

          const uninstalled = lifecycleEvent('app_uninstalled', 'Ev_UNINSTALLED');
          await app.request(url, {
            method: 'POST',
            headers: uninstalled.headers,
            body: uninstalled.body,
          });
          current = await config.getSlackIdentity(identity.id);
          assert.equal(current.health, 'uninstalled');

          const lateRevocation = lifecycleEvent('tokens_revoked', 'Ev_REVOKED_LATE');
          await app.request(url, {
            method: 'POST',
            headers: lateRevocation.headers,
            body: lateRevocation.body,
          });
          current = await config.getSlackIdentity(identity.id);
          assert.equal(current.health, 'uninstalled');
          assert.equal(
            (await config.getSlackIdentity('slack_identity_default')).health,
            'unknown',
          );
        } finally {
          config.close();
          settings.close();
        }
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('lifecycle callbacks retry one revision conflict and surface persistent store failures', async () => {
  const identity = pendingIdentity({
    lifecycle: 'connected',
    teamId: 'T_ACME',
    appId: 'A0FINANCE',
    botUserId: 'U_FINANCE',
    credentialProvenance: 'stored',
    health: 'healthy',
    connectionRevision: 1,
  });
  const keys = slackIdentityCredentialSettingKeys(identity.id);
  const settingValues = new Map<string, string>([
    [keys.connectionRevision, 'credential-revision-1'],
    [keys.botToken, 'xoxb-finance'],
    [keys.signingSecret, 'finance-secret'],
    [keys.botUserId, 'U_FINANCE'],
  ]);
  const lifecycleEvent = signedSlackEvent('finance-secret', {
    type: 'event_callback',
    api_app_id: 'A0FINANCE',
    team_id: 'T_ACME',
    event_id: 'Ev_LIFECYCLE_STORE',
    event: { type: 'tokens_revoked' },
  });
  const url = `/channels/slack/events/${identity.ingressKey}`;
  const app = await identityIngressApp();

  await withEnv(NO_SLACK_ENV, async () => {
    await withCloudflareUserAgent(async () => {
      let current = identity;
      let updateAttempts = 0;
      const racingStub = {
        configGetSlackIdentityByIngressKey: async (ingressKey: string) => ({
          ok: true as const,
          value: ingressKey === current.ingressKey ? current : null,
        }),
        configGetSlackIdentity: async () => ({ ok: true as const, value: current }),
        configUpdateSlackIdentity: async (
          identityId: string,
          expectedRevision: number,
          patch: Record<string, unknown>,
        ) => {
          assert.equal(identityId, identity.id);
          updateAttempts += 1;
          if (updateAttempts === 1) {
            current = { ...current, connectionRevision: 2, updatedAt: 2 };
            return {
              ok: false as const,
              error: {
                code: 'slack_identity_revision_conflict' as const,
                message: 'identity changed',
                details: {
                  identityId,
                  expectedRevision: String(expectedRevision),
                  actualRevision: '2',
                },
              },
            };
          }
          assert.equal(expectedRevision, 2);
          current = {
            ...current,
            ...patch,
            connectionRevision: 3,
            updatedAt: 3,
          } as SlackIdentity;
          return { ok: true as const, value: current };
        },
        settingGet: async (key: string) => ({
          ok: true as const,
          value: settingValues.get(key) ?? null,
        }),
        settingGetMany: async (requested: readonly string[]) => ({
          ok: true as const,
          value: requested.map((key) => settingValues.get(key) ?? null),
        }),
      };
      const racingEnv = { TAG_STATE: { getByName: () => racingStub } };
      const retried = await app.request(
        url,
        {
          method: 'POST',
          headers: lifecycleEvent.headers,
          body: lifecycleEvent.body,
        },
        racingEnv,
      );
      assert.equal(retried.status, 200, await retried.clone().text());
      assert.equal(updateAttempts, 2);
      assert.equal(current.lifecycle, 'degraded');
      assert.equal(current.health, 'unauthorized');
      assert.equal(current.healthDetail, 'tokens_revoked');

      let failedUpdateAttempts = 0;
      const failingStub = {
        configGetSlackIdentityByIngressKey: async (ingressKey: string) => ({
          ok: true as const,
          value: ingressKey === identity.ingressKey ? identity : null,
        }),
        configGetSlackIdentity: async () => ({ ok: true as const, value: identity }),
        configUpdateSlackIdentity: async () => {
          failedUpdateAttempts += 1;
          return {
            ok: false as const,
            error: { code: 'internal' as const, message: 'durable write unavailable' },
          };
        },
        settingGet: async (key: string) => ({
          ok: true as const,
          value: settingValues.get(key) ?? null,
        }),
        settingGetMany: async (requested: readonly string[]) => ({
          ok: true as const,
          value: requested.map((key) => settingValues.get(key) ?? null),
        }),
      };
      const failingEnv = { TAG_STATE: { getByName: () => failingStub } };
      const failed = await app.request(
        url,
        {
          method: 'POST',
          headers: lifecycleEvent.headers,
          body: lifecycleEvent.body,
        },
        failingEnv,
      );
      assert.equal(failed.status, 500, 'Slack must retry a lifecycle event whose state write failed');
      assert.equal(failedUpdateAttempts, 1);
    });
  });
});

test('requestOrigin honors SLACK_TAG_PUBLIC_URL as an operator pin over the request host', async () => {
  await withEnv(
    { ...NO_SLACK_ENV, SLACK_TAG_PUBLIC_URL: 'https://pinned.example.com/' },
    async () => {
      const settings = new SqliteSettingsStore(':memory:');
      try {
        const app = appWith(settings);
        // Request arrives on a different host AND carries a forged x-forwarded-*
        // — the pin must win over both, with the trailing slash trimmed.
        const response = await app.request('https://socket.internal/admin/api/slack-connection', {
          headers: { ...auth(), 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' },
        });
        const body = (await response.json()) as { requestUrl: string };
        assert.equal(body.requestUrl, 'https://pinned.example.com/channels/slack/events');
      } finally {
        settings.close();
      }
    },
  );
});

test('requestOrigin on Node takes the LAST x-forwarded hop, not a client-forged first', async () => {
  await withEnv(NO_SLACK_ENV, async () => {
    const settings = new SqliteSettingsStore(':memory:');
    try {
      const app = appWith(settings);
      // A client can pre-seed the first hop; the proxy nearest us appends the
      // real one. The derivation must trust the LAST value.
      const response = await app.request('http://127.0.0.1:8787/admin/api/slack-connection', {
        headers: {
          ...auth(),
          'x-forwarded-proto': 'http, https',
          'x-forwarded-host': 'client-forged.example, chickpea.real.workers.dev',
        },
      });
      const body = (await response.json()) as { requestUrl: string };
      assert.equal(body.requestUrl, 'https://chickpea.real.workers.dev/channels/slack/events');
    } finally {
      settings.close();
    }
  });
});

test('bot user id resolution ties a stored id to a stored token, and env token probes instead', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-stored');
    await settings.setSetting(SLACK_SETTING_KEYS.signingSecret, 'stored-secret');
    await settings.setSetting(SLACK_SETTING_KEYS.botUserId, 'U_STORED_BOT');

    // No env token: the stored token wins, so its stored bot user id is honored.
    await withEnv(NO_SLACK_ENV, async () => {
      const resolved = await resolveSlackCredentials(undefined, settings);
      assert.equal(resolved.botToken, 'xoxb-stored');
      assert.equal(resolved.botUserId, 'U_STORED_BOT');
    });

    // Env token, NO env SLACK_BOT_USER_ID: the env token wins, so the stored
    // bot user id (from a possibly-different bot) must NOT be adopted — it falls
    // through to the auth.test probe (undefined), matching main.
    await withEnv({ ...NO_SLACK_ENV, SLACK_BOT_TOKEN: 'xoxb-env' }, async () => {
      const resolved = await resolveSlackCredentials(undefined, settings);
      assert.equal(resolved.botToken, 'xoxb-env');
      assert.equal(resolved.botUserId, undefined);
    });

    // Env token + explicit empty SLACK_BOT_USER_ID: '' is preserved ('no bot
    // user id, do not probe' — the fail-closed knob), never overwritten by the
    // stored id.
    await withEnv(
      { ...NO_SLACK_ENV, SLACK_BOT_TOKEN: 'xoxb-env', SLACK_BOT_USER_ID: '' },
      async () => {
        const resolved = await resolveSlackCredentials(undefined, settings);
        assert.equal(resolved.botUserId, '');
      },
    );

    // Env token + explicit env SLACK_BOT_USER_ID: the env id wins outright.
    await withEnv(
      { ...NO_SLACK_ENV, SLACK_BOT_TOKEN: 'xoxb-env', SLACK_BOT_USER_ID: 'U_ENV_BOT' },
      async () => {
        const resolved = await resolveSlackCredentials(undefined, settings);
        assert.equal(resolved.botUserId, 'U_ENV_BOT');
      },
    );
  } finally {
    settings.close();
  }
});

test('dedicated identity setup validates a bot, stores isolated credentials, and completes from a signed challenge', async () => {
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const signingSecret = 'finance-signing-secret';
  try {
    const draft = await config.createSlackIdentity(pendingIdentity());
    const recorded = await recordPendingSlackChallenge(
      settings,
      draft,
      signedChallenge(signingSecret),
    );
    assert.equal(recorded.accepted, true);
    if (recorded.accepted) assert.ok(Number.isSafeInteger(recorded.expiresAt));

    const pending = await beginSlackIdentityConnection(
      {
        config,
        settings,
        identityId: draft.id,
        expectedRevision: 0,
        expectedTeamId: 'T_ACME',
        botToken: 'xoxb-finance',
        signingSecret,
      },
      validDedicatedSlackDeps(),
    );
    assert.equal(pending.lifecycle, 'credentials_pending');
    assert.equal(pending.connectionRevision, 1);
    assert.equal(pending.teamId, 'T_ACME');
    assert.equal(pending.appId, 'A0FINANCE');
    assert.equal(pending.botUserId, 'U_FINANCE');
    assert.equal(pending.observedDisplayName, 'Finance');
    assert.equal(pending.observedAvatarUrl, 'https://avatars.slack-edge.com/finance.png');

    const connected = await completeSlackIdentityConnection({
      config,
      settings,
      identityId: draft.id,
      expectedRevision: pending.connectionRevision,
    });
    assert.equal(connected.lifecycle, 'connected');
    assert.equal(connected.connectionRevision, 2);
    assert.equal(await readPendingSlackChallenge(settings, draft.id), undefined);
    const credentials = await resolveSlackIdentityCredentials(
      draft.id,
      undefined,
      settings,
    );
    assert.equal(credentials.botToken, 'xoxb-finance');
    assert.equal(credentials.signingSecret, signingSecret);
    assert.equal(credentials.botUserId, 'U_FINANCE');
    assert.ok(credentials.connectionRevision);
    assert.equal(JSON.stringify(connected).includes('xoxb-finance'), false);
    assert.equal(JSON.stringify(connected).includes(signingSecret), false);

    const refreshed = await refreshSlackIdentityHealth(
      {
        config,
        settings,
        identityId: draft.id,
        expectedRevision: connected.connectionRevision,
      },
      validDedicatedSlackDeps(),
    );
    assert.equal(refreshed.identity.health, 'healthy');
    assert.equal(
      refreshed.consoleUrl,
      'https://api.slack.com/apps/A0FINANCE/general',
    );
    assert.equal(JSON.stringify(refreshed).includes(signingSecret), false);

    const rotationSecret = 'finance-rotated-signing-secret';
    const reconnecting = await beginSlackIdentityConnection(
      {
        config,
        settings,
        identityId: draft.id,
        expectedRevision: refreshed.identity.connectionRevision,
        expectedTeamId: 'T_ACME',
        botToken: 'xoxb-finance-rotated',
        signingSecret: rotationSecret,
      },
      validDedicatedSlackDeps(),
    );
    assert.equal(reconnecting.lifecycle, 'credentials_pending');
    assert.equal(reconnecting.setupIntent?.reconnecting, true);
    assert.equal(
      (
        await recordPendingSlackChallenge(
          settings,
          reconnecting,
          signedChallenge(rotationSecret),
        )
      ).accepted,
      true,
    );
    const reconnected = await completeSlackIdentityConnection({
      config,
      settings,
      identityId: draft.id,
      expectedRevision: reconnecting.connectionRevision,
    });
    assert.equal(reconnected.lifecycle, 'connected');
    assert.equal(reconnected.setupIntent?.reconnecting, undefined);
  } finally {
    config.close();
    settings.close();
  }
});

test('legacy Slack Admin GETs never expose dedicated credential values or setting keys', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const keys = slackIdentityCredentialSettingKeys('slack_identity_finance');
    await settings.setSetting(keys.botToken, 'xoxb-must-not-leak');
    await settings.setSetting(keys.signingSecret, 'signing-secret-must-not-leak');
    await withEnv(NO_SLACK_ENV, async () => {
      const app = appWith(settings);
      for (const path of ['/admin/api/slack-connection', '/admin/api/slack-identity']) {
        const response = await app.request(path, { headers: auth() });
        const body = await response.text();
        assert.doesNotMatch(body, /xoxb-must-not-leak|signing-secret-must-not-leak/);
        assert.doesNotMatch(body, /slack\.identity\.slack_identity_finance/);
      }
    });
  } finally {
    settings.close();
  }
});

test('workspace-default identity health keeps the legacy env-first credential contract', async () => {
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(SLACK_SETTING_KEYS.botToken, 'xoxb-default-stored');
    await settings.setSetting(SLACK_SETTING_KEYS.signingSecret, 'default-stored-secret');
    await withEnv(NO_SLACK_ENV, async () => {
      const base = (await config.listSlackIdentities())[0];
      assert.ok(base);
      const refreshed = await refreshSlackIdentityHealth(
        {
          config,
          settings,
          identityId: base.id,
          expectedRevision: base.connectionRevision,
        },
        validDedicatedSlackDeps(),
      );
      assert.equal(refreshed.identity.kind, 'workspace_default');
      assert.equal(refreshed.identity.lifecycle, 'connected');
      assert.equal(refreshed.identity.teamId, 'T_ACME');
      assert.equal(refreshed.identity.appId, 'A0FINANCE');
      assert.equal(JSON.stringify(refreshed).includes('xoxb-default-stored'), false);
      assert.equal(JSON.stringify(refreshed).includes('default-stored-secret'), false);
    });
  } finally {
    config.close();
    settings.close();
  }
});

test('dedicated identity validation rejects user tokens, cross-workspace installs, and duplicate apps', async () => {
  const config = new SqliteConfigStore(':memory:');
  try {
    await config.createSlackIdentity(pendingIdentity());
    await config.createSlackIdentity(
      pendingIdentity({
        id: 'slack_identity_existing',
        ingressKey: 'existing_ingress_0123456789abcdef',
        lifecycle: 'connected',
        teamId: 'T_ACME',
        appId: 'A0EXISTING',
        botUserId: 'U_EXISTING',
        dmState: 'off',
        credentialProvenance: 'stored',
        health: 'healthy',
      }),
    );

    const fallback = await validateSlackIdentityBotInstallation(
      {
        config,
        identityId: 'slack_identity_finance',
        expectedTeamId: 'T_ACME',
        botToken: 'xoxb-fallback-app-id',
      },
      {
        ...validDedicatedSlackDeps(),
        authTest: async () => {
          const { appId: _appId, ...authWithoutAppId } =
            await validDedicatedSlackDeps().authTest();
          return authWithoutAppId;
        },
        botIdentityInfo: async () => ({
          ...(await validDedicatedSlackDeps().botIdentityInfo()),
          avatarUrl: 'javascript:alert(1)',
        }),
      },
    );
    assert.equal(fallback.appId, 'A0FINANCE');
    assert.equal(fallback.avatarUrl, undefined);
    assert.equal(
      fallback.consoleUrl,
      'https://api.slack.com/apps/A0FINANCE/general',
    );

    const assertBootstrapCode = async (
      code: string,
      deps: SlackIdentityBootstrapDeps,
    ) => {
      await assert.rejects(
        () =>
          validateSlackIdentityBotInstallation(
            {
              config,
              identityId: 'slack_identity_finance',
              expectedTeamId: 'T_ACME',
              botToken: 'token-under-test',
            },
            deps,
          ),
        (error: unknown) =>
          error instanceof SlackIdentityBootstrapError && error.code === code,
      );
    };

    await assertBootstrapCode('bot_token_required', {
      ...validDedicatedSlackDeps(),
      authTest: async () => {
        const { botId: _botId, ...userAuth } = await validDedicatedSlackDeps().authTest();
        return userAuth;
      },
    });
    await assertBootstrapCode('workspace_mismatch', {
      ...validDedicatedSlackDeps(),
      authTest: async () => ({
        ...(await validDedicatedSlackDeps().authTest()),
        teamId: 'T_OTHER',
      }),
    });
    await assertBootstrapCode('app_already_connected', {
      ...validDedicatedSlackDeps(),
      authTest: async () => ({
        ...(await validDedicatedSlackDeps().authTest()),
        appId: 'A0EXISTING',
      }),
      botIdentityInfo: async () => ({
        ...(await validDedicatedSlackDeps().botIdentityInfo()),
        appId: 'A0EXISTING',
      }),
    });
    await assertBootstrapCode('app_identity_missing', {
      ...validDedicatedSlackDeps(),
      authTest: async () => {
        const { appId: _appId, ...authWithoutAppId } =
          await validDedicatedSlackDeps().authTest();
        return authWithoutAppId;
      },
      botIdentityInfo: async () => {
        const { appId: _appId, ...profileWithoutAppId } =
          await validDedicatedSlackDeps().botIdentityInfo();
        return { ...profileWithoutAppId, appId: undefined };
      },
    });
  } finally {
    config.close();
  }
});

test('dedicated identity setup requires a known workspace before calling Slack', async () => {
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  let authCalls = 0;
  try {
    const draft = await config.createSlackIdentity(pendingIdentity());
    await assert.rejects(
      () =>
        beginSlackIdentityConnection(
          {
            config,
            settings,
            identityId: draft.id,
            expectedRevision: draft.connectionRevision,
            expectedTeamId: ' ',
            botToken: 'xoxb-other-workspace',
            signingSecret: 'other-secret',
          },
          {
            ...validDedicatedSlackDeps(),
            authTest: async () => {
              authCalls += 1;
              return {
                ...(await validDedicatedSlackDeps().authTest()),
                teamId: 'T_OTHER',
              };
            },
          },
        ),
      (error: unknown) =>
        error instanceof SlackIdentityBootstrapError &&
        error.code === 'workspace_unverified',
    );
    assert.equal(authCalls, 0);
    assert.equal((await config.getSlackIdentity(draft.id)).lifecycle, 'setup_incomplete');
    assert.equal(
      (
        await resolveSlackIdentityCredentials(draft.id, undefined, settings)
      ).botToken,
      undefined,
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('pending Slack challenges are bounded, rate-limited, and atomically cleared with credentials', async () => {
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const now = 1_700_000_000_000;
  const secret = 'pending-secret';
  try {
    const draft = await config.createSlackIdentity(pendingIdentity());
    const oversized = await recordPendingSlackChallenge(
      settings,
      draft,
      {
        rawBody: 'x'.repeat(MAX_PENDING_SLACK_CHALLENGE_BYTES + 1),
        signature: 'v0=bad',
        timestamp: String(Math.floor(now / 1_000)),
      },
      { now },
    );
    assert.deepEqual(oversized, { accepted: false, reason: 'oversized' });

    const envelope = signedChallenge(secret, { timestamp: Math.floor(now / 1_000) });
    const first = await recordPendingSlackChallenge(settings, draft, envelope, { now });
    assert.equal(first.accepted, true);
    assert.deepEqual(
      await recordPendingSlackChallenge(settings, draft, envelope, { now: now + 1 }),
      { accepted: false, reason: 'rate_limited' },
    );
    assert.deepEqual(
      await verifyPendingSlackChallenge(settings, draft.id, secret, {
        now: now + 5 * 60_000 + 1,
      }),
      { verified: false, reason: 'expired' },
    );
    assert.equal(await readPendingSlackChallenge(settings, draft.id), undefined);

    assert.equal(
      (
        await recordPendingSlackChallenge(settings, draft, envelope, {
          now: now + 2,
        })
      ).accepted,
      true,
    );
    assert.deepEqual(
      await verifyPendingSlackChallenge(settings, draft.id, 'wrong-identity-secret', {
        now: now + 3,
      }),
      { verified: false, reason: 'invalid_signature' },
    );
    assert.equal(
      (
        await recordPendingSlackChallenge(settings, draft, envelope, {
          now: now + 4,
        })
      ).accepted,
      true,
    );
    const verified = await verifyPendingSlackChallenge(settings, draft.id, secret, {
      now: now + 5,
    });
    assert.equal(verified.verified, true);
    assert.ok(await readPendingSlackChallenge(settings, draft.id, { now: now + 5 }));

    const pending = await beginSlackIdentityConnection(
      {
        config,
        settings,
        identityId: draft.id,
        expectedRevision: 0,
        expectedTeamId: 'T_ACME',
        botToken: 'xoxb-finance',
        signingSecret: secret,
      },
      validDedicatedSlackDeps(),
    );
    const cancelled = await cancelSlackIdentityConnection({
      config,
      settings,
      identityId: draft.id,
      expectedRevision: pending.connectionRevision,
    });
    assert.equal(cancelled.lifecycle, 'setup_incomplete');
    assert.equal(cancelled.credentialProvenance, 'none');
    assert.equal(await readPendingSlackChallenge(settings, draft.id), undefined);
    const keys = slackIdentityCredentialSettingKeys(draft.id);
    assert.deepEqual(
      await settings.getSettings([
        keys.botToken,
        keys.signingSecret,
        keys.botUserId,
      ]),
      [undefined, undefined, undefined],
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('setup cancellation cannot erase credentials from a connected identity', async () => {
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const identity = await config.createSlackIdentity(
      pendingIdentity({
        lifecycle: 'connected',
        teamId: 'T_ACME',
        appId: 'A0FINANCE',
        botUserId: 'U_FINANCE',
        dmState: 'off',
        credentialProvenance: 'stored',
        health: 'healthy',
      }),
    );
    await writeSlackIdentityCredentials(settings, identity.id, null, {
      botToken: 'xoxb-connected',
      signingSecret: 'connected-secret',
      botUserId: 'U_FINANCE',
    });

    await assert.rejects(
      () =>
        cancelSlackIdentityConnection({
          config,
          settings,
          identityId: identity.id,
          expectedRevision: identity.connectionRevision,
        }),
      (error: unknown) =>
        error instanceof SlackIdentityBootstrapError &&
        error.code === 'identity_not_connectable',
    );
    assert.equal((await config.getSlackIdentity(identity.id)).lifecycle, 'connected');
    assert.equal(
      (
        await resolveSlackIdentityCredentials(identity.id, undefined, settings)
      ).botToken,
      'xoxb-connected',
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('a delayed dedicated connect cannot recreate credentials after the identity is deleted', async () => {
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const { promise: authStarted, resolve: markAuthStarted } = Promise.withResolvers<void>();
  const { promise: releaseAuth, resolve: release } = Promise.withResolvers<void>();
  try {
    const identity = pendingIdentity({ dmState: 'off' });
    delete identity.dmAgentId;
    const draft = await config.createSlackIdentity(identity);
    const deps = {
      ...validDedicatedSlackDeps(),
      authTest: async () => {
        markAuthStarted();
        await releaseAuth;
        return validDedicatedSlackDeps().authTest();
      },
    };
    const connecting = beginSlackIdentityConnection(
      {
        config,
        settings,
        identityId: draft.id,
        expectedRevision: 0,
        expectedTeamId: 'T_ACME',
        botToken: 'xoxb-delayed',
        signingSecret: 'delayed-secret',
      },
      deps,
    );
    await authStarted;
    assert.equal(await config.deleteIncompleteSlackIdentity(draft.id, 0, true), true);
    release();
    await assert.rejects(connecting, /Unknown Slack identity/);

    const keys = slackIdentityCredentialSettingKeys(draft.id);
    assert.deepEqual(
      await settings.getSettings([
        keys.connectionRevision,
        keys.botToken,
        keys.signingSecret,
      ]),
      [undefined, undefined, undefined],
    );
  } finally {
    release();
    config.close();
    settings.close();
  }
});
