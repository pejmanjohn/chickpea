import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AmbiguousEffect,
  SlackRefused,
  SlackUnavailable,
  createAgentAppSlackApi,
} from '../src/slack/agent-apps/slack-api.ts';
import { buildSlackAppManifest } from '../src/slack/app-manifest.ts';

const TOKEN = 'xoxe.xoxp-1-config-access-token';
const MANIFEST = buildSlackAppManifest({ kind: 'workspace_app', origin: 'https://example.test' });

interface Seen {
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

function api(answer: (seen: Seen) => Response | Promise<Response> | never) {
  const seen: Seen[] = [];
  const client = createAgentAppSlackApi({
    apiBaseUrl: 'https://slack.test/api/',
    fetch: async (input, init) => {
      const url = String(input);
      assert.equal(url.startsWith('https://slack.test/api/'), true);
      const headers = new Headers(init?.headers);
      const body = init?.body;
      const record: Seen = {
        method: url.slice('https://slack.test/api/'.length),
        authorization: headers.get('authorization'),
        contentType: headers.get('content-type'),
        body: typeof body === 'string'
          ? (headers.get('content-type')?.includes('json') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)))
          : body instanceof FormData ? Object.fromEntries([...body.entries()].map(([key, value]) => [key, value instanceof Blob ? `blob:${value.size}` : value]))
          : body,
      };
      seen.push(record);
      return answer(record);
    },
  });
  return { client, seen };
}

const ok = (payload: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ ok: true, ...payload }), { status, headers: { 'content-type': 'application/json' } });
const refused = (error: string, status = 200) =>
  new Response(JSON.stringify({ ok: false, error }), { status, headers: { 'content-type': 'application/json' } });

test('rotate sends the refresh token as a form field and parses the new pair', async () => {
  const { client, seen } = api(() => ok({ token: 'xoxe.xoxp-1-new', refresh_token: 'xoxe-1-new', team_id: 'TACME', exp: 1_800_000_000, iat: 1 }));
  assert.deepEqual(await client.rotate('xoxe-1-old'), {
    accessToken: 'xoxe.xoxp-1-new', refreshToken: 'xoxe-1-new', teamId: 'TACME', expiresAt: 1_800_000_000_000,
  });
  assert.equal(seen[0]?.method, 'tooling.tokens.rotate');
  assert.equal(seen[0]?.authorization, null);
  assert.deepEqual(seen[0]?.body, { refresh_token: 'xoxe-1-old' });

  const dead = api(() => refused('invalid_refresh_token'));
  await assert.rejects(() => dead.client.rotate('xoxe-1-old'), (error: unknown) =>
    error instanceof SlackRefused && error.code === 'invalid_refresh_token' && !error.message.includes('xoxe-1-old'));
  const down = api(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(() => down.client.rotate('xoxe-1-old'), (error: unknown) =>
    error instanceof SlackUnavailable && error.reason === 'network_error');
  const odd = api(() => ok({ token: 'x', refresh_token: 'y' }));
  await assert.rejects(() => odd.client.rotate('xoxe-1-old'), (error: unknown) =>
    error instanceof SlackUnavailable && error.reason === 'invalid_slack_response');
  const noTeam = api(() => ok({ token: 'x', refresh_token: 'y', exp: 1_800_000_000 }));
  await assert.rejects(() => noTeam.client.rotate('xoxe-1-old'), (error: unknown) =>
    error instanceof SlackUnavailable && error.reason === 'invalid_slack_response');
});

test('create carries the manifest under the configuration token and tells a refusal from an unknown answer', async () => {
  const { client, seen } = api(() => ok({
    app_id: 'A0C8APP',
    credentials: { client_id: '1.2', client_secret: 'cs', signing_secret: 'ss', verification_token: 'vt' },
  }));
  assert.deepEqual(await client.create(TOKEN, MANIFEST), { appId: 'A0C8APP', clientId: '1.2', clientSecret: 'cs', signingSecret: 'ss' });
  assert.equal(seen[0]?.method, 'apps.manifest.create');
  assert.equal(seen[0]?.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(seen[0]?.body, { manifest: MANIFEST });

  const noResult = (error: unknown): boolean => error instanceof Error && !error.message.includes(TOKEN);
  await assert.rejects(() => api(() => refused('invalid_manifest')).client.create(TOKEN, MANIFEST), (error: unknown) =>
    error instanceof SlackRefused && error.code === 'invalid_manifest' && noResult(error));
  await assert.rejects(() => api(() => refused('ratelimited', 429)).client.create(TOKEN, MANIFEST), (error: unknown) =>
    error instanceof SlackRefused && error.code === 'ratelimited');
  await assert.rejects(() => api(() => refused('internal_error', 500)).client.create(TOKEN, MANIFEST), (error: unknown) =>
    error instanceof AmbiguousEffect && error.reason === 'internal_error' && noResult(error));
  await assert.rejects(() => api(() => { throw new TypeError('fetch failed'); }).client.create(TOKEN, MANIFEST), (error: unknown) =>
    error instanceof AmbiguousEffect && error.reason === 'network_error');
  await assert.rejects(() => api(() => new Response('<html>', { status: 200 })).client.create(TOKEN, MANIFEST), (error: unknown) =>
    error instanceof AmbiguousEffect && error.reason === 'invalid_slack_response');
  await assert.rejects(() => api(() => ok({ app_id: 'A0C8APP' })).client.create(TOKEN, MANIFEST), (error: unknown) =>
    error instanceof AmbiguousEffect && error.reason === 'incomplete_slack_success');
});

test('update names the app and the manifest, and a refusal is a refusal', async () => {
  const { client, seen } = api(() => ok({}));
  await client.update(TOKEN, 'A0C8APP', MANIFEST);
  assert.equal(seen[0]?.method, 'apps.manifest.update');
  assert.deepEqual(seen[0]?.body, { app_id: 'A0C8APP', manifest: MANIFEST });
  await assert.rejects(() => api(() => refused('invalid_manifest')).client.update(TOKEN, 'A0C8APP', MANIFEST), (error: unknown) =>
    error instanceof SlackRefused && error.code === 'invalid_manifest');
});

test('the icon upload is multipart and every outcome is one of three words', async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const { client, seen } = api(() => ok({}));
  assert.equal(await client.setIcon(TOKEN, 'A0C8APP', png), 'set');
  assert.equal(seen[0]?.method, 'apps.icon.set');
  assert.equal(seen[0]?.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(seen[0]?.body, { app_id: 'A0C8APP', file: 'blob:4' });
  assert.equal(await api(() => refused('invalid_image')).client.setIcon(TOKEN, 'A0C8APP', png), 'refused');
  assert.equal(await api(() => refused('service_unavailable', 503)).client.setIcon(TOKEN, 'A0C8APP', png), 'failed');
  assert.equal(await api(() => { throw new TypeError('fetch failed'); }).client.setIcon(TOKEN, 'A0C8APP', png), 'failed');
});

test("exchange uses the app's own client credentials and parses the grant", async () => {
  const { client, seen } = api(() => ok({
    access_token: 'xoxb-agent', bot_user_id: 'UBOT', app_id: 'A0C8APP', team: { id: 'TACME', name: 'Acme' },
    scope: 'app_mentions:read,chat:write, im:history,chat:write', authed_user: { id: 'UOWNER' },
  }));
  assert.deepEqual(await client.exchange({ clientId: '1.2', clientSecret: 'cs', code: 'code-1', redirectUri: 'https://host/cb' }), {
    botToken: 'xoxb-agent', botUserId: 'UBOT', teamId: 'TACME', appId: 'A0C8APP', installerUserId: 'UOWNER',
    scopes: ['app_mentions:read', 'chat:write', 'im:history'],
  });
  assert.equal(seen[0]?.method, 'oauth.v2.access');
  assert.deepEqual(seen[0]?.body, { client_id: '1.2', client_secret: 'cs', code: 'code-1', redirect_uri: 'https://host/cb' });
  await assert.rejects(
    () => api(() => refused('invalid_code')).client.exchange({ clientId: '1.2', clientSecret: 'cs', code: 'code-1', redirectUri: 'https://host/cb' }),
    (error: unknown) => error instanceof SlackRefused && error.code === 'invalid_code' && !error.message.includes('cs'),
  );
});

test('uninstall and delete count an app that is already gone as done', async () => {
  const creds = { clientId: '1.2', clientSecret: 'cs', botToken: 'xoxb-agent' };
  const { client, seen } = api(() => ok({}));
  assert.equal(await client.uninstall(creds), 'removed');
  assert.equal(seen[0]?.method, 'apps.uninstall');
  assert.equal(seen[0]?.authorization, 'Bearer xoxb-agent');
  assert.deepEqual(seen[0]?.body, { client_id: '1.2', client_secret: 'cs' });
  assert.equal(await api(() => refused('account_inactive')).client.uninstall(creds), 'absent');
  assert.equal(await api(() => refused('token_revoked')).client.uninstall(creds), 'absent');
  await assert.rejects(() => api(() => refused('invalid_client_id')).client.uninstall(creds), (error: unknown) =>
    error instanceof SlackRefused && error.code === 'invalid_client_id');

  const deleting = api(() => ok({}));
  assert.equal(await deleting.client.delete(TOKEN, 'A0C8APP'), 'deleted');
  assert.deepEqual(deleting.seen[0]?.body, { app_id: 'A0C8APP' });
  assert.equal(await api(() => refused('app_not_found')).client.delete(TOKEN, 'A0C8APP'), 'absent');
  await assert.rejects(() => api(() => refused('invalid_auth')).client.delete(TOKEN, 'A0C8APP'), (error: unknown) =>
    error instanceof SlackRefused && error.code === 'invalid_auth');
});
