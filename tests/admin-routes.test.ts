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
  // Pin the provider registry: importing src/app.ts anywhere in this test
  // process records real registrations, which would otherwise make the
  // unknown-provider pre-check reject the local-stub models used here.
  app.route(
    '/',
    createAdminRoutes({ store, adminToken: token, knownProviders: new Set(['local-stub']) }),
  );
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

test('admin API returns 404 for every admin route when TAG_ADMIN_TOKEN is unset', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store, undefined);

    const apiResponse = await app.request('/admin/api/agents', {
      headers: auth(ADMIN_TOKEN),
    });
    const pageResponse = await app.request('/admin', {
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(apiResponse.status, 404);
    assert.equal(pageResponse.status, 404);
  } finally {
    store.close();
  }
});

test('TAG_AGENT_API_TOKEN does not authorize admin routes', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv(
      {
        TAG_ADMIN_TOKEN: undefined,
        TAG_AGENT_API_TOKEN: 'agent-api-token',
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

    const page = await app.request('/admin', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Tag Team/);
  } finally {
    store.close();
  }
});

test('admin query token redirects to strip the secret and sets a hashed HttpOnly cookie', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    const login = await app.request(`/admin?token=${ADMIN_TOKEN}`);
    // The page GET redirects to /admin without the query so the token does not
    // linger in the address bar / history / access logs.
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/admin');

    const cookie = login.headers.get('set-cookie') ?? '';
    assert.match(cookie, /flue_admin=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    // The cookie carries a hash, never the raw admin token.
    assert.doesNotMatch(cookie, new RegExp(ADMIN_TOKEN));

    const cookieValue = cookie.split(';')[0] as string;
    const api = await app.request('/admin/api/agents', {
      headers: { cookie: cookieValue },
    });
    assert.equal(api.status, 200);
  } finally {
    store.close();
  }
});

test('unauthenticated page GET renders a login form while XHR/API still gets JSON 401', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    // A browser navigating to /admin with no session gets the token-entry form
    // (401, HTML) instead of a bare JSON error — the documented ?token= login
    // has a visible entry point.
    const page = await app.request('/admin');
    assert.equal(page.status, 401);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.match(html, /name="token"/);
    assert.match(html, /Sign in to Tag Team/);

    // A wrong ?token= surfaces the rejection notice (without echoing the token).
    const rejected = await app.request('/admin?token=nope');
    assert.equal(rejected.status, 401);
    assert.match(await rejected.text(), /was not accepted/);

    // API/XHR callers under /admin/* keep the JSON 401 they can handle.
    const api = await app.request('/admin/api/agents');
    assert.equal(api.status, 401);
    assert.deepEqual(await api.json(), { error: 'unauthorized' });
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
        SLACK_TAG_MODEL: undefined,
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
    await store.createAgent(agent());
    await store.putAssignment({
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
        SLACK_TAG_MODEL: undefined,
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
        await store.createAgent(unpinnedAgent);

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
        channelLabel: 'eng-releases',
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
        channelLabel: 'eng-releases',
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
        channelLabel: 'eng-releases',
        channelPromptAddendum: 'Admin channel addendum.',
      },
    });

    const listAssignments = await app.request('/admin/api/assignments', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(listAssignments.status, 200);
    assert.deepEqual(await listAssignments.json(), {
      assignments: [
        {
          workspaceId: 'T_ADMIN',
          channelId: 'C_ADMIN',
          agentId: 'agent_admin',
          enabled: true,
          channelLabel: 'eng-releases',
          channelPromptAddendum: 'Admin channel addendum.',
        },
      ],
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
      TAG_ADMIN_TOKEN: 'mounted-admin-token',
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

test('admin API accepts a free-text model with an unknown provider prefix but warns', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const freeTextAgent = agent({ id: 'agent_free_text', model: 'anthropc/claude-sonnet-4-6' });

    const response = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(freeTextAgent),
    });

    // Warn, never block: the provider registry approximates the runtime's real
    // provider surface, so unknown prefixes save fine — with a visible warning
    // instead of a false all-clear.
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      agent: freeTextAgent,
      warnings: [
        { code: 'unknown_provider', provider: 'anthropc', knownProviders: ['local-stub'] },
      ],
    });
  } finally {
    store.close();
  }
});

test('admin API exposes model suggestions for configured provider sources', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv(
      {
        ANTHROPIC_API_KEY: 'anthropic-key',
        OPENAI_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
      },
      async () => {
        const app = appWithAdmin(store);

        const response = await app.request('/admin/api/models', {
          headers: auth(ADMIN_TOKEN),
        });

        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          automatic: { label: string; value: null };
          providers: Array<{ id: string; configured: boolean; suggestions: string[] }>;
        };
        assert.deepEqual(body.automatic, { label: 'Automatic (provider default)', value: null });
        assert.equal(
          body.providers.some(
            (provider) =>
              provider.id === 'anthropic' &&
              provider.configured &&
              provider.suggestions.includes('anthropic/claude-sonnet-4-6'),
          ),
          true,
        );
        // Custom (non-catalog) providers advertise no fabricated suggestions.
        assert.equal(
          body.providers.some(
            (provider) =>
              provider.id === 'local-stub' &&
              provider.configured &&
              provider.suggestions.length === 0,
          ),
          true,
        );
      },
    );
  } finally {
    store.close();
  }
});

test('effective config endpoint resolves through the runtime assignment path', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    await store.createAgent(
      agent({
        instructions: 'Base profile instructions from the admin test.',
        model: 'local-stub/effective-model',
        allowedTools: ['lookup_channel_brief'],
      }),
    );
    await store.putAssignment({
      workspaceId: 'T_ADMIN',
      channelId: 'C_ADMIN',
      agentId: 'agent_admin',
      enabled: true,
      channelPromptAddendum: 'Channel addendum from the admin test.',
    });

    const response = await app.request(
      '/admin/api/effective-config?workspaceId=T_ADMIN&channelId=C_ADMIN',
      { headers: auth(ADMIN_TOKEN) },
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      config: {
        agentId: string;
        model: string;
        provider: string;
        allowedTools: string[];
        instructions: string;
        instructionLayers: Array<{ source: string; text: string }>;
      };
    };
    assert.equal(body.config.agentId, 'agent_admin');
    assert.equal(body.config.model, 'local-stub/effective-model');
    assert.equal(body.config.provider, 'local-stub');
    assert.deepEqual(body.config.allowedTools, ['lookup_channel_brief']);
    assert.match(body.config.instructions, /Base profile instructions from the admin test\./);
    assert.match(body.config.instructions, /Channel addendum from the admin test\./);
    assert.match(body.config.instructions, /Do not reveal Slack tokens/);
    assert.deepEqual(
      body.config.instructionLayers.map((layer) => layer.source),
      ['profile', 'channel', 'runtime', 'guardrail'],
    );
  } finally {
    store.close();
  }
});

test('admin API clears a pinned model with PATCH model: null', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const previousFallback = process.env.SLACK_TAG_MODEL;
  process.env.SLACK_TAG_MODEL = 'local-stub/fallback-after-clear';
  try {
    const app = appWithAdmin(store);
    await store.createAgent(agent());

    const response = await app.request('/admin/api/agents/agent_admin', {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ model: null }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { agent: CustomAgentConfig };
    assert.equal('model' in body.agent, false);
    assert.equal('model' in (await store.getAgent('agent_admin')), false);
  } finally {
    if (previousFallback === undefined) {
      delete process.env.SLACK_TAG_MODEL;
    } else {
      process.env.SLACK_TAG_MODEL = previousFallback;
    }
    store.close();
  }
});

test('admin API maps an assignment to a missing agent to a stable unknown_agent error', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    const response = await app.request('/admin/api/assignments', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'T_ADMIN',
        channelId: 'C_ADMIN',
        agentId: 'agent_missing',
        enabled: true,
      }),
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'unknown_agent' });
  } finally {
    store.close();
  }
});
