import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import type { ToolDefinition } from '@flue/runtime';

import { classifyMcpError, safeMcpFailureText } from '../src/config/mcp-errors.ts';
import {
  connectMcp,
  discoverMcpTools,
  projectMcpToolInputSchema,
  type McpConnectInput,
  type McpServerConnection,
  type McpServerOptions,
} from '../src/config/mcp-test.ts';

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

const metaInput: McpConnectInput = {
  ...baseInput,
  id: 'meta-ads',
  url: 'https://mcp.facebook.com/ads',
};

interface ProtocolToolPage {
  tools: Array<Record<string, unknown>>;
  nextCursor?: string;
}

function pagedProtocolFetch(
  pages: Record<string, ProtocolToolPage>,
  listCursors: Array<string | undefined> = [],
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const rpc = await request.json() as { id?: number; method: string; params?: { cursor?: string } };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') {
      return Response.json({
        jsonrpc: '2.0', id: rpc.id,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } },
      });
    }
    const cursor = rpc.params?.cursor;
    listCursors.push(cursor);
    const page = pages[cursor ?? ''];
    if (!page) throw new Error(`Unexpected tools/list cursor ${cursor ?? '<first>'}.`);
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: page });
  };
}

function protocolTool(name: string, inputSchema: Record<string, unknown> = { type: 'object' }): Record<string, unknown> {
  return { name, inputSchema };
}

function scopedMetaSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: { ad_account_id: { type: 'string' } },
    required: ['ad_account_id'],
  };
}

const reviewedMetaToolNames = [
  'ads_get_ad_entities',
  'ads_get_opportunity_score',
  'ads_insights_advertiser_context',
  'ads_insights_anomaly_signal',
  'ads_insights_auction_ranking_benchmarks',
  'ads_insights_industry_benchmark',
  'ads_insights_performance_trend',
] as const;

test('protocol discovery preserves true, false and absent read-only declarations', async () => {
  const methods: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const rpc = await request.json() as { id?: number; method: string };
    methods.push(rpc.method);
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const result = rpc.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
      : { tools: [
          { name: 'task_only', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } },
          { name: 'run_query', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { rows: { type: 'array' } }, required: ['rows'] }, annotations: { readOnlyHint: true } },
          { name: 'get_messages', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
          { name: 'unknown', inputSchema: { type: 'object' } },
          { name: 'x'.repeat(121), inputSchema: { type: 'object' } },
          { name: 'y'.repeat(120), inputSchema: { type: 'object' } },
        ] };
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  };
  const result = await discoverMcpTools(baseInput, undefined, () => fakeFetch);
  assert.deepEqual(result.tools.map(({ inputSchema: _inputSchema, ...entry }) => entry), [
    { name: 'run_query', readOnlyHint: true },
    { name: 'get_messages', readOnlyHint: false },
    { name: 'unknown' },
    { name: 'y'.repeat(120) },
  ]);
  assert.ok(result.tools.every((entry) => entry.inputSchema?.ambiguous === true));
  assert.ok(methods.includes('tools/list'));
});

test('Meta protocol discovery scans past 50 tools and retains reviewed reporting tools', async () => {
  const cursors: Array<string | undefined> = [];
  const first = Array.from({ length: 60 }, (_, index) =>
    protocolTool(`unsupported_${String(index).padStart(3, '0')}`));
  const fetch = pagedProtocolFetch({
    '': { tools: first, nextCursor: 'reporting' },
    reporting: {
      tools: reviewedMetaToolNames.map((name) => protocolTool(name, scopedMetaSchema())),
    },
  }, cursors);

  const result = await discoverMcpTools(metaInput, undefined, () => fetch);

  assert.deepEqual(result.tools.map((entry) => entry.name), reviewedMetaToolNames);
  assert.deepEqual(result.tools[0]?.inputSchema?.accountFields, [
    { name: 'ad_account_id', type: 'string', required: true },
  ]);
  assert.deepEqual(cursors, [undefined, 'reporting']);
});

test('generic protocol discovery keeps the first 50 tools and does not scan later pages', async () => {
  const cursors: Array<string | undefined> = [];
  const fetch = pagedProtocolFetch({
    '': {
      tools: Array.from({ length: 60 }, (_, index) => protocolTool(`generic_${index}`)),
      nextCursor: 'later',
    },
    later: { tools: [protocolTool('ads_get_ad_entities', scopedMetaSchema())] },
  }, cursors);

  const result = await discoverMcpTools(baseInput, undefined, () => fetch);

  assert.equal(result.tools.length, 50);
  assert.equal(result.tools[0]?.name, 'generic_0');
  assert.equal(result.tools[49]?.name, 'generic_49');
  assert.deepEqual(cursors, [undefined]);
});

test('Meta protocol discovery fails closed for raw bounds, pagination bounds, repeated cursors and duplicate reviewed tools', async () => {
  const tooManyTools = pagedProtocolFetch({
    '': { tools: Array.from({ length: 1_025 }, (_, index) => protocolTool(`tool_${index}`)) },
  });
  const rawLimitError = await discoverMcpTools(metaInput, undefined, () => tooManyTools).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(rawLimitError instanceof Error);
  assert.match(rawLimitError.message, /exceeded the raw tool limit/);
  assert.equal(classifyMcpError(rawLimitError), 'discovery_failed');
  assert.equal(safeMcpFailureText(rawLimitError), 'Connected, but tool discovery failed.');

  const tooManyPages: Record<string, ProtocolToolPage> = {};
  for (let index = 0; index < 20; index += 1) {
    const cursor = index === 0 ? '' : `page_${index}`;
    tooManyPages[cursor] = {
      tools: [],
      nextCursor: `page_${index + 1}`,
    };
  }
  await assert.rejects(
    () => discoverMcpTools(metaInput, undefined, () => pagedProtocolFetch(tooManyPages)),
    /exceeded the page limit/,
  );

  const repeatedCursor = pagedProtocolFetch({
    '': { tools: [], nextCursor: 'same' },
    same: { tools: [], nextCursor: 'same' },
  });
  await assert.rejects(
    () => discoverMcpTools(metaInput, undefined, () => repeatedCursor),
    /repeated a cursor/,
  );

  const duplicateReviewed = pagedProtocolFetch({
    '': {
      tools: [
        ...reviewedMetaToolNames.map((name) => protocolTool(name, scopedMetaSchema())),
        ...Array.from({ length: 60 }, (_, index) => protocolTool(`unreviewed_${index}`)),
      ],
      nextCursor: 'duplicate',
    },
    duplicate: { tools: [protocolTool('ads_get_ad_entities', scopedMetaSchema())] },
  });
  await assert.rejects(
    () => discoverMcpTools(metaInput, undefined, () => duplicateReviewed),
    /duplicate reviewed tool ads_get_ad_entities/,
  );
});

test('Meta protocol discovery omits task-required reviewed tools and rejects duplicates even when one is task-only', async () => {
  const taskOnly = protocolTool('ads_insights_performance_trend', scopedMetaSchema());
  taskOnly.execution = { taskSupport: 'required' };
  const result = await discoverMcpTools(metaInput, undefined, () => pagedProtocolFetch({
    '': { tools: [
      taskOnly,
      protocolTool('ads_get_ad_entities', scopedMetaSchema()),
    ] },
  }));
  assert.deepEqual(result.tools.map((entry) => entry.name), ['ads_get_ad_entities']);

  await assert.rejects(
    () => discoverMcpTools(metaInput, undefined, () => pagedProtocolFetch({
      '': { tools: [taskOnly], nextCursor: 'duplicate' },
      duplicate: { tools: [protocolTool('ads_insights_performance_trend', scopedMetaSchema())] },
    })),
    /duplicate reviewed tool ads_insights_performance_trend/,
  );
});

test('Meta protocol discovery applies a short total deadline to a nonresponding tools/list', async () => {
  let aborted = false;
  const startedAt = Date.now();
  const createFetch = ({ signal }: { signal?: AbortSignal }): typeof fetch => async (input, init) => {
    const request = new Request(input, init);
    const rpc = await request.json() as { id?: number; method: string };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') {
      return Response.json({
        jsonrpc: '2.0', id: rpc.id,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } },
      });
    }
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = () => {
        aborted = true;
        reject(new Error('discovery fetch aborted'));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  const error = await discoverMcpTools(
    { ...metaInput, callTimeoutMs: 20 }, undefined, createFetch,
  ).then(() => null, (reason: unknown) => reason);

  assert.ok(error instanceof Error);
  assert.equal(classifyMcpError(error), 'timeout');
  assert.equal(aborted, true);
  assert.ok(Date.now() - startedAt < 1_000, 'total discovery deadline must stop a hung page');
});

test('input-schema projection keeps exact required account evidence and fingerprints the whole schema', () => {
  const first = projectMcpToolInputSchema({
    type: 'object',
    required: ['ad_account_id'],
    properties: {
      filters: { type: 'object', oneOf: [{ required: ['date_start'] }, { required: ['date_preset'] }] },
      ad_account_id: { type: 'string' },
    },
  });
  const reordered = projectMcpToolInputSchema({
    properties: {
      ad_account_id: { type: 'string' },
      filters: { oneOf: [{ required: ['date_start'] }, { required: ['date_preset'] }], type: 'object' },
    },
    required: ['ad_account_id'],
    type: 'object',
  });
  assert.deepEqual(first.accountFields, [{ name: 'ad_account_id', type: 'string', required: true }]);
  assert.equal(first.ambiguous, false, 'unrelated nested filter alternatives do not invalidate account scope');
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(reordered.fingerprint, first.fingerprint, 'object key order does not change the schema fingerprint');
  assert.notEqual(projectMcpToolInputSchema({
    type: 'object', required: ['ad_account_id'],
    properties: { ad_account_id: { type: 'string' }, limit: { type: 'number' } },
  }).fingerprint, first.fingerprint, 'any bounded input-schema change changes the fingerprint');
});

test('input-schema projection fails closed for optional, alternate and composed account selectors', () => {
  for (const schema of [
    { type: 'object', properties: { account_id: { type: 'string' } } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, business_account_id: { type: 'string' },
    } },
    { type: 'object', oneOf: [{ required: ['account_id'] }], required: ['account_id'],
      properties: { account_id: { type: 'string' } } },
    { type: 'object', required: ['account_id'], properties: { account_id: { type: 'number' } } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, target: { type: 'object', properties: { ad_account_id: { type: 'string' } } },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, campaign_id: { type: 'string' },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, filters: { type: 'array', items: {
        type: 'object', properties: { campaign_id: { type: 'string' } },
      } },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, filters: { type: 'array', prefixItems: [{
        type: 'object', properties: { ad_account_id: { type: 'string' } },
      }] },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, filters: { type: 'object', additionalProperties: {
        type: 'object', properties: { entity_id: { type: 'string' } },
      } },
    } },
  ]) {
    assert.equal(projectMcpToolInputSchema(schema).ambiguous, true);
  }
});

test('input-schema projection bounds oversized property names without retaining them', () => {
  const oversized = 'x'.repeat(100_000);
  const projection = projectMcpToolInputSchema({
    type: 'object', required: ['account_id'],
    properties: { account_id: { type: 'string' }, [oversized]: { type: 'string' } },
  });
  assert.equal(projection.ambiguous, true);
  assert.deepEqual(projection.propertyNames, ['account_id']);
  assert.match(projection.fingerprint, /^[a-f0-9]{64}$/);
});

test('MCP output-schema discovery works when dynamic code generation is forbidden', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [
    '--disallow-code-generation-from-strings', '--import', 'tsx', '--test',
    '--test-name-pattern=^protocol discovery', new URL(import.meta.url).pathname,
  ], { encoding: 'utf8', timeout: 30_000, env });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /protocol discovery preserves/);
});

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

test('injected Meta discovery scans the bounded adapter catalog but returns only reviewed schema-less tools', async () => {
  const unreviewed = Array.from({ length: 60 }, (_, index) =>
    tool(`mcp__meta-ads__unsupported_${index}`));
  const reviewed = reviewedMetaToolNames.map((name) => tool(`mcp__meta-ads__${name}`));
  const { fn } = stubConnect(fakeConnection([...unreviewed, ...reviewed]));

  const result = await discoverMcpTools(metaInput, fn);

  assert.deepEqual(result.tools.map((entry) => entry.name), reviewedMetaToolNames);
  assert.ok(result.tools.every((entry) => entry.inputSchema === undefined));
});

test('discoverMcpTools passes id as the server name and callTimeoutMs to connect', async () => {
  const { fn, calls } = stubConnect(fakeConnection([]));
  await discoverMcpTools({ ...baseInput, callTimeoutMs: 12_345 }, fn);
  assert.equal(calls[0]?.name, 'srv');
  assert.equal(calls[0]?.options.timeoutMs, 12_345);
  assert.equal(calls[0]?.options.transport, 'streamable-http');
  assert.equal(typeof calls[0]?.options.fetch, 'function', 'every MCP connect gets guarded fetch');
});

test('discoverMcpTools defaults callTimeoutMs to 30000', async () => {
  const { fn, calls } = stubConnect(fakeConnection([]));
  await discoverMcpTools(baseInput, fn);
  assert.equal(calls[0]?.options.timeoutMs, 30_000);
});

test('discoverMcpTools preserves supported identifiers, omits overlong names and truncates descriptions', async () => {
  // Flue's adapter folds any MCP title into the description, so the adapted
  // ToolDefinition never carries a title — we surface name + description only.
  const longName = 'a'.repeat(200);
  const longDesc = 'c'.repeat(500);
  const conn = fakeConnection([
    tool('mcp__srv__' + longName),
    tool('mcp__srv__' + 'b'.repeat(120), 'first   line\n\tsecond    line ' + longDesc),
  ]);
  const { fn } = stubConnect(conn);

  const result = await discoverMcpTools(baseInput, fn);
  const t = result.tools[0];
  assert.ok(t);
  assert.equal(result.tools.length, 1, 'unsupported identifiers are not rewritten into different tools');
  assert.equal(t.name, 'b'.repeat(120), 'supported identifier is preserved exactly');
  assert.equal(t.title, undefined, 'title never surfaced (folded into description by Flue)');
  assert.equal(t.description?.length, 400, 'description truncated to 400');
  // Whitespace collapsed: no runs of 2+ spaces, tabs, or newlines survive.
  assert.ok(!/\s\s/.test(t.description ?? ''), 'description whitespace collapsed');
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

test('connectMcp aborts in-flight guarded fetch work at the connect deadline', async () => {
  let fetchAborted = false;
  const createGuardedFetch = ({ signal }: { signal?: AbortSignal }): typeof fetch => {
    assert.ok(signal, 'connect deadline signal must be supplied to guarded fetch');
    return (async () => {
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          fetchAborted = true;
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }) as typeof fetch;
  };

  const connect = async (
    _name: string,
    options: McpServerOptions,
  ): Promise<McpServerConnection> => {
    assert.ok(options.fetch, 'guarded fetch must be passed to Flue');
    await options.fetch(options.url);
    return fakeConnection([]);
  };

  const err = await connectMcp(
    { ...baseInput, url: 'https://8.8.8.8/mcp', connectTimeoutMs: 25 },
    connect,
    createGuardedFetch,
  ).then(
    () => null,
    (e: unknown) => e,
  );
  assert.equal(classifyMcpError(err), 'timeout');
  assert.equal(fetchAborted, true, 'deadline must abort the underlying fetch');
});
