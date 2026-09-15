import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ToolDefinition } from '@flue/runtime';

import type {
  McpServerConnection,
  McpServerOptions,
} from '../src/config/mcp-test.ts';
import {
  resolveProfileMcpConnections,
  resolveProfileMcpTools,
  resolveRuntimePlanMcpConnections,
} from '../src/config/profile-mcp.ts';
import { ConnectionCredentialUnavailableError } from '../src/connections/errors.ts';
import {
  META_ADS_ACCOUNT_HELPER,
  META_ADS_APPROVED_ACCOUNT_SCOPE,
  META_ADS_FIELD_HELPER,
} from '../src/config/meta-ads-policy.ts';
import { mcpOAuthSettingKeys } from '../src/config/mcp-oauth.ts';
import { mcpBearerEnvVar, mcpHeaderEnvVar } from '../src/config/mcp-secrets.ts';
import {
  closeNodeStateStores,
  getConfigStore,
  getSettingsStore,
} from '../src/config/state-backend.ts';
import type { McpConnectionConfig } from '../src/config/types.ts';
import { projectEffectiveMcpConnections } from '../src/connections/runtime.ts';
import type { EffectiveConnectionAccount } from '../src/connections/types.ts';
import { withEnv } from './helpers/env.ts';

// --- fixtures -------------------------------------------------------------

/** A minimal adapted ToolDefinition; the adapter names tools `mcp__<id>__<tool>`. */
function tool(name: string): ToolDefinition {
  return {
    name,
    description: '',
    input: undefined,
    output: undefined,
    run() {
      throw new Error('not used');
    },
  } as ToolDefinition;
}

function fakeConnection(tools: ToolDefinition[], onClose?: () => void): McpServerConnection {
  return {
    name: 'srv',
    tools,
    async close() {
      onClose?.();
    },
  };
}

function server(overrides: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  return {
    id: 'srv',
    displayName: 'Server',
    url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    authMode: 'none',
    headerNames: [],
    enabled: true,
    lifecycleStatus: 'ready',
    statusText: '',
    discoveredTools: [{ name: 'search' }, { name: 'create' }],
    allowedTools: ['search', 'create'],
    ...overrides,
  };
}

const metaAccountSchema = {
  propertyNames: ['ad_account_id'],
  accountFields: [{ name: 'ad_account_id' as const, type: 'string' as const, required: true }],
  ambiguous: false,
  fingerprint: 'a'.repeat(64),
};
const metaEntitySchema = {
  ...metaAccountSchema,
  propertyNames: ['ad_account_id', 'client_conversation_id', 'fields', 'object_ids'],
};
const metaReportTool = 'ads_get_ad_entities';
const metaScoreTool = 'ads_get_opportunity_score';
const metaAccountHelperSchema = {
  propertyNames: [],
  accountFields: [],
  ambiguous: false,
  fingerprint: 'b'.repeat(64),
};

function metaAccountHelperServer(overrides: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  return server({
    url: 'https://mcp.facebook.com/ads',
    presetId: 'meta-ads',
    discoveredTools: [{ name: META_ADS_ACCOUNT_HELPER, inputSchema: metaAccountHelperSchema }],
    allowedTools: [META_ADS_ACCOUNT_HELPER],
    toolPolicies: { [META_ADS_ACCOUNT_HELPER]: {
      effect: 'read', argumentConstraints: {
        [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['144860434', 'act_144860434'],
      },
    } },
    ...overrides,
  });
}

/**
 * A connect stub that dispatches per server id to a preset connection (or a
 * behavior). Records which ids it was asked to connect.
 */
function stubConnect(
  byId: Record<string, McpServerConnection | (() => Promise<McpServerConnection>)>,
): {
  fn: (name: string, options: McpServerOptions) => Promise<McpServerConnection>;
  connected: string[];
} {
  const connected: string[] = [];
  const fn = async (name: string, _options: McpServerOptions): Promise<McpServerConnection> => {
    connected.push(name);
    const entry = byId[name];
    if (entry === undefined) throw new Error('no stub for ' + name);
    return typeof entry === 'function' ? entry() : entry;
  };
  return { fn, connected };
}

const noSecretsEnv = {} as Record<string, unknown>;

// --- (a) filtering: disabled/failed/empty-allowlist never connect --

test('skips servers that are disabled, not ready, or have an empty allowlist', async () => {
  const servers: McpConnectionConfig[] = [
    server({ id: 'disabled', enabled: false }),
    server({ id: 'pending', lifecycleStatus: 'pending' }),
    server({ id: 'failed', lifecycleStatus: 'failed' }),
    server({ id: 'empty', allowedTools: [] }),
  ];
  const { fn, connected } = stubConnect({});
  const starts: string[] = [];
  const tools = await resolveProfileMcpTools(servers, {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    connect: fn,
    onConnectionStart(connection) {
      starts.push(connection.id);
    },
  });
  assert.deepEqual(connected, [], 'no filtered server should be connected');
  assert.deepEqual(starts, [], 'no filtered server should report a connection start');
  assert.deepEqual(tools, []);
});

test('returns [] without throwing when servers is undefined (pre-migration frozen snapshot)', async () => {
  // A channel snapshot frozen before mcpServers existed deserializes with the
  // field undefined; the factory must never throw.
  const { fn, connected } = stubConnect({});
  const tools = await resolveProfileMcpTools(undefined as unknown as McpConnectionConfig[], {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    connect: fn,
  });
  assert.deepEqual(tools, []);
  assert.deepEqual(connected, []);
});

// --- (c) intersection on stripped names -----------------------------------

test('exposes only approved tools, keeping the mcp__<id>__ prefix on returned names', async () => {
  const conn = fakeConnection([tool('mcp__srv__search'), tool('mcp__srv__create')]);
  const { fn } = stubConnect({ srv: conn });
  const tools = await resolveProfileMcpTools([server({ allowedTools: ['search'] })], {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    connect: fn,
  });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['mcp__srv__search'],
  );
});

test('legacy Meta resolution does not connect when selected tools lack enforceable account policy', async () => {
  const { fn, connected } = stubConnect({});
  const tools = await resolveProfileMcpTools([server({
    url: 'https://mcp.facebook.com/ads',
    presetId: 'meta-ads',
    discoveredTools: [{ name: metaReportTool }],
    allowedTools: [metaReportTool],
  })], {
    agentId: 'agent_test', env: noSecretsEnv, existingToolNames: [], connect: fn,
  });
  assert.deepEqual(tools, []);
  assert.deepEqual(connected, [], 'invalid Meta access is withheld before provider connection');
});

test('legacy Meta tools enforce exact account arguments before their run function', async () => {
  let runs = 0;
  const remoteTool = {
    name: `mcp__srv__${metaReportTool}`, description: '', input: undefined, output: undefined,
    run() { runs += 1; return 'reported'; },
  } as ToolDefinition;
  const { fn } = stubConnect({ srv: fakeConnection([remoteTool]) });
  const metaServer = server({
    url: 'https://mcp.facebook.com/ads',
    presetId: 'meta-ads',
    discoveredTools: [{ name: metaReportTool, inputSchema: metaEntitySchema }],
    allowedTools: [metaReportTool],
    toolPolicies: { [metaReportTool]: {
      effect: 'read', argumentConstraints: { ad_account_id: ['act_123'] },
    } },
  });
  const tools = await resolveProfileMcpTools([metaServer], {
    agentId: 'agent_test', env: noSecretsEnv, existingToolNames: [], connect: fn,
    resolveCurrentConnection: async () => metaServer,
  });
  assert.equal(tools.length, 1);
  await assert.rejects(async () => { await tools[0]!.run({ data: { ad_account_id: 'act_456' } } as never); }, /approved value/);
  assert.equal(runs, 0);
  await assert.rejects(async () => {
    await tools[0]!.run({ data: { ad_account_id: 'act_123', object_ids: ['other'] } } as never);
  }, /does not permit the argument object_ids/);
  assert.equal(runs, 0);
  await assert.rejects(async () => {
    await tools[0]!.run({ data: { ad_account_id: 'act_123', campaign_id: 'other' } } as never);
  }, /does not permit the argument campaign_id/);
  assert.equal(runs, 0);
  assert.equal(await tools[0]!.run({
    data: { ad_account_id: 'act_123', client_conversation_id: 'correlation-1' },
  } as never), 'reported');
  assert.equal(runs, 1);
});

test('legacy Meta tools reread policy and OAuth before provider I/O', async () => {
  const frozen = server({
    url: 'https://mcp.facebook.com/ads',
    authMode: 'oauth',
    presetId: 'meta-ads',
    discoveredTools: [{ name: metaReportTool, inputSchema: metaAccountSchema }],
    allowedTools: [metaReportTool],
    toolPolicies: { [metaReportTool]: {
      effect: 'read', argumentConstraints: { ad_account_id: ['act_123'] },
    } },
  });
  let current: McpConnectionConfig | undefined = frozen;
  let oauthGenerationCurrent = true;
  let remoteRuns = 0;
  let outbound = 0;
  const connect = async (_name: string, options: McpServerOptions): Promise<McpServerConnection> =>
    fakeConnection([{
      name: `mcp__srv__${metaReportTool}`, description: '', input: undefined, output: undefined,
      async run(context) {
        remoteRuns += 1;
        await options.fetch!('https://mcp.facebook.com/ads', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: metaReportTool, arguments: 'data' in context ? context.data : undefined } }),
        });
        return 'reported';
      },
    } as ToolDefinition]);
  const tools = await resolveProfileMcpTools([frozen], {
    agentId: 'agent_test', env: noSecretsEnv, existingToolNames: [], connect,
    resolveCurrentConnection: async () => current,
    resolveOAuthAccessToken: async () => {
      if (!oauthGenerationCurrent) throw new Error('OAuth client generation changed.');
      return 'fresh-token';
    },
    createGuardedFetch: () => async () => {
      outbound += 1;
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
    },
  });
  assert.equal(tools.length, 1);

  current = { ...frozen, allowedTools: [] };
  await assert.rejects(async () => {
    await tools[0]!.run({ data: { ad_account_id: 'act_123' } } as never);
  }, /policy changed/);
  assert.equal(remoteRuns, 0);
  assert.equal(outbound, 0);

  current = frozen;
  oauthGenerationCurrent = false;
  await assert.rejects(async () => {
    await tools[0]!.run({ data: { ad_account_id: 'act_123' } } as never);
  }, /generation changed/);
  assert.equal(remoteRuns, 1, 'the local adapter begins but cannot use its old bearer');
  assert.equal(outbound, 0, 'OAuth replacement blocks before provider network I/O');

  current = undefined;
  await assert.rejects(async () => {
    await tools[0]!.run({ data: { ad_account_id: 'act_123' } } as never);
  }, /policy changed/);
  assert.equal(remoteRuns, 1, 'disconnect blocks before the remote tool adapter runs again');
  assert.equal(outbound, 0);
});

test('legacy Meta account helper sends no fake scope argument and returns only approved accounts', async () => {
  const frozen = metaAccountHelperServer();
  let current: McpConnectionConfig | undefined = frozen;
  let outbound = 0;
  const connect = async (_name: string, options: McpServerOptions): Promise<McpServerConnection> =>
    fakeConnection([{
      name: `mcp__srv__${META_ADS_ACCOUNT_HELPER}`, description: '', input: undefined, output: undefined,
      async run(context) {
        const response = await options.fetch!('https://mcp.facebook.com/ads', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            name: META_ADS_ACCOUNT_HELPER, arguments: 'data' in context ? context.data : undefined,
          } }),
        });
        return response.json();
      },
    } as ToolDefinition]);
  const tools = await resolveProfileMcpTools([frozen], {
    agentId: 'agent_test', env: noSecretsEnv, existingToolNames: [], connect,
    resolveCurrentConnection: async () => current,
    createGuardedFetch: () => async () => {
      outbound += 1;
      return Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { accounts: [
        { id: 'act_999', is_ads_mcp_enabled: true, is_queryable: true, ad_account_name: 'Other' },
        { id: 'act_144860434', is_ads_mcp_enabled: true, is_queryable: true, currency: 'USD', ad_account_name: 'Magoosh' },
      ] } } });
    },
  });
  const result = await tools[0]!.run({ data: {} } as never);
  assert.equal(outbound, 1);
  assert.doesNotMatch(JSON.stringify(result), /999|Other/);
  assert.match(JSON.stringify(result), /144860434|Magoosh/);

  current = { ...frozen, allowedTools: [] };
  await assert.rejects(async () => { await tools[0]!.run({ data: {} } as never); }, /policy changed/);
  assert.equal(outbound, 1, 'revocation blocks before the provider request');
});

test('legacy Meta account helper blocks response release after policy changes in flight', async () => {
  const frozen = metaAccountHelperServer();
  let current: McpConnectionConfig | undefined = frozen;
  let outbound = 0;
  const connect = async (_name: string, options: McpServerOptions): Promise<McpServerConnection> =>
    fakeConnection([{
      name: `mcp__srv__${META_ADS_ACCOUNT_HELPER}`, description: '', input: undefined, output: undefined,
      async run(context) {
        const response = await options.fetch!('https://mcp.facebook.com/ads', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            name: META_ADS_ACCOUNT_HELPER, arguments: 'data' in context ? context.data : undefined,
          } }),
        });
        return response.json();
      },
    } as ToolDefinition]);
  const tools = await resolveProfileMcpTools([frozen], {
    agentId: 'agent_test', env: noSecretsEnv, existingToolNames: [], connect,
    resolveCurrentConnection: async () => current,
    createGuardedFetch: () => async () => {
      outbound += 1;
      current = { ...frozen, allowedTools: [] };
      return Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { accounts: [
        { id: 'act_144860434', is_ads_mcp_enabled: true, is_queryable: true },
      ] } } });
    },
  });
  await assert.rejects(async () => { await tools[0]!.run({ data: {} } as never); }, /policy changed/);
  assert.equal(outbound, 1);
});

test('reports connection start with policy-only identity before opening the server', async () => {
  const conn = fakeConnection([tool('mcp__srv__search')]);
  const starts: Array<{ id: string; displayName: string }> = [];
  const connect = async (): Promise<McpServerConnection> => {
    assert.deepEqual(starts, [{ id: 'srv', displayName: 'Docs search' }]);
    return conn;
  };

  await resolveProfileMcpTools([server({ displayName: 'Docs search' })], {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    connect,
    onConnectionStart(connection) {
      starts.push(connection);
    },
  });

  assert.deepEqual(starts, [{ id: 'srv', displayName: 'Docs search' }]);
});

// --- (d) approved-but-vanished tool is simply absent, no error ------------

test('an approved tool no longer discovered is absent, not an error', async () => {
  // allowlist has search+create, but the server now only exposes search.
  const conn = fakeConnection([tool('mcp__srv__search')]);
  const { fn } = stubConnect({ srv: conn });
  const tools = await resolveProfileMcpTools([server({ allowedTools: ['search', 'create'] })], {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    connect: fn,
  });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['mcp__srv__search'],
  );
});

test('runtime resolution uses the agent-scoped environment override for the same connection id', async () => {
  const seen: string[] = [];
  const connect = async (_name: string, options: McpServerOptions): Promise<McpServerConnection> => {
    seen.push(new Headers(options.headers).get('Authorization') ?? '');
    return fakeConnection([tool('mcp__srv__search')]);
  };

  await withEnv(
    {
      MCP_AGENT_AGENT_5FALPHA_CONNECTION_SRV_BEARER: 'alpha-token',
      MCP_AGENT_AGENT_5FBETA_CONNECTION_SRV_BEARER: 'beta-token',
    },
    async () => {
      await resolveProfileMcpTools([server({ authMode: 'bearer', allowedTools: ['search'] })], {
        agentId: 'agent_alpha',
        env: noSecretsEnv,
        existingToolNames: [],
        connect,
      });
      await resolveProfileMcpTools([server({ authMode: 'bearer', allowedTools: ['search'] })], {
        agentId: 'agent_beta',
        env: noSecretsEnv,
        existingToolNames: [],
        connect,
      });
    },
  );

  assert.deepEqual(seen, ['Bearer alpha-token', 'Bearer beta-token']);
});

test('Agent-owned account credentials populate preset-specific MCP headers at runtime', async () => {
  const seen: Record<string, string> = {};
  const connect = async (_name: string, options: McpServerOptions): Promise<McpServerConnection> => {
    new Headers(options.headers).forEach((value, key) => { seen[key] = value; });
    return fakeConnection([tool('mcp__srv__search')]);
  };
  const tools = await resolveProfileMcpTools([
    server({
      authMode: 'none',
      headerNames: ['Authorization'],
      credentialHeaderName: 'Authorization',
      credentialValuePrefix: 'Sentry-Bearer ',
      allowedTools: ['search'],
    }),
  ], {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    connect,
    resolveBearerCredential: async () => 'sentry-user-token',
  });

  assert.deepEqual(tools.map((entry) => entry.name), ['mcp__srv__search']);
  assert.equal(seen.authorization, 'Sentry-Bearer sentry-user-token');
});

test('Agent-owned account credential projection preserves custom headers without double-prefixing', async () => {
  const effective: EffectiveConnectionAccount = {
    account: {
      id: 'connection_sentry',
      workspaceId: 'T_TEST',
      revision: 1,
      ownerKind: 'team',
      createdByMembershipId: 'membership_owner',
      providerId: 'sentry',
      label: 'Production Sentry',
      policy: {
        kind: 'mcp',
        url: 'https://mcp.sentry.dev/mcp',
        transport: 'streamable-http',
        authMode: 'none',
        headerNames: ['Authorization'],
        credentialHeaderName: 'Authorization',
        credentialValuePrefix: 'Sentry-Bearer ',
        discoveredTools: [{ name: 'search_issues' }],
        allowedTools: ['search_issues'],
        presetId: 'sentry',
      },
      secretRefId: 'connection-account:connection_sentry',
      lifecycle: 'ready',
      createdAt: 1,
      updatedAt: 1,
    },
    binding: {
      agentId: 'agent_test',
      connectionAccountId: 'connection_sentry',
      providerId: 'sentry',
      allowedCapabilities: ['search_issues'],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    policy: {
      kind: 'mcp',
      url: 'https://mcp.sentry.dev/mcp',
      transport: 'streamable-http',
      authMode: 'none',
      headerNames: ['Authorization'],
      credentialHeaderName: 'Authorization',
      credentialValuePrefix: 'Sentry-Bearer ',
      discoveredTools: [{ name: 'search_issues' }],
      allowedTools: ['search_issues'],
      presetId: 'sentry',
    },
    scope: 'team',
  };
  const projected = projectEffectiveMcpConnections([effective]);
  const seen: Record<string, string> = {};

  await resolveProfileMcpTools(projected, {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    connect: async (_name, options) => {
      new Headers(options.headers).forEach((value, key) => { seen[key] = value; });
      return fakeConnection([tool('mcp__connection_sentry__search_issues')]);
    },
    resolveBearerCredential: async () => 'Sentry-Bearer stored-token',
  });

  assert.equal(projected[0]?.credentialHeaderName, 'Authorization');
  assert.equal(projected[0]?.credentialValuePrefix, 'Sentry-Bearer ');
  assert.equal(seen.authorization, 'Sentry-Bearer stored-token');
});

test('an optional reusable MCP credential falls back to anonymous access', async () => {
  const seen: Array<Record<string, string>> = [];
  const tools = await resolveProfileMcpTools([
    server({
      authMode: 'none',
      headerNames: ['x-api-key'],
      credentialHeaderName: 'x-api-key',
      credentialOptional: true,
      allowedTools: ['search'],
    }),
  ], {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    resolveBearerCredential: async () => { throw new ConnectionCredentialUnavailableError(); },
    connect: async (_name, options) => {
      const headers: Record<string, string> = {};
      new Headers(options.headers).forEach((value, key) => { headers[key] = value; });
      seen.push(headers);
      return fakeConnection([tool('mcp__srv__search')]);
    },
  });

  assert.deepEqual(tools.map(({ name }) => name), ['mcp__srv__search']);
  assert.deepEqual(seen, [{}]);
});

test('an optional reusable MCP credential still fails closed on authorization errors', async () => {
  let connected = false;
  const tools = await resolveProfileMcpTools([
    server({
      authMode: 'none',
      headerNames: ['x-api-key'],
      credentialHeaderName: 'x-api-key',
      credentialOptional: true,
      allowedTools: ['search'],
    }),
  ], {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    resolveBearerCredential: async () => {
      throw new Error('Connection account is not available to this actor');
    },
    connect: async () => {
      connected = true;
      return fakeConnection([tool('mcp__srv__search')]);
    },
  });

  assert.deepEqual(tools, []);
  assert.equal(connected, false);
});

test('a required reusable MCP credential never falls back to anonymous access', async () => {
  let connected = false;
  const tools = await resolveProfileMcpTools([
    server({
      authMode: 'bearer',
      allowedTools: ['search'],
    }),
  ], {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    resolveBearerCredential: async () => { throw new ConnectionCredentialUnavailableError(); },
    connect: async () => {
      connected = true;
      return fakeConnection([tool('mcp__srv__search')]);
    },
  });

  assert.deepEqual(tools, []);
  assert.equal(connected, false);
});

test('runtime resolves OAuth at connection time and injects only the bearer header', async () => {
  const seen: Array<{ ref: object; serverUrl: string; authorization: string }> = [];
  const connect = async (_name: string, options: McpServerOptions): Promise<McpServerConnection> => {
    seen[0]!.authorization =
      new Headers(options.headers).get('Authorization') ?? '';
    return fakeConnection([tool('mcp__srv__search')]);
  };

  const tools = await resolveProfileMcpTools(
    [server({ authMode: 'oauth', allowedTools: ['search'] })],
    {
      agentId: 'agent_test',
      env: noSecretsEnv,
      existingToolNames: [],
      connect,
      resolveOAuthAccessToken: async (input) => {
        seen.push({
          ref: input.ref,
          serverUrl: input.serverUrl,
          authorization: '',
        });
        return 'oauth-access-token';
      },
    },
  );

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['mcp__srv__search'],
  );
  assert.deepEqual(seen, [
    {
      ref: { agentId: 'agent_test', connectionId: 'srv' },
      serverUrl: 'https://mcp.example.com/mcp',
      authorization: 'Bearer oauth-access-token',
    },
  ]);
});

test('runtime preserves a Sentry-scoped OAuth URL and exposes only reviewed tools', async () => {
  const serverUrl = 'https://mcp.sentry.dev/mcp/acme/web-app';
  const seen: Array<{ serverUrl: string; connectedUrl: string; authorization: string }> = [];
  const tools = await resolveProfileMcpTools([server({
    id: 'sentry',
    displayName: 'Sentry',
    url: serverUrl,
    authMode: 'oauth',
    discoveredTools: [{ name: 'search_issues' }, { name: 'update_issue' }],
    allowedTools: ['search_issues'],
    presetId: 'sentry',
  })], {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    resolveOAuthAccessToken: async (input) => {
      seen.push({ serverUrl: input.serverUrl, connectedUrl: '', authorization: '' });
      return 'sentry-oauth-token';
    },
    connect: async (_name, options) => {
      seen[0]!.connectedUrl = String(options.url);
      seen[0]!.authorization = new Headers(options.headers).get('authorization') ?? '';
      return fakeConnection([
        tool('mcp__sentry__search_issues'),
        tool('mcp__sentry__update_issue'),
      ]);
    },
  });

  assert.deepEqual(seen, [{
    serverUrl,
    connectedUrl: serverUrl,
    authorization: 'Bearer sentry-oauth-token',
  }]);
  assert.deepEqual(tools.map(({ name }) => name), ['mcp__sentry__search_issues']);
});

test('runtime uses Intercom OAuth and withholds unreviewed discovered tools', async () => {
  const serverUrl = 'https://mcp.intercom.com/mcp';
  const seen: Array<{ serverUrl: string; connectedUrl: string; authorization: string }> = [];
  const tools = await resolveProfileMcpTools([server({
    id: 'intercom',
    displayName: 'Intercom',
    url: serverUrl,
    authMode: 'oauth',
    discoveredTools: [{ name: 'search_contacts' }, { name: 'delete_contact' }],
    allowedTools: ['search_contacts'],
    presetId: 'intercom',
  })], {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    resolveOAuthAccessToken: async (input) => {
      seen.push({ serverUrl: input.serverUrl, connectedUrl: '', authorization: '' });
      return 'intercom-oauth-token';
    },
    connect: async (_name, options) => {
      seen[0]!.connectedUrl = String(options.url);
      seen[0]!.authorization = new Headers(options.headers).get('authorization') ?? '';
      return fakeConnection([
        tool('mcp__intercom__search_contacts'),
        tool('mcp__intercom__delete_contact'),
      ]);
    },
  });

  assert.deepEqual(seen, [{
    serverUrl,
    connectedUrl: serverUrl,
    authorization: 'Bearer intercom-oauth-token',
  }]);
  assert.deepEqual(tools.map(({ name }) => name), ['mcp__intercom__search_contacts']);
});

// --- (b) graceful degrade: one dead server never kills the others ---------

test('one server hanging past the connect deadline does not block the other', async () => {
  const good = fakeConnection([tool('mcp__good__ok')]);
  const hung = (): Promise<McpServerConnection> => new Promise(() => {});
  const { fn } = stubConnect({ good, dead: hung });
  const servers = [
    server({ id: 'good', discoveredTools: [{ name: 'ok' }], allowedTools: ['ok'] }),
    server({ id: 'dead', discoveredTools: [{ name: 'x' }], allowedTools: ['x'] }),
  ];
  const tools = await resolveProfileMcpTools(servers, {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    connect: fn,
    connectTimeoutMs: 50,
  });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['mcp__good__ok'],
    'the healthy server still returns its tools',
  );
});

test('a server that rejects on connect degrades gracefully (returns nothing, no throw)', async () => {
  const good = fakeConnection([tool('mcp__good__ok')]);
  const rejecting = (): Promise<McpServerConnection> => {
    throw new Error('HTTP 401 Unauthorized');
  };
  const { fn } = stubConnect({ good, bad: rejecting });
  const servers = [
    server({ id: 'good', discoveredTools: [{ name: 'ok' }], allowedTools: ['ok'] }),
    server({ id: 'bad', discoveredTools: [{ name: 'x' }], allowedTools: ['x'] }),
  ];
  const tools = await resolveProfileMcpTools(servers, {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    connect: fn,
  });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['mcp__good__ok'],
  );
});

test('turn-time MCP failure logs redact configured query and header credentials', async () => {
  const warnings: string[] = [];
  const previousWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    await withEnv(
      {
        MCP_AGENT_AGENT_5FTEST_CONNECTION_SRV_BEARER: 'bearer-secret',
        MCP_AGENT_AGENT_5FTEST_CONNECTION_SRV_HEADER_X_2DCUSTOM_2DCREDENTIAL:
          'custom-secret',
      },
      async () => {
        const connect = async (
          _name: string,
          options: McpServerOptions,
        ): Promise<McpServerConnection> => {
          const headers = new Headers(options.headers);
          throw new Error(
            'upstream echoed ' +
              options.url +
              ' ' +
              headers.get('Authorization') +
              ' ' +
              headers.get('X-Custom-Credential'),
          );
        };
        const tools = await resolveProfileMcpTools(
          [
            server({
              url: 'https://mcp.example.com/mcp?access_token=query-secret',
              authMode: 'bearer',
              headerNames: ['X-Custom-Credential'],
            }),
          ],
          {
            agentId: 'agent_test',
            env: noSecretsEnv,
            existingToolNames: [],
            connect,
          },
        );
        assert.deepEqual(tools, []);
      },
    );
  } finally {
    console.warn = previousWarn;
  }

  const logged = warnings.join('\n');
  assert.ok(logged.includes('[redacted]'));
  assert.doesNotMatch(logged, /query-secret|bearer-secret|custom-secret/);
});

// --- (e) collision with existingToolNames dropped -------------------------

test('drops an MCP tool whose full name collides with an existing tool/skill name', async () => {
  const conn = fakeConnection([tool('gmail_send_message'), tool('mcp__srv__create')]);
  const { fn } = stubConnect({ srv: conn });
  const tools = await resolveProfileMcpTools([server()], {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: ['gmail_send_message'],
    connect: fn,
  });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['mcp__srv__create'],
    'the colliding tool is dropped, the other survives',
  );
});

test('drops a later MCP tool that collides with an earlier server (first wins)', async () => {
  // Two servers that (pathologically) produce the same full tool name.
  const a = fakeConnection([tool('mcp__dup__go')]);
  const b = fakeConnection([tool('mcp__dup__go')]);
  const { fn } = stubConnect({ a, b });
  const servers = [
    server({ id: 'a', discoveredTools: [{ name: 'go' }], allowedTools: ['go'] }),
    server({ id: 'b', discoveredTools: [{ name: 'go' }], allowedTools: ['go'] }),
  ];
  const tools = await resolveProfileMcpTools(servers, {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    connect: fn,
  });
  assert.equal(tools.length, 1, 'only the first server keeps the colliding name');
  assert.equal(tools[0]?.name, 'mcp__dup__go');
});

// --- (f) zero-approved-after-intersection closes immediately --------------

test('a server whose approved tools all vanished is closed immediately', async () => {
  let closed = false;
  // allowlist approves only "gone", which the server no longer exposes.
  const conn = fakeConnection([tool('mcp__srv__still-here')], () => {
    closed = true;
  });
  const { fn } = stubConnect({ srv: conn });
  const tools = await resolveProfileMcpTools(
    [server({ discoveredTools: [{ name: 'gone' }], allowedTools: ['gone'] })],
    { agentId: 'agent_test', env: noSecretsEnv, existingToolNames: [], connect: fn },
  );
  assert.deepEqual(tools, [], 'no approved tool survives the intersection');
  assert.equal(closed, true, 'the useless connection is closed immediately');
});

test('returns [] for an empty server list without connecting', async () => {
  const { fn, connected } = stubConnect({});
  const tools = await resolveProfileMcpTools([], {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: [],
    connect: fn,
  });
  assert.deepEqual(tools, []);
  assert.deepEqual(connected, []);
});

test('Flue 2 MCP definitions retain only policy and resolve rotating bearer auth live', async () => {
  const ref = { agentId: 'agent_v2', connectionId: 'srv' };
  const envVar = mcpBearerEnvVar(ref);
  await withEnv({ [envVar]: 'first-token' }, async () => {
    const [definition] = resolveProfileMcpConnections(
      [server({ authMode: 'bearer', allowedTools: ['search'] })],
      { agentId: ref.agentId, env: noSecretsEnv },
    );
    assert.ok(definition);
    assert.deepEqual(definition.tools, ['search']);
    assert.equal(definition.optional, true);
    assert.equal(typeof definition.auth, 'function');
    assert.doesNotMatch(JSON.stringify(definition), /first-token/);
    assert.equal(await (definition.auth as () => Promise<string>)(), 'first-token');

    process.env[envVar] = 'second-token';
    assert.equal(await (definition.auth as () => Promise<string>)(), 'second-token');
  });
});

test('direct Meta definitions expose only scoped tools and reject undeclared arguments', async () => {
  let outbound = 0;
  const metaServer = server({
    url: 'https://mcp.facebook.com/ads',
    discoveredTools: [
      { name: metaReportTool, inputSchema: metaEntitySchema },
      { name: metaScoreTool },
    ],
    allowedTools: [metaReportTool, metaScoreTool],
    toolPolicies: {
      [metaReportTool]: { effect: 'read', argumentConstraints: { ad_account_id: ['act_123'] } },
      [metaScoreTool]: { effect: 'read' },
    },
  });
  const [definition] = resolveProfileMcpConnections([metaServer], {
    agentId: 'agent_test', env: noSecretsEnv,
    resolveCurrentConnection: async () => metaServer,
    createGuardedFetch: () => async () => {
      outbound += 1;
      return Response.json({});
    },
  });
  assert.deepEqual(definition?.tools, [metaReportTool]);
  await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: metaReportTool, arguments: { ad_account_id: 'act_123', object_ids: ['other'] } } }),
  }), /does not permit the argument object_ids/);
  assert.equal(outbound, 0);
  await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: metaReportTool, arguments: { ad_account_id: 'act_123', campaign_id: 'other' } } }),
  }), /does not permit the argument campaign_id/);
  assert.equal(outbound, 0);
  await definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: metaReportTool, arguments: {
        ad_account_id: 'act_123', client_conversation_id: 'correlation-1', fields: ['spend'],
      } } }),
  });
  assert.equal(outbound, 1);
});

test('custom MCP tool with a helper-shaped name keeps ordinary argument constraints', async () => {
  let outbound = 0;
  const custom = server({
    discoveredTools: [{ name: META_ADS_ACCOUNT_HELPER }],
    allowedTools: [META_ADS_ACCOUNT_HELPER],
    toolPolicies: { [META_ADS_ACCOUNT_HELPER]: {
      effect: 'read', argumentConstraints: { tenant_id: ['tenant-1'] },
    } },
  });
  const [definition] = resolveProfileMcpConnections([custom], {
    agentId: 'agent_test', env: noSecretsEnv,
    createGuardedFetch: () => async () => {
      outbound += 1;
      return Response.json({});
    },
  });
  await assert.rejects(definition!.fetch!('https://mcp.example.com/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: META_ADS_ACCOUNT_HELPER, arguments: {},
    } }),
  }), /approved value/);
  assert.equal(outbound, 0);
});

test('direct Meta field helper has no phantom account input and honors live revocation', async () => {
  const fieldServer = server({
    url: 'https://mcp.facebook.com/ads', presetId: 'meta-ads',
    discoveredTools: [{ name: META_ADS_FIELD_HELPER, inputSchema: {
      propertyNames: [], accountFields: [], ambiguous: false, fingerprint: 'c'.repeat(64),
    } }],
    allowedTools: [META_ADS_FIELD_HELPER],
    toolPolicies: { [META_ADS_FIELD_HELPER]: { effect: 'read', argumentConstraints: {
      [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['act_123'],
    } } },
  });
  let current: McpConnectionConfig | undefined = fieldServer;
  let outbound = 0;
  const [definition] = resolveProfileMcpConnections([fieldServer], {
    agentId: 'agent_test', env: noSecretsEnv,
    resolveCurrentConnection: async () => current,
    createGuardedFetch: () => async () => {
      outbound += 1;
      return Response.json({ jsonrpc: '2.0', id: 1, result: {
        content: [{ type: 'text', text: 'field metadata' }],
      } });
    },
  });
  await definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: META_ADS_FIELD_HELPER, arguments: {},
    } }),
  });
  assert.equal(outbound, 1);
  current = { ...fieldServer, allowedTools: [] };
  await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: META_ADS_FIELD_HELPER, arguments: {},
    } }),
  }), /policy changed/);
  assert.equal(outbound, 1);
});

test('direct Meta account helper sanitizes SSE under live profile policy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-direct-meta-helper-'));
  const agentId = 'agent_direct_meta_helper';
  const connection = metaAccountHelperServer();
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
      await getConfigStore().createAgent({
        id: agentId, name: 'Direct Meta helper', instructions: 'Test Meta helper policy.',
        enabled: true, model: 'local-stub/direct-meta', skills: [],
        mcpServers: [connection], apiConnections: [], repositories: [],
      });
      const [definition] = resolveProfileMcpConnections([connection], {
        agentId,
        createGuardedFetch: () => async () => {
          const envelope = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ accounts: [
            { id: 'act_999', is_ads_mcp_enabled: true, is_queryable: true, ad_account_name: 'Other' },
            { id: '144860434', is_ads_mcp_enabled: true, is_queryable: true, ad_account_name: 'Magoosh' },
          ] }) }] } };
          return new Response(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      });
      assert.deepEqual(definition?.tools, [META_ADS_ACCOUNT_HELPER]);
      const response = await definition!.fetch!('https://mcp.facebook.com/ads', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: META_ADS_ACCOUNT_HELPER, arguments: {},
        } }),
      });
      const text = await response.text();
      assert.match(text, /144860434|Magoosh/);
      assert.doesNotMatch(text, /999|Other|meta_ads_approved/);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime-plan Meta account helper accepts empty provider args and sanitizes JSON', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-runtime-meta-helper-'));
  const agentId = 'agent_runtime_meta_helper';
  const connection = metaAccountHelperServer({ id: 'meta' });
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
      await getConfigStore().createAgent({
        id: agentId, name: 'Runtime Meta helper', instructions: 'Test Meta helper policy.',
        enabled: true, model: 'local-stub/runtime-meta-helper', skills: [],
        mcpServers: [connection], apiConnections: [], repositories: [],
      });
      const [definition] = resolveRuntimePlanMcpConnections(agentId, [{
        id: connection.id, url: connection.url, transport: connection.transport,
        authMode: 'none', headerNames: [], optional: true,
        allowedTools: [META_ADS_ACCOUNT_HELPER], readOnlyTools: [META_ADS_ACCOUNT_HELPER],
        toolArgumentConstraints: { [META_ADS_ACCOUNT_HELPER]: {
          [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['144860434', 'act_144860434'],
        } },
      }], undefined, undefined, { createGuardedFetch: () => async () => Response.json({
        jsonrpc: '2.0', id: 1, result: { structuredContent: { accounts: [
          { id: 'act_999', is_ads_mcp_enabled: true, is_queryable: true, ad_account_name: 'Other' },
          { id: 'act_144860434', is_ads_mcp_enabled: true, is_queryable: true, ad_account_name: 'Magoosh' },
        ] } },
      }) });
      assert.deepEqual(definition?.tools, [META_ADS_ACCOUNT_HELPER]);
      const response = await definition!.fetch!('https://mcp.facebook.com/ads', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: META_ADS_ACCOUNT_HELPER, arguments: {},
        } }),
      });
      const result = await response.json();
      assert.match(JSON.stringify(result), /144860434|Magoosh/);
      assert.doesNotMatch(JSON.stringify(result), /999|Other|meta_ads_approved/);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime-plan direct Meta definitions withhold unscoped tools and reject another account pre-I/O', async () => {
  const [definition] = resolveRuntimePlanMcpConnections('missing-agent', [{
    id: 'meta', url: 'https://mcp.facebook.com/ads', transport: 'streamable-http',
    authMode: 'none', headerNames: [], optional: true,
    allowedTools: [metaReportTool, metaScoreTool],
    readOnlyTools: [metaReportTool, metaScoreTool],
    toolArgumentConstraints: { [metaReportTool]: { ad_account_id: ['act_123'] } },
  }]);
  assert.deepEqual(definition?.tools, [metaReportTool]);
  await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: metaReportTool, arguments: { ad_account_id: 'act_456' } } }),
  }), /approved value/);
});

test('runtime-plan Meta invocation rejects optional entity targets from the current schema', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-runtime-meta-arguments-'));
  const agentId = 'agent_runtime_meta_arguments';
  const connection = server({
    id: 'meta', url: 'https://mcp.facebook.com/ads', presetId: 'meta-ads',
    discoveredTools: [{ name: metaReportTool, inputSchema: metaEntitySchema }],
    allowedTools: [metaReportTool],
    toolPolicies: { [metaReportTool]: {
      effect: 'read', argumentConstraints: { ad_account_id: ['act_123'] },
    } },
  });
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
      await getConfigStore().createAgent({
        id: agentId, name: 'Runtime Meta arguments', instructions: 'Test Meta argument policy.',
        enabled: true, model: 'local-stub/runtime-meta', skills: [],
        mcpServers: [connection], apiConnections: [], repositories: [],
      });
      const [definition] = resolveRuntimePlanMcpConnections(agentId, [{
        id: connection.id, url: connection.url, transport: connection.transport,
        authMode: 'none', headerNames: [], optional: true,
        allowedTools: [metaReportTool], readOnlyTools: [metaReportTool],
        toolArgumentConstraints: { [metaReportTool]: { ad_account_id: ['act_123'] } },
      }]);
      await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: metaReportTool,
          arguments: { ad_account_id: 'act_123', object_ids: ['other'] },
        } }),
      }), /does not permit the argument object_ids/);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Flue 2 MCP guarded fetch resolves rotating custom headers per request', async () => {
  const ref = { agentId: 'agent_v2_headers', connectionId: 'srv' };
  const envVar = mcpHeaderEnvVar(ref, 'X-Api-Key');
  const captured: Request[] = [];
  await withEnv({ [envVar]: 'header-one' }, async () => {
    const [definition] = resolveProfileMcpConnections(
      [server({ headerNames: ['X-Api-Key'], allowedTools: ['search'] })],
      {
        agentId: ref.agentId,
        env: noSecretsEnv,
        createGuardedFetch: () => (async (input, init) => {
          captured.push(new Request(input, init));
          return new Response('{}');
        }) as typeof fetch,
      },
    );
    assert.ok(definition?.fetch);
    await definition.fetch('https://mcp.example.com/mcp', { method: 'POST' });
    process.env[envVar] = 'header-two';
    await definition.fetch('https://mcp.example.com/mcp', { method: 'POST' });
  });
  assert.equal(captured[0]?.headers.get('x-api-key'), 'header-one');
  assert.equal(captured[1]?.headers.get('x-api-key'), 'header-two');
});

test('runtime-plan OAuth auth reuses its live policy read for a fresh token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-runtime-mcp-oauth-'));
  const statePath = join(directory, 'state.db');
  const agentId = 'agent_runtime_oauth';
  const connection = server({
    id: 'oauth-server',
    authMode: 'oauth',
    allowedTools: ['search'],
  });
  try {
    await withEnv({ SLACK_STATE_DB_PATH: statePath }, async () => {
      const config = getConfigStore();
      await config.createAgent({
        id: agentId,
        name: 'Runtime OAuth',
        instructions: 'Test runtime OAuth policy reads.',
        enabled: true,
        model: 'local-stub/runtime-oauth',
        skills: [],
        mcpServers: [connection],
        apiConnections: [],
        repositories: [],
      });
      const settings = getSettingsStore();
      await settings.setSetting(
        mcpOAuthSettingKeys({ agentId, connectionId: connection.id })[2],
        JSON.stringify({
          serverUrl: connection.url,
          authorizationServerUrl: 'https://auth.example.com',
          metadata: {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code'],
          },
          resource: connection.url,
          clientInformation: { client_id: 'runtime-client' },
          tokens: {
            access_token: 'runtime-access-token',
            token_type: 'Bearer',
            expires_in: 3_600,
          },
          obtainedAt: Date.now(),
        }),
      );

      const originalGetAgent = config.getAgent.bind(config);
      let policyReads = 0;
      config.getAgent = async (id) => {
        policyReads += 1;
        return originalGetAgent(id);
      };
      try {
        const [definition] = resolveRuntimePlanMcpConnections(agentId, [{
          id: connection.id,
          url: connection.url,
          transport: connection.transport,
          authMode: connection.authMode,
          headerNames: [],
          allowedTools: ['search'],
          optional: true,
        }]);
        const auth = definition?.auth as (() => Promise<string>) | undefined;
        assert.equal(await auth?.(), 'runtime-access-token');
        assert.equal(await auth?.(), 'runtime-access-token');
        assert.equal(policyReads, 2, 'each auth call performs one current-policy read');
      } finally {
        config.getAgent = originalGetAgent;
      }
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('account-backed runtime MCP resolves OAuth and rechecks live tool and actor authority', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-account-mcp-'));
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db'), CHICKPEA_AUTH_DB_PATH: join(directory, 'auth.db') }, async () => {
      const { getIdentityStore } = await import('../src/config/state-backend.ts');
      const { connectionAccountOAuthRef } = await import('../src/config/api-oauth.ts');
      const config = getConfigStore();
      const identity = getIdentityStore();
      const policy = { kind: 'mcp', url: 'https://mcp.example.com/mcp', transport: 'streamable-http', authMode: 'oauth', headerNames: [], discoveredTools: [{ name: 'search' }], allowedTools: ['search'], oauthAttemptId: '11111111-1111-4111-8111-111111111111' };
      const account = { id: 'connection_test', workspaceId: 'T_TEST', providerId: 'test', label: 'Test MCP', ownerKind: 'team', lifecycle: 'ready', policy };
      const binding = { agentId: 'agent_test', connectionAccountId: account.id, providerId: 'test', enabled: true, allowedCapabilities: [] };
      let active = true;
      t.mock.method(identity, 'getOrganization', async () => ({ id: 'org', slackTeamId: 'T_TEST' }));
      t.mock.method(identity, 'getMembership', async () => ({ id: 'member', userId: 'user', organizationId: 'org', status: active ? 'active' : 'suspended' }));
      t.mock.method(identity, 'getMembershipAccessOverlay', async () => null);
      t.mock.method(identity, 'getUser', async () => ({ id: 'user', slackTeamId: 'T_TEST', slackUserId: 'U_TEST' }));
      t.mock.method(identity, 'resolveSlackIdentity', async () => ({ user: { id: 'user' }, membership: { id: 'member' }, binding: { membershipId: 'member' } }));
      t.mock.method(config, 'listConnectionAccounts', async () => [account]);
      t.mock.method(config, 'listAgentConnectionBindings', async () => [binding]);
      t.mock.method(config, 'getAgent', async () => { throw new Error('Must not read legacy MCP profile'); });
      await getSettingsStore().setSetting(mcpOAuthSettingKeys(connectionAccountOAuthRef(account.id))[2], JSON.stringify({
        serverUrl: policy.url, authorizationServerUrl: 'https://auth.example.com',
        metadata: { issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token', response_types_supported: ['code'] },
        resource: policy.url, clientInformation: { client_id: 'client' },
        tokens: { access_token: 'account-token', token_type: 'Bearer', expires_in: 3600 },
        obtainedAt: Date.now(), oauthAttemptId: '11111111-1111-4111-8111-111111111111',
      }));
      const [definition] = resolveRuntimePlanMcpConnections('agent_test', [{
        id: account.id, url: policy.url, transport: 'streamable-http', authMode: 'oauth', headerNames: [], allowedTools: ['search'], optional: true,
      }], undefined, { workspaceId: 'T_TEST', actorMembershipId: 'member' });
      const auth = definition!.auth as () => Promise<string>;
      assert.equal(await auth(), 'account-token');
      // Descriptive server hints do not change selected tool permissions.
      Object.assign(policy.discoveredTools[0]!, { readOnlyHint: true });
      assert.equal(await auth(), 'account-token');
      policy.discoveredTools = [{ name: 'search' }];
      binding.enabled = false;
      await assert.rejects(auth(), /policy changed/);
      binding.enabled = true;
      policy.allowedTools = [];
      await assert.rejects(auth(), /policy changed/);
      policy.allowedTools = ['search'];
      active = false;
      await assert.rejects(auth(), /not available/);
      active = true;
      policy.oauthAttemptId = '22222222-2222-4222-8222-222222222222';
      await assert.rejects(auth());
      t.mock.restoreAll();
    });
  } finally {
    t.mock.restoreAll();
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});
