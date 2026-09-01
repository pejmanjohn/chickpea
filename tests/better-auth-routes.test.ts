import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBetterAuthPublicHandler } from '../src/auth/better-auth-routes.ts';
import { createBetterAuthRuntimeRoutes } from '../src/auth/better-auth-runtime.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const ORIGIN = 'https://chickpea.example';
const SECRET = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => (index * 53 + 17) % 256))
  .toString('base64url');

test('public Better Auth boundary exposes only active-session lookup and sign-out', async () => {
  const backend = new NodeBetterAuthBackend(':memory:');
  const handler = createBetterAuthPublicHandler({
    backend,
    baseURL: ORIGIN,
    secret: SECRET,
  });

  const session = await handler(new Request(`${ORIGIN}/api/auth/get-session`));
  assert.equal(session.status, 200);
  assert.equal(await session.json(), null);

  const logout = await handler(jsonRequest('/api/auth/sign-out', {}));
  assert.equal(logout.status, 200);

  for (const probe of [
    ['/api/auth/sign-in/email', { email: 'owner@example.com', password: 'not-used' }],
    ['/api/auth/sign-up/email', { email: 'owner@example.com', password: 'not-used' }],
    ['/api/auth/sign-in/social', { provider: 'slack', callbackURL: 'https://attacker.example' }],
    ['/api/auth/request-sign-up', { requestSignUp: true }],
    ['/api/auth/organization/create', { name: 'Attacker' }],
    ['/api/auth/chickpea-private/issue-session', { operationId: 'browser-selected' }],
  ] as const) {
    const response = await handler(jsonRequest(probe[0], probe[1]));
    assert.equal(response.status, 404, probe[0]);
    assert.equal(response.headers.has('set-cookie'), false, probe[0]);
  }

  const genericCallback = await handler(new Request(
    `${ORIGIN}/api/auth/callback/slack?code=redacted&state=redacted`,
  ));
  assert.equal(genericCallback.status, 404);
  assert.equal(genericCallback.headers.has('set-cookie'), false);
  backend.close();
});

test('public sign-out mutation boundary rejects origin and content-type ambiguity', async () => {
  const backend = new NodeBetterAuthBackend(':memory:');
  const handler = createBetterAuthPublicHandler({
    backend,
    baseURL: ORIGIN,
    secret: SECRET,
  });

  const crossOrigin = await handler(jsonRequest('/api/auth/sign-out', {}, {
    origin: 'https://attacker.example',
  }));
  assert.equal(crossOrigin.status, 403);

  const form = await handler(new Request(`${ORIGIN}/api/auth/sign-out`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'signout=true',
  }));
  assert.equal(form.status, 415);
  backend.close();
});

test('runtime keeps every Better Auth endpoint dark while unconfigured', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  await identity.ensureAuthControl();
  const app = createBetterAuthRuntimeRoutes({ identity, authSecret: '0'.repeat(64) });
  for (const path of [
    '/api/auth/get-session',
    '/api/auth/sign-in/email',
    '/api/auth/sign-up/email',
    '/api/auth/sign-in/slack',
    '/api/auth/callback/slack',
    '/api/auth/chickpea-private/issue-session',
  ]) {
    const response = await app.request(`${ORIGIN}${path}`);
    assert.equal(response.status, 404, path);
  }
  identity.close();
});

// Every other unauthenticated POST surface caps its body before buffering.
// This one is reachable by any anonymous client whenever the install is in
// Slack auth is active, so an uncapped body would be free memory pressure.
test('the unauthenticated auth routes cap the request body before buffering it', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  await identity.ensureAuthControl();
  const app = createBetterAuthRuntimeRoutes({ identity, authSecret: '0'.repeat(64) });

  // Streamed with no content-length, so the cap cannot be satisfied by
  // trusting a header the client controls.
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 8; index += 1) {
        controller.enqueue(new Uint8Array(16 * 1024));
      }
      controller.close();
    },
  });
  const response = await app.request(new Request(`${ORIGIN}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: oversized,
    // @ts-expect-error -- undici requires duplex for a streaming body
    duplex: 'half',
  }));
  assert.equal(response.status, 413);

  const falseLength = await app.request(new Request(`${ORIGIN}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'content-length': '1',
    },
    body: 'x'.repeat(32 * 1024 + 1),
  }));
  assert.equal(falseLength.status, 413);
  identity.close();
});

test('runtime DCR rate limits persist across fresh per-request handlers', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    await createSlackOwner(identity, { suffix: 'runtime-dcr' });
    const control = await identity.getAuthControl();
    assert.ok(control);
    await identity.updateAuthControl({
      expectedRevision: control.revision,
      canonicalAdminOrigin: ORIGIN,
    });
    const app = createBetterAuthRuntimeRoutes({
      identity,
      environment: {
        backend,
        baseURL: ORIGIN,
        secret: SECRET,
      },
    });
    const registration = {
      application_type: 'native',
      client_name: 'Codex',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: ['http://127.0.0.1:47321/callback'],
      response_types: ['code'],
      scope: 'chickpea:workspace',
      token_endpoint_auth_method: 'none',
    };
    for (let index = 0; index < 20; index += 1) {
      const response = await app.request(jsonRequest(
        '/api/auth/oauth2/register',
        { ...registration, client_name: `Codex ${index}` },
      ));
      assert.equal(response.status, 201, `registration ${index}: ${await response.clone().text()}`);
    }
    const limited = await app.request(jsonRequest(
      '/api/auth/oauth2/register',
      { ...registration, client_name: 'Codex limited' },
    ));
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'registration_rate_limited' });
  } finally {
    backend.close();
    identity.close();
  }
});

function jsonRequest(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  const encoded = JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(encoded)),
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: encoded,
  });
}
