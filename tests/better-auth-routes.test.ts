import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBetterAuthPublicHandler } from '../src/auth/better-auth-routes.ts';
import { createBetterAuthRuntimeRoutes } from '../src/auth/better-auth-runtime.ts';
import { createBetterAuth } from '../src/auth/better-auth.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { nativePasswordPrimitive, type PasswordPrimitive } from '../src/auth/password.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const ORIGIN = 'https://chickpea.example';
const PASSWORD = 'several unrelated words 5729';
const SECRET = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => (index * 53 + 17) % 256))
  .toString('base64url');

test('public Better Auth boundary exposes only session login and logout with uniform failures', async () => {
  const backend = new NodeBetterAuthBackend(':memory:');
  const native = nativePasswordPrimitive();
  const privateAuth = createBetterAuth({
    backend,
    baseURL: ORIGIN,
    secret: SECRET,
    password: native,
    allowSignUp: true,
  });
  const signup = await privateAuth.handler(jsonRequest('/api/auth/sign-up/email', {
    email: 'owner@example.com',
    name: 'Owner',
    password: PASSWORD,
  }));
  assert.equal(signup.status, 200, await signup.text());

  let verifyCalls = 0;
  const measuredPassword: PasswordPrimitive = {
    hash: (value) => native.hash(value),
    verify: async (input) => {
      verifyCalls += 1;
      return native.verify(input);
    },
  };
  let allowLogin = true;
  let identityLimitChecks = 0;
  const handler = createBetterAuthPublicHandler({
    backend,
    baseURL: ORIGIN,
    secret: SECRET,
    password: measuredPassword,
    loginSourceAllowed: async () => allowLogin,
    loginIdentityAllowed: async () => {
      identityLimitChecks += 1;
      return allowLogin;
    },
    sourceKey: () => 'test-source',
  });

  const signupDenied = await handler(jsonRequest('/api/auth/sign-up/email', {
    email: 'second@example.com', name: 'Second', password: PASSWORD,
  }));
  assert.equal(signupDenied.status, 404);

  const wrong = await handler(jsonRequest('/api/auth/sign-in/email', {
    email: 'owner@example.com', password: 'incorrect unrelated words 9182',
  }));
  const wrongBody = await wrong.text();
  assert.equal(wrong.status, 401);
  assert.equal(verifyCalls, 1);

  const unknown = await handler(jsonRequest('/api/auth/sign-in/email', {
    email: 'unknown@example.com', password: 'incorrect unrelated words 9182',
  }));
  assert.equal(unknown.status, 401);
  assert.equal(await unknown.text(), wrongBody);
  assert.equal(verifyCalls, 2, 'unknown users must perform one dummy scrypt');
  assert.equal(identityLimitChecks, 1, 'unknown users must not allocate an identity limiter shard');

  allowLogin = false;
  const throttled = await handler(jsonRequest('/api/auth/sign-in/email', {
    email: 'owner@example.com', password: PASSWORD,
  }));
  assert.equal(throttled.status, 401);
  assert.equal(await throttled.text(), wrongBody);
  assert.equal(verifyCalls, 2, 'pre-throttled attempts must not consume KDF or database quota');
  allowLogin = true;

  const loggedIn = await handler(jsonRequest('/api/auth/sign-in/email', {
    email: 'owner@example.com', password: PASSWORD,
  }));
  assert.equal(loggedIn.status, 200, await loggedIn.clone().text());
  const cookie = loggedIn.headers.get('set-cookie');
  assert.match(cookie ?? '', /better-auth\.session_token=/);
  assert.match(cookie ?? '', /HttpOnly/i);
  assert.match(cookie ?? '', /Secure/i);

  const session = await handler(new Request(`${ORIGIN}/api/auth/get-session`, {
    headers: { cookie: cookieHeader(cookie) },
  }));
  assert.equal(session.status, 200);
  assert.equal((await session.json() as { user?: { email?: string } }).user?.email, 'owner@example.com');

  const logout = await handler(jsonRequest('/api/auth/sign-out', {}, {
    cookie: cookieHeader(cookie),
  }));
  assert.equal(logout.status, 200);
  backend.close();
});

test('public Better Auth mutation boundary rejects origin and content-type ambiguity', async () => {
  const backend = new NodeBetterAuthBackend(':memory:');
  const handler = createBetterAuthPublicHandler({
    backend,
    baseURL: ORIGIN,
    secret: SECRET,
    password: nativePasswordPrimitive(),
    loginSourceAllowed: async () => true,
    loginIdentityAllowed: async () => true,
    sourceKey: () => 'test-source',
  });

  const crossOrigin = await handler(jsonRequest('/api/auth/sign-in/email', {
    email: 'owner@example.com', password: PASSWORD,
  }, { origin: 'https://attacker.example' }));
  assert.equal(crossOrigin.status, 403);

  const form = await handler(new Request(`${ORIGIN}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=owner%40example.com',
  }));
  assert.equal(form.status, 415);
  backend.close();
});

test('runtime keeps every Better Auth endpoint dark until password mode commits', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  await identity.ensureAuthControl();
  const app = createBetterAuthRuntimeRoutes({ identity, recoveryToken: '0'.repeat(64) });
  for (const path of [
    '/api/auth/get-session',
    '/api/auth/sign-in/email',
    '/api/auth/sign-up/email',
    '/api/auth/admin/create-user',
  ]) {
    const response = await app.request(`${ORIGIN}${path}`);
    assert.equal(response.status, 404, path);
  }
  identity.close();
});

// Every other unauthenticated POST surface caps its body before buffering.
// This one is reachable by any anonymous client whenever the install is in
// password mode, so an uncapped body is free memory pressure.
test('the unauthenticated auth routes cap the request body before buffering it', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  await identity.ensureAuthControl();
  const app = createBetterAuthRuntimeRoutes({ identity, recoveryToken: '0'.repeat(64) });

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

function cookieHeader(setCookie: string | null): string {
  return (setCookie ?? '').split(';', 1)[0] ?? '';
}
