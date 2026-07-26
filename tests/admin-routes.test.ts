import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import flueApp from '../src/app.ts';
import {
  connectorCredentialSettingKey,
  connectorSecretCleanupMarkerKey,
  describeConnectorCredentialSource,
} from '../src/config/connector-secrets.ts';
import { DEFAULT_EGRESS_POLICY } from '../src/config/egress.ts';
import {
  McpOAuthError,
  mcpOAuthSettingKeys,
} from '../src/config/mcp-oauth.ts';
import type {
  CompleteMcpOAuthInput,
  McpOAuthDependencies,
  ResolveMcpOAuthAccessInput,
  StartMcpOAuthInput,
} from '../src/config/mcp-oauth.ts';
import {
  mcpSecretCleanupMarkerKey,
  saveMcpSecrets,
} from '../src/config/mcp-secrets.ts';
import type { McpConnectInput, McpDiscoveryResult } from '../src/config/mcp-test.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore, type ConfigStore } from '../src/config/store.ts';
import type {
  ApiConnectionConfig,
  CustomAgentConfig,
  McpConnectionConfig,
} from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

const ADMIN_TOKEN = 'admin-secret-token';

interface AdminHarnessOptions {
  adminToken?: string | undefined;
  settings?: SettingsStore;
  discoverMcp?: (input: McpConnectInput) => Promise<McpDiscoveryResult>;
  startMcpOAuth?: (
    input: StartMcpOAuthInput,
    dependencies: McpOAuthDependencies,
  ) => Promise<{ authorizationUrl: URL; state: string }>;
  completeMcpOAuth?: (
    input: CompleteMcpOAuthInput,
    dependencies: McpOAuthDependencies,
  ) => Promise<{ ref: { agentId: string; connectionId: string } }>;
  cancelMcpOAuth?: (
    state: string,
    dependencies: McpOAuthDependencies,
  ) => Promise<{ ref: { agentId: string; connectionId: string } }>;
  resolveMcpOAuthToken?: (
    input: ResolveMcpOAuthAccessInput,
    dependencies: McpOAuthDependencies,
  ) => Promise<string>;
  identifyMcp?: (input: {
    id: string;
    url: string;
    transport: 'streamable-http' | 'sse';
    headers: Record<string, string>;
    presetId?: string;
  }) => Promise<{ workspaceName?: string; accountName?: string } | undefined>;
}

function appWithAdmin(store: ConfigStore, adminToken?: string): Hono {
  const overrides: AdminHarnessOptions = arguments.length >= 2 ? { adminToken } : {};
  return appWithAdminOptions(store, overrides);
}

function appWithAdminOptions(store: ConfigStore, options: AdminHarnessOptions = {}): Hono {
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
      ...(options.startMcpOAuth ? { startMcpOAuth: options.startMcpOAuth } : {}),
      ...(options.completeMcpOAuth
        ? { completeMcpOAuth: options.completeMcpOAuth }
        : {}),
      ...(options.cancelMcpOAuth ? { cancelMcpOAuth: options.cancelMcpOAuth } : {}),
      ...(options.resolveMcpOAuthToken
        ? { resolveMcpOAuthToken: options.resolveMcpOAuthToken }
        : {}),
      ...(options.identifyMcp ? { identifyMcp: options.identifyMcp } : {}),
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
    enabled: true,
    lifecycleStatus: 'ready',
    statusText: 'Connected · 2 tools',
    discoveredTools: [{ name: 'search' }, { name: 'create' }],
    allowedTools: ['search'],
    ...overrides,
  };
}

function apiConnection(overrides: Partial<ApiConnectionConfig> = {}): ApiConnectionConfig {
  return {
    id: 'linear-api',
    displayName: 'Linear API',
    allowedHosts: ['api.linear.app'],
    pathPrefixes: ['/v1'],
    headerName: 'Authorization',
    headerValuePrefix: 'Bearer ',
    allowedMethods: ['GET', 'POST'],
    enabled: true,
    presetId: 'linear-api',
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
    instructions: 'Use admin-managed instructions.',
    enabled: true,
    model: 'local-stub/admin-agent',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
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

test('MCP OAuth routes expose public metadata but gate start and return no secrets', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ mcpServers: [mcpServer({ authMode: 'oauth', oauthScope: 'read write' })] })],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  const starts: StartMcpOAuthInput[] = [];
  try {
    const app = appWithAdminOptions(store, {
      settings,
      startMcpOAuth: async (input) => {
        starts.push(input);
        return {
          authorizationUrl: new URL(
            'https://auth.example.test/authorize?client_id=registered-client',
          ),
          state: 'must-not-cross-the-admin-api',
        };
      },
    });

    const metadataResponse = await app.request(
      'https://chickpea.example.test/.well-known/oauth-client-metadata.json',
    );
    assert.equal(metadataResponse.status, 200);
    assert.deepEqual(await metadataResponse.json(), {
      client_id:
        'https://chickpea.example.test/.well-known/oauth-client-metadata.json',
      redirect_uris: ['https://chickpea.example.test/oauth/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Chickpea',
    });

    const unauthorized = await app.request(
      '/admin/api/agents/agent_admin/mcp/oauth/linear-mcp/start',
      { method: 'POST', body: '{}' },
    );
    assert.equal(unauthorized.status, 401);

    const response = await app.request(
      'https://chickpea.example.test/admin/api/agents/agent_admin/mcp/oauth/linear-mcp/start',
      {
        method: 'POST',
        headers: {
          ...auth(ADMIN_TOKEN),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scope: 'tampered scope' }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      authorizationUrl:
        'https://auth.example.test/authorize?client_id=registered-client',
    });
    assert.deepEqual(starts, [
      {
        ref: { agentId: 'agent_admin', connectionId: 'linear-mcp' },
        serverUrl: 'https://mcp.linear.app/mcp',
        callbackUrl: 'https://chickpea.example.test/oauth/callback',
        scope: 'read write',
      },
    ]);
  } finally {
    settings.close();
    store.close();
  }
});

test('MCP OAuth callback is public, state-gated, enables all tools on first connect, and redirects with status only', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({
      mcpServers: [mcpServer({
        id: 'notion',
        displayName: 'Notion',
        url: 'https://mcp.notion.com/mcp',
        authMode: 'oauth',
        lifecycleStatus: 'pending',
        statusText: '',
        headerNames: ['X-Tenant'],
        discoveredTools: [],
        allowedTools: [],
        presetId: 'notion',
      })],
    })],
    assignments: [],
  });
  const completed: CompleteMcpOAuthInput[] = [];
  const cancelled: string[] = [];
  const discoveryCalls: McpConnectInput[] = [];
  const identityCalls: Array<Record<string, unknown>> = [];
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await saveMcpSecrets(
      { agentId: 'agent_admin', connectionId: 'notion' },
      { headers: { 'X-Tenant': 'tenant-1' } },
      undefined,
      settings,
    );
    const app = appWithAdminOptions(store, {
      settings,
      completeMcpOAuth: async (input) => {
        completed.push(input);
        return {
          ref: { agentId: 'agent_admin', connectionId: 'notion' },
        };
      },
      cancelMcpOAuth: async (state) => {
        cancelled.push(state);
        return {
          ref: { agentId: 'agent_admin', connectionId: 'notion' },
        };
      },
      resolveMcpOAuthToken: async () => 'notion-access-token',
      discoverMcp: async (input) => {
        discoveryCalls.push(input);
        return {
          tools: [
            { name: 'notion-search', description: 'Search Notion.' },
            { name: 'notion-fetch', description: 'Fetch from Notion.' },
          ],
        };
      },
      identifyMcp: async (input) => {
        identityCalls.push(input);
        return {
          workspaceName: "Pejman Pour-Moezzi's Notion",
          accountName: 'Pejman Pour-Moezzi',
        };
      },
    });

    const success = await app.request(
      'https://chickpea.example.test/oauth/callback?code=provider-code&state=opaque-state',
      { redirect: 'manual' },
    );
    assert.equal(success.status, 303);
    assert.equal(
      success.headers.get('location'),
      '/admin/profiles/agent_admin?oauth=connected&connection=notion',
    );
    assert.equal(success.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(success.headers.get('cache-control'), 'no-store');
    assert.deepEqual(completed, [
      { code: 'provider-code', state: 'opaque-state' },
    ]);
    assert.equal(success.headers.get('location')?.includes('provider-code'), false);
    assert.equal(discoveryCalls.length, 1);
    assert.equal(discoveryCalls[0]?.headers.Authorization, 'Bearer notion-access-token');
    assert.equal(discoveryCalls[0]?.headers['X-Tenant'], 'tenant-1');
    assert.equal(identityCalls.length, 1);
    assert.equal(identityCalls[0]?.headers, discoveryCalls[0]?.headers);
    const connected = (await store.getAgent('agent_admin')).mcpServers[0];
    assert.equal(connected?.lifecycleStatus, 'ready');
    assert.equal(connected?.statusText, 'Connected · 2 tools');
    assert.deepEqual(connected?.allowedTools, ['notion-search', 'notion-fetch']);
    assert.deepEqual(connected?.identity, {
      workspaceName: "Pejman Pour-Moezzi's Notion",
      accountName: 'Pejman Pour-Moezzi',
    });
    assert.equal(typeof connected?.lastCheckedAt, 'number');

    const denied = await app.request(
      'https://chickpea.example.test/oauth/callback?error=access_denied&state=denied-state',
      { redirect: 'manual' },
    );
    assert.equal(denied.status, 303);
    assert.equal(
      denied.headers.get('location'),
      '/admin/profiles/agent_admin?oauth=cancelled&connection=notion',
    );
    assert.deepEqual(cancelled, ['denied-state']);

    const providerFailure = await app.request(
      'https://chickpea.example.test/oauth/callback?error=server_error&state=failed-state',
      { redirect: 'manual' },
    );
    assert.equal(providerFailure.status, 303);
    assert.equal(
      providerFailure.headers.get('location'),
      '/admin/profiles/agent_admin?oauth=failed&connection=notion',
    );
    assert.deepEqual(cancelled, ['denied-state', 'failed-state']);

    const malformed = await app.request(
      'https://chickpea.example.test/oauth/callback?code=provider-code',
      { redirect: 'manual' },
    );
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'invalid_request' });
  } finally {
    settings.close();
    store.close();
  }
});

test('MCP OAuth reconnect preserves approvals without enabling newly discovered tools', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({
      mcpServers: [mcpServer({
        authMode: 'oauth',
        discoveredTools: [
          { name: 'search', description: 'Search Linear.' },
          { name: 'create', description: 'Create a Linear issue.' },
          { name: 'legacy', description: 'A removed Linear tool.' },
        ],
        allowedTools: ['search', 'legacy'],
      })],
    })],
    assignments: [],
  });
  try {
    const app = appWithAdminOptions(store, {
      completeMcpOAuth: async () => ({
        ref: { agentId: 'agent_admin', connectionId: 'linear-mcp' },
      }),
      resolveMcpOAuthToken: async () => 'linear-access-token',
      discoverMcp: async () => ({
        tools: [
          { name: 'search', description: 'Search Linear.' },
          { name: 'create', description: 'Create a Linear issue.' },
          { name: 'get', description: 'Get a Linear issue.' },
        ],
      }),
    });

    const response = await app.request(
      'https://chickpea.example.test/oauth/callback?code=provider-code&state=opaque-state',
      { redirect: 'manual' },
    );

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      '/admin/profiles/agent_admin?oauth=connected&connection=linear-mcp',
    );
    const connected = (await store.getAgent('agent_admin')).mcpServers[0];
    assert.deepEqual(connected?.discoveredTools, [
      { name: 'search', description: 'Search Linear.' },
      { name: 'create', description: 'Create a Linear issue.' },
      { name: 'get', description: 'Get a Linear issue.' },
    ]);
    assert.deepEqual(connected?.allowedTools, ['search']);
  } finally {
    store.close();
  }
});

test('MCP OAuth callback preserves tool policy across post-authorization verification failures', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({
      mcpServers: [mcpServer({
        id: 'notion',
        displayName: 'Notion',
        url: 'https://mcp.notion.com/mcp',
        authMode: 'oauth',
        lifecycleStatus: 'pending',
        statusText: '',
        discoveredTools: [
          { name: 'notion-search', description: 'Search Notion.' },
          { name: 'notion-update', description: 'Update Notion.' },
        ],
        allowedTools: ['notion-search'],
        presetId: 'notion',
      })],
    })],
    assignments: [],
  });
  try {
    const app = appWithAdminOptions(store, {
      completeMcpOAuth: async () => ({
        ref: { agentId: 'agent_admin', connectionId: 'notion' },
      }),
      resolveMcpOAuthToken: async () => 'notion-access-token',
      discoverMcp: async () => {
        throw new Error('connect timeout after 8000ms with remote-secret');
      },
    });

    const response = await app.request(
      'https://chickpea.example.test/oauth/callback?code=provider-code&state=opaque-state',
      { redirect: 'manual' },
    );

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      '/admin/profiles/agent_admin?oauth=verification_failed&connection=notion',
    );
    const failed = (await store.getAgent('agent_admin')).mcpServers[0];
    assert.equal(failed?.lifecycleStatus, 'failed');
    assert.match(failed?.statusText ?? '', /did not respond in time/i);
    assert.doesNotMatch(failed?.statusText ?? '', /remote-secret/);
    assert.deepEqual(failed?.discoveredTools, [
      { name: 'notion-search', description: 'Search Notion.' },
      { name: 'notion-update', description: 'Update Notion.' },
    ]);
    assert.deepEqual(failed?.allowedTools, ['notion-search']);
  } finally {
    store.close();
  }
});

test('MCP OAuth callback returns exchange failures to the affected connection', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ mcpServers: [mcpServer({ authMode: 'oauth' })] })],
    assignments: [],
  });
  const state = Buffer.from(
    JSON.stringify({ a: 'agent_admin', c: 'linear-mcp', n: 'nonce' }),
  ).toString('base64url');
  try {
    const app = appWithAdminOptions(store, {
      completeMcpOAuth: async () => {
        throw new McpOAuthError(
          'oauth_unavailable',
          'authorization-code exchange failed',
        );
      },
    });

    const response = await app.request(
      `https://chickpea.example.test/oauth/callback?code=provider-code&state=${state}`,
      { redirect: 'manual' },
    );

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      '/admin/profiles/agent_admin?oauth=failed&connection=linear-mcp',
    );
    assert.equal(response.headers.get('location')?.includes('provider-code'), false);
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
    const loginResponse = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: ADMIN_TOKEN }).toString(),
    });

    assert.equal(apiResponse.status, 404);
    assert.equal(pageResponse.status, 404);
    assert.equal(loginResponse.status, 404);
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
    assert.match(await page.text(), /Chickpea/);
  } finally {
    store.close();
  }
});

test('admin POST login exchanges the body token for a hashed HttpOnly cookie', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    const login = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: ADMIN_TOKEN, returnTo: '/admin' }).toString(),
    });
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

    // Query parameters are never credentials: GETs cannot create a session,
    // even if they carry the right token.
    const queryAttempt = await app.request(`/admin?token=${ADMIN_TOKEN}`);
    assert.equal(queryAttempt.status, 401);
    assert.equal(queryAttempt.headers.get('set-cookie'), null);

    // The return path is local admin UI only; an absolute URL cannot turn the
    // login exchange into an open redirect.
    const unsafeReturn = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: ADMIN_TOKEN,
        returnTo: 'https://example.test/steal',
      }).toString(),
    });
    assert.equal(unsafeReturn.status, 303);
    assert.equal(unsafeReturn.headers.get('location'), '/admin');
  } finally {
    store.close();
  }
});

test('client-routed admin paths serve the SPA page and POST login keeps a safe deep path', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    // A deep page path serves the same SPA (client router takes it from there).
    const page = await app.request('/admin/profiles/agent_default', { headers: auth(ADMIN_TOKEN) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Chickpea/);

    const channelsHub = await app.request('/admin/channels', { headers: auth(ADMIN_TOKEN) });
    assert.equal(channelsHub.status, 200);
    assert.match(await channelsHub.text(), /Chickpea/);

    // A body-authenticated login can return to the same client-routed path.
    const login = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: ADMIN_TOKEN, returnTo: '/admin/profiles' }).toString(),
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/admin/profiles');
    assert.match(login.headers.get('set-cookie') ?? '', /flue_admin=/);

    // An unauthenticated deep page GET gets the HTML login form, not JSON.
    const anon = await app.request('/admin/channels/T_X/C_Y');
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('content-type') ?? '', /text\/html/);
    assert.match(
      await anon.text(),
      /name="returnTo"[^>]*value="\/admin\/channels\/T_X\/C_Y"/,
    );

    // Unknown API paths stay 404 — never swallowed by the SPA catch-all.
    const api = await app.request('/admin/api/nope', { headers: auth(ADMIN_TOKEN) });
    assert.equal(api.status, 404);
  } finally {
    store.close();
  }
});

test('unauthenticated page GET renders a login form while XHR/API still gets JSON 401', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    // A browser navigating to /admin with no session gets the POST token-entry
    // form (401, HTML) instead of a bare JSON error.
    const page = await app.request('/admin');
    assert.equal(page.status, 401);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.match(html, /name="token"/);
    assert.match(html, /method="post" action="\/admin\/login"/);
    assert.match(html, /Sign in to Chickpea/);

    // A rejected body token is never echoed and never creates a session.
    const rejected = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'do-not-reflect', returnTo: '/admin' }).toString(),
    });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('set-cookie'), null);
    const rejectedHtml = await rejected.text();
    assert.match(rejectedHtml, /was not accepted/);
    assert.doesNotMatch(rejectedHtml, /do-not-reflect/);

    // API/XHR callers under /admin/* keep the JSON 401 they can handle.
    const api = await app.request('/admin/api/agents');
    assert.equal(api.status, 401);
    assert.deepEqual(await api.json(), { error: 'unauthorized' });
  } finally {
    store.close();
  }
});

test('admin login rejects non-form and oversized bodies without setting a cookie', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const nonForm = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    assert.equal(nonForm.status, 401);
    assert.equal(nonForm.headers.get('set-cookie'), null);

    const oversizedRequest = new Request('http://localhost/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new Blob([
        new URLSearchParams({ token: '🐣'.repeat(2_048) }).toString(),
      ]),
    });
    assert.equal(oversizedRequest.headers.get('content-length'), null);
    const oversized = await app.request(oversizedRequest);
    assert.equal(oversized.status, 401);
    assert.equal(oversized.headers.get('set-cookie'), null);
    assert.doesNotMatch(await oversized.text(), /🐣{16}/);
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

test('admin API rejects enabled connections whose URL scopes overlap', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    // Both cover api.example.com and one path is a segment-ancestor of the other,
    // so a request under /repos/issues would match both and merge both secrets.
    const overlapping = agent({
      apiConnections: [
        apiConnection({
          id: 'gh-broad',
          displayName: 'GitHub broad',
          allowedHosts: ['api.example.com'],
          pathPrefixes: ['/repos'],
        }),
        apiConnection({
          id: 'gh-narrow',
          displayName: 'GitHub narrow',
          allowedHosts: ['api.example.com'],
          pathPrefixes: ['/repos/issues'],
        }),
      ],
    });

    const response = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(overlapping),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  } finally {
    store.close();
  }
});

test('admin API rejects connector path prefixes carrying a query or fragment', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    for (const pathPrefix of ['/v1?tenant=a', '/v1#section']) {
      const response = await app.request('/admin/api/agents', {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify(
          agent({ apiConnections: [apiConnection({ pathPrefixes: [pathPrefix] })] }),
        ),
      });
      assert.equal(response.status, 400, pathPrefix);
      assert.deepEqual(await response.json(), { error: 'invalid_request' });
    }
  } finally {
    store.close();
  }
});

test('admin API accepts same-host connections with disjoint path scopes', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    // Sibling prefixes (`/repos` vs `/repos-archive`, `/orgs`) never both match a
    // single request, so each connection governs a distinct URL space.
    const distinct = agent({
      apiConnections: [
        apiConnection({
          id: 'gh-repos',
          displayName: 'GitHub repos',
          allowedHosts: ['api.example.com'],
          pathPrefixes: ['/repos', '/repos-archive'],
        }),
        apiConnection({
          id: 'gh-orgs',
          displayName: 'GitHub orgs',
          allowedHosts: ['api.example.com'],
          pathPrefixes: ['/orgs'],
        }),
      ],
    });

    const response = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(distinct),
    });

    assert.equal(response.status, 201);
  } finally {
    store.close();
  }
});

test('admin API exempts a disabled connection from the overlap check', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);

    // A disabled connection is never injected, so overlapping with it is allowed.
    const withDisabledOverlap = agent({
      apiConnections: [
        apiConnection({
          id: 'gh-active',
          displayName: 'GitHub active',
          allowedHosts: ['api.example.com'],
          pathPrefixes: ['/repos'],
          enabled: true,
        }),
        apiConnection({
          id: 'gh-parked',
          displayName: 'GitHub parked',
          allowedHosts: ['api.example.com'],
          pathPrefixes: ['/repos'],
          enabled: false,
        }),
      ],
    });

    const response = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(withDisabledOverlap),
    });

    assert.equal(response.status, 201);
  } finally {
    store.close();
  }
});

test('admin egress API defaults when unset and persists a valid allowlist policy', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings });

    const initial = await app.request('/admin/api/egress', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { policy: DEFAULT_EGRESS_POLICY });

    const saved = await app.request('/admin/api/egress', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        // Exercises scheme stripping, case folding, whitespace trimming, and
        // dedup. A path (`/path`) is rejected separately, not silently dropped.
        mode: 'allowlist',
        domains: ['api.github.com', ' https://API.GITHUB.COM '],
      }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      policy: { mode: 'allowlist', domains: ['api.github.com'] },
    });

    const reflected = await app.request('/admin/api/egress', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(reflected.status, 200);
    assert.deepEqual(await reflected.json(), {
      policy: { mode: 'allowlist', domains: ['api.github.com'] },
    });
  } finally {
    settings.close();
    store.close();
  }
});

test('admin egress API rejects invalid modes, private hosts, and oversized allowlists', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings });
    const invalidPolicies = [
      { mode: 'somewhere', domains: [] },
      { mode: 'allowlist', domains: ['10.0.0.1'] },
      { mode: 'allowlist', domains: ['localhost'] },
      // A path/port/query/fragment must be rejected, not silently widened to the
      // whole origin.
      { mode: 'allowlist', domains: ['example.com/private'] },
      { mode: 'allowlist', domains: ['example.com:8443'] },
      { mode: 'allowlist', domains: ['example.com?x=1'] },
      {
        mode: 'allowlist',
        domains: Array.from({ length: 101 }, (_, index) => `api-${index}.example.com`),
      },
    ];

    for (const policy of invalidPolicies) {
      const response = await app.request('/admin/api/egress', {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify(policy),
      });
      assert.equal(response.status, 400, JSON.stringify(policy));
      assert.deepEqual(await response.json(), { error: 'invalid_request' });
    }
  } finally {
    settings.close();
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
          instructions: 'Use admin-managed instructions.',
          enabled: true,
          skills: [],
          mcpServers: [],
          apiConnections: [],
          repositories: [],
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
        };
        assert.equal(body.automatic, undefined);
        assert.equal(Object.hasOwn(body, 'defaultModels'), false);
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

// --- API Connections -----------------------------------------------------------

test('admin API accepts exact apiConnection hosts and round-trips every field', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const connection = apiConnection({ allowedHosts: ['api.linear.app'] });
    const createdAgent = agent({ id: 'agent_api_connection', apiConnections: [connection] });

    const create = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(createdAgent),
    });
    assert.equal(create.status, 201);
    assert.deepEqual(await create.json(), { agent: createdAgent });

    const patched = [
      apiConnection({
        displayName: 'Linear API v2',
        allowedHosts: ['api.example.com'],
        pathPrefixes: ['/v2/issues'],
        headerName: 'X-Api-Key',
        headerValuePrefix: 'token ',
        allowedMethods: ['HEAD', 'PUT', 'PATCH', 'DELETE'],
        enabled: false,
        presetId: 'linear-api-v2',
      }),
    ];
    const patch = await app.request('/admin/api/agents/agent_api_connection', {
      method: 'PATCH',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ apiConnections: patched }),
    });
    assert.equal(patch.status, 200);
    const body = (await patch.json()) as { agent: CustomAgentConfig };
    assert.deepEqual(body.agent.apiConnections, patched);
  } finally {
    store.close();
  }
});

test('admin API rejects invalid apiConnection hosts, methods, and header names', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const post = (id: string, connections: unknown) =>
      app.request('/admin/api/agents', {
        method: 'POST',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify(
          agent({ id, apiConnections: connections as ApiConnectionConfig[] }),
        ),
      });

    const cases: Array<[string, ApiConnectionConfig]> = [
      ['private_host', apiConnection({ allowedHosts: ['10.0.0.1'] })],
      ['localhost', apiConnection({ allowedHosts: ['localhost'] })],
      ['wildcard_host', apiConnection({ allowedHosts: ['*.example.com'] })],
      ['empty_hosts', apiConnection({ allowedHosts: [] })],
      ['bad_method', apiConnection({ allowedMethods: ['TRACE'] })],
      ['bad_header', apiConnection({ headerName: 'Authorization:' })],
    ];
    for (const [id, connection] of cases) {
      const response = await post(`agent_api_${id}`, [connection]);
      assert.equal(response.status, 400, id);
    }

    for (const host of ['github.com', 'API.GITHUB.COM', 'api.github.com.']) {
      const response = await post(
        `agent_api_reserved_github_${host.replaceAll('.', '_').toLowerCase()}`,
        [apiConnection({ allowedHosts: [host] })],
      );
      assert.equal(response.status, 400, host);
      assert.deepEqual(await response.json(), {
        error: 'invalid_request',
        message:
          'GitHub is managed by the GitHub App integration; connect it in Settings → GitHub',
      });
    }
  } finally {
    store.close();
  }
});

test('API connection secret PUT stores a write-only credential and keeps blank values', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(
      agent({
        id: 'agent_connector',
        apiConnections: [apiConnection({ id: 'linear-api' })],
      }),
    );
    const app = appWithAdminOptions(store, { settings });
    const url = '/admin/api/agents/agent_connector/api-connections/secrets/linear-api';
    const headers = { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' };

    const response = await app.request(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: 'super-secret-credential' }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { source: 'stored' });
    assert.doesNotMatch(JSON.stringify(body), /super-secret-credential/);
    assert.equal(
      await describeConnectorCredentialSource(
        'agent_connector',
        'linear-api',
        undefined,
        settings,
      ),
      'stored',
    );
    assert.equal(
      await settings.getSetting(
        connectorCredentialSettingKey('agent_connector', 'linear-api'),
      ),
      'super-secret-credential',
    );
    assert.equal(
      await settings.getSetting(connectorSecretCleanupMarkerKey('agent_connector')),
      JSON.stringify(['connector.agent_connector.linear-api.credential']),
    );

    for (const requestBody of [{ credential: '' }, {}]) {
      const keep = await app.request(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify(requestBody),
      });
      assert.equal(keep.status, 200);
      assert.deepEqual(await keep.json(), { source: 'stored' });
    }

    const profile = await app.request('/admin/api/agents/agent_connector', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(profile.status, 200);
    assert.doesNotMatch(await profile.text(), /super-secret-credential/);

    const clear = await app.request(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ clearCredential: true }),
    });
    assert.equal(clear.status, 200);
    assert.deepEqual(await clear.json(), { source: 'missing' });
    assert.equal(
      await settings.getSetting(
        connectorCredentialSettingKey('agent_connector', 'linear-api'),
      ),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('agent GET reports each API connection credential source, not a blanket "stored"', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(
      agent({ id: 'agent_connector', apiConnections: [apiConnection({ id: 'linear-api' })] }),
    );
    const app = appWithAdminOptions(store, { settings });
    const readSource = async () => {
      const res = await app.request('/admin/api/agents/agent_connector', {
        headers: auth(ADMIN_TOKEN),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        agent: { apiConnections: Array<{ id: string; credentialSource?: string }> };
      };
      return body.agent.apiConnections[0]?.credentialSource;
    };

    // A persisted connection with no stored secret must NOT claim "stored" —
    // turn-time resolution would skip it, so the editor has to show the truth.
    assert.equal(await readSource(), 'missing');

    await app.request('/admin/api/agents/agent_connector/api-connections/secrets/linear-api', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ credential: 'super-secret-credential' }),
    });

    assert.equal(await readSource(), 'stored');
  } finally {
    settings.close();
    store.close();
  }
});

test('API connection secret PUT rejects a connection outside the profile', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(agent({ id: 'agent_connector', apiConnections: [apiConnection()] }));
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request(
      '/admin/api/agents/agent_connector/api-connections/secrets/missing-api',
      {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'orphan-secret' }),
      },
    );

    assert.equal(response.status, 404);
    assert.equal(
      await settings.getSetting(
        connectorCredentialSettingKey('agent_connector', 'missing-api'),
      ),
      undefined,
    );
    assert.equal(
      await settings.getSetting(connectorSecretCleanupMarkerKey('agent_connector')),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('API connection secret PUT removes its write when the profile disappears in flight', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let reads = 0;
  const disappearingStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getAgent') {
        return async (agentId: string) => {
          const current = await target.getAgent(agentId);
          reads += 1;
          if (reads === 1) {
            await target.deleteAgent(agentId);
          }
          return current;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ConfigStore;

  try {
    await store.createAgent(
      agent({ id: 'agent_disappearing_api', apiConnections: [apiConnection()] }),
    );
    const app = appWithAdminOptions(disappearingStore, { settings });

    const response = await app.request(
      '/admin/api/agents/agent_disappearing_api/api-connections/secrets/linear-api',
      {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'late-secret' }),
      },
    );

    assert.equal(response.status, 404);
    assert.equal(
      await settings.getSetting(
        connectorCredentialSettingKey('agent_disappearing_api', 'linear-api'),
      ),
      undefined,
    );
    assert.equal(
      await settings.getSetting(connectorSecretCleanupMarkerKey('agent_disappearing_api')),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('API connection secret DELETE clears the stored credential and returns its source', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const key = connectorCredentialSettingKey('agent_connector', 'linear-api');
    await settings.setSetting(key, 'stored-secret');
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request(
      '/admin/api/agents/agent_connector/api-connections/secrets/linear-api',
      { method: 'DELETE', headers: auth(ADMIN_TOKEN) },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { source: 'missing' });
    assert.equal(await settings.getSetting(key), undefined);
  } finally {
    settings.close();
    store.close();
  }
});

// --- MCP Connections (Task 7) -------------------------------------------------

test('admin API accepts an agent with a valid mcpServers entry and round-trips it', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const createdAgent = agent({
      id: 'agent_mcp',
      mcpServers: [mcpServer({ authMode: 'oauth', oauthScope: 'read write' })],
    });

    const create = await app.request('/admin/api/agents', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(createdAgent),
    });
    assert.equal(create.status, 201);
    assert.deepEqual(await create.json(), { agent: createdAgent });

    // A PATCH carrying only mcpServers must preserve the array verbatim.
    const patched = [mcpServer({
      id: 'linear-mcp',
      authMode: 'oauth',
      oauthScope: 'read write admin',
      allowedTools: ['search', 'create'],
      identity: {
        workspaceName: 'Engineering workspace',
        accountName: 'Admin user',
      },
    })];
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

test('POST /admin/api/agents/:agentId/mcp/test returns discovered tools on success (HTTP 200)', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const calls: McpConnectInput[] = [];
    const app = appWithAdminOptions(store, {
      discoverMcp: async (input) => {
        calls.push(input);
        return { tools: [{ name: 'search', description: 'Search things' }, { name: 'create' }] };
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
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

test('profile-scoped MCP test resolves OAuth at the request boundary', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const calls: McpConnectInput[] = [];
  const resolutions: ResolveMcpOAuthAccessInput[] = [];
  try {
    const app = appWithAdminOptions(store, {
      resolveMcpOAuthToken: async (input) => {
        resolutions.push(input);
        return 'oauth-access-token';
      },
      discoverMcp: async (input) => {
        calls.push(input);
        return { tools: [] };
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'oauth',
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(resolutions, [
      {
        ref: { agentId: 'agent_test', connectionId: 'linear-mcp' },
        serverUrl: 'https://mcp.linear.app/mcp',
      },
    ]);
    assert.equal(calls[0]?.headers.Authorization, 'Bearer oauth-access-token');
  } finally {
    store.close();
  }
});

test('profile-scoped MCP test overrides stored secrets with body-supplied values', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting('mcp.agent_test.linear-mcp.bearer', 'stored-token');
    const calls: McpConnectInput[] = [];
    const app = appWithAdminOptions(store, {
      settings,
      discoverMcp: async (input) => {
        calls.push(input);
        return { tools: [] };
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
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

test('profile-scoped MCP test backs an un-retyped header with its stored value via headerNames', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    // Operator stored X-Api-Key earlier; on re-test they don't retype it, but
    // the client sends the header NAME so the server can resolve the stored value.
    await settings.setSetting('mcp.agent_test.linear-mcp.header.X-Api-Key', 'stored-key');
    const calls: McpConnectInput[] = [];
    const app = appWithAdminOptions(store, {
      settings,
      discoverMcp: async (input) => {
        calls.push(input);
        return { tools: [] };
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
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

test('profile-scoped MCP test classifies a hung connection as timeout (HTTP 200, no raw error)', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdminOptions(store, {
      discoverMcp: async () => {
        throw new Error('connect timeout after 8000ms — raw internal detail');
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
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

test('admin sandbox settings are auth-gated and round-trip install-level controls', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings });

    const unauthorized = await app.request('/admin/api/sandbox/status');
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: 'unauthorized' });

    const initial = await app.request('/admin/api/sandbox/status', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), {
      enabled: false,
      instanceType: 'standard-1',
      allowedHosts: ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'],
      monthlySessionCap: 0,
      monthlySessionCapConfigured: false,
      target: 'node',
      workersPaidNote: null,
    });

    const saved = await app.request('/admin/api/sandbox/status', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        // A legacy caller may still send this field, but it is no longer part
        // of the PUT contract and cannot alter the deploy-time value.
        instanceType: 'standard-2',
        allowedHosts: ['registry.npmjs.org', 'files.pythonhosted.org', 'registry.npmjs.org'],
        monthlySessionCap: 450,
      }),
    });
    assert.equal(saved.status, 200);
    const savedBody = {
      enabled: true,
      instanceType: 'standard-1',
      allowedHosts: ['registry.npmjs.org', 'files.pythonhosted.org'],
      monthlySessionCap: 450,
      monthlySessionCapConfigured: true,
      target: 'node',
      workersPaidNote: null,
    };
    assert.deepEqual(await saved.json(), savedBody);

    const reflected = await app.request('/admin/api/sandbox/status', {
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(reflected.status, 200);
    assert.deepEqual(await reflected.json(), savedBody);
  } finally {
    settings.close();
    store.close();
  }
});

test('profile-scoped MCP test classifies a 401 as unauthorized (HTTP 200)', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdminOptions(store, {
      discoverMcp: async () => {
        throw new Error('HTTP 401 Unauthorized');
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
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

test('profile-scoped MCP test redacts configured query and header credentials from logs', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const warnings: string[] = [];
  const previousWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    const app = appWithAdminOptions(store, {
      discoverMcp: async (input) => {
        throw new Error(
          'upstream echoed ' +
            input.url +
            ' ' +
            input.headers.Authorization +
            ' ' +
            input.headers['X-Custom-Credential'],
        );
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
      method: 'POST',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'linear-mcp',
        url: 'https://mcp.linear.app/mcp?access_token=query-secret',
        transport: 'streamable-http',
        authMode: 'bearer',
        bearerToken: 'bearer-secret',
        headers: { 'X-Custom-Credential': 'custom-secret' },
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { ok: boolean }).ok, false);
  } finally {
    console.warn = previousWarn;
    store.close();
  }

  const logged = warnings.join('\n');
  assert.ok(logged.includes('[redacted]'));
  assert.doesNotMatch(logged, /query-secret|bearer-secret|custom-secret/);
});

test('profile-scoped MCP test returns ok:false blocked_url without connecting to a private target', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    let discoverCalled = false;
    const app = appWithAdminOptions(store, {
      discoverMcp: async () => {
        discoverCalled = true;
        return { tools: [] };
      },
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
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

test('profile-scoped MCP test returns 400 only for a schema-invalid body', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdminOptions(store, {
      discoverMcp: async () => ({ tools: [] }),
    });

    const response = await app.request('/admin/api/agents/agent_test/mcp/test', {
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

test('PUT /admin/api/agents/:agentId/mcp/secrets/:connectionId stores scoped values', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(
      agent({
        id: 'agent_alpha',
        mcpServers: [mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] })],
      }),
    );
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request('/admin/api/agents/agent_alpha/mcp/secrets/linear-mcp', {
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
    assert.equal(
      await settings.getSetting('mcp.agent_alpha.linear-mcp.bearer'),
      'super-secret-token',
    );
    assert.equal(
      await settings.getSetting('mcp.agent_alpha.linear-mcp.header.X-Api-Key'),
      'header-secret-value',
    );
    assert.equal(
      await settings.getSetting(mcpSecretCleanupMarkerKey('agent_alpha')),
      JSON.stringify([
        'mcp.agent_alpha.linear-mcp.bearer',
        'mcp.agent_alpha.linear-mcp.header.X-Api-Key',
      ]),
    );
  } finally {
    settings.close?.();
    store.close();
  }
});

test('MCP secret PUT rejects missing scopes and header names outside the connection policy', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(
      agent({
        id: 'agent_alpha',
        mcpServers: [mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] })],
      }),
    );
    const app = appWithAdminOptions(store, { settings });
    const headers = { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' };

    const missingAgent = await app.request(
      '/admin/api/agents/agent_missing/mcp/secrets/linear-mcp',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ bearerToken: 'orphan', headerNames: [] }),
      },
    );
    const missingConnection = await app.request(
      '/admin/api/agents/agent_alpha/mcp/secrets/missing-mcp',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ bearerToken: 'orphan', headerNames: [] }),
      },
    );
    const untrackedHeader = await app.request(
      '/admin/api/agents/agent_alpha/mcp/secrets/linear-mcp',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ headers: { 'X-Untracked': 'orphan' }, headerNames: [] }),
      },
    );

    assert.equal(missingAgent.status, 404);
    assert.equal(missingConnection.status, 404);
    assert.equal(untrackedHeader.status, 400);
    assert.equal(await settings.getSetting('mcp.agent_missing.linear-mcp.bearer'), undefined);
    assert.equal(await settings.getSetting('mcp.agent_alpha.missing-mcp.bearer'), undefined);
    assert.equal(
      await settings.getSetting('mcp.agent_alpha.linear-mcp.header.X-Untracked'),
      undefined,
    );
    assert.equal(await settings.getSetting(mcpSecretCleanupMarkerKey('agent_alpha')), undefined);
  } finally {
    settings.close();
    store.close();
  }
});

test('MCP secret PUT can clear an OAuth bundle without returning its values', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(
      agent({
        id: 'agent_alpha',
        mcpServers: [mcpServer({ id: 'linear-mcp', authMode: 'none' })],
      }),
    );
    const oauthKeys = mcpOAuthSettingKeys({
      agentId: 'agent_alpha',
      connectionId: 'linear-mcp',
    });
    for (const [index, key] of oauthKeys.entries()) {
      await settings.setSetting(key, `oauth-secret-${index}`);
    }
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request('/admin/api/agents/agent_alpha/mcp/secrets/linear-mcp', {
      method: 'PUT',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ headerNames: [], clearOAuth: true }),
    });

    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.clone().text(), /oauth-secret/);
    assert.deepEqual(await settings.getSettings(oauthKeys), oauthKeys.map(() => undefined));
  } finally {
    settings.close?.();
    store.close();
  }
});

test('MCP secret PUT removes its writes when the profile disappears in flight', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let reads = 0;
  const disappearingStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getAgent') {
        return async (agentId: string) => {
          const current = await target.getAgent(agentId);
          reads += 1;
          if (reads === 1) {
            await target.deleteAgent(agentId);
          }
          return current;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ConfigStore;

  try {
    await store.createAgent(
      agent({
        id: 'agent_disappearing',
        mcpServers: [mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] })],
      }),
    );
    const app = appWithAdminOptions(disappearingStore, { settings });

    const response = await app.request(
      '/admin/api/agents/agent_disappearing/mcp/secrets/linear-mcp',
      {
        method: 'PUT',
        headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({
          bearerToken: 'late-token',
          headers: { 'X-Api-Key': 'late-header' },
          headerNames: ['X-Api-Key'],
        }),
      },
    );

    assert.equal(response.status, 404);
    assert.equal(
      await settings.getSetting('mcp.agent_disappearing.linear-mcp.bearer'),
      undefined,
    );
    assert.equal(
      await settings.getSetting('mcp.agent_disappearing.linear-mcp.header.X-Api-Key'),
      undefined,
    );
    assert.equal(
      await settings.getSetting(mcpSecretCleanupMarkerKey('agent_disappearing')),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('parallel MCP secret PUTs retain cleanup inventory for every connection', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await store.createAgent(
      agent({
        id: 'agent_parallel',
        mcpServers: [
          mcpServer({ id: 'linear-mcp', headerNames: ['X-Linear-Key'] }),
          mcpServer({ id: 'github-mcp', headerNames: ['X-GitHub-Key'] }),
        ],
      }),
    );
    const app = appWithAdminOptions(store, { settings });
    const headers = { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' };

    const [linear, github] = await Promise.all([
      app.request('/admin/api/agents/agent_parallel/mcp/secrets/linear-mcp', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          bearerToken: 'linear-token',
          headers: { 'X-Linear-Key': 'linear-key' },
          headerNames: ['X-Linear-Key'],
        }),
      }),
      app.request('/admin/api/agents/agent_parallel/mcp/secrets/github-mcp', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          bearerToken: 'github-token',
          headers: { 'X-GitHub-Key': 'github-key' },
          headerNames: ['X-GitHub-Key'],
        }),
      }),
    ]);

    assert.equal(linear.status, 200);
    assert.equal(github.status, 200);
    const marker = await settings.getSetting(mcpSecretCleanupMarkerKey('agent_parallel'));
    assert.ok(marker);
    assert.deepEqual(
      new Set(JSON.parse(marker) as string[]),
      new Set([
        'mcp.agent_parallel.linear-mcp.bearer',
        'mcp.agent_parallel.linear-mcp.header.X-Linear-Key',
        'mcp.agent_parallel.github-mcp.bearer',
        'mcp.agent_parallel.github-mcp.header.X-GitHub-Key',
      ]),
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('DELETE /admin/api/agents/:agentId/mcp/secrets/:connectionId clears only scoped secrets', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting('mcp.agent_alpha.linear-mcp.bearer', 'tok');
    await settings.setSetting('mcp.agent_alpha.linear-mcp.header.X-Api-Key', 'val');
    const alphaOAuthKeys = mcpOAuthSettingKeys({
      agentId: 'agent_alpha',
      connectionId: 'linear-mcp',
    });
    for (const [index, key] of alphaOAuthKeys.entries()) {
      await settings.setSetting(key, `alpha-oauth-${index}`);
    }
    await settings.setSetting('mcp.agent_beta.linear-mcp.bearer', 'beta-tok');
    const betaOAuthTokenKey = mcpOAuthSettingKeys({
      agentId: 'agent_beta',
      connectionId: 'linear-mcp',
    })[2];
    await settings.setSetting(betaOAuthTokenKey, 'beta-oauth-token');
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request('/admin/api/agents/agent_alpha/mcp/secrets/linear-mcp', {
      method: 'DELETE',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ headerNames: ['X-Api-Key'] }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(await settings.getSetting('mcp.agent_alpha.linear-mcp.bearer'), undefined);
    assert.equal(
      await settings.getSetting('mcp.agent_alpha.linear-mcp.header.X-Api-Key'),
      undefined,
    );
    assert.deepEqual(
      await settings.getSettings(alphaOAuthKeys),
      alphaOAuthKeys.map(() => undefined),
    );
    assert.equal(await settings.getSetting('mcp.agent_beta.linear-mcp.bearer'), 'beta-tok');
    assert.equal(await settings.getSetting(betaOAuthTokenKey), 'beta-oauth-token');
  } finally {
    settings.close?.();
    store.close();
  }
});

test('profile-scoped MCP routes reject invalid agent and connection ids', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const app = appWithAdmin(store);
    const headers = { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' };
    const secretBody = JSON.stringify({ headerNames: [] });
    const testBody = JSON.stringify({
      id: 'linear-mcp',
      url: 'https://mcp.linear.app/mcp',
      transport: 'streamable-http',
      authMode: 'none',
    });

    const badAgentSecret = await app.request(
      '/admin/api/agents/agent.bad/mcp/secrets/linear-mcp',
      { method: 'PUT', headers, body: secretBody },
    );
    const badConnectionSecret = await app.request(
      '/admin/api/agents/agent_good/mcp/secrets/Not_Valid',
      { method: 'PUT', headers, body: secretBody },
    );
    const badAgentTest = await app.request('/admin/api/agents/agent.bad/mcp/test', {
      method: 'POST',
      headers,
      body: testBody,
    });

    assert.equal(badAgentSecret.status, 400);
    assert.equal(badConnectionSecret.status, 400);
    assert.equal(badAgentTest.status, 400);
  } finally {
    store.close();
  }
});

test('deleting an agent sweeps only that agent\'s connection secrets', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = appWithAdminOptions(store, { settings });
    await store.createAgent(
      agent({
        id: 'agent_sweep',
        mcpServers: [mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] })],
        apiConnections: [apiConnection({ id: 'linear-api' })],
      }),
    );
    await settings.setSetting('mcp.agent_sweep.linear-mcp.bearer', 'tok');
    await settings.setSetting('mcp.agent_sweep.linear-mcp.header.X-Api-Key', 'val');
    await settings.setSetting('mcp.agent_survivor.linear-mcp.bearer', 'survivor-token');
    await settings.setSetting(
      'connector.agent_sweep.linear-api.credential',
      'connector-secret',
    );
    await settings.setSetting(
      'connector.agent_survivor.linear-api.credential',
      'survivor-connector-secret',
    );

    const response = await app.request('/admin/api/agents/agent_sweep', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(response.status, 204);
    assert.equal(await settings.getSetting('mcp.agent_sweep.linear-mcp.bearer'), undefined);
    assert.equal(
      await settings.getSetting('mcp.agent_sweep.linear-mcp.header.X-Api-Key'),
      undefined,
    );
    assert.equal(
      await settings.getSetting('mcp.agent_survivor.linear-mcp.bearer'),
      'survivor-token',
    );
    assert.equal(
      await settings.getSetting('connector.agent_sweep.linear-api.credential'),
      undefined,
    );
    assert.equal(
      await settings.getSetting('connector.agent_survivor.linear-api.credential'),
      'survivor-connector-secret',
    );
  } finally {
    settings.close?.();
    store.close();
  }
});

test('agent deletion removes every fixed MCP OAuth setting', async () => {
  const oauthRef = { agentId: 'agent_oauth_delete', connectionId: 'linear-mcp' };
  const store = new SqliteConfigStore(':memory:', {
    agents: [
      agent({
        id: oauthRef.agentId,
        mcpServers: [mcpServer({ id: oauthRef.connectionId, authMode: 'oauth' })],
      }),
    ],
    assignments: [],
  });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    for (const key of mcpOAuthSettingKeys(oauthRef)) {
      await settings.setSetting(key, 'sensitive-oauth-state');
    }
    const app = appWithAdminOptions(store, { settings });

    const response = await app.request(
      `/admin/api/agents/${oauthRef.agentId}`,
      { method: 'DELETE', headers: auth(ADMIN_TOKEN) },
    );

    assert.equal(response.status, 204);
    assert.deepEqual(
      await settings.getSettings(mcpOAuthSettingKeys(oauthRef)),
      [undefined, undefined, undefined, undefined, undefined],
    );
    assert.equal(
      await settings.getSetting(mcpSecretCleanupMarkerKey(oauthRef.agentId)),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('agent deletion keeps a durable cleanup marker when secret deletion fails and can retry', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const persistedSettings = new SqliteSettingsStore(':memory:');
  const bearerKey = 'mcp.agent_cleanup_retry.linear-mcp.bearer';
  const headerKey = 'mcp.agent_cleanup_retry.linear-mcp.header.X-Api-Key';
  const survivorKey = 'mcp.agent_survivor.linear-mcp.bearer';
  const connectorKey = 'connector.agent_cleanup_retry.linear-api.credential';
  const survivorConnectorKey = 'connector.agent_survivor.linear-api.credential';
  let failSecretDeletion = true;
  const settings: SettingsStore = {
    getSetting: (key) => persistedSettings.getSetting(key),
    getSettings: (keys) => persistedSettings.getSettings(keys),
    setSetting: (key, value) => persistedSettings.setSetting(key, value),
    applySettingsPatch: (patch) => persistedSettings.applySettingsPatch(patch),
    mergeSettingStringSet: (key, values) =>
      persistedSettings.mergeSettingStringSet(key, values),
    deleteSetting: async (key) => {
      if (failSecretDeletion && key === connectorKey) {
        throw new Error('settings deletion unavailable');
      }
      await persistedSettings.deleteSetting(key);
    },
  };

  try {
    const connection = mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] });
    await store.createAgent(
      agent({
        id: 'agent_cleanup_retry',
        mcpServers: [connection],
        apiConnections: [apiConnection({ id: 'linear-api' })],
      }),
    );
    await persistedSettings.setSetting(bearerKey, 'tok');
    await persistedSettings.setSetting(headerKey, 'val');
    await persistedSettings.setSetting(survivorKey, 'survivor-token');
    await persistedSettings.setSetting(connectorKey, 'connector-secret');
    await persistedSettings.setSetting(survivorConnectorKey, 'survivor-connector-secret');
    const app = appWithAdminOptions(store, { settings });

    const failed = await app.request('/admin/api/agents/agent_cleanup_retry', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'internal_error' });
    assert.equal(
      (await store.listAgents()).some(({ id }) => id === 'agent_cleanup_retry'),
      false,
    );
    assert.equal(await persistedSettings.getSetting(bearerKey), undefined);
    assert.equal(await persistedSettings.getSetting(headerKey), undefined);
    assert.equal(
      await persistedSettings.getSetting(mcpSecretCleanupMarkerKey('agent_cleanup_retry')),
      undefined,
    );
    assert.equal(await persistedSettings.getSetting(connectorKey), 'connector-secret');
    assert.equal(
      await persistedSettings.getSetting(
        connectorSecretCleanupMarkerKey('agent_cleanup_retry'),
      ),
      JSON.stringify([connectorKey]),
    );
    assert.equal(await persistedSettings.getSetting(survivorKey), 'survivor-token');
    assert.equal(
      await persistedSettings.getSetting(survivorConnectorKey),
      'survivor-connector-secret',
    );

    failSecretDeletion = false;
    const retried = await app.request('/admin/api/agents/agent_cleanup_retry', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(retried.status, 204);
    assert.equal(
      (await store.listAgents()).some(({ id }) => id === 'agent_cleanup_retry'),
      false,
    );
    assert.equal(await persistedSettings.getSetting(bearerKey), undefined);
    assert.equal(await persistedSettings.getSetting(headerKey), undefined);
    assert.equal(await persistedSettings.getSetting(survivorKey), 'survivor-token');
    assert.equal(await persistedSettings.getSetting(connectorKey), undefined);
    assert.equal(
      await persistedSettings.getSetting(survivorConnectorKey),
      'survivor-connector-secret',
    );
    assert.equal(
      await persistedSettings.getSetting(mcpSecretCleanupMarkerKey('agent_cleanup_retry')),
      undefined,
    );
    assert.equal(
      await persistedSettings.getSetting(
        connectorSecretCleanupMarkerKey('agent_cleanup_retry'),
      ),
      undefined,
    );

    const missing = await app.request('/admin/api/agents/agent_cleanup_retry', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'not_found' });
  } finally {
    persistedSettings.close();
    store.close();
  }
});

test('agent deletion leaves secrets untouched when the config delete fails before commit', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let failConfigDelete = true;
  const flakyStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'deleteAgent') {
        return async (agentId: string) => {
          if (failConfigDelete) {
            throw new Error('config deletion unavailable');
          }
          return target.deleteAgent(agentId);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ConfigStore;

  try {
    const connection = mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] });
    await store.createAgent(agent({ id: 'agent_config_retry', mcpServers: [connection] }));
    const bearerKey = 'mcp.agent_config_retry.linear-mcp.bearer';
    const headerKey = 'mcp.agent_config_retry.linear-mcp.header.X-Api-Key';
    await settings.setSetting(bearerKey, 'tok');
    await settings.setSetting(headerKey, 'val');
    const app = appWithAdminOptions(flakyStore, { settings });

    const failed = await app.request('/admin/api/agents/agent_config_retry', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'internal_error' });
    assert.deepEqual((await store.getAgent('agent_config_retry')).mcpServers, [connection]);
    assert.equal(await settings.getSetting(bearerKey), 'tok');
    assert.equal(await settings.getSetting(headerKey), 'val');
    assert.equal(
      await settings.getSetting(mcpSecretCleanupMarkerKey('agent_config_retry')),
      JSON.stringify([
        bearerKey,
        headerKey,
        ...mcpOAuthSettingKeys({
          agentId: 'agent_config_retry',
          connectionId: 'linear-mcp',
        }),
      ]),
    );

    failConfigDelete = false;
    const retried = await app.request('/admin/api/agents/agent_config_retry', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(retried.status, 204);
    assert.equal(await settings.getSetting(bearerKey), undefined);
    assert.equal(await settings.getSetting(headerKey), undefined);
    assert.equal(
      await settings.getSetting(mcpSecretCleanupMarkerKey('agent_config_retry')),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('agent deletion finishes cleanup after an ambiguous post-commit config error', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const ambiguousStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'deleteAgent') {
        return async (agentId: string) => {
          await target.deleteAgent(agentId);
          throw new Error('durable object response lost after commit');
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ConfigStore;

  try {
    const connection = mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] });
    await store.createAgent(agent({ id: 'agent_ambiguous', mcpServers: [connection] }));
    const bearerKey = 'mcp.agent_ambiguous.linear-mcp.bearer';
    const headerKey = 'mcp.agent_ambiguous.linear-mcp.header.X-Api-Key';
    await settings.setSetting(bearerKey, 'tok');
    await settings.setSetting(headerKey, 'val');
    const app = appWithAdminOptions(ambiguousStore, { settings });

    const response = await app.request('/admin/api/agents/agent_ambiguous', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(response.status, 204);
    assert.equal(
      (await store.listAgents()).some(({ id }) => id === 'agent_ambiguous'),
      false,
    );
    assert.equal(await settings.getSetting(bearerKey), undefined);
    assert.equal(await settings.getSetting(headerKey), undefined);
    assert.equal(
      await settings.getSetting(mcpSecretCleanupMarkerKey('agent_ambiguous')),
      undefined,
    );
  } finally {
    settings.close();
    store.close();
  }
});

test('an assignment race leaves the live agent credentials intact and can retry', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let injectAssignment = true;
  const racingStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'deleteAgent') {
        return async (agentId: string) => {
          if (injectAssignment) {
            injectAssignment = false;
            await target.putAssignment({
              workspaceId: 'T_RACE',
              channelId: 'C_RACE',
              agentId,
              enabled: true,
            });
          }
          return target.deleteAgent(agentId);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ConfigStore;

  try {
    const connection = mcpServer({ id: 'linear-mcp', headerNames: ['X-Api-Key'] });
    await store.createAgent(agent({ id: 'agent_race', mcpServers: [connection] }));
    const bearerKey = 'mcp.agent_race.linear-mcp.bearer';
    const headerKey = 'mcp.agent_race.linear-mcp.header.X-Api-Key';
    await settings.setSetting(bearerKey, 'tok');
    await settings.setSetting(headerKey, 'val');
    const app = appWithAdminOptions(racingStore, { settings });

    const raced = await app.request('/admin/api/agents/agent_race', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(raced.status, 409);
    assert.deepEqual(await raced.json(), { error: 'agent_still_assigned' });
    assert.deepEqual((await store.getAgent('agent_race')).mcpServers, [connection]);
    assert.equal(await settings.getSetting(bearerKey), 'tok');
    assert.equal(await settings.getSetting(headerKey), 'val');

    await store.deleteAssignment('T_RACE', 'C_RACE');
    const retried = await app.request('/admin/api/agents/agent_race', {
      method: 'DELETE',
      headers: auth(ADMIN_TOKEN),
    });

    assert.equal(retried.status, 204);
    assert.equal(await settings.getSetting(bearerKey), undefined);
    assert.equal(await settings.getSetting(headerKey), undefined);
    assert.equal(await settings.getSetting(mcpSecretCleanupMarkerKey('agent_race')), undefined);
  } finally {
    settings.close();
    store.close();
  }
});
