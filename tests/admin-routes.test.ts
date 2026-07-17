import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import flueApp from '../src/app.ts';
import type { McpConnectInput, McpDiscoveryResult } from '../src/config/mcp-test.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig, McpConnectionConfig } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

const ADMIN_TOKEN = 'admin-secret-token';

interface AdminHarnessOptions {
  adminToken?: string | undefined;
  settings?: SettingsStore;
  discoverMcp?: (input: McpConnectInput) => Promise<McpDiscoveryResult>;
}

function appWithAdmin(store: SqliteConfigStore, adminToken?: string): Hono {
  const overrides: AdminHarnessOptions = arguments.length >= 2 ? { adminToken } : {};
  return appWithAdminOptions(store, overrides);
}

function appWithAdminOptions(store: SqliteConfigStore, options: AdminHarnessOptions = {}): Hono {
  const app = new Hono();
  const token = Object.hasOwn(options, 'adminToken') ? options.adminToken : ADMIN_TOKEN;
  // A fresh in-memory settings store keeps the assignment-PUT Slack validation
  // hermetic: with no stored bot token (and no SLACK_* env in CI), validation is
  // skipped, so these CRUD assertions keep their exact pre-validation shape and
  // never touch a file-backed store.
  const settings = options.settings ?? new SqliteSettingsStore(':memory:');
  // Pin the provider registry: importing src/app.ts anywhere in this test
  // process records real registrations, which would otherwise make the
  // unknown-provider pre-check reject the local-stub models used here.
  app.route(
    '/',
    createAdminRoutes({
      store,
      settings,
      adminToken: token,
      knownProviders: new Set(['local-stub']),
      ...(options.discoverMcp ? { discoverMcp: options.discoverMcp } : {}),
    }),
  );
  return app;
}

function mcpServer(overrides: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  return {
    id: 'linear-mcp',
    displayName: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    transport: 'streamable-http',
    authMode: 'bearer',
    headerNames: [],
    trusted: true,
    enabled: true,
    lifecycleStatus: 'ready',
    statusText: 'Connected · 2 tools',
    discoveredTools: [{ name: 'search' }, { name: 'create' }],
    allowedTools: ['search'],
    ...overrides,
  };
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
    skills: [],
    mcpServers: [],
    ...overrides,
  };
}

test('the worker root redirects to /admin instead of a bare 404', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const response = await app.request('/', { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/admin');
  } finally {
    store.close();
  }
});

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

test('admin API validates skills: rejects whitespace-only description and duplicate names, trims on accept', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const post = (body: unknown) =>
      app.request('/admin/api/agents', {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // A whitespace-only description would pass a naive minLength(1) but throws at
    // defineSkill (which trims) — the write boundary must reject it up front.
    const whitespace = await post(
      agent({
        id: 'agent_ws',
        model: 'local-stub/x',
        skills: [{ name: 'ok-name', description: '   ', instructions: '# body', enabled: true }],
      }),
    );
    assert.equal(whitespace.status, 400);

    // Duplicate skill names are a runtime turn-killer — reject at the boundary.
    const dup = await post(
      agent({
        id: 'agent_dup',
        model: 'local-stub/x',
        skills: [
          { name: 'dupe', description: 'a', instructions: 'x', enabled: true },
          { name: 'dupe', description: 'b', instructions: 'y', enabled: true },
        ],
      }),
    );
    assert.equal(dup.status, 400);

    // A valid skill with padded values is accepted and stored trimmed.
    const ok = await post(
      agent({
        id: 'agent_ok',
        model: 'local-stub/x',
        skills: [
          { name: 'good-skill', description: '  Trim me.  ', instructions: '  # body  ', enabled: true },
        ],
      }),
    );
    assert.equal(ok.status, 201);
    const created = (await ok.json()) as { agent: { skills: Array<{ description: string; instructions: string }> } };
    assert.equal(created.agent.skills[0]?.description, 'Trim me.');
    assert.equal(created.agent.skills[0]?.instructions, '# body');
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
        assert.deepEqual(await response.json(), {
          error: 'model_not_resolvable',
          message:
            'No model pinned for agent agent_admin. Pin a model in /admin (Profiles -> Model), or set SLACK_TAG_MODEL for offline/dev unpinned-profile fallback.',
        });
      },
    );
  } finally {
    store.close();
  }
});

test('admin API accepts an unpinned agent only when SLACK_TAG_MODEL is set', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv(
      {
        SLACK_TAG_MODEL: 'local-stub/admin-fallback',
        ANTHROPIC_API_KEY: 'anthropic-key',
        CLOUDFLARE_API_TOKEN: 'cf-token',
        CLOUDFLARE_ACCOUNT_ID: 'cf-account',
      },
      async () => {
        const app = appWithAdmin(store);
        const createdAgent = agent();
        delete createdAgent.model;
        const response = await app.request('/admin/api/agents', {
          method: 'POST',
          headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
          body: JSON.stringify(createdAgent),
        });

        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), { agent: createdAgent });
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
          skills: [],
          mcpServers: [],
        };
        await store.createAgent(unpinnedAgent);

        const response = await app.request('/admin/api/agents/agent_admin', {
          method: 'PATCH',
          headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
          body: JSON.stringify({ description: 'Still unresolvable after patch.' }),
        });

        assert.equal(response.status, 422);
        assert.deepEqual(await response.json(), {
          error: 'model_not_resolvable',
          message:
            'No model pinned for agent agent_admin. Pin a model in /admin (Profiles -> Model), or set SLACK_TAG_MODEL for offline/dev unpinned-profile fallback.',
        });
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
          automatic?: unknown;
          providers: Array<{ id: string; configured: boolean; suggestions: string[] }>;
          defaultModels: unknown;
        };
        assert.equal(body.automatic, undefined);
        assert.ok(body.defaultModels);
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
        skills: [],
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
        instructions: string;
        instructionLayers: Array<{ source: string; text: string }>;
      };
    };
    assert.equal(body.config.agentId, 'agent_admin');
    assert.equal(body.config.model, 'local-stub/effective-model');
    assert.equal(body.config.provider, 'local-stub');
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

test('effective config endpoint uses SLACK_TAG_MODEL for an unpinned profile on node', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv(
      {
        SLACK_TAG_MODEL: 'local-stub/node-unpinned-fallback',
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
      },
      async () => {
        const app = appWithAdmin(store);
        const unpinnedAgent = agent({
          id: 'agent_unpinned',
          name: 'Unpinned Agent',
        });
        delete unpinnedAgent.model;
        await store.createAgent(unpinnedAgent);
        await store.putAssignment({
          workspaceId: 'T_ADMIN',
          channelId: 'C_UNPINNED',
          agentId: 'agent_unpinned',
          enabled: true,
        });

        const response = await app.request(
          '/admin/api/effective-config?workspaceId=T_ADMIN&channelId=C_UNPINNED',
          { headers: auth(ADMIN_TOKEN) },
        );

        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          config: { model: string; provider: string; profile: { model: string | null } };
        };
        assert.equal(body.config.profile.model, null);
        assert.equal(body.config.model, 'local-stub/node-unpinned-fallback');
        assert.equal(body.config.provider, 'local-stub');
      },
    );
  } finally {
    store.close();
  }
});

test('admin API clears a pinned model with PATCH model: null', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    await withEnv({ SLACK_TAG_MODEL: 'local-stub/fallback-after-clear' }, async () => {
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
    });
  } finally {
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

// --- MCP Connections (Task 7) -------------------------------------------------

test('admin API accepts an agent with a valid mcpServers entry and round-trips it', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const createdAgent = agent({ id: 'agent_mcp', mcpServers: [mcpServer()] });

    const create = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(createdAgent),
    });
    assert.equal(create.status, 201);
    assert.deepEqual(await create.json(), { agent: createdAgent });

    // A PATCH carrying only mcpServers must preserve the array verbatim.
    const patched = [mcpServer({ id: 'linear-mcp', allowedTools: ['search', 'create'] })];
    const patch = await app.request('/admin/api/agents/agent_mcp', {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ mcpServers: patched }),
    });
    assert.equal(patch.status, 200);
    const body = (await patch.json()) as { agent: CustomAgentConfig };
    assert.deepEqual(body.agent.mcpServers, patched);
  } finally {
    store.close();
  }
});

test('admin API rejects mcpServers with a bad id, duplicate ids, oversize fields, or a blocked URL', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const post = (id: string, servers: unknown) =>
      app.request('/admin/api/agents', {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify(agent({ id, mcpServers: servers as McpConnectionConfig[] })),
      });

    const badId = await post('agent_badid', [mcpServer({ id: 'Not_Valid' })]);
    assert.equal(badId.status, 400);

    const dup = await post('agent_dup_mcp', [
      mcpServer({ id: 'dupe' }),
      mcpServer({ id: 'dupe' }),
    ]);
    assert.equal(dup.status, 400);

    const oversize = await post('agent_oversize', [mcpServer({ displayName: 'x'.repeat(81) })]);
    assert.equal(oversize.status, 400);

    // The schema-level v.check runs validateMcpUrl — a private IP literal is
    // rejected at the write boundary, not just at turn time.
    const blocked = await post('agent_blocked', [mcpServer({ url: 'https://10.0.0.1/mcp' })]);
    assert.equal(blocked.status, 400);
  } finally {
    store.close();
  }
});

test('POST /admin/api/mcp/test returns discovered tools on success (HTTP 200)', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const calls: McpConnectInput[] = [];
    const app = appWithAdminOptions(store, {
      discoverMcp: async (input) => {
        calls.push(input);
        return { tools: [{ name: 'search', description: 'Search things' }, { name: 'create' }] };
      },
    });

    const response = await app.request('/admin/api/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'bearer',
        bearerToken: 'tok-from-form',
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      tools: [{ name: 'search', description: 'Search things' }, { name: 'create' }],
    });
    // The transient bearer from the body is applied to the connect headers.
    assert.equal(calls[0]?.headers.Authorization, 'Bearer tok-from-form');
  } finally {
    store.close();
  }
});

test('POST /admin/api/mcp/test overrides stored secrets with body-supplied values', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting('mcp.linear-mcp.bearer', 'stored-token');
    const calls: McpConnectInput[] = [];
    const app = appWithAdminOptions(store, {
      settings,
      discoverMcp: async (input) => {
        calls.push(input);
        return { tools: [] };
      },
    });

    const response = await app.request('/admin/api/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'bearer',
        bearerToken: 'fresh-token',
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls[0]?.headers.Authorization, 'Bearer fresh-token');
  } finally {
    settings.close?.();
    store.close();
  }
});

test('POST /admin/api/mcp/test backs an un-retyped header with its stored value via headerNames', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    // Operator stored X-Api-Key earlier; on re-test they don't retype it, but
    // the client sends the header NAME so the server can resolve the stored value.
    await settings.setSetting('mcp.linear-mcp.header.X-Api-Key', 'stored-key');
    const calls: McpConnectInput[] = [];
    const app = appWithAdminOptions(store, {
      settings,
      discoverMcp: async (input) => {
        calls.push(input);
        return { tools: [] };
      },
    });

    const response = await app.request('/admin/api/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'none',
        headerNames: ['X-Api-Key'],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls[0]?.headers['X-Api-Key'], 'stored-key');
  } finally {
    settings.close?.();
    store.close();
  }
});

test('POST /admin/api/mcp/test classifies a hung connection as timeout (HTTP 200, no raw error)', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdminOptions(store, {
      discoverMcp: async () => {
        throw new Error('connect timeout after 8000ms — raw internal detail');
      },
    });

    const response = await app.request('/admin/api/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'none',
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; code: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'timeout');
    assert.doesNotMatch(body.message, /raw internal detail/);
    assert.doesNotMatch(body.message, /8000ms/);
  } finally {
    store.close();
  }
});

test('POST /admin/api/mcp/test classifies a 401 as unauthorized (HTTP 200)', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdminOptions(store, {
      discoverMcp: async () => {
        throw new Error('HTTP 401 Unauthorized');
      },
    });

    const response = await app.request('/admin/api/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'bearer',
        bearerToken: 'bad',
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; code: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'unauthorized');
    assert.doesNotMatch(body.message, /401/);
  } finally {
    store.close();
  }
});

test('POST /admin/api/mcp/test returns ok:false blocked_url for a private target (HTTP 200) without calling discover', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    let discoverCalled = false;
    const app = appWithAdminOptions(store, {
      discoverMcp: async () => {
        discoverCalled = true;
        return { tools: [] };
      },
    });

    const response = await app.request('/admin/api/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://192.168.1.1/mcp',
        transport: 'streamable-http',
        authMode: 'none',
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; code: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'blocked_url');
    // No raw error text and no discover attempt against the blocked target.
    assert.doesNotMatch(body.message, /192\.168/);
    assert.equal(discoverCalled, false);
  } finally {
    store.close();
  }
});

test('POST /admin/api/mcp/test returns 400 only for a schema-invalid body', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdminOptions(store, {
      discoverMcp: async () => ({ tools: [] }),
    });

    const response = await app.request('/admin/api/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'linear-mcp' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  } finally {
    store.close();
  }
});

test('PUT /admin/api/mcp/secrets/:id stores values and reports sources without echoing them', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request('/admin/api/mcp/secrets/linear-mcp', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        bearerToken: 'super-secret-token',
        headers: { 'X-Api-Key': 'header-secret-value' },
        headerNames: ['X-Api-Key'],
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      bearer: string;
      headers: Record<string, string>;
    };
    assert.deepEqual(body, { bearer: 'stored', headers: { 'X-Api-Key': 'stored' } });
    // The response never echoes the secret values.
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /super-secret-token/);
    assert.doesNotMatch(raw, /header-secret-value/);
    // The values did land in the settings store by reference.
    assert.equal(await settings.getSetting('mcp.linear-mcp.bearer'), 'super-secret-token');
    assert.equal(await settings.getSetting('mcp.linear-mcp.header.X-Api-Key'), 'header-secret-value');
  } finally {
    settings.close?.();
    store.close();
  }
});

test('DELETE /admin/api/mcp/secrets/:id clears the bearer and named header secrets', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting('mcp.linear-mcp.bearer', 'tok');
    await settings.setSetting('mcp.linear-mcp.header.X-Api-Key', 'val');
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request('/admin/api/mcp/secrets/linear-mcp', {
      method: 'DELETE',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ headerNames: ['X-Api-Key'] }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(await settings.getSetting('mcp.linear-mcp.bearer'), undefined);
    assert.equal(await settings.getSetting('mcp.linear-mcp.header.X-Api-Key'), undefined);
  } finally {
    settings.close?.();
    store.close();
  }
});

test('deleting an agent sweeps its mcp connection secrets from the settings store', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings });
    await store.createAgent(
      agent({
        id: 'agent_sweep',
        mcpServers: [mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] })],
      }),
    );
    await settings.setSetting('mcp.linear-mcp.bearer', 'tok');
    await settings.setSetting('mcp.linear-mcp.header.X-Api-Key', 'val');

    const response = await app.request('/admin/api/agents/agent_sweep', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(response.status, 204);
    assert.equal(await settings.getSetting('mcp.linear-mcp.bearer'), undefined);
    assert.equal(await settings.getSetting('mcp.linear-mcp.header.X-Api-Key'), undefined);
  } finally {
    settings.close?.();
    store.close();
  }
});
