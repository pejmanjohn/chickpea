import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBetterAuthPublicHandler } from '../src/auth/better-auth-routes.ts';
import { createBetterAuthRuntimeRoutes } from '../src/auth/better-auth-runtime.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

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
  const app = createBetterAuthRuntimeRoutes({ identity, recoveryToken: '0'.repeat(64) });
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
