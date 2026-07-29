import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  OPENAI_SUBSCRIPTION_CLIENT_ID,
  OPENAI_SUBSCRIPTION_ENDPOINTS,
  OPENAI_SUBSCRIPTION_MODELS,
  OpenAiSubscriptionProtocolError,
  buildOpenAiSubscriptionHeaders,
  exchangeOpenAiDeviceAuthorization,
  extractOpenAiSubscriptionAccountId,
  pollOpenAiDeviceAuthorization,
  refreshOpenAiSubscriptionToken,
  startOpenAiDeviceAuthorization,
} from '../src/openai-subscription/protocol.ts';

const fixtureRoot = new URL('./fixtures/openai-subscription/', import.meta.url);
const deviceStartFixture = JSON.parse(
  readFileSync(new URL('device-start.json', fixtureRoot), 'utf8'),
) as Record<string, unknown>;
const deviceApprovedFixture = JSON.parse(
  readFileSync(new URL('device-approved.json', fixtureRoot), 'utf8'),
) as Record<string, unknown>;

function jwt(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'fixture-signature',
  ].join('.');
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('device authorization follows the pinned OpenCode contract and exchanges tokens', async () => {
  const now = 1_800_000_000_000;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const idToken = jwt({
    iss: 'https://auth.openai.com',
    aud: OPENAI_SUBSCRIPTION_CLIENT_ID,
    exp: Math.floor(now / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-fixture' },
  });
  const responses = [
    jsonResponse(deviceStartFixture),
    jsonResponse({}, 403),
    jsonResponse(deviceApprovedFixture),
    jsonResponse({
      access_token: jwt({ exp: Math.floor(now / 1000) + 3600 }),
      refresh_token: 'refresh-fixture',
      id_token: idToken,
      expires_in: 3600,
    }),
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });
    const response = responses.shift();
    assert.ok(response, 'fixture fetch received an unexpected request');
    return response;
  };

  const pending = await startOpenAiDeviceAuthorization({ fetch: fetchImpl, now: () => now });
  assert.deepEqual(pending, {
    deviceAuthId: 'device-auth-fixture',
    userCode: 'CHICK-PEA',
    verificationUri: 'https://auth.openai.com/codex/device',
    intervalMs: 5000,
    expiresAt: now + 15 * 60 * 1000,
  });
  assert.deepEqual(await pollOpenAiDeviceAuthorization(pending, { fetch: fetchImpl }), {
    state: 'pending',
  });
  const approved = await pollOpenAiDeviceAuthorization(pending, { fetch: fetchImpl });
  assert.deepEqual(approved, {
    state: 'approved',
    authorizationCode: 'authorization-code-fixture',
    codeVerifier: 'code-verifier-fixture',
  });
  assert.equal(approved.state, 'approved');
  const bundle = await exchangeOpenAiDeviceAuthorization(approved, {
    fetch: fetchImpl,
    now: () => now,
  });
  assert.equal(bundle.accountId, 'account-fixture');
  assert.equal(bundle.refreshToken, 'refresh-fixture');
  assert.equal(bundle.expiresAt, now + 3600_000);

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      OPENAI_SUBSCRIPTION_ENDPOINTS.deviceStart,
      OPENAI_SUBSCRIPTION_ENDPOINTS.devicePoll,
      OPENAI_SUBSCRIPTION_ENDPOINTS.devicePoll,
      OPENAI_SUBSCRIPTION_ENDPOINTS.token,
    ],
  );
  const exchangeBody = String(requests[3]?.init?.body);
  assert.match(exchangeBody, /grant_type=authorization_code/);
  assert.match(exchangeBody, /code_verifier=code-verifier-fixture/);
  assert.match(exchangeBody, new RegExp(`client_id=${OPENAI_SUBSCRIPTION_CLIENT_ID}`));
});

test('refresh keeps the previous refresh token when OpenAI omits a replacement', async () => {
  const now = 1_800_000_000_000;
  const idToken = jwt({
    iss: 'https://auth.openai.com',
    aud: OPENAI_SUBSCRIPTION_CLIENT_ID,
    exp: Math.floor(now / 1000) + 3600,
    chatgpt_account_id: 'account-refresh',
  });
  const fetchImpl: typeof fetch = async () =>
    jsonResponse({ access_token: 'access-refreshed', id_token: idToken, expires_in: 600 });

  const bundle = await refreshOpenAiSubscriptionToken('refresh-existing', {
    fetch: fetchImpl,
    now: () => now,
  });
  assert.equal(bundle.refreshToken, 'refresh-existing');
  assert.equal(bundle.accountId, 'account-refresh');
  assert.equal(bundle.expiresAt, now + 600_000);
});

test('claim extraction rejects invalid issuer, audience, expiry, and account shapes', () => {
  const now = 1_800_000_000_000;
  const valid = {
    iss: 'https://auth.openai.com',
    aud: OPENAI_SUBSCRIPTION_CLIENT_ID,
    exp: Math.floor(now / 1000) + 60,
    chatgpt_account_id: 'account-valid',
  };
  assert.equal(extractOpenAiSubscriptionAccountId({ idToken: jwt(valid), now }), 'account-valid');
  assert.throws(
    () => extractOpenAiSubscriptionAccountId({ idToken: jwt({ ...valid, iss: 'https://evil.test' }), now }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionProtocolError && error.code === 'protocol_drift',
  );
  assert.throws(
    () => extractOpenAiSubscriptionAccountId({ idToken: jwt({ ...valid, aud: 'other-client' }), now }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionProtocolError && error.code === 'protocol_drift',
  );
  assert.throws(
    () => extractOpenAiSubscriptionAccountId({ idToken: jwt({ ...valid, exp: Math.floor(now / 1000) - 1 }), now }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionProtocolError && error.code === 'auth_reconnect_required',
  );
  assert.throws(
    () => extractOpenAiSubscriptionAccountId({ idToken: jwt({ ...valid, chatgpt_account_id: { id: 'bad' } }), now }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionProtocolError && error.code === 'protocol_drift',
  );
});

test('protocol maps safe failures and rejects redirects, oversized bodies, and bad content types', async () => {
  for (const [status, body, expected] of [
    [401, { error: 'unauthorized' }, 'auth_reconnect_required'],
    [403, { error: 'originator rejected' }, 'originator_rejected'],
    [403, { error: 'client rejected' }, 'client_rejected'],
    [403, { error: 'plan not entitled' }, 'entitlement_denied'],
    [429, { error: 'rate limit' }, 'subscription_quota_exhausted'],
    [500, { error: 'server error' }, 'provider_unavailable'],
  ] as const) {
    await assert.rejects(
      () =>
        startOpenAiDeviceAuthorization({
          fetch: async () => jsonResponse(body, status, { 'retry-after': '2' }),
        }),
      (error: unknown) =>
        error instanceof OpenAiSubscriptionProtocolError &&
        error.code === expected &&
        (status !== 429 || error.retryAfterMs === 2000),
    );
  }

  await assert.rejects(
    () =>
      startOpenAiDeviceAuthorization({
        fetch: async () =>
          new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
      }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionProtocolError && error.code === 'protocol_drift',
  );
  await assert.rejects(
    () =>
      startOpenAiDeviceAuthorization({
        fetch: async () => new Response('not json', { headers: { 'content-type': 'text/plain' } }),
      }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionProtocolError && error.code === 'invalid_response',
  );
  await assert.rejects(
    () =>
      startOpenAiDeviceAuthorization({
        fetch: async () => jsonResponse({ padding: 'x'.repeat(70_000) }),
      }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionProtocolError && error.code === 'invalid_response',
  );
});

test('subscription request headers override caller credentials and use a curated catalog', () => {
  const headers = buildOpenAiSubscriptionHeaders({
    accessToken: 'access-secret',
    accountId: 'account-secret',
    sessionId: 'session-random',
    headers: {
      authorization: 'Bearer caller-secret',
      'ChatGPT-Account-Id': 'caller-account',
      'x-request-id': 'safe-request-id',
    },
  });
  assert.equal(headers.get('authorization'), 'Bearer access-secret');
  assert.equal(headers.get('ChatGPT-Account-Id'), 'account-secret');
  assert.equal(headers.get('originator'), 'chickpea');
  assert.equal(headers.get('session-id'), 'session-random');
  assert.equal(headers.get('x-request-id'), 'safe-request-id');
  assert.deepEqual(OPENAI_SUBSCRIPTION_MODELS, [
    'gpt-5.3-codex-spark',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.5',
  ]);
});
