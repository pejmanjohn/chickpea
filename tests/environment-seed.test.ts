import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  environmentSeedResponse,
  parseSeedRequest,
  QA_FIXTURES_AGENT_ID,
  seedFingerprint,
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
  const created: Array<{ presetId: string; fields: Record<string, string>; agentId?: string }> = [];
  const replaced: Array<{ connectionId: string; fields: Record<string, string> }> = [];
  const fingerprints = new Map<string, string>();
  const agentsCreated: string[] = [];
  const deps: EnvironmentSeedDependencies = {
    owner: async () => owner,
    agentState: async (agentId) => agentId === 'qa-agent' ? 'ready' : agentId === 'off-agent' ? 'inactive' : 'missing',
    createFixturesAgent: async ({ id }) => { agentsCreated.push(id); },
    existingConnection: async () => undefined,
    createConnection: async ({ preset, fields }) => {
      created.push({ presetId: preset.id, fields });
      return `connection_${preset.id}`;
    },
    replaceConnection: async ({ connectionId, fields }) => { replaced.push({ connectionId, fields }); },
    recordFingerprint: async ({ connectionId, fingerprint }) => { fingerprints.set(connectionId, fingerprint); },
    adminSetupUrl: ({ agentId, presetId }) => `https://lane.example/admin/agents/${agentId}/connections/new/${presetId}/team`,
    ...overrides,
  };
  return { deps, created, replaced, fingerprints, agentsCreated };
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
    existingConnection: async ({ presetId }) => presetId === 'stripe'
      ? { connectionId: 'connection_existing', fingerprint: seedFingerprint('stripe', { credential: 'sk_test_x' }) }
      : undefined,
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

test('a reseed compares fingerprints: present when equal, stale when changed or unrecorded, replaced on request', async () => {
  const same = seedFingerprint('asana', { credential: 'asana-token-a' });
  assert.match(same, /^sha256:[0-9a-f]{16}$/);
  assert.notEqual(seedFingerprint('asana', { credential: 'asana-token-b' }), same);
  assert.notEqual(seedFingerprint('asana', { credential: 'asana-token-a', workspace: 'x' }), same);
  assert.equal(
    seedFingerprint('zendesk', { b: '2', a: '1', credential: 'c' }),
    seedFingerprint('zendesk', { credential: 'c', a: '1', b: '2' }),
  );

  const stored = new Map<string, { connectionId: string; fingerprint?: string }>([
    ['asana', { connectionId: 'connection_asana', fingerprint: same }],
    ['stripe', { connectionId: 'connection_stripe' }],
  ]);
  const harness = dependencies({ existingConnection: async ({ presetId }) => stored.get(presetId) });
  const body = (credential: string, replace?: boolean) => ({
    agentId: 'qa-agent',
    ...(replace === undefined ? {} : { replace }),
    connections: [{ connector: 'asana', credential }, { connector: 'stripe', credential: 'sk_test_y' }],
  });

  const unchanged = await seed(body('asana-token-a'), { deps: harness.deps });
  assert.equal(unchanged.body.connections[0].status, 'present');
  assert.equal(unchanged.body.connections[1].status, 'stale');
  assert.equal(unchanged.body.connections[1].reason, 'unrecorded');

  const rotated = await seed(body('asana-token-b'), { deps: harness.deps });
  assert.equal(rotated.body.connections[0].status, 'stale');
  assert.equal(rotated.body.connections[0].reason, 'changed');
  assert.equal(rotated.body.connections[0].connectionId, 'connection_asana');
  assert.equal(harness.replaced.length, 0);
  assert.equal(harness.created.length, 0);
  assert.equal(harness.fingerprints.size, 0);

  const replaced = await seed(body('asana-token-b', true), { deps: harness.deps });
  assert.deepEqual(replaced.body.connections.map((entry: { status: string }) => entry.status), ['replaced', 'replaced']);
  assert.deepEqual(harness.replaced, [
    { connectionId: 'connection_asana', fields: { credential: 'asana-token-b' } },
    { connectionId: 'connection_stripe', fields: { credential: 'sk_test_y' } },
  ]);
  assert.equal(harness.fingerprints.get('connection_asana'), seedFingerprint('asana', { credential: 'asana-token-b' }));
  assert.equal(harness.created.length, 0);
  assert.doesNotMatch(JSON.stringify([unchanged.body, rotated.body, replaced.body]), /asana-token|sk_test_y/);
});

test('a failed replace reports a code and records no new fingerprint', async () => {
  const harness = dependencies({
    existingConnection: async () => ({ connectionId: 'connection_asana', fingerprint: 'sha256:0000000000000000' }),
    replaceConnection: async () => { throw new Error('target_changed'); },
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await seed({ agentId: 'qa-agent', replace: true, connections: [{ connector: 'asana', credential: 'new' }] }, { deps: harness.deps });
    assert.equal(result.body.connections[0].status, 'failed');
    assert.equal(result.body.connections[0].error, 'target_changed');
  } finally {
    console.error = originalError;
  }
  assert.equal(harness.fingerprints.size, 0);
});

test('fixtures mode creates the standing fixtures Agent when missing and seeds onto it', async () => {
  const agents = new Set<string>();
  const harness = dependencies({
    agentState: async (agentId) => agents.has(agentId) ? 'ready' : 'missing',
    createFixturesAgent: async ({ id }) => { agents.add(id); },
  });
  const result = await seed({ fixtures: true, connections: [{ connector: 'asana', credential: 'fixture-token' }] }, { deps: harness.deps });
  assert.equal(result.status, 200);
  assert.equal(result.body.agentId, QA_FIXTURES_AGENT_ID);
  assert.equal(result.body.fixtures, true);
  assert.equal(result.body.connections[0].status, 'created');
  assert.deepEqual([...agents], [QA_FIXTURES_AGENT_ID]);

  const disabled = dependencies({ agentState: async () => 'inactive' });
  const refused = await seed({ fixtures: true, connections: [{ connector: 'asana', credential: 'x' }] }, { deps: disabled.deps });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'agent_inactive');
  assert.deepEqual(disabled.agentsCreated, []);

  // A named Agent is never created on demand.
  const named = dependencies();
  assert.equal((await seed({ agentId: 'other-agent', connections: [{ connector: 'asana', credential: 'x' }] }, { deps: named.deps })).status, 404);
  assert.deepEqual(named.agentsCreated, []);
});

test('parses exactly one seed target and boolean flags', () => {
  const connections = [{ connector: 'asana' }];
  assert.deepEqual(parseSeedRequest(JSON.stringify({ fixtures: true, connections })), {
    agentId: QA_FIXTURES_AGENT_ID, fixtures: true, replace: false, connections,
  });
  assert.deepEqual(parseSeedRequest(JSON.stringify({ agentId: 'qa-agent', replace: true, connections })), {
    agentId: 'qa-agent', fixtures: false, replace: true, connections,
  });
  assert.equal(parseSeedRequest(JSON.stringify({ fixtures: true, agentId: 'qa-agent', connections })), undefined);
  assert.equal(parseSeedRequest(JSON.stringify({ fixtures: 'yes', connections })), undefined);
  assert.equal(parseSeedRequest(JSON.stringify({ agentId: 'qa-agent', replace: 1, connections })), undefined);
  assert.equal(parseSeedRequest(JSON.stringify({ connections })), undefined);
});

test('the models route answers only the lane seed token on a QA target', async () => {
  const { environmentModelsResponse } = await import('../src/admin/environment-seed.ts');
  const readModels = async () => ({ defaultChatModel: 'openai/gpt-5.6-terra', imageModel: null });
  const ok = await environmentModelsResponse({ authorization: `Bearer ${SEED_TOKEN}`, env: laneEnv, readModels });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {
    schemaVersion: 'chickpea-environment-models/v1', target: 'cobalt',
    defaultChatModel: 'openai/gpt-5.6-terra', imageModel: null,
  });
  const denied = await environmentModelsResponse({ authorization: `Bearer ${'W'.repeat(43)}`, env: laneEnv, readModels });
  assert.equal(denied.status, 404);
  const production = await environmentModelsResponse({
    authorization: `Bearer ${SEED_TOKEN}`,
    env: { CHICKPEA_ENV_SEED_TOKEN: SEED_TOKEN } as unknown as PlatformEnv,
    readModels,
  });
  assert.equal(production.status, 404);
});
