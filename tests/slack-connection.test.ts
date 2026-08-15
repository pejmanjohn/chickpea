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
import { getSlackCredentialDependencies } from '../src/config/state-backend.ts';
import type { SlackIdentity } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  invalidateStoredSlackCredentials,
  resolveSlackCredentials,
  resolveSlackTeamInfo,
  type SlackConversationsListPage,
  SLACK_SETTING_KEYS,
} from '../src/slack/credentials.ts';
import {
  readActiveSlackCredentialMetadata,
  resolveSlackIdentityCredentials,
  slackIdentityCredentialSettingKeys,
  type SlackCredentialDependencies,
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
  PENDING_SLACK_CHALLENGE_TTL_MS,
  recordPendingSlackChallenge,
  readPendingSlackChallenge,
  SLACK_REQUEST_FRESHNESS_MS,
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
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

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
  options: {
    challenge?: string;
    timestamp?: number;
    appId?: string;
    teamId?: string;
    includeIdentity?: boolean;
  } = {},
): { rawBody: string; signature: string; timestamp: string } {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1_000));
  const rawBody = JSON.stringify({
    type: 'url_verification',
    challenge: options.challenge ?? 'challenge-finance',
    ...(options.includeIdentity === false
      ? {}
      : {
          api_app_id: options.appId ?? 'A0FINANCE',
          team_id: options.teamId ?? 'TACME',
        }),
  });
  return {
    rawBody,
    timestamp,
    signature: `v0=${createHmac('sha256', secret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex')}`,
  };
}

async function recordWorkspaceDefaultChallenge(
  config: SqliteConfigStore,
  settings: SettingsStore,
  signingSecret: string,
  options: { appId?: string; teamId?: string; now?: number } = {},
): Promise<void> {
  const identity = await config.getSlackIdentity('slack_identity_default');
  const now = options.now ?? Date.now();
  const recorded = await recordPendingSlackChallenge(
    settings,
    identity,
    signedChallenge(signingSecret, {
      timestamp: Math.floor(now / 1_000),
      appId: options.appId ?? 'A0CHICKPEA',
      teamId: options.teamId ?? 'TACME',
    }),
    { now },
  );
  assert.equal(recorded.accepted, true);
}

async function markWorkspaceDefaultConnected(
  config: SqliteConfigStore,
  overrides: Partial<SlackIdentity> = {},
): Promise<SlackIdentity> {
  const identity = await config.getSlackIdentity('slack_identity_default');
  return config.updateSlackIdentity(identity.id, identity.connectionRevision, {
    lifecycle: 'connected',
    teamId: 'TACME',
    appId: 'A0CHICKPEA',
    botUserId: 'UOLD',
    credentialProvenance: 'stored',
    health: 'healthy',
    ...overrides,
  });
}

function validDedicatedSlackDeps() {
  return {
    authTest: async () => ({
      ok: true,
      error: undefined,
      appId: 'A0FINANCE',
      teamId: 'TACME',
      teamName: 'Acme Inc',
      botName: 'finance',
      botUserId: 'UFINANCE',
      botId: 'BFINANCE',
      grantedScopes: [...slackAppManifest.oauth_config.scopes.bot],
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

function appWith(
  settings: SettingsStore,
  store?: SqliteConfigStore,
  slackCredentials?: SlackCredentialDependencies,
): Hono {
  const app = new Hono();
  app.route('/', createAdminRoutes({
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
    ...(store ? { store } : {}),
    ...(slackCredentials ? { slackCredentials } : {}),
  }));
  return app;
}

function createSlackCredentialFixture(): SlackCredentialDependencies & { close(): void } {
  const state = new SqliteIdentityStore(':memory:');
  return {
    state,
    keyring: generateCredentialKeyring(),
    close: () => state.close(),
  };
}

async function writeWorkspaceCredentialFixture(
  settings: SettingsStore,
  values: Partial<{
    botToken: string;
    signingSecret: string;
    botUserId: string;
    appId: string;
    teamId: string;
    grantedScopes: string[];
  }> = {},
): Promise<string> {
  const active = await resolveSlackIdentityCredentials(
    'slack_identity_default',
    undefined,
    settings,
  );
  return writeSlackIdentityCredentials(
    settings,
    'slack_identity_default',
    active.connectionRevision,
    {
      botToken: values.botToken ?? 'xoxb-workspace',
      signingSecret: values.signingSecret ?? 'workspace-signing-secret',
      ...(values.botUserId ? { botUserId: values.botUserId } : {}),
      appId: values.appId ?? 'A0CHICKPEA',
      teamId: values.teamId ?? 'TACME',
      grantedScopes: values.grantedScopes ?? [...slackAppManifest.oauth_config.scopes.bot],
    },
  );
}

function auth(): Record<string, string> {
  return testAdminHeaders(ADMIN_TOKEN);
}

async function postCreds(app: Hono, body: unknown): Promise<Response> {
  return app.request('/admin/api/slack-connection', {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const WIZARD_CONNECTION_SETTING_KEYS = [SLACK_SETTING_KEYS.teamName] as const;

async function workspaceDefaultConnectionSnapshot(
  settings: SettingsStore,
  config: SqliteConfigStore,
) {
  return {
    settings: await settings.getSettings(WIZARD_CONNECTION_SETTING_KEYS),
    credentials: await resolveSlackIdentityCredentials(
      'slack_identity_default',
      undefined,
      settings,
    ),
    credentialMetadata: await readActiveSlackCredentialMetadata(
      'slack_identity_default',
      undefined,
      settings,
    ),
    identity: await config.getSlackIdentity('slack_identity_default'),
    challenge: await readPendingSlackChallenge(settings, 'slack_identity_default'),
    auditTypes: (await config.listSlackIdentityAuditEvents()).map(({ eventType }) => eventType),
  };
}

/** Minimal fake Slack Web API answering auth.test and, optionally, users.info. */
function listenFakeSlack(
  authTestBody: Record<string, unknown>,
  usersInfoBody?: Record<string, unknown> | ReadonlyArray<Record<string, unknown>>,
  authTestHeaders: Readonly<Record<string, string>> = {},
  conversationsListBody: Record<string, unknown> = { ok: true, channels: [] },
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
      for (const [name, value] of Object.entries(authTestHeaders)) {
        res.setHeader(name, value);
      }
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
    if (req.url?.endsWith('/conversations.list')) {
      authHeaders.push(req.headers.authorization ?? '');
      res.end(JSON.stringify(conversationsListBody));
      return;
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

/** Fake Slack whose auth.test scopes can change across retries for one token. */
function listenSequencedGrantFakeSlack(
  authTestSteps: ReadonlyArray<{
    body: Record<string, unknown>;
    scopes?: readonly string[];
  }>,
  usersInfoBody: Record<string, unknown> = {
    ok: true,
    user: {
      id: 'UTAGBOT',
      profile: { display_name: 'Chickpea', api_app_id: 'A0CHICKPEA' },
    },
  },
): Promise<{
  server: Server;
  baseUrl: string;
  authHeaders: string[];
}> {
  assert.ok(authTestSteps.length > 0, 'sequenced Slack requires at least one auth.test step');
  const authHeaders: string[] = [];
  let authTestIndex = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    authHeaders.push(req.headers.authorization ?? '');
    if (req.url?.endsWith('/auth.test')) {
      const step = authTestSteps[Math.min(authTestIndex, authTestSteps.length - 1)]!;
      authTestIndex += 1;
      if (step.scopes) res.setHeader('x-oauth-scopes', step.scopes.join(','));
      res.end(JSON.stringify(step.body));
      return;
    }
    if (req.url?.endsWith('/users.info')) {
      res.end(JSON.stringify(usersInfoBody));
      return;
    }
    if (req.url?.endsWith('/conversations.list')) {
      res.end('{"ok":true,"channels":[]}');
      return;
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
  requestPaths: string[];
  setMember(value: boolean): void;
}> {
  const authHeaders: string[] = [];
  const requestPaths: string[] = [];
  let member = true;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    authHeaders.push(req.headers.authorization ?? '');
    requestPaths.push(req.url ?? '');
    if (req.url?.endsWith('/users.info')) {
      res.end(JSON.stringify({
        ok: true,
        user: { id: 'UMEMBER', team_id: 'TACME' },
      }));
      return;
    }
    if (req.url?.endsWith('/conversations.info')) {
      res.end(JSON.stringify({
        ok: true,
        channel: {
          id: 'CFINANCE',
          name: 'finance',
          context_team_id: 'TACME',
          is_member: member,
        },
      }));
      return;
    }
    if (req.url?.endsWith('/auth.test')) {
      res.end(JSON.stringify({
        ok: true,
        app_id: 'A0FINANCE',
        team_id: 'TACME',
        user_id: 'UFINANCE',
      }));
      return;
    }
    if (req.url?.endsWith('/chat.postMessage')) {
      res.end(JSON.stringify({ ok: true, channel: 'CFINANCE', ts: '1782770400.009000' }));
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
        requestPaths,
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
    if (req.url?.endsWith('/users.info')) {
      res.end(JSON.stringify({
        ok: true,
        user: {
          id: 'UNEW',
          profile: { display_name: 'Chickpea', api_app_id: 'A0CHICKPEA' },
        },
      }));
      return;
    }
    if (req.url?.endsWith('/conversations.list')) {
      res.end(JSON.stringify({ ok: true, channels: [] }));
      return;
    }
    if (!req.url?.endsWith('/auth.test')) {
      res.statusCode = 404;
      res.end('{"ok":false,"error":"unknown_method"}');
      return;
    }
    res.setHeader('x-oauth-scopes', slackAppManifest.oauth_config.scopes.bot.join(','));
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

test('slack-connection endpoints fail closed without Slack session authority', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = new Hono();
    app.route('/', createAdminRoutes({ settings, adminToken: undefined }));
    const get = await app.request('/admin/api/slack-connection', { headers: auth() });
    assert.equal(get.status, 503);
    const post = await postCreds(app, { botToken: 'xoxb-x', signingSecret: 's' });
    assert.equal(post.status, 503);
    const testConnection = await app.request('/admin/api/slack-connection/test', {
      method: 'POST',
      headers: auth(),
    });
    assert.equal(testConnection.status, 503);
    const identity = await app.request('/admin/api/slack-identity', { headers: auth() });
    assert.equal(identity.status, 503);
    const disconnect = await app.request('/admin/api/slack-connection', {
      method: 'DELETE',
      headers: auth(),
    });
    assert.equal(disconnect.status, 503);
    const getBehavior = await app.request('/admin/api/slack-behavior', { headers: auth() });
    assert.equal(getBehavior.status, 503);
    const putBehavior = await app.request('/admin/api/slack-behavior', {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ allowDms: false }),
    });
    assert.equal(putBehavior.status, 503);
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
      team_id: 'TCURRENT',
      user_id: 'UCURRENTBOT',
    },
    {
      ok: true,
      user: {
        id: 'UCURRENTBOT',
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
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-current',
      botUserId: 'UCURRENTBOT',
      teamId: 'TCURRENT',
    });
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await appWith(settings).request('/admin/api/slack-identity', {
        headers: auth(),
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), {
        displayName: 'Chickpea Helper',
        avatarUrl: 'https://avatars.slack-edge.com/2026-07-28/chickpea_512.png',
        botUserId: 'UCURRENTBOT',
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
      user_id: 'UFALLBACKBOT',
    },
    {
      ok: true,
      user: {
        id: 'UFALLBACKBOT',
        name: 'chickpea',
        profile: { display_name: 'Chickpea', image_72: 'https://avatars.slack-edge.com/fallback.png' },
      },
    },
  );
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-fallback',
      appId: 'A0FALLBACK',
    });
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await appWith(settings).request('/admin/api/slack-identity', {
        headers: auth(),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.botUserId, 'UFALLBACKBOT');
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

test('Slack identity ignores an explicit-empty env bot id without changing encrypted event credentials', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl, authHeaders } = await listenFakeSlack(
    { ok: true, app_id: 'A0EMPTY1', user_id: 'UEMPTYID' },
    {
      ok: true,
      user: {
        id: 'UEMPTYID',
        profile: { display_name: 'Chickpea from Slack', image_72: 'https://avatars.slack-edge.com/empty.png' },
      },
    },
  );
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-empty-id',
      appId: 'A0EMPTY1',
    });
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl, SLACK_BOT_USER_ID: '' }, async () => {
      const response = await appWith(settings).request('/admin/api/slack-identity', { headers: auth() });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        displayName: 'Chickpea from Slack',
        avatarUrl: 'https://avatars.slack-edge.com/empty.png',
        botUserId: 'UEMPTYID',
        appId: 'A0EMPTY1',
        consoleUrl: 'https://api.slack.com/apps/A0EMPTY1/general',
      });
      assert.deepEqual(authHeaders, ['Bearer xoxb-empty-id', 'Bearer xoxb-empty-id']);
      assert.equal(process.env.SLACK_BOT_USER_ID, '');
      assert.equal(
        (await resolveSlackIdentityCredentials('slack_identity_default', undefined, settings))
          .botUserId,
        undefined,
      );
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
    { ok: true, app_id: 'A0REPLACED', user_id: 'UREPLACED' },
    [
      { ok: false, error: 'user_not_found' },
      {
        ok: true,
        user: {
          id: 'UREPLACED',
          profile: { display_name: 'Replacement Chickpea', image_512: 'https://avatars.slack-edge.com/replaced.png' },
        },
      },
    ],
  );
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-stale',
      botUserId: 'USTALE',
      appId: 'A0REPLACED',
    });
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await appWith(settings).request('/admin/api/slack-identity', { headers: auth() });
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.botUserId, 'UREPLACED');
      assert.equal(body.consoleUrl, 'https://api.slack.com/apps/A0REPLACED/general');
      assert.deepEqual(authHeaders, ['Bearer xoxb-stale', 'Bearer xoxb-stale', 'Bearer xoxb-stale']);
      assert.equal(
        (await readActiveSlackCredentialMetadata(
          'slack_identity_default',
          undefined,
          settings,
        ))?.botUserId,
        'USTALE',
      );
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
    { ok: true, app_id: 'A0LINKRECOVERY', user_id: 'ULINK' },
    {
      ok: true,
      user: {
        id: 'ULINK',
        profile: { display_name: 'Link Chickpea', image_72: 'https://avatars.slack-edge.com/link.png' },
      },
    },
  );
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-link',
      botUserId: 'ULINK',
      appId: 'A0LINKRECOVERY',
    });
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await appWith(settings).request('/admin/api/slack-identity', { headers: auth() });
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.appId, 'A0LINKRECOVERY');
      assert.equal(body.consoleUrl, 'https://api.slack.com/apps/A0LINKRECOVERY/general');
      assert.deepEqual(authHeaders, ['Bearer xoxb-link', 'Bearer xoxb-link']);
      assert.equal(
        (await readActiveSlackCredentialMetadata(
          'slack_identity_default',
          undefined,
          settings,
        ))?.botUserId,
        'ULINK',
      );
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
        id: 'UPRESENTATION',
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
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-presentation',
      botUserId: 'UPRESENTATION',
      appId: 'A0PRESENTATION',
    });
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
    { ok: true, user_id: 'UFAILURE' },
    { ok: false, error: 'missing_scope' },
  );
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-failure',
      botUserId: 'UFAILURE',
    });
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
    team_id: 'TCURRENT',
    team: 'Current Team',
    user: 'chickpea',
    user_id: 'UCURRENTBOT',
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-current',
      botUserId: 'UCURRENTBOT',
      teamId: 'TCURRENT',
    });
    await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Previously Saved Team');
    await settings.setSetting(SLACK_SETTING_KEYS.publicUrl, 'https://saved.example');
    await withEnv(
      { ...NO_SLACK_ENV, SLACK_API_URL: baseUrl, SLACK_BOT_TOKEN: 'xoxb-env-current' },
      async () => {
        const app = appWith(settings);
        const response = await app.request('/admin/api/slack-connection/test', {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          ok: true,
          teamId: 'TCURRENT',
          teamName: 'Current Team',
          botName: 'chickpea',
          botUserId: 'UCURRENTBOT',
        });

        // Testing is observational: it must not backfill or overwrite any
        // connection metadata, even when auth.test returns newer values.
        assert.equal(
          (await resolveSlackIdentityCredentials(
            'slack_identity_default',
            undefined,
            settings,
          )).botToken,
          'xoxb-current',
        );
        assert.equal(
          await settings.getSetting(SLACK_SETTING_KEYS.teamName),
          'Previously Saved Team',
        );
        assert.equal(
          (await readActiveSlackCredentialMetadata(
            'slack_identity_default',
            undefined,
            settings,
          ))?.teamId,
          'TCURRENT',
        );
        assert.equal(
          await settings.getSetting(SLACK_SETTING_KEYS.publicUrl),
          'https://saved.example',
        );
        assert.deepEqual(authHeaders, ['Bearer xoxb-current']);
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
        headers: { ...auth(), 'content-type': 'application/json' },
      });
      assert.equal(missing.status, 409);
      assert.deepEqual(await missing.json(), { error: 'slack_not_configured' });
    });

    await writeWorkspaceCredentialFixture(settings, { botToken: 'xoxb-bad' });
    const rejectedSlack = await listenFakeSlack({ ok: false, error: 'invalid_auth' });
    try {
      await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: rejectedSlack.baseUrl }, async () => {
        const app = appWith(settings);
        const rejected = await app.request('/admin/api/slack-connection/test', {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
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

    const staleSlack = await listenFakeSlack(
      { ok: true, team_id: 'TACME', user_id: 'USTALE' },
      undefined,
      { 'x-oauth-scopes': 'channels:history,chat:write' },
    );
    try {
      await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: staleSlack.baseUrl }, async () => {
        const stale = await appWith(settings).request('/admin/api/slack-connection/test', {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
        });
        assert.equal(stale.status, 422);
        assert.deepEqual(await stale.json(), {
          error: 'slack_missing_scopes',
          missingScopes: slackAppManifest.oauth_config.scopes.bot.filter(
            (scope) => !['channels:history', 'chat:write'].includes(scope),
          ),
        });
      });
    } finally {
      await closeServer(staleSlack.server);
    }

    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: 'http://127.0.0.1:9/api/' }, async () => {
      const app = appWith(settings);
      const unreachable = await app.request('/admin/api/slack-connection/test', {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
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
      await writeWorkspaceCredentialFixture(settings, {
        botToken: 'xoxb-stored',
        signingSecret: 'stored-secret',
        botUserId: 'USTORED',
        teamId: 'TSTORED',
      });
      await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Stored Team');
      await settings.setSetting(SLACK_SETTING_KEYS.publicUrl, 'https://chickpea.example');

      // Warm the encrypted revision cache so DELETE must fence stale plaintext.
      await resolveSlackIdentityCredentials('slack_identity_default', undefined, settings);

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
          'Disconnected Chickpea locally. The Slack app was not uninstalled or revoked, and Agents, channel assignments, transcripts, and the public URL were preserved.',
      });

      assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.teamName), undefined);
      assert.equal(
        await settings.getSetting(SLACK_SETTING_KEYS.publicUrl),
        'https://chickpea.example',
      );

      const resolved = await resolveSlackIdentityCredentials(
        'slack_identity_default',
        undefined,
        settings,
      );
      assert.equal(resolved.botToken, undefined);
      assert.equal(resolved.signingSecret, undefined);
      assert.equal(resolved.connectionRevision, null);
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
      await writeWorkspaceCredentialFixture(settings, {
        botToken: 'xoxb-default',
        signingSecret: 'default-secret',
      });
      const { dmAgentId: _retiredDmAgentId, ...retiredIdentity } = pendingIdentity({
        lifecycle: 'retired',
        teamId: 'TACME',
        appId: 'A0FINANCE',
        botUserId: 'UFINANCE',
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
        botUserId: 'UFINANCE',
        appId: 'A0FINANCE',
        teamId: 'TACME',
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
      assert.equal(
        (await resolveSlackIdentityCredentials(
          'slack_identity_default',
          undefined,
          settings,
        )).botToken,
        'xoxb-default',
      );
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

test('disconnect ignores conflicting env credentials and tombstones the encrypted revision', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-stored',
      signingSecret: 'stored-secret',
    });
    const app = appWith(settings);

    await withEnv(
      { ...NO_SLACK_ENV, SLACK_BOT_TOKEN: 'xoxb-env', SLACK_SIGNING_SECRET: 'env-secret' },
      async () => {
        const response = await app.request('/admin/api/slack-connection', {
          method: 'DELETE',
          headers: auth(),
        });
        assert.equal(response.status, 200, await response.clone().text());
      },
    );
    assert.equal(
      (await resolveSlackIdentityCredentials('slack_identity_default', undefined, settings))
        .connectionRevision,
      null,
    );
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
  }
});

test('disconnect keeps credentials and the live cache intact when atomic deletion fails', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const credentials = createSlackCredentialFixture();
  const failingState = new Proxy(credentials.state, {
    get(target, property) {
      if (property === 'tombstoneSlackCredentialRevision') {
        return async () => {
          throw new Error('atomic credential tombstone unavailable');
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    await withEnv(NO_SLACK_ENV, async () => {
      await writeSlackIdentityCredentials(credentials, 'slack_identity_default', null, {
        botToken: 'xoxb-still-live',
        signingSecret: 'still-live-secret',
        appId: 'A0CHICKPEA',
        teamId: 'TSTILLLIVE',
      });

      const response = await appWith(settings, undefined, {
        state: failingState,
        keyring: credentials.keyring,
      }).request('/admin/api/slack-connection', {
        method: 'DELETE',
        headers: auth(),
      });
      assert.equal(response.status, 500, await response.clone().text());
      assert.deepEqual(await response.json(), { error: 'internal_error' });
      const resolved = await resolveSlackIdentityCredentials(
        'slack_identity_default',
        undefined,
        credentials,
      );
      assert.equal(resolved.botToken, 'xoxb-still-live');
      assert.equal(resolved.signingSecret, 'still-live-secret');
    });
  } finally {
    invalidateStoredSlackCredentials();
    credentials.close();
    settings.close();
  }
});

test('disconnect resumes config cleanup after a credential tombstone outlives a failed write', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  let failConfigWrite = true;
  const flakyConfig = new Proxy(config, {
    get(target, property) {
      if (property === 'updateSlackIdentity') {
        return async (...args: Parameters<typeof target.updateSlackIdentity>) => {
          if (failConfigWrite) {
            failConfigWrite = false;
            throw new Error('config write unavailable after credential tombstone');
          }
          return target.updateSlackIdentity(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-resumable',
      signingSecret: 'resumable-secret',
      botUserId: 'URES502',
      teamId: 'TRES502',
    });
    await markWorkspaceDefaultConnected(config, {
      teamId: 'TRES502',
      botUserId: 'URES502',
    });
    const app = appWith(settings, flakyConfig);

    const interrupted = await app.request('/admin/api/slack-connection', {
      method: 'DELETE',
      headers: auth(),
    });
    assert.equal(interrupted.status, 500);
    assert.equal(
      (
        await resolveSlackIdentityCredentials(
          'slack_identity_default',
          undefined,
          settings,
        )
      ).connectionRevision,
      null,
    );
    assert.equal(
      (await config.getSlackIdentity('slack_identity_default')).lifecycle,
      'connected',
    );

    const resumed = await app.request('/admin/api/slack-connection', {
      method: 'DELETE',
      headers: auth(),
    });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.equal(
      (await config.getSlackIdentity('slack_identity_default')).lifecycle,
      'setup_incomplete',
    );
  } finally {
    invalidateStoredSlackCredentials();
    config.close();
    settings.close();
  }
});

test('disconnect returns a conflict without erasing a rotation that wins the CAS', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const credentials = createSlackCredentialFixture();
  let raced = false;
  const racingState = new Proxy(credentials.state, {
    get(target, property) {
      if (property === 'tombstoneSlackCredentialRevision') {
        return async (input: Parameters<typeof target.tombstoneSlackCredentialRevision>[0]) => {
          if (!raced) {
            raced = true;
            await writeSlackIdentityCredentials(
              credentials,
              'slack_identity_default',
              input.revision,
              {
                botToken: 'xoxb-rotated',
                signingSecret: 'secret-rotated',
                appId: 'A0CHICKPEA',
                teamId: 'TACME',
              },
            );
          }
          return target.tombstoneSlackCredentialRevision(input);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    await writeSlackIdentityCredentials(credentials, 'slack_identity_default', null, {
      botToken: 'xoxb-old',
      signingSecret: 'secret-old',
      appId: 'A0CHICKPEA',
      teamId: 'TACME',
    });

    await withEnv(NO_SLACK_ENV, async () => {
      const response = await appWith(settings, undefined, {
        state: racingState,
        keyring: credentials.keyring,
      }).request('/admin/api/slack-connection', {
        method: 'DELETE',
        headers: auth(),
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: 'slack_connection_changed',
        message: 'Slack connection changed before it could be disconnected. Try again.',
      });
      const resolved = await resolveSlackIdentityCredentials(
        'slack_identity_default',
        undefined,
        credentials,
      );
      assert.equal(resolved.botToken, 'xoxb-rotated');
      assert.equal(resolved.signingSecret, 'secret-rotated');
    });
  } finally {
    invalidateStoredSlackCredentials();
    credentials.close();
    settings.close();
  }
});

test('Cloudflare isolates re-check the durable connection revision before reusing credentials', async () => {
  const state = new SqliteIdentityStore(':memory:');
  const keyring = generateCredentialKeyring('key_cf_cache');
  const revision = await writeSlackIdentityCredentials(
    { state, keyring },
    'slack_identity_default',
    null,
    {
      botToken: 'xoxb-old',
      signingSecret: 'old-secret',
      botUserId: 'UOLD',
      appId: 'A0CHICKPEA',
      teamId: 'TACME',
    },
  );
  const requests: string[] = [];
  const stub = {
    identityExecute: async (request: { kind: string; identityId?: string }) => {
      requests.push(request.kind);
      if (request.kind === 'get_slack_credential_control') {
        return {
          ok: true as const,
          value: { kind: 'slack_credential_control', control: await state.getSlackCredentialControl() ?? null },
        };
      }
      if (request.kind === 'get_active_slack_credential_revision') {
        return {
          ok: true as const,
          value: {
            kind: 'slack_credential_revision',
            revision: await state.getActiveSlackCredentialRevision(request.identityId!) ?? null,
          },
        };
      }
      throw new Error(`unexpected identity RPC ${request.kind}`);
    },
  };
  const platformEnv = {
    TAG_STATE: { getByName: () => stub },
    CHICKPEA_CREDENTIAL_KEY_CURRENT_ID: keyring.currentKeyId,
    [`CHICKPEA_CREDENTIAL_KEY_${keyring.currentKeyId.toUpperCase()}`]:
      keyring.keys[keyring.currentKeyId],
  };

  try {
    await withEnv(NO_SLACK_ENV, async () => {
      await withCloudflareUserAgent(async () => {
        invalidateStoredSlackCredentials();
        assert.deepEqual(await resolveSlackCredentials(platformEnv as never), {
          botToken: 'xoxb-old',
          signingSecret: 'old-secret',
          botUserId: 'UOLD',
        });

        // Simulate a disconnect committed by another Worker isolate without
        // touching this process's cache.
        const control = (await state.getSlackCredentialControl())!;
        await state.tombstoneSlackCredentialRevision({
          identityId: 'slack_identity_default',
          revision,
          expectedRotationEpoch: control.rotationEpoch,
        });

        assert.deepEqual(await resolveSlackCredentials(platformEnv as never), {
          botToken: undefined,
          signingSecret: undefined,
          botUserId: undefined,
        });
      });
    });
    assert.equal(
      requests.filter((kind) => kind === 'get_active_slack_credential_revision').length,
      2,
    );
  } finally {
    invalidateStoredSlackCredentials();
    state.close();
  }
});

test('fallback bot-user identity is cached per bot token across rotations', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const fake = await listenTokenAwareFakeSlack({
    'xoxb-one': 'UONE',
    'xoxb-two': 'UTWO',
  });
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-slack-bot-id-rotation-'));
  const path = join(directory, 'state.db');
  try {
    invalidateSlackBotUserIdCache();
    await withEnv(
      {
        ...NO_SLACK_ENV,
        SLACK_API_URL: fake.baseUrl,
        TAG_DB_PATH: path,
        SLACK_STATE_DB_PATH: path,
      },
      async () => {
        const credentials = getSlackCredentialDependencies();
        const first = await writeSlackIdentityCredentials(
          credentials,
          'slack_identity_default',
          null,
          {
            botToken: 'xoxb-one',
            signingSecret: 'signing-one',
            appId: 'A0CHICKPEA',
            teamId: 'TACME',
          },
        );
        assert.equal(await resolveBotUserId(undefined), 'UONE');
        await writeSlackIdentityCredentials(
          credentials,
          'slack_identity_default',
          first,
          {
            botToken: 'xoxb-two',
            signingSecret: 'signing-two',
            appId: 'A0CHICKPEA',
            teamId: 'TACME',
          },
        );
        assert.equal(await resolveBotUserId(undefined), 'UTWO');
      },
    );
    assert.deepEqual(fake.authHeaders, ['Bearer xoxb-one', 'Bearer xoxb-two']);
  } finally {
    invalidateSlackBotUserIdCache();
    invalidateStoredSlackCredentials();
    await closeServer(fake.server);
    rmSync(directory, { recursive: true, force: true });
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
    const config = new SqliteConfigStore(':memory:');
    try {
      const identity = await config.getSlackIdentity('slack_identity_default');
      const app = appWith(settings, config);
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
      assert.equal(
        body.requestUrl,
        `https://tag.example.workers.dev/channels/slack/events/${identity.ingressKey}`,
      );

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
      config.close();
      settings.close();
    }
  });
});

test('wizard GET honors x-forwarded-proto/host when deriving the events URL', async () => {
  await withEnv(NO_SLACK_ENV, async () => {
    const settings = new SqliteSettingsStore(':memory:');
    const config = new SqliteConfigStore(':memory:');
    try {
      const identity = await config.getSlackIdentity('slack_identity_default');
      const app = appWith(settings, config);
      const response = await app.request('http://127.0.0.1:8787/admin/api/slack-connection', {
        headers: {
          ...auth(),
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'chickpea.acme.workers.dev',
        },
      });
      const body = (await response.json()) as { requestUrl: string; manifestUrl: string };
      assert.equal(
        body.requestUrl,
        `https://chickpea.acme.workers.dev/channels/slack/events/${identity.ingressKey}`,
      );
      assert.ok(body.manifestUrl.includes(encodeURIComponent(body.requestUrl)));
    } finally {
      config.close();
      settings.close();
    }
  });
});

test('wizard GET ignores env credentials and withholds connected until encrypted lifecycle proof', async () => {
  await withEnv(
    {
      ...NO_SLACK_ENV,
      SLACK_BOT_TOKEN: 'xoxb-env',
      SLACK_SIGNING_SECRET: 'env-secret',
      SLACK_BOT_USER_ID: 'UENV',
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
          botToken: 'missing',
          signingSecret: 'missing',
          botUserId: 'missing',
        });
        assert.equal(body.connected, false);
      } finally {
        settings.close();
      }
    },
  );
});

test('wizard turns a starter-scope token into an app-specific reinstall handoff', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenFakeSlack(
    {
      ok: true,
      team_id: 'TACME',
      team: 'Acme Inc',
      user: 'chickpea',
      user_id: 'USTARTERBOT',
      bot_id: 'BSTARTER',
    },
    undefined,
    { 'x-oauth-scopes': 'channels:history,chat:write' },
  );
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  try {
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      await recordWorkspaceDefaultChallenge(config, settings, 'starter-secret', {
        appId: 'A0STARTER',
      });
      const response = await postCreds(appWith(settings, config), {
        botToken: 'xoxb-starter',
        signingSecret: 'starter-secret',
      });
      assert.equal(response.status, 422);
      const body = (await response.json()) as {
        error: string;
        missingScopes: string[];
        consoleUrl?: string;
      };
      assert.equal(body.error, 'slack_missing_scopes');
      assert.match(body.consoleUrl ?? '', /^https:\/\/api\.slack\.com\/apps\/A0STARTER\/oauth$/);
      assert.ok(body.missingScopes.includes('assistant:write'));
      assert.equal(
        (await resolveSlackIdentityCredentials(
          'slack_identity_default',
          undefined,
          settings,
        )).connectionRevision,
        null,
      );
      assert.ok(await readPendingSlackChallenge(settings, 'slack_identity_default'));
    });
  } finally {
    invalidateStoredSlackCredentials();
    config.close();
    settings.close();
    await closeServer(server);
  }
});

test('wizard completes the same credential pair only after Slack expands its grant', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const shortScopes = ['channels:history', 'chat:write'];
  const authBody = {
    ok: true,
    app_id: 'A0CHICKPEA',
    team_id: 'TACME',
    team: 'Acme Inc',
    user: 'chickpea',
    user_id: 'UTAGBOT',
    bot_id: 'BTAG',
  };
  const { server, baseUrl, authHeaders } = await listenSequencedGrantFakeSlack([
    { body: authBody, scopes: shortScopes },
    { body: authBody, scopes: slackAppManifest.oauth_config.scopes.bot },
  ]);
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  try {
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      await recordWorkspaceDefaultChallenge(config, settings, 'same-secret');
      const before = await workspaceDefaultConnectionSnapshot(settings, config);
      const app = appWith(settings, config);
      const credentials = { botToken: 'xoxb-same-token', signingSecret: 'same-secret' };

      const incomplete = await postCreds(app, credentials);
      assert.equal(incomplete.status, 422);
      const incompleteBody = (await incomplete.json()) as {
        error: string;
        missingScopes: string[];
        consoleUrl?: string;
      };
      assert.equal(incompleteBody.error, 'slack_missing_scopes');
      assert.deepEqual(
        incompleteBody.missingScopes,
        slackAppManifest.oauth_config.scopes.bot.filter(
          (scope) => !shortScopes.includes(scope),
        ),
      );
      assert.equal(
        incompleteBody.consoleUrl,
        'https://api.slack.com/apps/A0CHICKPEA/oauth',
      );
      assert.deepEqual(await workspaceDefaultConnectionSnapshot(settings, config), before);
      const statusBefore = await app.request('/admin/api/slack-connection', { headers: auth() });
      assert.equal(((await statusBefore.json()) as { connected: boolean }).connected, false);

      const complete = await postCreds(app, credentials);
      assert.equal(complete.status, 200, await complete.clone().text());
      assert.equal(((await complete.json()) as { ok: boolean }).ok, true);
      const stored = await resolveSlackIdentityCredentials(
        'slack_identity_default',
        undefined,
        settings,
      );
      const metadata = await readActiveSlackCredentialMetadata(
        'slack_identity_default',
        undefined,
        settings,
      );
      assert.ok(stored.connectionRevision);
      assert.deepEqual(
        [stored.botToken, stored.signingSecret, stored.botUserId, metadata?.teamId],
        ['xoxb-same-token', 'same-secret', 'UTAGBOT', 'TACME'],
      );
      const connected = await config.getSlackIdentity('slack_identity_default');
      assert.equal(connected.lifecycle, 'connected');
      assert.equal(connected.health, 'healthy');
      assert.equal(await readPendingSlackChallenge(settings, connected.id), undefined);
      assert.deepEqual(
        (await config.listSlackIdentityAuditEvents()).map(({ eventType }) => eventType),
        ['slack_identity.credentials_connected'],
      );
      assert.deepEqual(authHeaders, Array(4).fill('Bearer xoxb-same-token'));
    });
  } finally {
    invalidateStoredSlackCredentials();
    config.close();
    settings.close();
    await closeServer(server);
  }
});

test('wizard leaves repeated incomplete grants and their signed challenge untouched', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const shortScopes = ['channels:history', 'chat:write'];
  const authBody = {
    ok: true,
    app_id: 'A0CHICKPEA',
    team_id: 'TACME',
    user_id: 'UTAGBOT',
    bot_id: 'BTAG',
  };
  const { server, baseUrl, authHeaders } = await listenSequencedGrantFakeSlack([
    { body: authBody, scopes: shortScopes },
    { body: authBody, scopes: shortScopes },
  ]);
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  try {
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      await recordWorkspaceDefaultChallenge(config, settings, 'same-secret');
      const before = await workspaceDefaultConnectionSnapshot(settings, config);
      const app = appWith(settings, config);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await postCreds(app, {
          botToken: 'xoxb-short-token',
          signingSecret: 'same-secret',
        });
        assert.equal(response.status, 422);
        assert.equal(
          ((await response.json()) as { error: string }).error,
          'slack_missing_scopes',
        );
        assert.deepEqual(await workspaceDefaultConnectionSnapshot(settings, config), before);
      }
      assert.deepEqual(authHeaders, Array(2).fill('Bearer xoxb-short-token'));
    });
  } finally {
    invalidateStoredSlackCredentials();
    config.close();
    settings.close();
    await closeServer(server);
  }
});

test('wizard verifies the signing secret only after Slack reports a complete grant', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const authBody = {
    ok: true,
    app_id: 'A0CHICKPEA',
    team_id: 'TACME',
    user_id: 'UTAGBOT',
    bot_id: 'BTAG',
  };
  const { server, baseUrl } = await listenSequencedGrantFakeSlack([
    { body: authBody, scopes: ['channels:history', 'chat:write'] },
    { body: authBody, scopes: slackAppManifest.oauth_config.scopes.bot },
  ]);
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  try {
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      await recordWorkspaceDefaultChallenge(config, settings, 'right-secret');
      const before = await workspaceDefaultConnectionSnapshot(settings, config);
      const app = appWith(settings, config);
      const credentials = { botToken: 'xoxb-same-token', signingSecret: 'wrong-secret' };

      const incomplete = await postCreds(app, credentials);
      assert.equal(incomplete.status, 422);
      assert.equal(
        ((await incomplete.json()) as { error: string }).error,
        'slack_missing_scopes',
      );

      const rejectedSecret = await postCreds(app, credentials);
      assert.equal(rejectedSecret.status, 422);
      assert.equal(
        ((await rejectedSecret.json()) as { error: string }).error,
        'challenge_invalid_signature',
      );
      assert.deepEqual(await workspaceDefaultConnectionSnapshot(settings, config), before);
    });
  } finally {
    invalidateStoredSlackCredentials();
    config.close();
    settings.close();
    await closeServer(server);
  }
});

test('wizard POST requires the signed challenge and live Slack readiness before connecting', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenFakeSlack(
    {
      ok: true,
      app_id: 'A0CHICKPEA',
      team_id: 'TACME',
      team: 'Acme Inc',
      user: 'tag',
      user_id: 'UTAGBOT',
      bot_id: 'BTAG',
    },
    [
      {
        ok: true,
        user: {
          id: 'UTAGBOT',
          profile: { display_name: 'Chickpea', api_app_id: 'A0CHICKPEA' },
        },
      },
      {
        ok: true,
        user: {
          id: 'UTAGBOT',
          profile: { display_name: 'Chickpea', api_app_id: 'A0CHICKPEA' },
        },
      },
    ],
    { 'x-oauth-scopes': slackAppManifest.oauth_config.scopes.bot.join(',') },
  );
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  try {
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      await recordWorkspaceDefaultChallenge(config, settings, 'pasted-secret');
      const app = appWith(settings, config);
      const rejectedSecret = await postCreds(app, {
        botToken: 'xoxb-pasted',
        signingSecret: 'wrong-secret',
      });
      assert.equal(rejectedSecret.status, 422);
      assert.equal(
        ((await rejectedSecret.json()) as { error: string }).error,
        'challenge_invalid_signature',
      );
      assert.ok(await readPendingSlackChallenge(settings, 'slack_identity_default'));
      assert.equal(
        (await resolveSlackIdentityCredentials(
          'slack_identity_default',
          undefined,
          settings,
        )).connectionRevision,
        null,
      );

      const response = await postCreds(app, {
        botToken: 'xoxb-pasted',
        signingSecret: 'pasted-secret',
      });
      assert.equal(response.status, 200, await response.clone().text());
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.team, 'Acme Inc');
      assert.equal(body.botName, 'tag');
      assert.equal(body.botUserId, 'UTAGBOT');
      assert.match(String(body.note), /Request URL verified/i);

      const stored = await resolveSlackIdentityCredentials(
        'slack_identity_default',
        undefined,
        settings,
      );
      assert.equal(stored.botToken, 'xoxb-pasted');
      assert.equal(stored.signingSecret, 'pasted-secret');
      assert.equal(stored.botUserId, 'UTAGBOT');
      assert.equal(await readPendingSlackChallenge(settings, 'slack_identity_default'), undefined);
      const connectedIdentity = await config.getSlackIdentity('slack_identity_default');
      assert.equal(connectedIdentity.lifecycle, 'connected');
      assert.equal(connectedIdentity.health, 'healthy');
      assert.equal(connectedIdentity.appId, 'A0CHICKPEA');
      assert.equal(connectedIdentity.teamId, 'TACME');
      assert.equal(connectedIdentity.botUserId, 'UTAGBOT');

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
      assert.equal(resolved.botUserId, 'UTAGBOT');
      assert.deepEqual(
        (await config.listSlackIdentityAuditEvents()).map(({ eventType }) => eventType),
        ['slack_identity.credentials_connected'],
      );
    });

    // ...and env values cannot override the active encrypted revision.
    await withEnv(
      { ...NO_SLACK_ENV, SLACK_BOT_TOKEN: 'xoxb-env-wins', SLACK_SIGNING_SECRET: 'env-secret-wins' },
      async () => {
        const resolved = await resolveSlackCredentials(undefined, settings);
        assert.equal(resolved.botToken, 'xoxb-pasted');
        assert.equal(resolved.signingSecret, 'pasted-secret');
        assert.equal(resolved.botUserId, 'UTAGBOT');
      },
    );
  } finally {
    invalidateStoredSlackCredentials();
    config.close();
    settings.close();
    await closeServer(server);
  }
});

test('wizard stages validated credentials until Slack later retries the Events URL', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenFakeSlack(
    {
      ok: true,
      app_id: 'A0CHICKPEA',
      team_id: 'TACME',
      team: 'Acme Inc',
      user: 'tag',
      user_id: 'UTAGBOT',
      bot_id: 'BTAG',
    },
    [{
      ok: true,
      user: {
        id: 'UTAGBOT',
        profile: { display_name: 'Chickpea', api_app_id: 'A0CHICKPEA' },
      },
    }],
    { 'x-oauth-scopes': slackAppManifest.oauth_config.scopes.bot.join(',') },
  );
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-slack-late-events-check-'));
  const path = join(directory, 'state.db');
  try {
    await withEnv(
      {
        ...NO_SLACK_ENV,
        SLACK_API_URL: baseUrl,
        TAG_DB_PATH: path,
        SLACK_STATE_DB_PATH: path,
      },
      async () => {
        const settings = new SqliteSettingsStore(path);
        const config = new SqliteConfigStore(path);
        try {
          const identity = await config.getSlackIdentity('slack_identity_default');
          const credentialDependencies = getSlackCredentialDependencies();
          const admin = appWith(settings, config, credentialDependencies);
          const staged = await postCreds(admin, {
            botToken: 'xoxb-late-events',
            signingSecret: 'late-events-secret',
          });
          assert.equal(staged.status, 202, await staged.clone().text());
          const stagedBody = (await staged.json()) as Record<string, unknown>;
          assert.equal(stagedBody.ok, true);
          assert.equal(stagedBody.connected, false);
          assert.equal(stagedBody.eventsVerificationRequired, true);
          assert.equal(
            stagedBody.consoleUrl,
            'https://api.slack.com/apps/A0CHICKPEA/event-subscriptions',
          );
          const stagedCredentials = await resolveSlackIdentityCredentials(
            'slack_identity_default',
            undefined,
            credentialDependencies,
          );
          assert.equal(stagedCredentials.botToken, 'xoxb-late-events');
          assert.equal(stagedCredentials.signingSecret, 'late-events-secret');
          assert.equal(
            (await config.getSlackIdentity(identity.id)).lifecycle,
            'credentials_pending',
          );

          const challenge = signedSlackEvent('late-events-secret', {
            type: 'url_verification',
            challenge: 'late-events-challenge',
            api_app_id: 'A0CHICKPEA',
            team_id: 'TACME',
          });
          const retry = await (await identityIngressApp()).request(
            `/channels/slack/events/${identity.ingressKey}`,
            { method: 'POST', headers: challenge.headers, body: challenge.body },
          );
          assert.equal(retry.status, 200, await retry.clone().text());
          assert.deepEqual(await retry.json(), { challenge: 'late-events-challenge' });
          assert.equal(
            (await config.getSlackIdentity(identity.id)).lifecycle,
            'connected',
          );
          assert.equal(await readPendingSlackChallenge(settings, identity.id), undefined);

          const status = await admin.request('/admin/api/slack-connection', { headers: auth() });
          assert.equal(status.status, 200);
          assert.equal(((await status.json()) as { connected: boolean }).connected, true);
        } finally {
          invalidateStoredSlackCredentials();
          config.close();
          settings.close();
        }
      },
    );
  } finally {
    await closeServer(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('wizard rotation replaces the whole connection record with freshly validated metadata', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenFakeSlack(
    {
      ok: true,
      app_id: 'A0CHICKPEA',
      team_id: 'TACME',
      user_id: 'UNEW',
      bot_id: 'BNEW',
    },
    [
      {
        ok: true,
        user: {
          id: 'UNEW',
          profile: { display_name: 'Chickpea', api_app_id: 'A0CHICKPEA' },
        },
      },
      {
        ok: true,
        user: {
          id: 'UNEW',
          profile: { display_name: 'Chickpea', api_app_id: 'A0CHICKPEA' },
        },
      },
    ],
    { 'x-oauth-scopes': slackAppManifest.oauth_config.scopes.bot.join(',') },
  );
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  try {
    await markWorkspaceDefaultConnected(config);
    const oldRevision = await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-old',
      signingSecret: 'secret-old',
      botUserId: 'UOLD',
    });
    await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Old Team');

    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      assert.equal(
        (await resolveSlackIdentityCredentials(
          'slack_identity_default',
          undefined,
          settings,
        )).botToken,
        'xoxb-old',
      );
      const rejected = await postCreds(appWith(settings, config), {
        botToken: 'xoxb-new',
        signingSecret: 'secret-new',
      });
      assert.equal(rejected.status, 422);
      assert.equal(
        ((await rejected.json()) as { error: string }).error,
        'signing_secret_change_requires_reconnect',
      );
      const response = await postCreds(appWith(settings, config), {
        botToken: 'xoxb-new',
        signingSecret: 'secret-old',
      });
      assert.equal(response.status, 200, await response.clone().text());
      const resolved = await resolveSlackIdentityCredentials(
        'slack_identity_default',
        undefined,
        settings,
      );
      assert.equal(resolved.botToken, 'xoxb-new');
      assert.equal(resolved.signingSecret, 'secret-old');
      assert.equal(resolved.botUserId, 'UNEW');
      assert.notEqual(resolved.connectionRevision, oldRevision);
    });

    const metadata = await readActiveSlackCredentialMetadata(
      'slack_identity_default',
      undefined,
      settings,
    );
    assert.equal(metadata?.teamId, 'TACME');
    assert.equal(metadata?.botUserId, 'UNEW');
    assert.equal(await settings.getSetting(SLACK_SETTING_KEYS.teamName), undefined);
  } finally {
    invalidateStoredSlackCredentials();
    config.close();
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
  const { server, baseUrl } = await listenFakeSlack(
    {
      ok: true,
      app_id: 'A0CHICKPEA',
      team_id: 'TOLD',
      team: 'Old Team',
      user_id: 'UNEW',
      bot_id: 'BNEW',
    },
    {
      ok: true,
      user: {
        id: 'UNEW',
        profile: { display_name: 'Chickpea', api_app_id: 'A0CHICKPEA' },
      },
    },
    { 'x-oauth-scopes': slackAppManifest.oauth_config.scopes.bot.join(',') },
  );
  const persisted = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  const credentials = createSlackCredentialFixture();
  const failingState = new Proxy(credentials.state, {
    get(target, property) {
      if (property === 'promoteSlackCredentialRevision') {
        return async () => {
          throw new Error('atomic credential promotion unavailable');
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    await markWorkspaceDefaultConnected(config, { teamId: 'TOLD' });
    await writeSlackIdentityCredentials(credentials, 'slack_identity_default', null, {
      botToken: 'xoxb-old',
      signingSecret: 'secret-old',
      appId: 'A0CHICKPEA',
      teamId: 'TOLD',
    });

    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await postCreds(appWith(persisted, config, {
        state: failingState,
        keyring: credentials.keyring,
      }), {
        botToken: 'xoxb-new',
        signingSecret: 'secret-old',
      });
      assert.equal(response.status, 409, await response.clone().text());
      assert.deepEqual(await response.json(), {
        error: 'slack_identity_credentials_changed',
      });
    });
    const resolved = await resolveSlackIdentityCredentials(
      'slack_identity_default',
      undefined,
      credentials,
    );
    assert.equal(resolved.botToken, 'xoxb-old');
    assert.equal(resolved.signingSecret, 'secret-old');
  } finally {
    invalidateStoredSlackCredentials();
    config.close();
    credentials.close();
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
    app_id: 'A0CHICKPEA',
    team_id: 'TACME',
    team: 'Acme Inc',
    user_id: 'UNEW',
    bot_id: 'BNEW',
  });
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  try {
    await markWorkspaceDefaultConnected(config);
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-old',
      signingSecret: 'secret-old',
    });
    const app = appWith(settings, config);

    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: controlled.baseUrl }, async () => {
      const pendingRotation = postCreds(app, {
        botToken: 'xoxb-new',
        signingSecret: 'secret-old',
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
      assert.equal(
        ((await staleRotation.json()) as { error: string }).error,
        'slack_identity_changed',
      );
    });

    assert.equal(
      (await resolveSlackIdentityCredentials(
        'slack_identity_default',
        undefined,
        settings,
      )).connectionRevision,
      null,
    );
  } finally {
    controlled.releaseAuth();
    invalidateStoredSlackCredentials();
    config.close();
    settings.close();
    await closeServer(controlled.server);
  }
});

test('team-info reads cannot restore canonical metadata after disconnect', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-old',
      signingSecret: 'secret-old',
      teamId: 'TOLD',
    });
    await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Old Team');
    const app = appWith(settings);
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: 'http://127.0.0.1:9/api/' }, async () => {
      assert.deepEqual(await resolveSlackTeamInfo(undefined, settings), {
        teamId: 'TOLD',
        teamName: 'Old Team',
      });
      const disconnected = await app.request('/admin/api/slack-connection', {
        method: 'DELETE',
        headers: auth(),
      });
      assert.equal(disconnected.status, 200);
      assert.deepEqual(await resolveSlackTeamInfo(undefined, settings), {
        teamId: undefined,
        teamName: undefined,
      });
    });
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
  }
});

test('team-info reads canonical revision metadata without network backfill', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-current',
      teamId: 'TNEW',
    });
    await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Stale Team');

    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: 'http://127.0.0.1:9/api/' }, async () => {
      assert.deepEqual(await resolveSlackTeamInfo(undefined, settings), {
        teamId: 'TNEW',
        teamName: 'Stale Team',
      });
    });
  } finally {
    settings.close();
  }
});

test('wizard POST distinguishes invalid and revoked tokens without consuming the challenge', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenSequencedGrantFakeSlack([
    { body: { ok: false, error: 'invalid_auth' } },
    { body: { ok: false, error: 'token_revoked' } },
  ]);
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  try {
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      await recordWorkspaceDefaultChallenge(config, settings, 'secret');
      const before = await workspaceDefaultConnectionSnapshot(settings, config);
      const app = appWith(settings, config);
      for (const detail of ['invalid_auth', 'token_revoked']) {
        const response = await postCreds(app, {
          botToken: 'xoxb-rejected',
          signingSecret: 'secret',
        });
        assert.equal(response.status, 422);
        const body = (await response.json()) as Record<string, unknown>;
        assert.equal(body.error, 'slack_auth_failed');
        assert.equal(body.detail, detail);
        assert.deepEqual(await workspaceDefaultConnectionSnapshot(settings, config), before);
      }
    });
  } finally {
    invalidateStoredSlackCredentials();
    config.close();
    settings.close();
    await closeServer(server);
  }
});

test('wizard POST keeps Slack reachability failure distinct and non-mutating', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  try {
    await recordWorkspaceDefaultChallenge(config, settings, 'secret');
    const before = await workspaceDefaultConnectionSnapshot(settings, config);
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: 'http://127.0.0.1:9/api/' }, async () => {
      const response = await postCreds(appWith(settings, config), {
        botToken: 'xoxb-unreachable',
        signingSecret: 'secret',
      });
      assert.equal(response.status, 502);
      assert.equal(
        ((await response.json()) as { error: string }).error,
        'slack_unreachable',
      );
    });
    assert.deepEqual(await workspaceDefaultConnectionSnapshot(settings, config), before);
  } finally {
    invalidateStoredSlackCredentials();
    config.close();
    settings.close();
  }
});

test('wizard POST rejects a valid Slack token whose installation is missing manifest scopes', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenFakeSlack(
    {
      ok: true,
      app_id: 'A0STALE',
      team_id: 'TACME',
      team: 'Acme Inc',
      user_id: 'USTALE',
    },
    undefined,
    { 'x-oauth-scopes': 'channels:history,chat:write' },
  );
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await postCreds(appWith(settings), {
        botToken: 'xoxb-stale-scopes',
        signingSecret: 'stale-secret',
      });
      assert.equal(response.status, 422);
      const body = (await response.json()) as {
        error: string;
        message: string;
        missingScopes: string[];
        consoleUrl: string;
      };
      assert.equal(body.error, 'slack_missing_scopes');
      assert.match(body.message, /grant the required permissions/i);
      assert.equal(body.consoleUrl, 'https://api.slack.com/apps/A0STALE/oauth');
      assert.deepEqual(
        body.missingScopes,
        slackAppManifest.oauth_config.scopes.bot.filter(
          (scope) => !['channels:history', 'chat:write'].includes(scope),
        ),
      );
      assert.equal(
        (await resolveSlackIdentityCredentials(
          'slack_identity_default',
          undefined,
          settings,
        )).connectionRevision,
        null,
      );
    });
  } finally {
    invalidateStoredSlackCredentials();
    settings.close();
    await closeServer(server);
  }
});

test('wizard POST requires conversations.list readiness before connecting', async (t) => {
  const skip = await loopbackListenSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { server, baseUrl } = await listenFakeSlack(
    {
      ok: true,
      app_id: 'A0CHICKPEA',
      team_id: 'TACME',
      user_id: 'UTAGBOT',
      bot_id: 'BTAG',
    },
    {
      ok: true,
      user: {
        id: 'UTAGBOT',
        profile: { display_name: 'Chickpea', api_app_id: 'A0CHICKPEA' },
      },
    },
    { 'x-oauth-scopes': slackAppManifest.oauth_config.scopes.bot.join(',') },
    { ok: false, error: 'missing_scope' },
  );
  const settings = new SqliteSettingsStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  try {
    await recordWorkspaceDefaultChallenge(config, settings, 'pasted-secret');
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const response = await postCreds(appWith(settings, config), {
        botToken: 'xoxb-pasted',
        signingSecret: 'pasted-secret',
      });
      assert.equal(response.status, 422);
      assert.equal(
        ((await response.json()) as { error: string }).error,
        'slack_missing_scopes',
      );
      assert.equal(
        (await resolveSlackIdentityCredentials(
          'slack_identity_default',
          undefined,
          settings,
        )).connectionRevision,
        null,
      );
      assert.ok(await readPendingSlackChallenge(settings, 'slack_identity_default'));
      assert.equal(
        (await config.getSlackIdentity('slack_identity_default')).lifecycle,
        'setup_incomplete',
      );
    });
  } finally {
    config.close();
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
      assert.equal(
        (await resolveSlackIdentityCredentials(
          'slack_identity_default',
          undefined,
          settings,
        )).connectionRevision,
        null,
      );
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

test('fixed events route rejects anonymous url_verification before any signing secret exists', async () => {
  await withEnv(
    { ...NO_SLACK_ENV, TAG_DB_PATH: ':memory:', SLACK_STATE_DB_PATH: undefined },
    async () => {
      invalidateStoredSlackCredentials();
      const { channel } = await import('../src/channels/slack.ts');
      const route = channel.routes.find((r) => r.path === '/events');
      assert.ok(route, 'channel must expose the /events route');
      const json = (body: unknown, status?: number) =>
        Response.json(body, { status: status ?? 200 });

      // Fresh installs use their opaque ingress. The compatibility route must
      // never accept unsigned setup material.
      const challengeCtx = {
        env: undefined,
        req: { json: async () => ({ type: 'url_verification', challenge: 'abc123' }) },
        json,
      };
      const deniedChallenge = (await route.handler(
        challengeCtx as never,
        undefined as never,
      )) as Response;
      assert.equal(deniedChallenge.status, 401);
      assert.deepEqual(await deniedChallenge.json(), { error: 'slack_not_configured' });

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

test('workspace-default opaque ingress retains a fresh signed challenge for setup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-slack-default-ingress-pending-'));
  const path = join(directory, 'state.db');
  try {
    await withEnv(
      { ...NO_SLACK_ENV, TAG_DB_PATH: path, SLACK_STATE_DB_PATH: path },
      async () => {
        const config = new SqliteConfigStore(path);
        const settings = new SqliteSettingsStore(path);
        try {
          const identity = await config.getSlackIdentity('slack_identity_default');
          const app = await identityIngressApp();
          const challenge = signedSlackEvent('future-secret', {
            type: 'url_verification',
            challenge: 'challenge-default',
            api_app_id: 'A0CHICKPEA',
            team_id: 'TACME',
          });
          const response = await app.request(
            `/channels/slack/events/${identity.ingressKey}`,
            {
              method: 'POST',
              headers: challenge.headers,
              body: challenge.body,
            },
          );
          assert.equal(response.status, 200, await response.clone().text());
          assert.deepEqual(await response.json(), { challenge: 'challenge-default' });
          assert.equal(
            (await readPendingSlackChallenge(settings, identity.id))?.rawBody,
            challenge.body,
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
            assert.equal(duplicate.status, 200, await duplicate.clone().text());
            assert.deepEqual(await duplicate.json(), { challenge: 'challenge-finance' });

            const event = signedSlackEvent('future-secret', {
              type: 'event_callback',
              api_app_id: 'A0FINANCE',
              team_id: 'TACME',
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
            teamId: 'TACME',
            appId: 'A0FINANCE',
            botUserId: 'UFINANCE',
            credentialProvenance: 'stored',
            connectionRevision: 1,
            health: 'healthy',
          }));
          const credentialDependencies = getSlackCredentialDependencies();
          await writeSlackIdentityCredentials(credentialDependencies, identity.id, null, {
            botToken: 'xoxb-finance',
            signingSecret: 'finance-secret',
            botUserId: 'UFINANCE',
            appId: 'A0FINANCE',
            teamId: 'TACME',
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
            team_id: 'TACME',
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
            credentialDependencies,
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
              teamId: 'TACME',
              appId: 'A0FINANCE',
              botUserId: 'UFINANCE',
              credentialProvenance: 'stored',
              health: 'healthy',
            }),
          );
          await writeSlackIdentityCredentials(getSlackCredentialDependencies(), identity.id, null, {
            botToken: 'xoxb-finance',
            signingSecret: 'finance-secret',
            botUserId: 'UFINANCE',
            appId: 'A0FINANCE',
            teamId: 'TACME',
          });
          await config.updateAgent('agent_default', { slackIdentityId: identity.id });
          await config.putAssignment({
            workspaceId: 'TACME',
            channelId: 'CFINANCE',
            agentId: 'agent_default',
          });
          const app = await identityIngressApp();
          const url = `/channels/slack/events/${identity.ingressKey}`;
          const basePayload = {
            type: 'event_callback',
            api_app_id: 'A0FINANCE',
            team_id: 'TACME',
            event_id: 'Ev_FINANCE',
            event: {
              type: 'app_mention',
              user: 'UMEMBER',
              text: '<@UFINANCE> hello',
              ts: '1782770400.000100',
              event_ts: '1782770400.000100',
              channel: 'CFINANCE',
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
            api_app_id: 'AOTHER',
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
            team_id: 'TOTHER',
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
            teamId: 'TACME',
            appId: 'A0FINANCE',
            botUserId: 'UFINANCE',
            credentialProvenance: 'stored',
            health: 'healthy',
          }));
          const credentialDependencies = getSlackCredentialDependencies();
          await writeSlackIdentityCredentials(credentialDependencies, identity.id, null, {
            botToken: 'xoxb-finance-v1',
            signingSecret: 'finance-secret-v1',
            botUserId: 'UFINANCE',
            appId: 'A0FINANCE',
            teamId: 'TACME',
          });
          const app = await identityIngressApp();
          const url = `/channels/slack/events/${identity.ingressKey}`;
          const payload = (eventId: string) => ({
            type: 'event_callback',
            api_app_id: 'A0FINANCE',
            team_id: 'TACME',
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
            credentialDependencies,
          );
          await writeSlackIdentityCredentials(
            credentialDependencies,
            identity.id,
            currentCredentials.connectionRevision,
            {
              botToken: 'xoxb-finance-v2',
              signingSecret: 'finance-secret-v2',
              botUserId: 'UFINANCE',
              appId: 'A0FINANCE',
              teamId: 'TACME',
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
            teamId: 'TACME',
            appId: 'A0FINANCE',
            botUserId: 'UFINANCE',
            credentialProvenance: 'stored',
            health: 'healthy',
          }));
          await config.updateAgent('agent_default', { slackIdentityId: identity.id });
          await config.putAssignment({
            workspaceId: 'TACME',
            channelId: 'CFINANCE',
            agentId: 'agent_default',
          });
          await markWorkspaceDefaultConnected(config, {
            appId: 'ADEFAULT',
            botUserId: 'UDEFAULT',
          });
          await writeSlackIdentityCredentials(
            getSlackCredentialDependencies(),
            'slack_identity_default',
            null,
            {
              botToken: 'xoxb-default',
              signingSecret: 'default-secret',
              botUserId: 'UDEFAULT',
              appId: 'ADEFAULT',
              teamId: 'TACME',
            },
          );

          const app = await identityIngressApp();
          const event = signedSlackEvent('default-secret', {
            type: 'event_callback',
            api_app_id: 'ADEFAULT',
            team_id: 'TACME',
            event_id: 'Ev_WRONG_IDENTITY',
            event: {
              type: 'app_mention',
              user: 'UMEMBER',
              text: '<@UDEFAULT> hello',
              ts: '1782770400.000200',
              event_ts: '1782770400.000200',
              channel: 'CFINANCE',
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
            teamId: 'TACME',
            appId: 'A0FINANCE',
            botUserId: 'UFINANCE',
            credentialProvenance: 'stored',
            health: 'healthy',
          }));
          await writeSlackIdentityCredentials(getSlackCredentialDependencies(), identity.id, null, {
            botToken: 'xoxb-finance',
            signingSecret: 'finance-secret',
            botUserId: 'UFINANCE',
            appId: 'A0FINANCE',
            teamId: 'TACME',
          });
          await config.updateAgent('agent_default', {
            slackIdentityId: identity.id,
            model: 'local-stub/identity-admission',
          });
          await config.putAssignment({
            workspaceId: 'TACME',
            channelId: 'CFINANCE',
            agentId: 'agent_default',
          });
          const app = await identityIngressApp();
          const url = `/channels/slack/events/${identity.ingressKey}`;
          const event = (eventId: string, ts: string) => signedSlackEvent('finance-secret', {
            type: 'event_callback',
            api_app_id: 'A0FINANCE',
            team_id: 'TACME',
            event_id: eventId,
            event: {
              type: 'app_mention',
              user: 'UMEMBER',
              text: '<@UFINANCE> hello',
              ts,
              event_ts: ts,
              channel: 'CFINANCE',
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
          // Admission is asynchronous, and a row can exist before durable
          // execution has finished its live membership check. Wait for the
          // first turn to settle before changing the fake Slack membership;
          // otherwise the next assertion races the already-admitted turn.
          for (let attempt = 0; attempt < 300 && admitted?.status !== 'done'; attempt += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            const db = new DatabaseSync(path);
            try {
              const row = db.prepare(
                `SELECT status, recovery_reason, turn_json
                 FROM turn_jobs WHERE id = 'msg:CFINANCE:1782770400.000300'`,
              ).get() as
                | { status: string; recovery_reason: string | null; turn_json: string }
                | undefined;
              if (row) admitted = row;
            } finally {
              db.close();
            }
          }
          assert.equal(admitted?.status, 'done');
          assert.equal(admitted?.recovery_reason, null);
          assert.equal(JSON.parse(admitted?.turn_json ?? '{}').slackIdentityId, identity.id);

          fake.setMember(false);
          const beforeMembershipCheckCalls = fake.requestPaths.length;
          const nonMember = event('Ev_MULTI_NOT_MEMBER', '1782770400.000400');
          const nonMemberResponse = await app.request(url, {
            method: 'POST',
            headers: nonMember.headers,
            body: nonMember.body,
          });
          assert.equal(nonMemberResponse.status, 200, await nonMemberResponse.clone().text());
          // Event admission continues after Slack's acknowledgement. The
          // dedicated identity must consult current Slack truth and stop
          // before canonical admission when conversations.info says the app
          // is no longer a member. That admission-layer denial intentionally
          // does not emit the durable-execution operational log.
          let membershipCheckPaths: string[] = [];
          for (let attempt = 0; attempt < 300; attempt += 1) {
            membershipCheckPaths = fake.requestPaths.slice(beforeMembershipCheckCalls);
            if (membershipCheckPaths.some((requestPath) =>
              requestPath.endsWith('/conversations.info')
            )) {
              break;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(
            membershipCheckPaths.some((requestPath) => requestPath.endsWith('/users.info')),
            JSON.stringify(membershipCheckPaths),
          );
          assert.ok(
            membershipCheckPaths.some((requestPath) =>
              requestPath.endsWith('/conversations.info')
            ),
            JSON.stringify(membershipCheckPaths),
          );
          // Let the fetch continuation observe the fake response, then prove
          // the rejected callback never became durable work.
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          const rejectedDb = new DatabaseSync(path);
          try {
            assert.equal(
              rejectedDb.prepare('SELECT COUNT(*) AS count FROM turn_jobs').get()?.count,
              1,
            );
            assert.equal(
              rejectedDb.prepare('SELECT COUNT(*) AS count FROM runs').get()?.count,
              1,
            );
          } finally {
            rejectedDb.close();
          }

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
        SLACK_TAG_LEDGER_CANARY_CHANNELS: 'TACME/DFINANCE,TACME/DLEGAL,TACME/DSILENT',
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
            teamId: 'TACME',
            appId: 'A0FINANCE',
            botUserId: 'UFINANCE',
            dmAgentId: 'agent_default',
            credentialProvenance: 'stored',
            health: 'healthy',
          }));
          const legal = await config.createSlackIdentity(pendingIdentity({
            id: 'slack_identity_legal',
            ingressKey: 'legal_dm_ingress_0123456789abcdef',
            lifecycle: 'connected',
            teamId: 'TACME',
            appId: 'A0LEGAL',
            botUserId: 'ULEGAL',
            dmAgentId: 'agent_legal',
            credentialProvenance: 'stored',
            health: 'healthy',
          }));
          const silentDraft = pendingIdentity({
            id: 'slack_identity_silent',
            ingressKey: 'silent_dm_ingress_0123456789abcdef',
            lifecycle: 'connected',
            teamId: 'TACME',
            appId: 'A0SILENT',
            botUserId: 'USILENT',
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
            await writeSlackIdentityCredentials(
              getSlackCredentialDependencies(),
              identity.id,
              null,
              {
              botToken,
              signingSecret,
              botUserId: identity.botUserId!,
                appId: identity.appId!,
                teamId: identity.teamId!,
              },
            );
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
              team_id: 'TACME',
              event_id: eventId,
              event: {
                type: 'message',
                user: 'UMEMBER',
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
            'DFINANCE',
            '1782770400.001000',
          )).status, 200);
          assert.equal((await sendDm(
            legal,
            'legal-dm-secret',
            'Ev_DM_LEGAL',
            'DLEGAL',
            '1782770400.002000',
          )).status, 200);
          assert.equal((await sendDm(
            silent,
            'silent-dm-secret',
            'Ev_DM_SILENT',
            'DSILENT',
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
            teamId: 'TACME',
            appId: 'A0FINANCE',
            botUserId: 'UFINANCE',
            credentialProvenance: 'stored',
            health: 'healthy',
          }));
          await writeSlackIdentityCredentials(getSlackCredentialDependencies(), identity.id, null, {
            botToken: 'xoxb-finance',
            signingSecret: 'finance-secret',
            botUserId: 'UFINANCE',
            appId: 'A0FINANCE',
            teamId: 'TACME',
          });
          const app = await identityIngressApp();
          const url = `/channels/slack/events/${identity.ingressKey}`;
          const lifecycleEvent = (
            type: 'tokens_revoked' | 'app_uninstalled',
            eventId: string,
          ) => signedSlackEvent('finance-secret', {
            type: 'event_callback',
            api_app_id: 'A0FINANCE',
            team_id: 'TACME',
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
    teamId: 'TACME',
    appId: 'A0FINANCE',
    botUserId: 'UFINANCE',
    credentialProvenance: 'stored',
    health: 'healthy',
    connectionRevision: 1,
  });
  const credentialState = new SqliteIdentityStore(':memory:');
  const keyring = generateCredentialKeyring('key_lifecycle_rpc');
  await writeSlackIdentityCredentials(
    { state: credentialState, keyring },
    identity.id,
    null,
    {
      botToken: 'xoxb-finance',
      signingSecret: 'finance-secret',
      botUserId: 'UFINANCE',
      appId: 'A0FINANCE',
      teamId: 'TACME',
    },
  );
  const identityExecute = async (request: { kind: string; identityId?: string }) => {
    if (request.kind === 'get_slack_credential_control') {
      return {
        ok: true as const,
        value: {
          kind: 'slack_credential_control',
          control: await credentialState.getSlackCredentialControl() ?? null,
        },
      };
    }
    if (request.kind === 'get_active_slack_credential_revision') {
      return {
        ok: true as const,
        value: {
          kind: 'slack_credential_revision',
          revision: await credentialState.getActiveSlackCredentialRevision(
            request.identityId!,
          ) ?? null,
        },
      };
    }
    throw new Error(`unexpected identity RPC ${request.kind}`);
  };
  const lifecycleEvent = signedSlackEvent('finance-secret', {
    type: 'event_callback',
    api_app_id: 'A0FINANCE',
    team_id: 'TACME',
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
        identityExecute,
      };
      const workerKeys = {
        CHICKPEA_CREDENTIAL_KEY_CURRENT_ID: keyring.currentKeyId,
        [`CHICKPEA_CREDENTIAL_KEY_${keyring.currentKeyId.toUpperCase()}`]:
          keyring.keys[keyring.currentKeyId],
      };
      const racingEnv = { TAG_STATE: { getByName: () => racingStub }, ...workerKeys };
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
        identityExecute,
      };
      const failingEnv = { TAG_STATE: { getByName: () => failingStub }, ...workerKeys };
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
  credentialState.close();
});

test('requestOrigin honors SLACK_TAG_PUBLIC_URL as an operator pin over the request host', async () => {
  await withEnv(
    { ...NO_SLACK_ENV, SLACK_TAG_PUBLIC_URL: 'https://pinned.example.com/' },
    async () => {
      const settings = new SqliteSettingsStore(':memory:');
      const config = new SqliteConfigStore(':memory:');
      try {
        const identity = await config.getSlackIdentity('slack_identity_default');
        const app = appWith(settings, config);
        // Request arrives on a different host AND carries a forged x-forwarded-*
        // — the pin must win over both, with the trailing slash trimmed.
        const response = await app.request('https://socket.internal/admin/api/slack-connection', {
          headers: { ...auth(), 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' },
        });
        const body = (await response.json()) as { requestUrl: string };
        assert.equal(
          body.requestUrl,
          `https://pinned.example.com/channels/slack/events/${identity.ingressKey}`,
        );
      } finally {
        config.close();
        settings.close();
      }
    },
  );
});

test('requestOrigin on Node takes the LAST x-forwarded hop, not a client-forged first', async () => {
  await withEnv(NO_SLACK_ENV, async () => {
    const settings = new SqliteSettingsStore(':memory:');
    const config = new SqliteConfigStore(':memory:');
    try {
      const identity = await config.getSlackIdentity('slack_identity_default');
      const app = appWith(settings, config);
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
      assert.equal(
        body.requestUrl,
        `https://chickpea.real.workers.dev/channels/slack/events/${identity.ingressKey}`,
      );
    } finally {
      config.close();
      settings.close();
    }
  });
});

test('bot user id resolution stays bound to one active encrypted bundle despite env conflicts', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-stored',
      signingSecret: 'stored-secret',
      botUserId: 'USTOREDBOT',
    });

    // No env token: the stored token wins, so its stored bot user id is honored.
    await withEnv(NO_SLACK_ENV, async () => {
      const resolved = await resolveSlackCredentials(undefined, settings);
      assert.equal(resolved.botToken, 'xoxb-stored');
      assert.equal(resolved.botUserId, 'USTOREDBOT');
    });

    // Environment credentials cannot splice a different token or identity into
    // the active revision.
    await withEnv({ ...NO_SLACK_ENV, SLACK_BOT_TOKEN: 'xoxb-env' }, async () => {
      const resolved = await resolveSlackCredentials(undefined, settings);
      assert.equal(resolved.botToken, 'xoxb-stored');
      assert.equal(resolved.botUserId, 'USTOREDBOT');
    });

    await withEnv(
      { ...NO_SLACK_ENV, SLACK_BOT_TOKEN: 'xoxb-env', SLACK_BOT_USER_ID: '' },
      async () => {
        const resolved = await resolveSlackCredentials(undefined, settings);
        assert.equal(resolved.botUserId, 'USTOREDBOT');
      },
    );

    await withEnv(
      { ...NO_SLACK_ENV, SLACK_BOT_TOKEN: 'xoxb-env', SLACK_BOT_USER_ID: 'UENVBOT' },
      async () => {
        const resolved = await resolveSlackCredentials(undefined, settings);
        assert.equal(resolved.botUserId, 'USTOREDBOT');
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
        expectedTeamId: 'TACME',
        botToken: 'xoxb-finance',
        signingSecret,
      },
      validDedicatedSlackDeps(),
    );
    assert.equal(pending.lifecycle, 'credentials_pending');
    assert.equal(pending.connectionRevision, 1);
    assert.equal(pending.teamId, 'TACME');
    assert.equal(pending.appId, 'A0FINANCE');
    assert.equal(pending.botUserId, 'UFINANCE');
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
    assert.equal(credentials.botUserId, 'UFINANCE');
    assert.ok(credentials.connectionRevision);
    assert.deepEqual(
      (
        await readActiveSlackCredentialMetadata(
          draft.id,
          undefined,
          settings,
        )
      )?.grantedScopes,
      [...slackAppManifest.oauth_config.scopes.bot].sort(),
    );
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
        expectedTeamId: 'TACME',
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

test('Slack Admin GETs never expose encrypted dedicated credential values or locators', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const keys = slackIdentityCredentialSettingKeys('slack_identity_finance');
    assert.deepEqual(Object.keys(keys), ['pendingEnvelope']);
    await writeSlackIdentityCredentials(settings, 'slack_identity_finance', null, {
      botToken: 'xoxb-must-not-leak',
      signingSecret: 'signing-secret-must-not-leak',
      botUserId: 'UFINANCE',
      appId: 'A0FINANCE',
      teamId: 'TACME',
    });
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

test('workspace-default identity health uses the active encrypted credential bundle', async () => {
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await writeWorkspaceCredentialFixture(settings, {
      botToken: 'xoxb-default-stored',
      signingSecret: 'default-stored-secret',
      appId: 'A0FINANCE',
    });
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
      assert.equal(refreshed.identity.teamId, 'TACME');
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
        teamId: 'TACME',
        appId: 'A0EXISTING',
        botUserId: 'UEXISTING',
        dmState: 'off',
        credentialProvenance: 'stored',
        health: 'healthy',
      }),
    );

    const fallback = await validateSlackIdentityBotInstallation(
      {
        config,
        identityId: 'slack_identity_finance',
        expectedTeamId: 'TACME',
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
              expectedTeamId: 'TACME',
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
    await assertBootstrapCode('slack_missing_scopes', {
      ...validDedicatedSlackDeps(),
      authTest: async () => ({
        ...(await validDedicatedSlackDeps().authTest()),
        grantedScopes: ['channels:history', 'chat:write'],
      }),
    });
    await assertBootstrapCode('workspace_mismatch', {
      ...validDedicatedSlackDeps(),
      authTest: async () => ({
        ...(await validDedicatedSlackDeps().authTest()),
        teamId: 'TOTHER',
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

test('dedicated identity validation normalizes transient failures from every Slack preflight', async () => {
  const config = new SqliteConfigStore(':memory:');
  try {
    await config.createSlackIdentity(pendingIdentity());
    const initialIdentity = await config.getSlackIdentity('slack_identity_finance');
    const validDeps = validDedicatedSlackDeps();
    const auth = await validDeps.authTest();
    const profile = await validDeps.botIdentityInfo();
    const channels: SlackConversationsListPage = {
      ok: true,
      error: undefined,
      channels: [],
      nextCursor: undefined,
    };
    const cases: ReadonlyArray<{
      name: string;
      deps: SlackIdentityBootstrapDeps;
      expectedCode: string;
    }> = [
      {
        name: 'auth.test named server failure',
        deps: {
          ...validDeps,
          authTest: async () => ({ ...auth, ok: false, error: 'internal_error' }),
        },
        expectedCode: 'slack_unreachable',
      },
      {
        name: 'auth.test invalid token control',
        deps: {
          ...validDeps,
          authTest: async () => ({ ...auth, ok: false, error: 'invalid_auth' }),
        },
        expectedCode: 'slack_auth_failed',
      },
      {
        name: 'users.info named server failure',
        deps: {
          ...validDeps,
          botIdentityInfo: async () => ({
            ...profile,
            ok: false,
            error: 'service_unavailable',
          }),
        },
        expectedCode: 'slack_unreachable',
      },
      {
        name: 'users.info thrown transport failure',
        deps: {
          ...validDeps,
          botIdentityInfo: async () => {
            throw new TypeError('network down');
          },
        },
        expectedCode: 'slack_unreachable',
      },
      {
        name: 'users.info authorization control',
        deps: {
          ...validDeps,
          botIdentityInfo: async () => ({ ...profile, ok: false, error: 'invalid_auth' }),
        },
        expectedCode: 'identity_profile_unavailable',
      },
      {
        name: 'conversations.list synthetic server failure',
        deps: {
          ...validDeps,
          conversationsList: async () => ({
            ...channels,
            ok: false,
            error: 'slack_http_503',
          }),
        },
        expectedCode: 'slack_unreachable',
      },
      {
        name: 'conversations.list missing-scope control',
        deps: {
          ...validDeps,
          conversationsList: async () => ({
            ...channels,
            ok: false,
            error: 'missing_scope',
          }),
        },
        expectedCode: 'slack_missing_scopes',
      },
    ];

    for (const scenario of cases) {
      await assert.rejects(
        () => validateSlackIdentityBotInstallation(
          {
            config,
            identityId: 'slack_identity_finance',
            expectedTeamId: 'TACME',
            botToken: 'xoxb-under-test',
            requireChannelList: true,
          },
          scenario.deps,
        ),
        (error: unknown) =>
          error instanceof SlackIdentityBootstrapError &&
          error.code === scenario.expectedCode,
        scenario.name,
      );
      assert.deepEqual(
        await config.getSlackIdentity('slack_identity_finance'),
        initialIdentity,
        `${scenario.name} must not persist connection state`,
      );
    }
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
                teamId: 'TOTHER',
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

test('a fresh Slack challenge immediately replaces an earlier app-creation challenge', async () => {
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const now = 1_700_000_000_000;
  try {
    const draft = await config.createSlackIdentity(pendingIdentity());
    const first = signedChallenge('first-secret', { timestamp: Math.floor(now / 1_000) });
    assert.equal((await recordPendingSlackChallenge(settings, draft, first, { now })).accepted, true);

    const replacementAt = now + 1;
    const replacement = signedChallenge('replacement-secret', {
      timestamp: Math.floor(replacementAt / 1_000),
    });
    assert.equal(
      (await recordPendingSlackChallenge(settings, draft, replacement, { now: replacementAt })).accepted,
      true,
    );
    assert.equal(
      (await readPendingSlackChallenge(settings, draft.id, { now: replacementAt + 1 }))?.rawBody,
      replacement.rawBody,
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('the documented Slack URL-verification payload verifies without optional app or team ids', async () => {
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const now = 1_700_000_000_000;
  const secret = 'documented-payload-secret';
  try {
    const draft = await config.createSlackIdentity(pendingIdentity());
    const envelope = signedChallenge(secret, {
      timestamp: Math.floor(now / 1_000),
      includeIdentity: false,
    });
    assert.equal(
      (await recordPendingSlackChallenge(settings, draft, envelope, { now })).accepted,
      true,
    );
    const verified = await verifyPendingSlackChallenge(settings, draft.id, secret, {
      now: now + 1,
      expectedAppId: 'A0FINANCE',
      expectedTeamId: 'TACME',
    });
    assert.equal(verified.verified, true);
  } finally {
    config.close();
    settings.close();
  }
});

test('pending Slack challenges are bounded, idempotent, and atomically cleared with credentials', async () => {
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

    const staleEnvelope = signedChallenge(secret, {
      timestamp: Math.floor((now - SLACK_REQUEST_FRESHNESS_MS - 1) / 1_000),
    });
    assert.deepEqual(
      await recordPendingSlackChallenge(settings, draft, staleEnvelope, { now }),
      { accepted: false, reason: 'stale_timestamp' },
    );

    const envelope = signedChallenge(secret, { timestamp: Math.floor(now / 1_000) });
    const first = await recordPendingSlackChallenge(settings, draft, envelope, { now });
    assert.equal(first.accepted, true);
    if (first.accepted) {
      assert.equal(first.appId, 'A0FINANCE');
      assert.equal(first.teamId, 'TACME');
    }
    const duplicate = await recordPendingSlackChallenge(settings, draft, envelope, { now: now + 1 });
    assert.equal(duplicate.accepted, true);
    if (duplicate.accepted) assert.equal(duplicate.challenge, 'challenge-finance');
    assert.deepEqual(
      await verifyPendingSlackChallenge(settings, draft.id, secret, {
        now: now + PENDING_SLACK_CHALLENGE_TTL_MS + 1,
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
    assert.ok(await readPendingSlackChallenge(settings, draft.id, { now: now + 4 }));
    assert.deepEqual(
      await verifyPendingSlackChallenge(settings, draft.id, secret, {
        now: now + 4,
        expectedAppId: 'A0OTHER',
      }),
      { verified: false, reason: 'app_mismatch' },
    );
    assert.deepEqual(
      await verifyPendingSlackChallenge(settings, draft.id, secret, {
        now: now + 4,
        expectedTeamId: 'TOTHER',
      }),
      { verified: false, reason: 'workspace_mismatch' },
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
        expectedTeamId: 'TACME',
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
    assert.equal(
      (await resolveSlackIdentityCredentials(draft.id, undefined, settings))
        .connectionRevision,
      null,
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
        teamId: 'TACME',
        appId: 'A0FINANCE',
        botUserId: 'UFINANCE',
        dmState: 'off',
        credentialProvenance: 'stored',
        health: 'healthy',
      }),
    );
    await writeSlackIdentityCredentials(settings, identity.id, null, {
      botToken: 'xoxb-connected',
      signingSecret: 'connected-secret',
      botUserId: 'UFINANCE',
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
        expectedTeamId: 'TACME',
        botToken: 'xoxb-delayed',
        signingSecret: 'delayed-secret',
      },
      deps,
    );
    await authStarted;
    assert.equal(await config.deleteIncompleteSlackIdentity(draft.id, 0, true), true);
    release();
    await assert.rejects(connecting, /Unknown Slack identity/);

    assert.equal(
      (await resolveSlackIdentityCredentials(draft.id, undefined, settings))
        .connectionRevision,
      null,
    );
  } finally {
    release();
    config.close();
    settings.close();
  }
});
