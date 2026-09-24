import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  environmentSeedResponse,
  parseSeedRequest,
  type EnvironmentSeedDependencies,
  type SeedOwner,
} from '../src/admin/environment-seed.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';

const SEED_TOKEN = 'S'.repeat(43);
const laneEnv = { CHICKPEA_ENV_TARGET: 'cobalt', CHICKPEA_ENV_SEED_TOKEN: SEED_TOKEN } as unknown as PlatformEnv;
const owner: SeedOwner = {
  workspaceId: 'T123',
  principal: {
    userId: 'user_owner', membershipId: 'membership_owner', organizationId: 'org_1', role: 'owner',
    authenticatorKind: 'environment_seed', credentialId: 'environment_seed', correlationId: 'seed_test', machine: true,
  },
};

function dependencies(overrides: Partial<EnvironmentSeedDependencies> = {}) {
  const created: Array<{ presetId: string; fields: Record<string, string> }> = [];
  const deps: EnvironmentSeedDependencies = {
    owner: async () => owner,
    agentState: async (agentId) => agentId === 'qa-agent' ? 'ready' : agentId === 'off-agent' ? 'inactive' : 'missing',
    existingConnection: async () => undefined,
    createConnection: async ({ preset, fields }) => {
      created.push({ presetId: preset.id, fields });
      return `connection_${preset.id}`;
    },
    adminSetupUrl: ({ agentId, presetId }) => `https://lane.example/admin/agents/${agentId}/connections/new/${presetId}/team`,
    ...overrides,
  };
  return { deps, created };
}

async function seed(body: unknown, options: { env?: PlatformEnv; authorization?: string; deps?: EnvironmentSeedDependencies } = {}) {
  const response = await environmentSeedResponse({
    authorization: options.authorization ?? `Bearer ${SEED_TOKEN}`,
    env: options.env ?? laneEnv,
    readBody: async () => typeof body === 'string' ? body : JSON.stringify(body),
    dependencies: options.deps ?? dependencies().deps,
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test('answers an empty 404 without the lane seed token or outside a QA target', async () => {
  const body = { agentId: 'qa-agent', connections: [{ connector: 'asana', credential: 'x' }] };
  for (const options of [
    { authorization: '' },
    { authorization: `Bearer ${'W'.repeat(43)}` },
    { env: { CHICKPEA_ENV_SEED_TOKEN: SEED_TOKEN } as unknown as PlatformEnv },
    { env: { CHICKPEA_ENV_TARGET: 'production', CHICKPEA_ENV_SEED_TOKEN: SEED_TOKEN } as unknown as PlatformEnv },
    { env: { CHICKPEA_ENV_TARGET: 'cobalt' } as unknown as PlatformEnv },
  ]) {
    const { deps, created } = dependencies();
    const result = await seed(body, { ...options, deps });
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, {});
    assert.equal(created.length, 0);
  }
});

test('creates token connectors, reports present ones, and returns setup links for consent connectors', async () => {
  const { deps, created } = dependencies({
    existingConnection: async ({ presetId }) => presetId === 'stripe' ? 'connection_existing' : undefined,
  });
  const result = await seed({
    agentId: 'qa-agent',
    connections: [
      { connector: 'asana', credential: 'asana-secret-token' },
      { connector: 'stripe', credential: 'sk_test_x' },
      { connector: 'linear' },
      { connector: 'gmail' },
      { connector: 'monday' },
      { connector: 'no-such-connector' },
    ],
  }, { deps });
  assert.equal(result.status, 200);
  const byConnector = Object.fromEntries(result.body.connections.map((entry: { connector: string }) => [entry.connector, entry]));
  assert.equal(byConnector.asana.status, 'created');
  assert.equal(byConnector.asana.connectionId, 'connection_asana');
  assert.equal(byConnector.stripe.status, 'present');
  assert.equal(byConnector.linear.status, 'needs_consent');
  assert.match(byConnector.linear.adminUrl, /\/connections\/new\/linear\/team$/);
  assert.equal(byConnector.gmail.status, 'needs_consent');
  assert.equal(byConnector.monday.status, 'missing_credential');
  assert.equal(byConnector['no-such-connector'].status, 'unknown_connector');
  assert.deepEqual(created, [{ presetId: 'asana', fields: { credential: 'asana-secret-token' } }]);
  assert.doesNotMatch(JSON.stringify(result.body), /asana-secret-token|sk_test_x/);
});

test('reports failures as codes without echoing provider text or credentials', async () => {
  const { deps } = dependencies({
    createConnection: async () => { throw new Error('upstream said: token sk_live_leak is invalid'); },
  });
  const coded = dependencies({ createConnection: async () => { throw new Error('credential_required'); } });
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  let leaked: Awaited<ReturnType<typeof seed>>;
  try {
    leaked = await seed({ agentId: 'qa-agent', connections: [{ connector: 'asana', credential: 'sk_live_leak' }] }, { deps });
  } finally {
    console.error = originalError;
  }
  assert.match(logged.join('\n'), /environment seed connection failed.*"presetId":"asana".*token \[credential\] is invalid/);
  assert.doesNotMatch(logged.join('\n'), /sk_live_leak/);
  assert.equal(leaked.body.connections[0].status, 'failed');
  assert.equal(leaked.body.connections[0].error, 'connection_failed');
  assert.doesNotMatch(JSON.stringify(leaked.body), /sk_live_leak/);
  const code = await seed({ agentId: 'qa-agent', connections: [{ connector: 'asana', credential: 'x' }] }, { deps: coded.deps });
  assert.equal(code.body.connections[0].error, 'credential_required');
});

test('refuses malformed requests, an unknown Agent, and a missing owner', async () => {
  assert.equal((await seed('{nope')).status, 400);
  assert.equal((await seed({ agentId: 'Bad Agent', connections: [{ connector: 'asana' }] })).status, 400);
  assert.equal((await seed({ agentId: 'qa-agent', connections: [] })).status, 400);
  assert.equal((await seed({ agentId: 'qa-agent', connections: [{ connector: 'asana', fields: { credential: 'x' } }] })).status, 400);
  const unknownAgent = await seed({ agentId: 'other-agent', connections: [{ connector: 'asana', credential: 'x' }] });
  assert.equal(unknownAgent.status, 404);
  assert.equal(unknownAgent.body.error, 'unknown_agent');
  const inactive = await seed({ agentId: 'off-agent', connections: [{ connector: 'asana', credential: 'x' }] });
  assert.equal(inactive.status, 409);
  assert.equal(inactive.body.error, 'agent_inactive');
  const { deps } = dependencies({ owner: async () => undefined });
  assert.equal((await seed({ agentId: 'qa-agent', connections: [{ connector: 'asana', credential: 'x' }] }, { deps })).status, 503);
  assert.equal(parseSeedRequest('x'.repeat(600 * 1024)), undefined);
});
