import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import {
  agentAvatarInstallation,
  agentAvatarUrl,
  agentAvatarUrlForPresentation,
  uploadAgentAvatar,
} from '../src/slack/agent-presence/avatar-assets.ts';
import { testAdminAuthority } from './helpers/admin-auth.ts';

const TOKEN = 'hosted-admin-slack-token';
const ORIGIN = 'https://hosted.example';
const HOSTED = { CHICKPEA_TENANCY: 'installation' };
const ENV_A = scopeInstallationEnv(HOSTED, { installationId: 'inst_tenant_a' });
const ENV_B = scopeInstallationEnv(HOSTED, { installationId: 'inst_tenant_b' });

function agent(id: string): Omit<CustomAgentConfig, 'revision'> {
  return {
    id, kind: 'user', name: 'Support', instructions: '', enabled: true, lifecycle: 'active',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
    slackPresence: {
      requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'unpublished',
      health: 'unpublished', avatar: { kind: 'generated', revision: 1, seed: 'support' },
    },
  };
}

function stores(t: TestContext) {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => {
    config.close();
    settings.close();
  });
  return { config, settings };
}

test('a hosted Agent avatar URL names its installation, and a standalone one is unchanged', async (t) => {
  assert.equal(agentAvatarInstallation(undefined), undefined);
  assert.equal(agentAvatarInstallation({}), undefined);
  assert.equal(agentAvatarInstallation(ENV_A), 'inst_tenant_a');
  assert.equal(agentAvatarUrl(`${ORIGIN}/admin`, 'agent_support', 3),
    `${ORIGIN}/assets/agents/agent_support/avatar/3`);
  assert.equal(agentAvatarUrl(`${ORIGIN}/admin`, 'agent_support', 3, agentAvatarInstallation({})),
    `${ORIGIN}/assets/agents/agent_support/avatar/3`);
  assert.equal(agentAvatarUrl(ORIGIN, 'agent_support', 3, agentAvatarInstallation(ENV_A)),
    `${ORIGIN}/assets/i/inst_tenant_a/agents/agent_support/avatar/3`);

  const { config, settings } = stores(t);
  const created = await config.createAgent(agent('agent_support'));
  assert.equal(agentAvatarUrlForPresentation(created, ORIGIN, 'inst_tenant_a'),
    `${ORIGIN}/assets/i/inst_tenant_a/agents/agent_support/avatar/1`);
  const png = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
    0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ]);
  const uploaded = await uploadAgentAvatar({
    config, settings, agentId: 'agent_support', bytes: png, contentType: 'image/png',
    publicOrigin: ORIGIN, installationId: 'inst_tenant_a',
  });
  assert.equal(uploaded.slackPresence?.avatar.url, `${ORIGIN}/assets/i/inst_tenant_a/agents/agent_support/avatar/2`);
});

test('the avatar route serves an installation\'s avatar only under that installation', async (t) => {
  const { config, settings } = stores(t);
  await config.createAgent(agent('agent_support'));
  const app = createAdminRoutes({ store: config, settings, ...testAdminAuthority(TOKEN, ORIGIN) });
  const get = (path: string, env: Record<string, unknown>) => app.request(`${ORIGIN}${path}`, {}, env);

  const hosted = await get('/assets/i/inst_tenant_a/agents/agent_support/avatar/1', ENV_A);
  assert.equal(hosted.status, 200);
  assert.equal(hosted.headers.get('content-type'), 'image/png');
  assert.equal((await get('/assets/i/inst_tenant_a/agents/agent_support/avatar/1', ENV_B)).status, 404,
    'another installation\'s segment is refused');
  assert.equal((await get('/assets/agents/agent_support/avatar/1', ENV_A)).status, 404,
    'a hosted installation serves no unnamed avatar URL');

  const standalone = await get('/assets/agents/agent_support/avatar/1', {});
  assert.equal(standalone.status, 200);
  assert.deepEqual(new Uint8Array(await standalone.arrayBuffer()), new Uint8Array(await hosted.arrayBuffer()));
  assert.equal((await get('/assets/i/inst_tenant_a/agents/agent_support/avatar/1', {})).status, 404);
});
