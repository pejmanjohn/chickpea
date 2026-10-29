import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { AuthPrincipal } from '../src/auth/types.ts';
import { connectionAccountOAuthRef } from '../src/config/api-oauth.ts';
import { mcpOAuthSettingKeys } from '../src/config/mcp-oauth.ts';
import { createMcpGuardedFetch } from '../src/config/mcp-url.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { ConnectionAccountPolicy } from '../src/config/types.ts';
import { ConnectionAccountService } from '../src/connections/store.ts';
import type { IdentityResolution } from '../src/identity/types.ts';
import { discoverOpenMcpServer, testManagedConnection } from '../src/management/discovery.ts';
import type { ManagementMcpConnection } from '../src/management/agent-connections.ts';
import { invokeWorkspaceManagementTool, type WorkspaceManagementToolResult } from '../src/management/tool-adapter.ts';
import type { ManagementApplyResult, ManagementWorkspaceSnapshot } from '../src/management/types.ts';
import { withConnectionNetwork } from './helpers/connection-network.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

interface FakeServer {
  /** The header and value this server requires, or undefined for an open server. */
  credential?: { header: string; value: string };
  tools: string[];
}

/**
 * Remote MCP servers keyed by origin, behind the real Node guarded fetch. Only
 * DNS and the final HTTPS exchange are faked; origin pinning, the public
 * address check, and the per-request authorization fence still run.
 */
function fakeRemoteServers() {
  const servers = new Map<string, FakeServer>();
  const requests: Request[] = [];
  const respond = async (request: Request): Promise<Response> => {
    requests.push(request.clone());
    const server = servers.get(new URL(request.url).origin);
    if (!server) return new Response('not found', { status: 404 });
    if (server.credential &&
        request.headers.get(server.credential.header) !== server.credential.value) {
      return new Response('unauthorized', { status: 401 });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const rpc = await request.json() as { id?: number; method: string };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const result = rpc.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { tools: server.tools.map((name) => ({ name, inputSchema: { type: 'object' } })) };
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  };
  return {
    servers,
    requests,
    createGuardedFetch: ((options) => createMcpGuardedFetch({
      ...options,
      cloudflare: false,
      resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetch: respond,
    })) satisfies typeof createMcpGuardedFetch,
    requestsTo(origin: string) {
      return requests.filter((request) => new URL(request.url).origin === origin);
    },
  };
}

async function fixture() {
  const settings = new SqliteSettingsStore(':memory:');
  const remote = fakeRemoteServers();
  const f = await createManagementAdapterFixture('test-connection', {
    testConnection: (input) => testManagedConnection({
      ...input,
      config: f.config,
      identity: f.identity,
      settings,
      createGuardedFetch: remote.createGuardedFetch,
      connectionCheck: { cloudflare: true },
    }),
    discoverMcpServer: (server) => discoverOpenMcpServer({ server, createGuardedFetch: remote.createGuardedFetch }),
  });
  const workspaceId = f.owner.user.slackTeamId;
  const member = await addMember(f, 'U11223344');
  const otherMember = await addMember(f, 'U55667788');
  const agent = await f.config.createAgent({
    id: 'agent_test_connection', name: 'Connection tester', instructions: 'Answer directly.',
    enabled: true, kind: 'user', creatorMembershipId: member.membership.id,
    editPolicy: 'all_workspace_members', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  const accounts = new ConnectionAccountService({ config: f.config, settings });
  /** Create the connection the way Admin's Custom connection form does. */
  const createConnection = async (input: {
    by: IdentityResolution;
    ownerKind: 'team' | 'member';
    policy: ConnectionAccountPolicy;
    credential?: string;
    agentId?: string;
    providerId?: string;
    allowedCapabilities?: string[];
  }) => (await accounts.createForAgent({
    principal: principal(input.by),
    agentId: input.agentId ?? agent.id,
    workspaceId,
    ownerKind: input.ownerKind,
    providerId: input.providerId ?? 'fixture',
    label: 'Fixture MCP',
    policy: input.policy,
    ...(input.credential ? { credential: input.credential } : {}),
    allowedCapabilities: input.allowedCapabilities ?? ['fixture_status'],
  })).account;
  /** Calls test_connection through the tool adapter, as both doors do. */
  const testAs = (
    by: IdentityResolution,
    connectionId: string,
    agentId = agent.id,
    path?: string,
  ): Promise<WorkspaceManagementToolResult> => invokeWorkspaceManagementTool({
    service: f.service,
    resolveContext: async () => ({
      userId: by.user.id,
      membershipId: by.membership.id,
      organizationId: by.membership.organizationId,
      origin: { kind: 'mcp', clientId: 'test-connection' },
    }),
  }, 'test_connection', { agentId, connectionId, ...(path === undefined ? {} : { path }) });
  const admin = f.admin;
  return {
    ...f, settings, remote, agent, member, otherMember, admin, workspaceId, createConnection, testAs,
    close() { settings.close(); f.close(); },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A ready team OAuth connection whose stored access token has expired, so the
 * next test refreshes it. `refresh.during` runs while the token endpoint answers.
 */
async function expiredOAuthConnection(t: TestContext, f: Fixture) {
  const origin = 'https://oauth-refresh.example.com';
  const url = `${origin}/mcp`;
  f.remote.servers.set(origin, {
    credential: { header: 'authorization', value: 'Bearer refreshed-access-token' },
    tools: ['fixture_status'],
  });
  const created = await f.createConnection({
    by: f.admin, ownerKind: 'team', policy: mcpPolicy(url, { authMode: 'oauth' }),
  });
  const account = await f.config.putConnectionAccount({ ...created, lifecycle: 'ready' }, created.revision);
  const tokenKey = mcpOAuthSettingKeys(connectionAccountOAuthRef(account.id))[2];
  await f.settings.setSetting(tokenKey, JSON.stringify({
    serverUrl: url, authorizationServerUrl: 'https://auth.example.com',
    metadata: {
      issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token', response_types_supported: ['code'],
    },
    resource: url, clientInformation: { client_id: 'client' },
    tokens: {
      access_token: 'expired-access-token', refresh_token: 'refresh-token', token_type: 'Bearer', expires_in: 3600,
    },
    obtainedAt: Date.now() - 2 * 3_600_000,
  }));
  const refresh = { requests: 0, during: async () => {} };
  // The Worker target sends the OAuth refresh through globalThis.fetch.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new Request(input, init).url, 'https://auth.example.com/token');
    refresh.requests += 1;
    await refresh.during();
    return Response.json({
      access_token: 'refreshed-access-token', refresh_token: 'rotated-refresh-token',
      token_type: 'Bearer', expires_in: 3600,
    });
  });
  return {
    account,
    refresh,
    async storedTokens(): Promise<{ access_token: string; refresh_token?: string } | undefined> {
      const raw = await f.settings.getSetting(tokenKey);
      return raw ? (JSON.parse(raw) as { tokens: { access_token: string; refresh_token?: string } }).tokens : undefined;
    },
  };
}

async function addMember(
  f: Awaited<ReturnType<typeof createManagementAdapterFixture>>,
  slackUserId: string,
): Promise<IdentityResolution> {
  return (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId,
    displayName: slackUserId,
  })).resolution;
}

function principal(resolution: IdentityResolution): AuthPrincipal {
  return {
    userId: resolution.user.id,
    membershipId: resolution.membership.id,
    organizationId: resolution.membership.organizationId,
    role: resolution.membership.role,
    authenticatorKind: 'session',
    credentialId: `session:${resolution.membership.id}`,
    correlationId: 'test-connection',
    machine: false,
  };
}

function mcpPolicy(
  url: string,
  overrides: Partial<Extract<ConnectionAccountPolicy, { kind: 'mcp' }>> = {},
): ConnectionAccountPolicy {
  return {
    kind: 'mcp', url, transport: 'streamable-http', authMode: 'none', headerNames: [],
    discoveredTools: [{ name: 'fixture_status' }], allowedTools: ['fixture_status'],
    ...overrides,
  };
}

/** The check test_connection returned. */
function outcome(response: WorkspaceManagementToolResult): Record<string, unknown> & { kind: string } {
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: Record<string, unknown> & { kind: string } }).result;
}

function toolNames(response: WorkspaceManagementToolResult): string[] {
  const result = outcome(response);
  assert.equal(result.kind, 'ok', `expected a passing test, got ${JSON.stringify(result)}`);
  return (result.tools as Array<{ name: string }>).map(({ name }) => name);
}

const NOT_FOUND = { ok: false, error: { code: 'invalid_request', message: 'The connection was not found.' } };

test('test_connection tests an Admin-created bearer-token MCP connection with its saved credential', async () => {
  const f = await fixture();
  try {
    const origin = 'https://bearer.example.com';
    f.remote.servers.set(origin, {
      credential: { header: 'authorization', value: 'Bearer bearer-secret' },
      tools: ['fixture_status'],
    });
    const account = await f.createConnection({
      by: f.admin, ownerKind: 'team', credential: 'bearer-secret',
      policy: mcpPolicy(`${origin}/mcp`, { authMode: 'bearer' }),
    });

    assert.deepEqual(toolNames(await f.testAs(f.member, account.id)), ['fixture_status']);
    assert.ok(f.remote.requestsTo(origin).length > 0);
  } finally { f.close(); }
});

test('test_connection sends a header-credential MCP connection its saved key with the prefix', async () => {
  const f = await fixture();
  try {
    const origin = 'https://header.example.com';
    f.remote.servers.set(origin, {
      credential: { header: 'x-api-key', value: 'Key header-secret' },
      tools: ['fixture_status', 'fixture_search'],
    });
    const account = await f.createConnection({
      by: f.admin, ownerKind: 'team', credential: 'header-secret',
      policy: mcpPolicy(`${origin}/mcp`, {
        headerNames: ['x-api-key'], credentialHeaderName: 'x-api-key', credentialValuePrefix: 'Key ',
      }),
    });

    assert.deepEqual(toolNames(await f.testAs(f.admin, account.id)), ['fixture_status', 'fixture_search']);
  } finally { f.close(); }
});

test('test_connection tests an Admin-created OAuth MCP connection once its sign-in completes', async () => {
  const f = await fixture();
  try {
    const origin = 'https://oauth.example.com';
    const url = `${origin}/mcp`;
    f.remote.servers.set(origin, {
      credential: { header: 'authorization', value: 'Bearer oauth-access-token' },
      tools: ['fixture_status'],
    });
    const account = await f.createConnection({
      by: f.admin, ownerKind: 'team', policy: mcpPolicy(url, { authMode: 'oauth' }),
    });

    // Before sign-in the connection is listed but not ready, and nothing is sent.
    assert.deepEqual(outcome(await f.testAs(f.member, account.id)), {
      kind: 'inconclusive',
      detail: 'This connection is not ready for this Agent. Finish its setup, then test it again.',
    });
    assert.equal(f.remote.requestsTo(origin).length, 0);

    // What the OAuth callback stores: the token bundle, then a ready account.
    await f.settings.setSetting(mcpOAuthSettingKeys(connectionAccountOAuthRef(account.id))[2], JSON.stringify({
      serverUrl: url, authorizationServerUrl: 'https://auth.example.com',
      metadata: {
        issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token', response_types_supported: ['code'],
      },
      resource: url, clientInformation: { client_id: 'client' },
      tokens: { access_token: 'oauth-access-token', token_type: 'Bearer', expires_in: 3600 },
      obtainedAt: Date.now(),
    }));
    await f.config.putConnectionAccount({ ...account, lifecycle: 'ready' }, account.revision);

    assert.deepEqual(toolNames(await f.testAs(f.member, account.id)), ['fixture_status']);
  } finally { f.close(); }
});

test('an Admin save during a test\'s OAuth refresh keeps the refreshed team token', async (t) => {
  const f = await fixture();
  try {
    const { account, refresh, storedTokens } = await expiredOAuthConnection(t, f);
    refresh.during = async () => {
      const current = (await f.config.listConnectionAccounts(f.workspaceId)).find(({ id }) => id === account.id)!;
      await f.config.putConnectionAccount({ ...current, label: 'Renamed MCP' }, current.revision);
    };

    // The test in flight is refused because the connection changed under it.
    assert.notEqual(outcome(await f.testAs(f.member, account.id)).kind, 'ok');
    assert.deepEqual(await storedTokens(), {
      access_token: 'refreshed-access-token', refresh_token: 'rotated-refresh-token',
      token_type: 'Bearer', expires_in: 3600,
    });
    assert.deepEqual(toolNames(await f.testAs(f.member, account.id)), ['fixture_status']);
    assert.equal(refresh.requests, 1);
  } finally { f.close(); }
});

test('a tester suspended during a test\'s OAuth refresh does not delete the team token', async (t) => {
  const f = await fixture();
  try {
    const { account, refresh, storedTokens } = await expiredOAuthConnection(t, f);
    refresh.during = async () => {
      await f.identity.updateMembershipAuthority({
        membershipId: f.member.membership.id, status: 'suspended', actorMembershipId: f.owner.membership.id,
        authenticationSurface: 'better_auth', correlationId: 'suspend-tester', reasonCode: 'owner_suspended_member',
      });
    };

    assert.notEqual(outcome(await f.testAs(f.member, account.id)).kind, 'ok');
    assert.equal((await storedTokens())?.access_token, 'refreshed-access-token');
    assert.deepEqual(toolNames(await f.testAs(f.admin, account.id)), ['fixture_status']);
    assert.equal(refresh.requests, 1);
  } finally { f.close(); }
});

test('test_connection names a connection by the id inspect_workspace gives it', async () => {
  const f = await fixture();
  try {
    const origin = 'https://named.example.com';
    f.remote.servers.set(origin, { tools: ['fixture_status'] });
    await f.createConnection({ by: f.admin, ownerKind: 'team', policy: mcpPolicy(`${origin}/mcp`, { authMode: 'none' }) });

    assert.deepEqual(toolNames(await f.testAs(f.member, 'fixture')), ['fixture_status']);
  } finally { f.close(); }
});

test('test_connection keeps personal connections personal and Agent bindings exact', async () => {
  const f = await fixture();
  try {
    const origin = 'https://personal.example.com';
    f.remote.servers.set(origin, {
      credential: { header: 'authorization', value: 'Bearer member-secret' },
      tools: ['fixture_status'],
    });
    const personal = await f.createConnection({
      by: f.member, ownerKind: 'member', credential: 'member-secret',
      policy: mcpPolicy(`${origin}/mcp`, { authMode: 'bearer' }),
    });
    assert.deepEqual(toolNames(await f.testAs(f.member, personal.id)), ['fixture_status']);
    const sentByOwner = f.remote.requestsTo(origin).length;

    // Another member's personal connection is not found, whatever the caller's role.
    assert.deepEqual(await f.testAs(f.otherMember, personal.id), NOT_FOUND);
    assert.deepEqual(await f.testAs(f.owner, personal.id), NOT_FOUND);
    assert.equal(f.remote.requestsTo(origin).length, sentByOwner, 'a refused test sends nothing');

    // A connection bound to a different Agent is not this Agent's to test.
    const otherAgent = await f.config.createAgent({
      ...f.agent, id: 'agent_test_connection_other', name: 'Other connection tester',
    });
    const elsewhere = await f.createConnection({
      by: f.admin, ownerKind: 'team', agentId: otherAgent.id,
      policy: mcpPolicy('https://elsewhere.example.com/mcp'),
    });
    assert.deepEqual(await f.testAs(f.admin, elsewhere.id), NOT_FOUND);
  } finally { f.close(); }
});

const REPORTS_POLICY: ConnectionAccountPolicy = {
  kind: 'api',
  allowedHosts: ['reports.example.com'],
  pathPrefixes: ['/v1'],
  headerName: 'Authorization',
  headerValuePrefix: 'Bearer ',
  allowedMethods: ['GET', 'HEAD', 'POST', 'DELETE'],
  authMode: 'credential',
};

test('test_connection checks an API connection with its saved key: one GET inside its scope, never the key back', async () => {
  const f = await fixture();
  try {
    const account = await f.createConnection({
      by: f.admin, ownerKind: 'team', providerId: 'reports', credential: 'sk-reports-saved', policy: REPORTS_POLICY,
      allowedCapabilities: [],
    });
    await withConnectionNetwork((request) => {
      if (request.headers.get('authorization') !== 'Bearer sk-reports-saved') {
        return Response.json({ message: 'Invalid token' }, { status: 401 });
      }
      if (request.url.endsWith('/admin')) return Response.json({ message: 'Missing scope' }, { status: 403 });
      return Response.json({ items: [] });
    }, async (requests) => {
      assert.deepEqual(outcome(await f.testAs(f.member, 'reports')), {
        kind: 'ok', url: 'https://reports.example.com/v1', status: 200,
      });
      assert.deepEqual(outcome(await f.testAs(f.member, account.id, f.agent.id, '/v1/reports?limit=1')), {
        kind: 'ok', url: 'https://reports.example.com/v1/reports?limit=1', status: 200,
      });
      const limited = outcome(await f.testAs(f.member, account.id, f.agent.id, '/v1/admin'));
      assert.equal(limited.kind, 'not_permitted');
      assert.equal(limited.status, 403);
      assert.deepEqual(requests.map(({ url, method }) => [method, url]), [
        ['GET', 'https://reports.example.com/v1'],
        ['GET', 'https://reports.example.com/v1/reports?limit=1'],
        ['GET', 'https://reports.example.com/v1/admin'],
      ]);

      assert.deepEqual(await f.testAs(f.member, account.id, f.agent.id, '/v2/reports'), {
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'path must be inside the connection on its first host: https://reports.example.com/v1.',
        },
      });
      assert.equal(requests.length, 3, 'a path outside the connection sends nothing');
    });

    const rotated = (await f.config.listConnectionAccounts(f.workspaceId)).find(({ id }) => id === account.id)!;
    const { saveConnectionAccountSecret } = await import('../src/config/connector-secrets.ts');
    await saveConnectionAccountSecret(rotated.secretRefId, 'sk-reports-revoked', undefined, f.settings);
    const rejected = await withConnectionNetwork(
      () => Response.json({ message: 'Invalid token sk-reports-revoked' }, { status: 401 }),
      async () => outcome(await f.testAs(f.member, account.id)),
    );
    assert.equal(rejected.kind, 'key_rejected');
    assert.equal(rejected.status, 401);
    assert.doesNotMatch(JSON.stringify(rejected), /sk-reports-revoked/);
  } finally { f.close(); }
});

test('test_connection refuses a path for an MCP connection, and a Google sign-in API connection', async () => {
  const f = await fixture();
  try {
    const origin = 'https://pathless.example.com';
    f.remote.servers.set(origin, { tools: ['fixture_status'] });
    const mcp = await f.createConnection({ by: f.admin, ownerKind: 'team', policy: mcpPolicy(`${origin}/mcp`) });
    assert.deepEqual(await f.testAs(f.admin, mcp.id, f.agent.id, '/mcp'), {
      ok: false, error: { code: 'invalid_request', message: 'path applies only to API connections.' },
    });
    assert.equal(f.remote.requestsTo(origin).length, 0);

    const google = await f.createConnection({
      by: f.admin, ownerKind: 'team', providerId: 'google', allowedCapabilities: [],
      policy: {
        kind: 'api', allowedHosts: ['gmail.googleapis.com'], pathPrefixes: ['/gmail/v1/users/me'],
        headerName: 'Authorization', headerValuePrefix: 'Bearer ', allowedMethods: ['GET', 'HEAD'],
        authMode: 'oauth', oauthProvider: 'google', oauthScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      },
    });
    assert.deepEqual(await f.testAs(f.admin, google.id), {
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Only API connections with a key and MCP connections can be tested. This one signs in with Google.',
      },
    });
  } finally { f.close(); }
});

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture();
  try {
    await f.config.ensureWorkspaceInstallation({
      workspaceId: f.workspaceId, transportMode: 'direct', defaultAgentId: f.agent.id,
    });
    await run(f);
  } finally { f.close(); }
}

async function applyAsAdmin(f: Fixture, key: string, connection: ManagementMcpConnection): Promise<ManagementApplyResult> {
  const context = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp' as const, clientId: 'test-connection' },
  };
  const snapshot = await f.service.inspectWorkspace(context) as ManagementWorkspaceSnapshot;
  const agent = snapshot.agents.find(({ id }) => id === f.agent.id)!;
  return await f.service.applyWorkspaceChanges({
    context,
    idempotencyKey: key,
    operations: [{
      itemId: 'server',
      kind: 'update_agent',
      agentId: f.agent.id,
      expectedRevision: agent.revision,
      patch: { mcpServers: [connection] },
    }],
  }) as ManagementApplyResult;
}

const wiki: ManagementMcpConnection = {
  id: 'wiki',
  displayName: 'Wiki',
  url: 'https://open-wiki.example.com/mcp',
  transport: 'streamable-http',
  authMode: 'none',
  headerNames: [],
  enabled: true,
  allowedTools: ['read_wiki_structure'],
};

test('a no-auth MCP server added through management is checked, and saves the tools it offers', () => withFixture(async (f) => {
  f.remote.servers.set('https://open-wiki.example.com', { tools: ['ask_wiki_question', 'read_wiki_structure'] });
  const result = await applyAsAdmin(f, 'add-wiki', wiki);
  assert.equal(result.status, 'completed', JSON.stringify(result.outcomes));
  assert.equal(f.remote.requestsTo('https://open-wiki.example.com').length > 0, true, 'discovery ran');
  const account = (await f.config.listConnectionAccounts(f.workspaceId)).find(({ providerId }) => providerId === 'wiki')!;
  assert.equal(account.lifecycle, 'ready');
  assert.equal(account.policy.kind, 'mcp');
  if (account.policy.kind !== 'mcp') return;
  assert.deepEqual(account.policy.discoveredTools.map(({ name }) => name), ['ask_wiki_question', 'read_wiki_structure']);
  assert.deepEqual(account.policy.allowedTools, ['read_wiki_structure']);
}));

test('an empty allowedTools on a checked no-auth server allows every tool it offers', () => withFixture(async (f) => {
  f.remote.servers.set('https://open-wiki.example.com', { tools: ['ask_wiki_question', 'read_wiki_structure'] });
  const result = await applyAsAdmin(f, 'add-wiki-all', { ...wiki, allowedTools: [] });
  assert.equal(result.status, 'completed', JSON.stringify(result.outcomes));
  const account = (await f.config.listConnectionAccounts(f.workspaceId)).find(({ providerId }) => providerId === 'wiki')!;
  assert.deepEqual(account.policy.kind === 'mcp' ? account.policy.allowedTools : [], ['ask_wiki_question', 'read_wiki_structure']);
}));

test('an allowed tool the no-auth server lacks is refused, naming the tools it has', () => withFixture(async (f) => {
  f.remote.servers.set('https://open-wiki.example.com', { tools: ['ask_wiki_question', 'read_wiki_structure'] });
  const result = await applyAsAdmin(f, 'add-wiki-stale', { ...wiki, allowedTools: ['ask_question', 'read_wiki_structure'] });
  assert.equal(result.outcomes[0]?.disposition, 'failed', JSON.stringify(result.outcomes));
  assert.equal(result.outcomes[0]?.warning,
    'Wiki does not offer ask_question. Its tools are: ask_wiki_question, read_wiki_structure.');
  assert.equal((await f.config.listConnectionAccounts(f.workspaceId)).some(({ providerId }) => providerId === 'wiki'), false,
    'nothing was saved');
}));

test('a no-auth server that cannot be reached is not saved or marked ready', () => withFixture(async (f) => {
  const result = await applyAsAdmin(f, 'add-wiki-down', { ...wiki, url: 'https://down-wiki.example.com/mcp' });
  assert.equal(result.outcomes[0]?.disposition, 'failed', JSON.stringify(result.outcomes));
  assert.match(result.outcomes[0]?.warning ?? '', /^Wiki was not saved: Chickpea could not connect to it\./);
  assert.equal((await f.config.listConnectionAccounts(f.workspaceId)).some(({ providerId }) => providerId === 'wiki'), false);
}));

test('re-pointing a no-auth server checks the new server', () => withFixture(async (f) => {
  f.remote.servers.set('https://open-wiki.example.com', { tools: ['ask_wiki_question', 'read_wiki_structure'] });
  f.remote.servers.set('https://next-wiki.example.com', { tools: ['search_pages'] });
  assert.equal((await applyAsAdmin(f, 'add-wiki-first', wiki)).status, 'completed');
  const moved = await applyAsAdmin(f, 'move-wiki', { ...wiki, url: 'https://next-wiki.example.com/mcp' });
  assert.equal(moved.outcomes[0]?.disposition, 'failed', JSON.stringify(moved.outcomes));
  assert.equal(moved.outcomes[0]?.warning, 'Wiki does not offer read_wiki_structure. Its tools are: search_pages.');
  const repointed = await applyAsAdmin(f, 'move-wiki-tools', {
    ...wiki, url: 'https://next-wiki.example.com/mcp', allowedTools: ['search_pages'],
  });
  assert.equal(repointed.status, 'completed', JSON.stringify(repointed.outcomes));
  const account = (await f.config.listConnectionAccounts(f.workspaceId)).find(({ providerId }) => providerId === 'wiki')!;
  assert.deepEqual(account.policy.kind === 'mcp' ? account.policy.discoveredTools.map(({ name }) => name) : [], ['search_pages']);
}));
