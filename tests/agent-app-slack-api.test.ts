import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AmbiguousEffect,
  SlackRefused,
  SlackUnavailable,
  createAgentAppSlackApi,
} from '../src/slack/agent-apps/slack-api.ts';
import { AGENT_APP_BOT_EVENTS, agentAppCreateManifest, buildSlackAppManifest } from '../src/slack/app-manifest.ts';
import { AGENT_APP_BOT_SCOPES } from '../src/slack/scopes.ts';
import { slackManifestRefusal } from './helpers/slack-manifest-rules.ts';

const TOKEN = 'xoxe.xoxp-1-config-access-token';
const AGENT = {
  appName: 'Support', botDisplayName: 'support', description: 'Support helps customers.',
  redirectUri: 'https://cloud.test/slack/agent-apps/callback', scopes: AGENT_APP_BOT_SCOPES, events: AGENT_APP_BOT_EVENTS,
};
const CREATE_MANIFEST = agentAppCreateManifest(AGENT);
const MANIFEST = buildSlackAppManifest({
  kind: 'agent_app', ...AGENT, urls: { events: 'https://cloud.test/events', interactions: 'https://cloud.test/interactions' },
});

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

test('revoke sends only the token as a form field; one Slack already revoked is done, an expired one is refused', async () => {
  for (const token of ['xoxe.xoxp-1-old', 'xoxe-1-old']) {
    const { client, seen } = api(() => ok({ revoked: true }));
    await client.revoke(token);
    assert.equal(seen[0]?.method, 'auth.revoke');
    assert.equal(seen[0]?.authorization, null, 'no credential but the token');
    assert.equal(seen[0]?.contentType, 'application/x-www-form-urlencoded; charset=utf-8');
    assert.deepEqual(seen[0]?.body, { token });
  }
  await api(() => refused('token_revoked')).client.revoke('xoxe-1-old');

  await assert.rejects(() => api(() => refused('token_expired')).client.revoke('xoxe.xoxp-1-old'), (error: unknown) =>
    error instanceof SlackRefused && error.code === 'token_expired' && !error.message.includes('xoxe'));
  await assert.rejects(() => api(() => { throw new TypeError('fetch failed'); }).client.revoke('xoxe-1-old'), (error: unknown) =>
    error instanceof SlackUnavailable && error.reason === 'network_error');
  await assert.rejects(() => api(() => refused('internal_error', 500)).client.revoke('xoxe-1-old'), SlackUnavailable);
  await assert.rejects(() => api(() => ok({ revoked: false })).client.revoke('xoxe-1-old'), (error: unknown) =>
    error instanceof SlackUnavailable && error.reason === 'invalid_slack_response', 'only revoked: true is a revoke');
});

// Defect caught: a token call with no time limit holding the Owner's request, so a removal cut short keeps a stored
// copy whose refresh token is spent.
test('rotate and revoke stop waiting after a time limit and read that as Slack not answering', async () => {
  for (const call of [
    (client: ReturnType<typeof api>['client']) => client.rotate('xoxe-1-old'),
    (client: ReturnType<typeof api>['client']) => client.revoke('xoxe-1-old'),
  ]) {
    let signal: AbortSignal | null | undefined;
    const client = createAgentAppSlackApi({
      apiBaseUrl: 'https://slack.test/api/',
      fetch: async (_input, init) => {
        signal = init?.signal;
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    });
    await assert.rejects(() => call(client), (error: unknown) => error instanceof SlackUnavailable && error.reason === 'timeout');
    assert.ok(signal instanceof AbortSignal && !signal.aborted, 'each call carries its own time limit');
  }
});

test('create carries the manifest under the configuration token and tells a refusal from an unknown answer', async () => {
  const { client, seen } = api((request) => {
    const refusal = slackManifestRefusal((request.body as { manifest?: unknown }).manifest);
    return refusal ? Response.json(refusal) : ok({
      app_id: 'A0C8APP',
      credentials: { client_id: '1.2', client_secret: 'cs', signing_secret: 'ss', verification_token: 'vt' },
    });
  });
  assert.deepEqual(await client.create(TOKEN, CREATE_MANIFEST), { appId: 'A0C8APP', clientId: '1.2', clientSecret: 'cs', signingSecret: 'ss' });
  assert.equal(seen[0]?.method, 'apps.manifest.create');
  assert.equal(seen[0]?.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(seen[0]?.body, { manifest: CREATE_MANIFEST });

  const noResult = (error: unknown): boolean => error instanceof Error && !error.message.includes(TOKEN);
  await assert.rejects(() => api(() => refused('invalid_manifest')).client.create(TOKEN, CREATE_MANIFEST), (error: unknown) =>
    error instanceof SlackRefused && error.code === 'invalid_manifest' && noResult(error));
  await assert.rejects(() => api(() => refused('ratelimited', 429)).client.create(TOKEN, CREATE_MANIFEST), (error: unknown) =>
    error instanceof SlackRefused && error.code === 'ratelimited');
  await assert.rejects(() => api(() => refused('internal_error', 500)).client.create(TOKEN, CREATE_MANIFEST), (error: unknown) =>
    error instanceof AmbiguousEffect && error.reason === 'internal_error' && noResult(error));
  await assert.rejects(() => api(() => { throw new TypeError('fetch failed'); }).client.create(TOKEN, CREATE_MANIFEST), (error: unknown) =>
    error instanceof AmbiguousEffect && error.reason === 'network_error');
  await assert.rejects(() => api(() => new Response('<html>', { status: 200 })).client.create(TOKEN, CREATE_MANIFEST), (error: unknown) =>
    error instanceof AmbiguousEffect && error.reason === 'invalid_slack_response');
  await assert.rejects(() => api(() => ok({ app_id: 'A0C8APP' })).client.create(TOKEN, CREATE_MANIFEST), (error: unknown) =>
    error instanceof AmbiguousEffect && error.reason === 'incomplete_slack_success');
});

test("a refusal carries Slack's code and its errors list, bounded and without URLs", async () => {
  const long = 'x'.repeat(500);
  const answer = () => Response.json({
    ok: false,
    error: 'invalid_manifest',
    errors: [
      { message: 'Event Subscription requires either Request URL or Socket Mode Enabled', pointer: '/settings/event_subscriptions' },
      { message: "Your URL https://cloud.test/channels/slack/agent-apps/inst/A0C8APP/path-token/events didn't respond\nin time", pointer: '/settings/event_subscriptions/request_url' },
      { message: long, pointer: long },
      { message: 7 },
      'not an object',
      { message: 'the sixth is dropped', pointer: '/sixth' },
    ],
  });
  const bounded = [
    { message: 'Event Subscription requires either Request URL or Socket Mode Enabled', pointer: '/settings/event_subscriptions' },
    { message: "Your URL <url> didn't respond in time", pointer: '/settings/event_subscriptions/request_url' },
    { message: 'x'.repeat(200), pointer: 'x'.repeat(200) },
    { message: '', pointer: '' },
    { message: '', pointer: '' },
  ];
  const carries = (method: string) => (error: unknown) =>
    error instanceof SlackRefused && error.method === method && error.code === 'invalid_manifest' &&
    JSON.stringify(error.errors) === JSON.stringify(bounded);
  await assert.rejects(() => api(answer).client.create(TOKEN, CREATE_MANIFEST), carries('apps.manifest.create'));
  await assert.rejects(() => api(answer).client.update(TOKEN, 'A0C8APP', MANIFEST), carries('apps.manifest.update'));
  await assert.rejects(() => api(() => refused('invalid_auth')).client.create(TOKEN, CREATE_MANIFEST), (error: unknown) =>
    error instanceof SlackRefused && error.code === 'invalid_auth' && error.errors.length === 0);
});

test('update names the app and the manifest, and a refusal is a refusal', async () => {
  const { client, seen } = api(() => ok({}));
  await client.update(TOKEN, 'A0C8APP', MANIFEST);
  assert.equal(seen[0]?.method, 'apps.manifest.update');
  assert.deepEqual(seen[0]?.body, { app_id: 'A0C8APP', manifest: MANIFEST });
  await assert.rejects(() => api(() => refused('invalid_manifest')).client.update(TOKEN, 'A0C8APP', MANIFEST), (error: unknown) =>
    error instanceof SlackRefused && error.code === 'invalid_manifest');
});

// Defect caught: an export with no usable bot scopes read as "no permissions", so the update that follows it sends an
// empty list and drops every permission the app's definition holds.
test("the export answers the app's bot scopes, and an answer without any is no answer", async () => {
  const { client, seen } = api(() => ok({ manifest: { oauth_config: { scopes: { bot: ['chat:write', 'im:history'] } } } }));
  assert.deepEqual(await client.definedBotScopes(TOKEN, 'A0C8APP'), ['chat:write', 'im:history']);
  assert.deepEqual(seen.map(({ method, authorization, body }) => [method, authorization, body]), [
    ['apps.manifest.export', `Bearer ${TOKEN}`, { app_id: 'A0C8APP' }],
  ]);
  for (const manifest of [
    undefined, {}, { oauth_config: {} }, { oauth_config: { scopes: {} } }, { oauth_config: { scopes: { bot: [] } } },
    { oauth_config: { scopes: { bot: 'chat:write' } } }, { oauth_config: { scopes: { bot: ['chat:write', 7] } } },
    { oauth_config: { scopes: { bot: [''] } } },
  ]) {
    await assert.rejects(() => api(() => ok({ manifest })).client.definedBotScopes(TOKEN, 'A0C8APP'), (error: unknown) =>
      error instanceof SlackUnavailable && error.reason === 'invalid_slack_response', JSON.stringify(manifest));
  }
  await assert.rejects(() => api(() => refused('app_not_found')).client.definedBotScopes(TOKEN, 'A0C8APP'), (error: unknown) =>
    error instanceof SlackRefused && error.method === 'apps.manifest.export' && error.code === 'app_not_found');
});

test('the icon upload is multipart, and a refusal is told from an outage', async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const { client, seen } = api(() => ok({}));
  await client.setIcon(TOKEN, 'A0C8APP', png);
  assert.equal(seen[0]?.method, 'apps.icon.set');
  assert.equal(seen[0]?.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(seen[0]?.body, { app_id: 'A0C8APP', file: 'blob:4' });
  await assert.rejects(() => api(() => refused('invalid_image')).client.setIcon(TOKEN, 'A0C8APP', png), (error: unknown) =>
    error instanceof SlackRefused && error.code === 'invalid_image');
  await assert.rejects(() => api(() => refused('service_unavailable', 503)).client.setIcon(TOKEN, 'A0C8APP', png), SlackUnavailable);
  await assert.rejects(() => api(() => { throw new TypeError('fetch failed'); }).client.setIcon(TOKEN, 'A0C8APP', png), SlackUnavailable);
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

test("auth.test with an app's own bot token says whether Slack still accepts it, and throws for any other answer", async () => {
  const { client, seen } = api(() => ok({ user_id: 'UBOT1' }));
  assert.equal(await client.botInstalled('xoxb-agent'), true);
  assert.equal(seen[0]?.method, 'auth.test');
  assert.equal(seen[0]?.authorization, 'Bearer xoxb-agent');
  for (const code of ['token_revoked', 'account_inactive', 'invalid_auth']) {
    assert.equal(await api(() => refused(code)).client.botInstalled('xoxb-agent'), false, code);
  }
  await assert.rejects(() => api(() => refused('ratelimited', 429)).client.botInstalled('xoxb-agent'), SlackRefused);
  await assert.rejects(() => api(() => refused('internal_error', 500)).client.botInstalled('xoxb-agent'), SlackUnavailable);
});
