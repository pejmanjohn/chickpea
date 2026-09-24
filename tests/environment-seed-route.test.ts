import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { ENVIRONMENT_SEED_PATH } from '../src/admin/environment-seed.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
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
