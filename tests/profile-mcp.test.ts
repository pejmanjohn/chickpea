import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { McpServerConnection, McpServerOptions, ToolDefinition } from '@flue/runtime';

import { resolveProfileMcpTools } from '../src/config/profile-mcp.ts';
import type { McpConnectionConfig } from '../src/config/types.ts';

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
  const tools = await resolveProfileMcpTools(servers, {
    env: noSecretsEnv,
    existingToolNames: [],
    connect: fn,
  });
  assert.deepEqual(connected, [], 'no filtered server should be connected');
  assert.deepEqual(tools, []);
});

test('returns [] without throwing when servers is undefined (pre-migration frozen snapshot)', async () => {
  // A channel snapshot frozen before mcpServers existed deserializes with the
  // field undefined; the factory must never throw.
  const { fn, connected } = stubConnect({});
  const tools = await resolveProfileMcpTools(undefined as unknown as McpConnectionConfig[], {
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
    env: noSecretsEnv,
    existingToolNames: [],
    connect: fn,
  });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['mcp__srv__search'],
  );
});

// --- (d) approved-but-vanished tool is simply absent, no error ------------

test('an approved tool no longer discovered is absent, not an error', async () => {
  // allowlist has search+create, but the server now only exposes search.
  const conn = fakeConnection([tool('mcp__srv__search')]);
  const { fn } = stubConnect({ srv: conn });
  const tools = await resolveProfileMcpTools([server({ allowedTools: ['search', 'create'] })], {
    env: noSecretsEnv,
    existingToolNames: [],
    connect: fn,
  });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['mcp__srv__search'],
  );
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
    env: noSecretsEnv,
    existingToolNames: [],
    connect: fn,
  });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['mcp__good__ok'],
  );
});

// --- (e) collision with existingToolNames dropped -------------------------

test('drops an MCP tool whose full name collides with an existing tool/skill name', async () => {
  const conn = fakeConnection([tool('mcp__srv__search'), tool('mcp__srv__create')]);
  const { fn } = stubConnect({ srv: conn });
  const tools = await resolveProfileMcpTools([server()], {
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
    { env: noSecretsEnv, existingToolNames: [], connect: fn },
  );
  assert.deepEqual(tools, [], 'no approved tool survives the intersection');
  assert.equal(closed, true, 'the useless connection is closed immediately');
});

test('returns [] for an empty server list without connecting', async () => {
  const { fn, connected } = stubConnect({});
  const tools = await resolveProfileMcpTools([], {
    env: noSecretsEnv,
    existingToolNames: [],
    connect: fn,
  });
  assert.deepEqual(tools, []);
  assert.deepEqual(connected, []);
});
