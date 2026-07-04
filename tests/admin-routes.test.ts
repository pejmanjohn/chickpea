import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import flueApp from '../src/app.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

const ADMIN_TOKEN = 'admin-secret-token';

function appWithAdmin(store: SqliteConfigStore, adminToken?: string): Hono {
  const app = new Hono();
  const token = arguments.length >= 2 ? adminToken : ADMIN_TOKEN;
  app.route('/', createAdminRoutes({ store, adminToken: token }));
  return app;
}

function auth(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function agent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: 'agent_admin',
    name: 'Admin Agent',
    description: 'Managed through the admin API',
    instructions: 'Use admin-managed instructions.',
    enabled: true,
    model: 'local-stub/admin-agent',
    defaultModels: {
      claude: 'anthropic/admin-claude',
      'workers-ai': '@cf/admin/model',
    },
    allowedTools: [],
    ...overrides,
  };
}

test('admin API returns 404 for every admin route when FLUE_ADMIN_TOKEN is unset', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store, undefined);

    const response = await app.request('/admin/api/agents', {
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(response.status, 404);
  } finally {
    store.close();
  }
});

test('FLUE_AGENT_API_TOKEN does not authorize admin routes', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv(
      {
        FLUE_ADMIN_TOKEN: undefined,
        FLUE_AGENT_API_TOKEN: 'agent-api-token',
      },
      async () => {
        const app = new Hono();
        app.route('/', createAdminRoutes({ store }));

        const response = await app.request('/admin/api/agents', {
          headers: auth('agent-api-token'),
        });

        assert.equal(response.status, 404);
      },
    );
  } finally {
    store.close();
  }
});

test('admin API rejects a wrong bearer token and accepts the configured admin token', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    const wrong = await app.request('/admin/api/agents', {
      headers: auth('wrong-token'),
    });
    assert.equal(wrong.status, 401);

    const right = await app.request('/admin/api/agents', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(right.status, 200);
    assert.deepEqual(await right.json(), { agents: [] });
  } finally {
    store.close();
  }
});

test('admin API validates request bodies with valibot', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    const response = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ id: '', enabled: 'yes' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  } finally {
    store.close();
  }
});

test('admin API rejects unpinned agents that cannot resolve a model in the current environment', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
        SLACK_FLUE_MODEL: undefined,
      },
      async () => {
        const app = appWithAdmin(store);
        const response = await app.request('/admin/api/agents', {
          method: 'POST',
          headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
          body: JSON.stringify({
            ...agent(),
            model: undefined,
          }),
        });

        assert.equal(response.status, 422);
        assert.deepEqual(await response.json(), { error: 'model_not_resolvable' });
      },
    );
  } finally {
    store.close();
  }
});

test('admin API blocks deleting an agent while assignments still reference it', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    store.createAgent(agent());
    store.putAssignment({
      workspaceId: 'T_ADMIN',
      channelId: 'C_ADMIN',
      agentId: 'agent_admin',
      enabled: true,
    });

    const response = await app.request('/admin/api/agents/agent_admin', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'agent_still_assigned',
      assignments: [{ workspaceId: 'T_ADMIN', channelId: 'C_ADMIN' }],
    });
  } finally {
    store.close();
  }
});

test('admin API rejects patches that leave an agent without a resolvable model', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
        SLACK_FLUE_MODEL: undefined,
      },
      async () => {
        const app = appWithAdmin(store);
        const unpinnedAgent: CustomAgentConfig = {
          id: 'agent_admin',
          name: 'Admin Agent',
          description: 'Managed through the admin API',
          instructions: 'Use admin-managed instructions.',
          enabled: true,
          defaultModels: {
            claude: 'anthropic/admin-claude',
            'workers-ai': '@cf/admin/model',
          },
          allowedTools: [],
        };
        store.createAgent(unpinnedAgent);

        const response = await app.request('/admin/api/agents/agent_admin', {
          method: 'PATCH',
          headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
          body: JSON.stringify({ description: 'Still unresolvable after patch.' }),
        });

        assert.equal(response.status, 422);
        assert.deepEqual(await response.json(), { error: 'model_not_resolvable' });
      },
    );
  } finally {
    store.close();
  }
});

test('admin API supports agent and assignment CRUD with the admin token', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const createdAgent = agent();

    const createAgent = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(createdAgent),
    });
    assert.equal(createAgent.status, 201);
    assert.deepEqual(await createAgent.json(), { agent: createdAgent });

    const patchAgent = await app.request('/admin/api/agents/agent_admin', {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        instructions: 'Updated runtime instructions.',
        model: 'local-stub/admin-updated',
      }),
    });
    assert.equal(patchAgent.status, 200);
    assert.deepEqual(await patchAgent.json(), {
      agent: {
        ...createdAgent,
        instructions: 'Updated runtime instructions.',
        model: 'local-stub/admin-updated',
      },
    });

    const getAgent = await app.request('/admin/api/agents/agent_admin', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(getAgent.status, 200);
    assert.equal(((await getAgent.json()) as { agent: CustomAgentConfig }).agent.model, 'local-stub/admin-updated');

    const putAssignment = await app.request('/admin/api/assignments', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'T_ADMIN',
        channelId: 'C_ADMIN',
        agentId: 'agent_admin',
        enabled: true,
        channelPromptAddendum: 'Admin channel addendum.',
      }),
    });
    assert.equal(putAssignment.status, 200);
    assert.deepEqual(await putAssignment.json(), {
      assignment: {
        workspaceId: 'T_ADMIN',
        channelId: 'C_ADMIN',
        agentId: 'agent_admin',
        enabled: true,
        channelPromptAddendum: 'Admin channel addendum.',
      },
    });

    const getAssignment = await app.request(
      '/admin/api/assignments?workspaceId=T_ADMIN&channelId=C_ADMIN',
      { headers: auth(ADMIN_TOKEN) },
    );
    assert.equal(getAssignment.status, 200);
    assert.deepEqual(await getAssignment.json(), {
      assignment: {
        workspaceId: 'T_ADMIN',
        channelId: 'C_ADMIN',
        agentId: 'agent_admin',
        enabled: true,
        channelPromptAddendum: 'Admin channel addendum.',
      },
    });

    const deleteAssignment = await app.request(
      '/admin/api/assignments?workspaceId=T_ADMIN&channelId=C_ADMIN',
      { method: 'DELETE', headers: auth(ADMIN_TOKEN) },
    );
    assert.equal(deleteAssignment.status, 204);

    const deleteAgent = await app.request('/admin/api/agents/agent_admin', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(deleteAgent.status, 204);
  } finally {
    store.close();
  }
});

test('main app mounts admin routes before flue routing', async () => {
  await withEnv(
    {
      FLUE_ADMIN_TOKEN: 'mounted-admin-token',
      SLACK_STATE_DB_PATH: ':memory:',
    },
    async () => {
      const response = await flueApp.request('/admin/api/agents', {
        headers: auth('mounted-admin-token'),
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as { agents?: unknown };
      assert.equal(Array.isArray(body.agents), true);
    },
  );
});
