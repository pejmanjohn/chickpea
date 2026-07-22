import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import {
  invalidateSlackBotUserIdCache,
  resolveBotUserId,
} from '../src/channels/slack.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import {
  invalidateStoredSlackCredentials,
  primeStoredSlackCredentials,
  resolveSlackCredentials,
  resolveSlackTeamInfo,
  slackTokenFingerprint,
  SLACK_SETTING_KEYS,
} from '../src/slack/credentials.ts';
import { withEnv } from './helpers/env.ts';
import { loopbackListenSkipReason } from './helpers/listen.ts';

const ADMIN_TOKEN = 'wizard-admin-token';

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
  // requestOrigin() honors SLACK_TAG_PUBLIC_URL as an operator pin; clear it so
  // the request-derived origin tests are hermetic against the dev shell.
  SLACK_TAG_PUBLIC_URL: undefined,
};

function appWith(settings: SettingsStore): Hono {
  const app = new Hono();
  app.route('/', createAdminRoutes({ settings, adminToken: ADMIN_TOKEN }));
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

/** Minimal fake Slack Web API answering only auth.test, with a canned body. */
function listenFakeSlack(authTestBody: Record<string, unknown>): Promise<{
  server: Server;
  baseUrl: string;
  authHeaders: string[];
}> {
  const authHeaders: string[] = [];
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/auth.test')) {
      authHeaders.push(req.headers.authorization ?? '');
      res.end(JSON.stringify(authTestBody));
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

      const app = appWith(settings);
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
    });
  } finally {
    invalidateStoredSlackCredentials();
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
      });

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
        settings: { event_subscriptions: { request_url: string } };
      };
      // The one substitution that removes the copy-the-URL setup step.
      assert.equal(manifest.settings.event_subscriptions.request_url, body.requestUrl);
      // Editor-tooling key must not leak into Slack's manifest import.
      assert.equal(manifest.$schema, undefined);
      assert.equal(manifest.display_information.name, 'Chickpea');
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
  try {
    await withEnv({ ...NO_SLACK_ENV, SLACK_API_URL: baseUrl }, async () => {
      const app = appWith(settings);
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
