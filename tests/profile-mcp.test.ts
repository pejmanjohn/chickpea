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

test('reusable account credentials populate preset-specific MCP headers at runtime', async () => {
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

test('reusable account credential projection preserves custom headers without double-prefixing', async () => {
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
  const conn = fakeConnection([tool('mcp__srv__search'), tool('mcp__srv__create')]);
  const { fn } = stubConnect({ srv: conn });
  const tools = await resolveProfileMcpTools([server()], {
    agentId: 'agent_test',
    env: noSecretsEnv,
    existingToolNames: ['mcp__srv__search'],
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
