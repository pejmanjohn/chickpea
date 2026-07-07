import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  invalidateStoredSlackCredentials,
  resolveSlackCredentials,
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
  // requestOrigin() honors SLACK_TAG_PUBLIC_URL as an operator pin; clear it so
  // the request-derived origin tests are hermetic against the dev shell.
  SLACK_TAG_PUBLIC_URL: undefined,
};

function appWith(settings: SqliteSettingsStore): Hono {
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
}> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/auth.test')) {
      res.end(JSON.stringify(authTestBody));
      return;
    }
    res.statusCode = 404;
    res.end('{"ok":false,"error":"unknown_method"}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/api/` });
    });
  });
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
      assert.equal(manifest.display_information.name, 'Tag Team');
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
          'x-forwarded-host': 'tag-team.acme.workers.dev',
        },
      });
      const body = (await response.json()) as { requestUrl: string; manifestUrl: string };
      assert.equal(body.requestUrl, 'https://tag-team.acme.workers.dev/channels/slack/events');
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
          'x-forwarded-host': 'client-forged.example, tag-team.real.workers.dev',
        },
      });
      const body = (await response.json()) as { requestUrl: string };
      assert.equal(body.requestUrl, 'https://tag-team.real.workers.dev/channels/slack/events');
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
