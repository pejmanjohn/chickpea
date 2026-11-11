import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { createManagementAdapterFixture, type ManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const ORIGIN = 'http://localhost';
const SECRET = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 3)).toString('base64url');
const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata';

type Person = 'owner' | 'member';

function seed(f: ManagementAdapterFixture, backend: NodeBetterAuthBackend): void {
  const db = backend.database;
  const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T09:00:00.000Z`;
  const user = (id: string) => db.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
  ).run(id, id, `${id}@example.test`, at(1), at(1));
  const client = (clientId: string, name: string) => db.prepare(
    'INSERT INTO oauthClient (id, clientId, name, redirectUris, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(`row_${clientId}`, clientId, name, '["http://127.0.0.1:1/cb"]', at(1), at(1));
  const consent = (clientId: string, userId: string, day: number) => db.prepare(
    'INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(`consent_${clientId}_${userId}`, clientId, userId, '["chickpea:workspace"]', at(day), at(day));
  const refresh = (clientId: string, userId: string, day: number) => db.prepare(
    'INSERT INTO oauthRefreshToken (id, token, clientId, userId, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(`refresh_${clientId}_${userId}_${day}`, `token_${clientId}_${userId}_${day}`, clientId, userId,
    '2026-11-30T00:00:00.000Z', at(day), '["chickpea:workspace","offline_access"]');
  const owner = f.owner.binding.betterAuthUserId!;
  const member = f.admin.binding.betterAuthUserId!;
  user(owner);
  user(member);
  client(CLAUDE_CODE, 'Claude Code');
  client('client_tool', '‮Spreadsheet\u0007 helper');
  client('client_theirs', 'Codex');
  consent(CLAUDE_CODE, owner, 2);
  refresh(CLAUDE_CODE, owner, 3);
  consent('client_tool', owner, 20);
  consent('client_theirs', member, 21);
  refresh('client_theirs', member, 21);
}

async function harness(t: TestContext, options: { machine?: true } = {}) {
  const f = await createManagementAdapterFixture('connected-apps');
  const backend = new NodeBetterAuthBackend(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  t.after(() => {
    f.close();
    backend.close();
    usage.close();
  });
  seed(f, backend);
  await f.identity.updateMembershipAuthority({
    membershipId: f.admin.membership.id,
    role: 'member',
    actorMembershipId: f.owner.membership.id,
    authenticationSurface: 'better_auth',
    correlationId: 'connected_apps_member',
    reasonCode: 'connected_apps_member',
  });
  const people = { owner: f.owner, member: f.admin };
  const apps = {} as Record<Person, Hono>;
  for (const person of ['owner', 'member'] as const) {
    const principal: AuthPrincipal = {
      userId: people[person].user.id,
      membershipId: people[person].membership.id,
      organizationId: people[person].membership.organizationId,
      role: person,
      authenticatorKind: options.machine ? 'personal_token' : 'test_slack_session',
      credentialId: `credential_${person}`,
      correlationId: `request_${person}`,
      machine: options.machine === true,
    };
    const app = new Hono();
    app.route('/', createAdminRoutes({
      store: f.config,
      settings: f.settings,
      management: f.management,
      memory: f.memory,
      routines: f.routines,
      usage,
      betterAuthEnvironment: { backend, baseURL: ORIGIN, secret: SECRET },
      knownProviders: new Set(['local-stub']),
      ...testAdminAuthority(`token-${person}`, ORIGIN, f.identity, principal),
    }));
    apps[person] = app;
  }
  const list = async (person: Person) => {
    const response = await apps[person].request(`${ORIGIN}/admin/api/connected-apps`, {
      headers: testAdminHeaders(`token-${person}`),
    });
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() as Record<string, unknown> };
  };
  const disconnect = async (person: Person, appId: unknown, headers: Record<string, string> = {}) => {
    const response = await apps[person].request(`${ORIGIN}/admin/api/connected-apps/disconnect`, {
      method: 'POST',
      headers: testAdminHeaders(`token-${person}`, { 'content-type': 'application/json', ...headers }),
      body: JSON.stringify({ appId }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const grants = (clientId: string) => {
    const count = (table: string) => Number((backend.database.prepare(
      `SELECT count(*) AS n FROM ${table} WHERE clientId = ?`,
    ).get(clientId) as { n: number }).n);
    return { consents: count('oauthConsent'), refreshTokens: count('oauthRefreshToken') };
  };
  return { list, disconnect, grants };
}

test('a person lists only their own connected apps, with nothing but name and dates', async (t) => {
  const { list } = await harness(t);
  const owner = await list('owner');
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.equal(owner.cache, 'no-store');
  assert.deepEqual(owner.body, {
    apps: [
      { appId: 'client_tool', name: 'Spreadsheet helper', nameFromApp: true, connectedAt: '2026-10-20T09:00:00.000Z', lastActiveAt: null },
      { appId: CLAUDE_CODE, name: 'Claude Code', connectedAt: '2026-10-02T09:00:00.000Z', lastActiveAt: '2026-10-03T09:00:00.000Z' },
    ],
  });
  assert.deepEqual((await list('member')).body, {
    // Registered as "Codex" under an unknown client ID: the app's own claim, never Chickpea's word.
    apps: [{ appId: 'client_theirs', name: 'Codex', nameFromApp: true, connectedAt: '2026-10-21T09:00:00.000Z', lastActiveAt: '2026-10-21T09:00:00.000Z' }],
  });
});

test('Disconnect revokes the app\'s consent and tokens, and a repeat finds nothing', async (t) => {
  const { list, disconnect, grants } = await harness(t);
  assert.deepEqual(grants(CLAUDE_CODE), { consents: 1, refreshTokens: 1 });
  const done = await disconnect('owner', CLAUDE_CODE);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body, { name: 'Claude Code' });
  assert.deepEqual(grants(CLAUDE_CODE), { consents: 0, refreshTokens: 0 });
  assert.deepEqual(((await list('owner')).body.apps as Array<{ appId: string }>).map(({ appId }) => appId), ['client_tool']);
  assert.deepEqual(await disconnect('owner', CLAUDE_CODE), { status: 404, body: { error: 'not_found' } });
});

test('another member\'s app cannot be disconnected through the page', async (t) => {
  const { list, disconnect, grants } = await harness(t);
  assert.deepEqual(await disconnect('owner', 'client_theirs'), { status: 404, body: { error: 'not_found' } });
  assert.deepEqual(await disconnect('member', CLAUDE_CODE), { status: 404, body: { error: 'not_found' } });
  assert.deepEqual(grants('client_theirs'), { consents: 1, refreshTokens: 1 });
  assert.deepEqual(grants(CLAUDE_CODE), { consents: 1, refreshTokens: 1 });
  assert.deepEqual(((await list('member')).body.apps as Array<{ appId: string }>).map(({ appId }) => appId), ['client_theirs']);

  assert.deepEqual(await disconnect('member', 'client_theirs'), { status: 200, body: { name: 'Codex', nameFromApp: true } });
  assert.deepEqual(grants('client_theirs'), { consents: 0, refreshTokens: 0 });
  assert.deepEqual(grants(CLAUDE_CODE), { consents: 1, refreshTokens: 1 });
});

test('Disconnect refuses a cross-site request and a form post, as every Admin write does', async (t) => {
  const { disconnect, grants } = await harness(t);
  assert.equal((await disconnect('owner', CLAUDE_CODE, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await disconnect('owner', CLAUDE_CODE, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await disconnect('owner', CLAUDE_CODE, { 'content-type': 'text/plain' })).status, 415);
  assert.deepEqual(grants(CLAUDE_CODE), { consents: 1, refreshTokens: 1 });
  assert.deepEqual(await disconnect('owner', ''), { status: 400, body: { error: 'invalid_request' } });
});

test('a personal token can neither list nor disconnect connected apps', async (t) => {
  const { list, disconnect, grants } = await harness(t, { machine: true });
  assert.equal((await list('owner')).status, 403);
  assert.equal((await disconnect('owner', CLAUDE_CODE)).status, 403);
  assert.deepEqual(grants(CLAUDE_CODE), { consents: 1, refreshTokens: 1 });
});
