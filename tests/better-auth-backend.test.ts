import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { createBetterAuth, createBetterAuthOptions } from '../src/auth/better-auth.ts';
import { applyBetterAuthMigrations, NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';

const ORIGIN = 'https://chickpea.example';
const SECRET = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => (index * 37 + 11) % 256))
  .toString('base64url');

test('reviewed Better Auth migrations are idempotent and Slack-only authentication stays passwordless', async () => {
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
    2,
  );
  assert.match(String(
    backend.database.prepare('SELECT digest FROM chickpea_better_auth_migrations').get()?.digest,
  ), /^[a-f0-9]{64}$/);
  const input = {
    backend,
    baseURL: ORIGIN,
    secret: SECRET,
  };
  const options = createBetterAuthOptions(input);
  assert.deepEqual(options.emailAndPassword, { enabled: false, disableSignUp: true });
  assert.deepEqual(options.account?.accountLinking, {
    enabled: false,
    disableImplicitLinking: true,
    trustedProviders: [],
  });
  const auth = createBetterAuth(input);
  const response = await auth.handler(jsonRequest('/api/auth/sign-up/email', {
    email: 'Owner@Example.com',
    name: 'Owner',
    password: 'several unrelated words 5729',
  }));
  assert.equal(response.status, 400, await response.text());
  assert.equal(response.headers.has('set-cookie'), false);
  assert.equal(backend.database.prepare('SELECT count(*) AS count FROM account').get()?.count, 0);
  assert.equal(backend.database.prepare('SELECT count(*) AS count FROM session').get()?.count, 0);
  assert.equal(backend.database.prepare('SELECT count(*) AS count FROM user').get()?.count, 0);
  backend.close();
});

test('Node Better Auth bootstrap refuses legacy ledgers and non-empty authority', () => {
  for (const setup of [
    (database: DatabaseSync) => {
      database.exec(`CREATE TABLE chickpea_better_auth_migrations (
        name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
      )`);
      database.prepare(
        'INSERT INTO chickpea_better_auth_migrations (name, applied_at) VALUES (?, ?)',
      ).run('0001_better_auth.sql', 1);
    },
    (database: DatabaseSync) => database.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY)'),
  ]) {
    const database = new DatabaseSync(':memory:');
    try {
      setup(database);
      assert.throws(
        () => applyBetterAuthMigrations(database),
        /incompatible Better Auth 0001; use a fresh empty database/,
      );
    } finally {
      database.close();
    }
  }
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
