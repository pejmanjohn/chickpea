import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import {
  ENVIRONMENT_SEED_PATH,
  QA_FIXTURES_AGENT_ID,
  seedFingerprint,
  seedFingerprintSettingKey,
} from '../src/admin/environment-seed.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { resolveConnectionAccountSecret } from '../src/config/connector-secrets.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const ORIGIN = 'https://chickpea-cobalt.example.workers.dev';
const SEED_TOKEN = 'S'.repeat(43);
const TEAM_ID = 'T12345678';

function qaAgent(): CustomAgentConfig {
  return {
    id: 'qa-agent',
    revision: 1,
    name: 'QA Agent',
    instructions: 'Seeded connection checks.',
    enabled: true,
    model: 'local-stub/qa',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    kind: 'user',
  };
}

test('the seed route creates a token connection as the workspace owner and is idempotent', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [qaAgent()] });
  const settings = new SqliteSettingsStore(':memory:');
  const identity = new SqliteIdentityStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    const owner = await createSlackOwner(identity, { teamId: TEAM_ID });
    const control = (await identity.getAuthControl())!;
    await identity.updateAuthControl({
      expectedRevision: control.revision,
      canonicalAdminOrigin: ORIGIN,
      betterAuthOrganizationId: '11111111-1111-4111-8111-111111111111',
    });
    await identity.updateOrganizationAuth({
      organizationId: owner.membership.organizationId,
      authMode: 'slack_active',
      canonicalAdminOrigin: ORIGIN,
    });
    const app = createAdminRoutes({
      store,
      settings,
      identity,
      recoveryToken: '9d'.repeat(32),
      betterAuthEnvironment: { backend, baseURL: ORIGIN, secret: 'test-seed-better-auth-secret-32-bytes' },
    });
    const env = { CHICKPEA_ENV_TARGET: 'cobalt', CHICKPEA_ENV_SEED_TOKEN: SEED_TOKEN };
    const seed = (authorization: string) => app.request(`${ORIGIN}${ENVIRONMENT_SEED_PATH}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'qa-agent',
        connections: [
          { connector: 'asana', credential: 'asana-seed-secret' },
          { connector: 'linear' },
        ],
      }),
    }, env);

    const denied = await seed(`Bearer ${'W'.repeat(43)}`);
    assert.equal(denied.status, 404);
    assert.equal((await store.listConnectionAccounts(TEAM_ID)).length, 0);

    const first = await seed(`Bearer ${SEED_TOKEN}`);
    assert.equal(first.status, 200, await first.clone().text());
    const body = await first.json() as { connections: Array<Record<string, string>> };
    const asana = body.connections.find((entry) => entry.connector === 'asana')!;
    assert.equal(asana.status, 'created');
    const linear = body.connections.find((entry) => entry.connector === 'linear')!;
    assert.equal(linear.status, 'needs_consent');
    assert.equal(linear.adminUrl, `${ORIGIN}/admin/agents/qa-agent/connections/new/linear/team`);
    assert.doesNotMatch(JSON.stringify(body), /asana-seed-secret/);

    const accounts = await store.listConnectionAccounts(TEAM_ID);
    assert.equal(accounts.length, 1);
    const [account] = accounts;
    assert.equal(account!.id, asana.connectionId);
    assert.equal(account!.providerId, 'asana');
    assert.equal(account!.ownerKind, 'team');
    assert.equal(account!.createdByMembershipId, owner.membership.id);
    assert.equal(account!.policy.kind, 'api');
    assert.deepEqual(
      (await store.listAgentConnectionBindings('qa-agent')).map((binding) => binding.connectionAccountId),
      [account!.id],
    );

    const second = await seed(`Bearer ${SEED_TOKEN}`);
    const again = (await second.json() as { connections: Array<Record<string, string>> }).connections;
    assert.equal(again.find((entry) => entry.connector === 'asana')!.status, 'present');
    assert.equal((await store.listConnectionAccounts(TEAM_ID)).length, 1);

    const production = await app.request(`${ORIGIN}${ENVIRONMENT_SEED_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SEED_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'qa-agent', connections: [{ connector: 'asana', credential: 'x' }] }),
    }, { CHICKPEA_ENV_SEED_TOKEN: SEED_TOKEN });
    assert.equal(production.status, 404);
  } finally {
    backend.close();
    identity.close();
    settings.close();
    store.close();
  }
});

async function seededLane(agents: CustomAgentConfig[]) {
  const store = new SqliteConfigStore(':memory:', { agents });
  const settings = new SqliteSettingsStore(':memory:');
  const identity = new SqliteIdentityStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  const owner = await createSlackOwner(identity, { teamId: TEAM_ID });
  const control = (await identity.getAuthControl())!;
  await identity.updateAuthControl({
    expectedRevision: control.revision,
    canonicalAdminOrigin: ORIGIN,
    betterAuthOrganizationId: '11111111-1111-4111-8111-111111111111',
  });
  await identity.updateOrganizationAuth({
    organizationId: owner.membership.organizationId,
    authMode: 'slack_active',
    canonicalAdminOrigin: ORIGIN,
  });
  const app = createAdminRoutes({
    store,
    settings,
    identity,
    recoveryToken: '9d'.repeat(32),
    betterAuthEnvironment: { backend, baseURL: ORIGIN, secret: 'test-seed-better-auth-secret-32-bytes' },
  });
  const env = { CHICKPEA_ENV_TARGET: 'cobalt', CHICKPEA_ENV_SEED_TOKEN: SEED_TOKEN };
  const seed = async (body: unknown) => {
    const response = await app.request(`${ORIGIN}${ENVIRONMENT_SEED_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SEED_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, env);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return {
    store,
    settings,
    seed,
    close: () => { backend.close(); identity.close(); settings.close(); store.close(); },
  };
}

test('a rotated credential is reported stale and replaced in place only on request', async () => {
  const lane = await seededLane([qaAgent()]);
  try {
    const asana = (credential: string, replace?: boolean) => ({
      agentId: 'qa-agent',
      ...(replace ? { replace } : {}),
      connections: [{ connector: 'asana', credential }],
    });
    const created = await lane.seed(asana('asana-token-one'));
    assert.equal(created.body.connections[0].status, 'created');
    const connectionId = created.body.connections[0].connectionId as string;
    assert.equal(
      await lane.settings.getSetting(seedFingerprintSettingKey(connectionId)),
      seedFingerprint('asana', { credential: 'asana-token-one' }),
    );
    const [account] = await lane.store.listConnectionAccounts(TEAM_ID);
    const secret = () => resolveConnectionAccountSecret(account!, undefined, lane.settings);
    assert.equal(await secret(), 'asana-token-one');

    assert.equal((await lane.seed(asana('asana-token-one'))).body.connections[0].status, 'present');

    const stale = await lane.seed(asana('asana-token-two'));
    assert.equal(stale.body.connections[0].status, 'stale');
    assert.equal(stale.body.connections[0].reason, 'changed');
    assert.equal(stale.body.connections[0].connectionId, connectionId);
    assert.equal(await secret(), 'asana-token-one');

    const replaced = await lane.seed(asana('asana-token-two', true));
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.connections[0].status, 'replaced');
    assert.equal(replaced.body.connections[0].connectionId, connectionId);
    assert.equal(await secret(), 'asana-token-two');
    const accounts = await lane.store.listConnectionAccounts(TEAM_ID);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]!.lifecycle, 'ready');
    assert.equal((await lane.seed(asana('asana-token-two'))).body.connections[0].status, 'present');
    assert.doesNotMatch(JSON.stringify([stale.body, replaced.body]), /asana-token/);

    // A connection that predates fingerprints (for example one made in Admin)
    // is never assumed current.
    await lane.settings.deleteSetting(seedFingerprintSettingKey(connectionId));
    const unrecorded = await lane.seed(asana('asana-token-two'));
    assert.equal(unrecorded.body.connections[0].status, 'stale');
    assert.equal(unrecorded.body.connections[0].reason, 'unrecorded');
  } finally {
    lane.close();
  }
});

test('fixtures mode keeps one standing, unpublished fixtures Agent whose connections stay bound to it', async () => {
  const lane = await seededLane([qaAgent()]);
  try {
    const first = await lane.seed({ fixtures: true, connections: [{ connector: 'asana', credential: 'fixture-token' }] });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.agentId, QA_FIXTURES_AGENT_ID);
    assert.equal(first.body.connections[0].status, 'created');
    const fixtures = await lane.store.getAgent(QA_FIXTURES_AGENT_ID);
    assert.equal(fixtures.enabled, true);
    assert.equal(fixtures.lifecycle, 'active');
    assert.equal(fixtures.creatorMembershipId, undefined);
    assert.equal(fixtures.slackPresence?.desiredState, 'unpublished');
    assert.equal(fixtures.slackPresence?.health, 'unpublished');

    const again = await lane.seed({ fixtures: true, connections: [{ connector: 'asana', credential: 'fixture-token' }] });
    assert.equal(again.body.connections[0].status, 'present');
    assert.equal((await lane.store.listUserAgents()).filter((agent) => agent.id === QA_FIXTURES_AGENT_ID).length, 1);

    // One account belongs to one Agent: the store refuses a second binding,
    // which is why fixture connections are not shared with run-owned Agents.
    const connectionId = first.body.connections[0].connectionId as string;
    const binding = (await lane.store.getAgentConnectionBindingForAccount(connectionId))!;
    await assert.rejects(
      lane.store.putAgentConnectionBinding({ ...binding, agentId: 'qa-agent' }),
      /already belongs to Agent qa-fixtures/,
    );
    assert.equal((await lane.store.listAgentConnectionBindings('qa-agent')).length, 0);

    await lane.store.updateAgent(QA_FIXTURES_AGENT_ID, { enabled: false });
    const disabled = await lane.seed({ fixtures: true, connections: [{ connector: 'asana', credential: 'fixture-token' }] });
    assert.equal(disabled.status, 409);
    assert.equal(disabled.body.error, 'agent_inactive');
  } finally {
    lane.close();
  }
});
