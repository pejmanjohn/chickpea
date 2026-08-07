import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBetterAuth } from '../src/auth/better-auth.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { nativePasswordPrimitive } from '../src/auth/password.ts';

const ORIGIN = 'https://chickpea.example';
const SECRET = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => (index * 37 + 11) % 256))
  .toString('base64url');

test('reviewed Better Auth migrations are idempotent and omit database rate-limit state', async () => {
  const backend = new NodeBetterAuthBackend(':memory:');
  const tables = backend.database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all().map((row) => String((row as { name: unknown }).name));

  for (const table of ['account', 'invitation', 'member', 'organization', 'session', 'user']) {
    assert.equal(tables.includes(table), true, `missing ${table}`);
  }
  assert.equal(tables.includes('rateLimit'), false);
  assert.equal(
    backend.database.prepare('SELECT count(*) AS count FROM chickpea_better_auth_migrations').get()
      ?.count,
    1,
  );
  assert.equal(await backend.hasPasswordCredential('owner@example.com'), false);

  const auth = createBetterAuth({
    backend,
    baseURL: ORIGIN,
    secret: SECRET,
    password: nativePasswordPrimitive(),
    allowSignUp: true,
  });
  const response = await auth.handler(jsonRequest('/api/auth/sign-up/email', {
    email: 'Owner@Example.com',
    name: 'Owner',
    password: 'several unrelated words 5729',
  }));
  assert.equal(response.status, 200, await response.text());
  assert.equal(await backend.hasPasswordCredential('owner@example.com'), true);
  assert.equal(await backend.hasPasswordCredential('OWNER@EXAMPLE.COM'), true);

  const session = backend.database.prepare(
    'SELECT token, expiresAt, absoluteExpiresAt FROM session LIMIT 1',
  ).get() as { token: string; expiresAt: number; absoluteExpiresAt: number };
  assert.equal(session.absoluteExpiresAt > session.expiresAt, true);
  backend.database.prepare('UPDATE session SET absoluteExpiresAt = ? WHERE token = ?')
    .run(Date.now() - 1, session.token);
  const expired = await auth.handler(new Request(`${ORIGIN}/api/auth/get-session`, {
    headers: { cookie: cookieHeader(response.headers.get('set-cookie')) },
  }));
  assert.equal(await expired.json(), null);
  assert.equal(backend.database.prepare('SELECT count(*) AS count FROM session').get()?.count, 0);
  backend.close();
});

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  const encoded = JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(encoded)),
      'sec-fetch-site': 'same-origin',
    },
    body: encoded,
  });
}

function cookieHeader(setCookie: string | null): string {
  return (setCookie ?? '').split(';', 1)[0] ?? '';
}
