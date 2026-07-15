import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { McpServerConnection, McpServerOptions } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime';

import { classifyMcpError, safeMcpFailureText } from '../src/config/mcp-errors.ts';
import { connectMcp, discoverMcpTools, type McpConnectInput } from '../src/config/mcp-test.ts';

// A minimal ToolDefinition stand-in — the real adapter freezes these, but for
// discovery we only read name/description (and defensively title if present).
function tool(name: string, description = '', extra: Record<string, unknown> = {}): ToolDefinition {
  return {
    name,
    description,
    input: undefined,
    output: undefined,
    run() {
      throw new Error('not used');
    },
    ...extra,
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

/** A connect fn that records the args it was called with and returns a preset connection. */
function stubConnect(
  connection: McpServerConnection,
): { fn: (name: string, options: McpServerOptions) => Promise<McpServerConnection>; calls: Array<{ name: string; options: McpServerOptions }> } {
  const calls: Array<{ name: string; options: McpServerOptions }> = [];
  const fn = async (name: string, options: McpServerOptions): Promise<McpServerConnection> => {
    calls.push({ name, options });
    return connection;
  };
  return { fn, calls };
}

const baseInput: McpConnectInput = {
  id: 'srv',
  url: 'https://mcp.example.com/mcp',
  transport: 'streamable-http',
  headers: {},
};

test('discoverMcpTools maps tools, strips the mcp__<id>__ prefix, and closes', async () => {
  let closed = false;
  const conn = fakeConnection(
    [tool('mcp__srv__search', 'Search things'), tool('mcp__srv__create', 'Create things')],
    () => {
      closed = true;
    },
  );
  const { fn } = stubConnect(conn);

  const result = await discoverMcpTools(baseInput, fn);

  assert.deepEqual(
    result.tools.map((t) => t.name),
    ['search', 'create'],
  );
  assert.equal(result.tools[0]?.description, 'Search things');
  assert.equal(closed, true, 'discover must close the connection');
});

test('discoverMcpTools passes id as the server name and callTimeoutMs to connect', async () => {
  const { fn, calls } = stubConnect(fakeConnection([]));
  await discoverMcpTools({ ...baseInput, callTimeoutMs: 12_345 }, fn);
  assert.equal(calls[0]?.name, 'srv');
  assert.equal(calls[0]?.options.timeoutMs, 12_345);
  assert.equal(calls[0]?.options.transport, 'streamable-http');
});

test('discoverMcpTools defaults callTimeoutMs to 30000', async () => {
  const { fn, calls } = stubConnect(fakeConnection([]));
  await discoverMcpTools(baseInput, fn);
  assert.equal(calls[0]?.options.timeoutMs, 30_000);
});

test('discoverMcpTools truncates name/title/description with whitespace collapse', async () => {
  const longName = 'a'.repeat(200);
  const longTitle = 'b'.repeat(200);
  const longDesc = 'c'.repeat(500);
  const conn = fakeConnection([
    tool('mcp__srv__' + longName, 'first   line\n\tsecond    line ' + longDesc, {
      title: '  spaced   ' + longTitle,
    }),
  ]);
  const { fn } = stubConnect(conn);

  const result = await discoverMcpTools(baseInput, fn);
  const t = result.tools[0];
  assert.ok(t);
  assert.equal(t.name.length, 120, 'name truncated to 120');
  assert.ok(t.title !== undefined);
  assert.equal(t.title?.length, 160, 'title truncated to 160');
  assert.equal(t.description?.length, 400, 'description truncated to 400');
  // Whitespace collapsed: no runs of 2+ spaces, tabs, or newlines survive.
  assert.ok(!/\s\s/.test(t.description ?? ''), 'description whitespace collapsed');
  assert.ok(!/\s\s/.test(t.title ?? ''), 'title whitespace collapsed');
});

test('discoverMcpTools omits title/description when absent (exactOptional-safe)', async () => {
  const conn = fakeConnection([tool('mcp__srv__bare', '')]);
  const { fn } = stubConnect(conn);
  const result = await discoverMcpTools(baseInput, fn);
  const t = result.tools[0];
  assert.ok(t);
  assert.equal(t.name, 'bare');
  assert.ok(!('title' in t), 'no title key when absent');
  assert.ok(!('description' in t), 'no description key when empty');
});

test('discoverMcpTools caps at 50 tools', async () => {
  const many = Array.from({ length: 75 }, (_, i) => tool('mcp__srv__t' + i, 'd'));
  const conn = fakeConnection(many);
  const { fn } = stubConnect(conn);
  const result = await discoverMcpTools(baseInput, fn);
  assert.equal(result.tools.length, 50);
  assert.equal(result.tools[0]?.name, 't0');
  assert.equal(result.tools[49]?.name, 't49');
});

test('discoverMcpTools rejects at the connect deadline when connect hangs', async () => {
  const hung = (): Promise<McpServerConnection> => new Promise(() => {});
  const err = await discoverMcpTools({ ...baseInput, connectTimeoutMs: 50 }, hung).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Error, 'should reject');
  assert.equal(classifyMcpError(err), 'timeout');
  assert.match(safeMcpFailureText(err), /did not respond/i);
});

test('discoverMcpTools throws McpBlockedUrlError BEFORE connect is invoked (blocked URL)', async () => {
  let called = false;
  const spy = async (): Promise<McpServerConnection> => {
    called = true;
    return fakeConnection([]);
  };
  const err = await discoverMcpTools({ ...baseInput, url: 'https://10.0.0.1/mcp' }, spy).then(
    () => null,
    (e: unknown) => e,
  );
  assert.equal(called, false, 'connect must not be called for a blocked URL');
  assert.equal(classifyMcpError(err), 'blocked_url');
});

test('discoverMcpTools propagates a 401 rejection classified as unauthorized', async () => {
  const rejecting = async (): Promise<McpServerConnection> => {
    throw new Error('HTTP 401 Unauthorized');
  };
  const err = await discoverMcpTools(baseInput, rejecting).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Error);
  assert.equal(classifyMcpError(err), 'unauthorized');
});

test('connectMcp returns the live connection without closing it', async () => {
  let closed = false;
  const conn = fakeConnection([tool('mcp__srv__x')], () => {
    closed = true;
  });
  const { fn, calls } = stubConnect(conn);

  const returned = await connectMcp(baseInput, fn);

  assert.equal(returned, conn, 'connectMcp returns the live connection');
  assert.equal(closed, false, 'connectMcp does NOT close the connection');
  assert.equal(calls[0]?.name, 'srv');
});

test('connectMcp also enforces the SSRF guard before connecting', async () => {
  let called = false;
  const spy = async (): Promise<McpServerConnection> => {
    called = true;
    return fakeConnection([]);
  };
  const err = await connectMcp({ ...baseInput, url: 'https://192.168.1.1/mcp' }, spy).then(
    () => null,
    (e: unknown) => e,
  );
  assert.equal(called, false, 'connect must not run for a blocked URL');
  assert.equal(classifyMcpError(err), 'blocked_url');
});

test('connectMcp rejects at the connect deadline when connect hangs', async () => {
  const hung = (): Promise<McpServerConnection> => new Promise(() => {});
  const err = await connectMcp({ ...baseInput, connectTimeoutMs: 50 }, hung).then(
    () => null,
    (e: unknown) => e,
  );
  assert.equal(classifyMcpError(err), 'timeout');
});
