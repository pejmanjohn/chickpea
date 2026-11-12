import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createMcpConnection, type McpConnectionDefinition } from '@flue/runtime';

import type { RuntimePlanMcpConnectionV2 } from '../src/agents/runtime-plan.ts';
import { projectMcpToolInputSchema } from '../src/config/mcp-test.ts';
import { createMcpToolsListFilter } from '../src/config/mcp-tools-list.ts';
import { resolveRuntimePlanMcpConnections } from '../src/config/profile-mcp.ts';
import {
  META_ADS_ACCOUNT_HELPER,
  META_ADS_APPROVED_ACCOUNT_SCOPE,
  META_ADS_FIELD_HELPER,
} from '../src/config/meta-ads-policy.ts';
import { META_ADS_ACCOUNT_HELPER_DESCRIPTION } from '../src/config/meta-ads-response.ts';
import { closeNodeStateStores, getConfigStore } from '../src/config/state-backend.ts';
import type { McpConnectionConfig } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

// Synthetic tool names only. `alpha`, `beta`, and `gamma` are granted; the
// server stops listing `beta` and starts listing `extra`, which nobody granted.
const GRANT = ['alpha', 'beta', 'gamma'];
const URL_ = 'https://mcp.example.com/mcp';
const NO_GRANTED_TOOLS = 'Example Tools no longer offers any of the tools this Agent may use. ' +
  'An Admin can pick its tools again in Chickpea Admin.';

type Wire = 'json' | 'sse';
type Rpc = {
  jsonrpc: '2.0'; id?: number; method: string; params?: { cursor?: string; name?: string; arguments?: unknown };
};
type ListedTool = string | Record<string, unknown>;

const encoder = new TextEncoder();

function listedTool(tool: ListedTool): Record<string, unknown> {
  return typeof tool === 'string'
    ? { name: tool, description: `The ${tool} tool.`, inputSchema: { type: 'object', properties: {} } }
    : tool;
}

function pageResult(pages: readonly (readonly ListedTool[])[], cursor: string | undefined): Record<string, unknown> {
  const index = cursor === undefined ? 0 : Number(cursor.replace('page-', ''));
  return {
    tools: pages[index]!.map(listedTool),
    ...(index + 1 < pages.length ? { nextCursor: `page-${index + 1}` } : {}),
  };
}

function initializeResult(params: Record<string, unknown> | undefined) {
  return {
    protocolVersion: params?.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: 'synthetic-tools', version: '1.0.0' },
  };
}

function eventStream(chunks: readonly string[], options: { open?: boolean; onCancel?: () => void } = {}): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!options.open) controller.close();
    },
    cancel() {
      options.onCancel?.();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function reply(wire: Wire, payload: unknown): Response {
  return wire === 'sse' ? eventStream([`event: message\ndata: ${JSON.stringify(payload)}\n\n`]) : Response.json(payload);
}

/** A Streamable HTTP server; `answerList` answers each tools/list POST, and `answerCall` each tools/call. */
function mcpServer(answerList: (rpc: Rpc) => Response, answerCall?: (rpc: Rpc) => Response) {
  const calls: string[] = [];
  const callArguments: unknown[] = [];
  const gets: Request[] = [];
  const fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET') {
      gets.push(request);
      return eventStream([': resumed\n\n']);
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const rpc = await request.json() as Rpc;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') {
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: initializeResult(rpc.params as Record<string, unknown>) });
    }
    if (rpc.method === 'tools/list') return answerList(rpc);
    if (rpc.method === 'tools/call') {
      calls.push(String(rpc.params?.name));
      callArguments.push(rpc.params?.arguments);
      if (answerCall) return answerCall(rpc);
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'done' }] } });
    }
    throw new Error(`Unexpected synthetic MCP request: ${rpc.method}`);
  }) as typeof globalThis.fetch;
  return { fetch, calls, callArguments, gets };
}

function pagedServer(wire: Wire, pages: readonly (readonly ListedTool[])[]) {
  return mcpServer((rpc) => reply(wire, { jsonrpc: '2.0', id: rpc.id, result: pageResult(pages, rpc.params?.cursor) }));
}

const sseMessage = (payload: unknown) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`;

/** The GET event stream a legacy SSE server writes to; text sent while none is open waits for the next. */
interface LegacyStream {
  send: (text: string) => void;
  end: () => void;
}

/**
 * A legacy SSE server: every answer arrives on the GET event stream, pushed
 * before the POST's 202 returns, as a fast server can. `answer` writes the
 * events for one request; by default its plain answer, with tools/list paged.
 * Each GET stream asks the client to reconnect after 10 ms.
 */
function legacySseServer(
  pages: readonly (readonly ListedTool[])[],
  answer: (rpc: Rpc, plain: string, stream: LegacyStream) => void = (_rpc, plain, stream) => stream.send(plain),
) {
  const calls: string[] = [];
  const gets: Request[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const queued: string[] = [];
  let open: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream: LegacyStream = {
    send: (text) => (open ? open.enqueue(encoder.encode(text)) : queued.push(text)),
    end: () => {
      open?.close();
      open = undefined;
    },
  };
  const fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET') {
      gets.push(request);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          open = controller;
          controller.enqueue(encoder.encode(`retry: 10\n\nevent: endpoint\ndata: /messages?stream=${gets.length}\n\n`));
          for (const text of queued.splice(0)) controller.enqueue(encoder.encode(text));
        },
        cancel() {
          open = undefined;
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    const rpc = await request.json() as Rpc;
    posts.push(rpc);
    if (rpc.id !== undefined && rpc.method !== undefined) {
      if (rpc.method === 'tools/call') calls.push(String(rpc.params?.name));
      const result = rpc.method === 'initialize'
        ? initializeResult(rpc.params as Record<string, unknown>)
        : rpc.method === 'tools/list'
          ? pageResult(pages, rpc.params?.cursor)
          : { content: [{ type: 'text', text: 'done' }] };
      answer(rpc, sseMessage({ jsonrpc: '2.0', id: rpc.id, result }), stream);
    }
    return new Response('Accepted', { status: 202 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, gets, posts };
}

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > 2_000) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function connectionConfig(overrides: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  const allowedTools = overrides.allowedTools ?? GRANT;
  return {
    id: 'srv',
    credentialRef: 'connection_44444444444444444444444444444444',
    displayName: 'Example Tools',
    url: URL_,
    transport: 'streamable-http',
    authMode: 'none',
    headerNames: [],
    enabled: true,
    lifecycleStatus: 'ready',
    statusText: '',
    discoveredTools: allowedTools.map((name) => ({ name })),
    allowedTools,
    ...overrides,
  };
}

/**
 * Store an Agent with one MCP connection, then mount its runtime-plan
 * declaration against `fetch`, the way a Slack turn does.
 */
async function withRuntimeConnection<T>(
  connection: McpConnectionConfig,
  fetch: typeof globalThis.fetch,
  run: (definition: McpConnectionDefinition) => Promise<T>,
  declaration: Partial<RuntimePlanMcpConnectionV2> = {},
  options: { readsOnly?: boolean } = {},
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-mcp-tools-list-'));
  try {
    return await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
      const agentId = 'agent_mcp_tools_list';
      const created = await getConfigStore().createAgent({
        id: agentId, name: 'Tool drift', instructions: 'Use the granted tools.',
        enabled: true, skills: [], mcpServers: [connection], apiConnections: [], repositories: [],
      });
      const stored = created.mcpServers[0]!;
      const [definition] = resolveRuntimePlanMcpConnections(agentId, [{
        id: stored.id,
        url: stored.url,
        transport: stored.transport,
        credentialRef: stored.credentialRef!,
        authMode: 'none',
        headerNames: [],
        optional: true,
        allowedTools: [...stored.allowedTools],
        ...declaration,
      }], undefined, undefined, { createGuardedFetch: () => fetch, ...options });
      assert.ok(definition);
      return await run(definition);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function mountedNames(definition: McpConnectionDefinition): Promise<string[]> {
  const connection = await createMcpConnection(definition);
  try {
    return connection.tools.map(({ name }) => name);
  } finally {
    await connection.close();
  }
}

/** Collect the filter's log lines and silence the per-request MCP telemetry. */
function captureLogs(t: TestContext) {
  const missing: Array<Record<string, unknown>> = [];
  const refused: Array<Record<string, unknown>> = [];
  const http: Array<Record<string, unknown>> = [];
  const envelopeKeys: Array<Record<string, unknown>> = [];
  const info = console.info.bind(console);
  t.mock.method(console, 'info', (event: unknown, ...rest: unknown[]) => {
    const name = (event as { event?: string } | undefined)?.event;
    if (name === 'chickpea.mcp.tools_missing') missing.push(event as Record<string, unknown>);
    else if (name === 'chickpea.mcp.tools_list_refused') refused.push(event as Record<string, unknown>);
    else if (name === 'chickpea.mcp.http') http.push(event as Record<string, unknown>);
    else if (name === 'chickpea.meta_ads.account_envelope_extra_keys') envelopeKeys.push(event as Record<string, unknown>);
    else info(event, ...rest);
  });
  return { missing, refused, http, envelopeKeys };
}

const missingLine = (missing: string[], listedCount: number, taskOnly: string[] = []) => ({
  event: 'chickpea.mcp.tools_missing', connectionId: 'srv', missing, taskOnly, listedCount,
});
const refusedLine = (reason: string) => ({ event: 'chickpea.mcp.tools_list_refused', connectionId: 'srv', reason });

// --- mounting through Flue -------------------------------------------------

for (const wire of ['json', 'sse'] as const) {
  test(`a granted tool the server stopped listing leaves the rest mounted in grant order (${wire})`, async (t) => {
    const logs = captureLogs(t);
    const server = pagedServer(wire, [['gamma', 'extra', 'alpha']]);
    await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
      assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha', 'mcp__srv__gamma']);
    });
    assert.deepEqual(logs.missing, [missingLine(['beta'], 3)]);
    assert.deepEqual(logs.refused, []);
  });
}

test('a grant split across two pages mounts what each page lists and reports what is missing after the last', async (t) => {
  const logs = captureLogs(t);
  const server = pagedServer('sse', [['extra', 'gamma'], ['alpha']]);
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__gamma', 'mcp__srv__alpha']);
  });
  assert.deepEqual(logs.missing, [missingLine(['beta'], 3)]);
});

test('mounted names stay inside the grant over JSON, SSE, and two pages', async (t) => {
  captureLogs(t);
  const grantNames = new Set(GRANT.map((name) => `mcp__srv__${name}`));
  for (const wire of ['json', 'sse'] as const) {
    for (const pages of [[['extra', 'gamma', 'alpha', 'other']], [['extra', 'alpha'], ['other', 'gamma', 'beta']]]) {
      const server = pagedServer(wire, pages);
      await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
        const mounted = await mountedNames(definition);
        assert.ok(mounted.length > 0);
        assert.ok(mounted.every((name) => grantNames.has(name)), `${wire} ${JSON.stringify(pages)}: ${mounted.join(', ')}`);
      });
    }
  }
});

test('a full listing logs nothing and mounts the whole grant in grant order', async (t) => {
  const logs = captureLogs(t);
  const server = pagedServer('json', [['gamma', 'beta', 'alpha']]);
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    assert.equal(definition.tools, undefined, 'Flue mounts the filtered listing, not a strict allowlist');
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha', 'mcp__srv__beta', 'mcp__srv__gamma']);
  });
  assert.deepEqual([logs.missing, logs.refused], [[], []]);
});

test('a test run mounts the same intersection', async (t) => {
  captureLogs(t);
  const server = pagedServer('json', [['gamma', 'extra', 'alpha']]);
  const reads = Object.fromEntries(GRANT.map((name) => [name, { effect: 'read' as const }]));
  await withRuntimeConnection(connectionConfig({ toolPolicies: reads }), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha', 'mcp__srv__gamma']);
  }, { readOnlyTools: GRANT }, { readsOnly: true });
});

test('a connection that lists none of its grant fails with a reason a person can act on', async (t) => {
  const logs = captureLogs(t);
  for (const wire of ['json', 'sse'] as const) {
    const server = pagedServer(wire, [['extra']]);
    await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
      await assert.rejects(createMcpConnection(definition), (error: Error) => {
        assert.equal(error.message, NO_GRANTED_TOOLS);
        return true;
      });
    });
  }
  assert.deepEqual(logs.missing, [missingLine(GRANT, 1), missingLine(GRANT, 1)]);
  assert.deepEqual(logs.refused, [refusedLine('no-granted-tools'), refusedLine('no-granted-tools')]);
});

test('a name listed twice mounts its first copy once, on one page and across two', async (t) => {
  captureLogs(t);
  const later = { ...listedTool('alpha'), description: 'A later copy.' };
  for (const pages of [[['alpha', 'gamma', later]], [['alpha'], ['gamma', later]]]) {
    const server = pagedServer('json', pages);
    await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
      const connection = await createMcpConnection(definition);
      try {
        assert.deepEqual(connection.tools.map(({ name, description }) => [name, description]), [
          ['mcp__srv__alpha', 'The alpha tool.'],
          ['mcp__srv__gamma', 'The gamma tool.'],
        ]);
      } finally {
        await connection.close();
      }
    });
  }
});

test('a granted task-only tool is reported and the rest mount', async (t) => {
  const logs = captureLogs(t);
  t.mock.method(console, 'warn', () => {});
  const taskOnly = (name: string) => ({ ...listedTool(name), execution: { taskSupport: 'required' } });
  const server = pagedServer('json', [['alpha', taskOnly('gamma')]]);
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha']);
  });
  assert.deepEqual(logs.missing, [missingLine(['beta'], 2, ['gamma'])]);
  const nothingMissing = pagedServer('json', [['alpha', taskOnly('gamma')]]);
  await withRuntimeConnection(connectionConfig({ allowedTools: ['alpha', 'gamma'] }), nothingMissing.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha']);
  });
  assert.deepEqual(logs.missing.at(-1), missingLine([], 2, ['gamma']));
  const onlyTasks = pagedServer('json', [[taskOnly('alpha')]]);
  await withRuntimeConnection(connectionConfig(), onlyTasks.fetch, async (definition) => {
    await assert.rejects(createMcpConnection(definition), /no longer offers any of the tools/);
  });
});

test('a reconnect starts a new listing instead of carrying the one that failed', async (t) => {
  const logs = captureLogs(t);
  let listings = 0;
  const server = mcpServer((rpc) => {
    if (rpc.params?.cursor === undefined) listings += 1;
    if (listings === 1) {
      return rpc.params?.cursor === undefined
        ? Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: [listedTool('alpha')], nextCursor: 'more' } })
        : new Response(null, { status: 202 });
    }
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: ['alpha', 'gamma'].map(listedTool) } });
  });
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    await assert.rejects(createMcpConnection(definition), /unsupported response \(status\)/);
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha', 'mcp__srv__gamma']);
  });
  assert.deepEqual(logs.refused, [refusedLine('status')]);
});

test('a listing outside the POST answer fails the connection and mounts nothing', async (t) => {
  const logs = captureLogs(t);
  const answer = (rpc: Rpc) => JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [listedTool('alpha')] } });
  const cases: Array<[string, (rpc: Rpc) => Response]> = [
    ['status', () => new Response(null, { status: 202 })],
    ['content-type', (rpc) => new Response(answer(rpc), { headers: { 'content-type': 'text/plain' } })],
    ['batch', (rpc) => new Response(`[${answer(rpc)}]`, { headers: { 'content-type': 'application/json' } })],
    ['batch', (rpc) => eventStream([`data: [${answer(rpc)}]\n\n`])],
    ['response-id', (rpc) => Response.json({ jsonrpc: '2.0', id: Number(rpc.id) + 100, result: { tools: [] } })],
    ['response-id', (rpc) => eventStream([
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: Number(rpc.id) + 100, result: { tools: [listedTool('alpha')] } })}\n\n`,
      `data: ${answer(rpc)}\n\n`,
    ])],
    ['no-response', () => eventStream([
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n',
    ])],
    ['invalid-json', () => new Response('{"jsonrpc":', { headers: { 'content-type': 'application/json' } })],
    ['json-rpc', (rpc) => Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: 'alpha' } })],
    ['tool', (rpc) => Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: [listedTool('alpha'), 'beta'] } })],
    ['tool', (rpc) => reply('sse', { jsonrpc: '2.0', id: rpc.id, result: { tools: [listedTool('alpha'), { description: 'no name' }] } })],
  ];
  for (const [reason, answerList] of cases) {
    const server = mcpServer(answerList);
    await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
      await assert.rejects(
        createMcpConnection(definition),
        (error: Error) => error.message === `Example Tools tool discovery returned an unsupported response (${reason}).`,
        reason,
      );
    });
  }
  assert.deepEqual(logs.refused, cases.map(([reason]) => refusedLine(reason)));
});

test('events before the answer reach the client, and a stream held open does not delay the mount', { timeout: 10_000 }, async (t) => {
  captureLogs(t);
  let cancelled = 0;
  const server = mcpServer((rpc) => eventStream([
    ': keep-alive\n\n',
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"listing"}}\n\n',
    `id: 1\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: ['extra', 'alpha'].map(listedTool) } })}\n\n`,
  ], { open: true, onCancel: () => { cancelled += 1; } }));
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha']);
  });
  assert.equal(cancelled, 1, 'the open stream is let go once the answer is read');
});

test('a JSON-RPC error answer to tools/list passes through untouched', async (t) => {
  captureLogs(t);
  const error = '{ "jsonrpc": "2.0", "id": 4, "error": { "code": -32601, "message": "Method not found" } }';
  const server = mcpServer(() => new Response(error, { headers: { 'content-type': 'application/json' } }));
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    const response = await definition.fetch!(URL_, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    assert.equal(await response.text(), error);
  });
});

test('a tools/list request that is not one JSON-RPC object never reaches the server', async (t) => {
  captureLogs(t);
  let outbound = 0;
  const server = pagedServer('json', [['alpha']]);
  const counted = (async (input, init) => {
    outbound += 1;
    return server.fetch(input, init);
  }) as typeof globalThis.fetch;
  await withRuntimeConnection(connectionConfig(), counted, async (definition) => {
    for (const body of ['{"jsonrpc":"2.0","id":1,"method":"tools/list"', '[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]']) {
      await assert.rejects(definition.fetch!(URL_, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      }));
    }
  });
  assert.equal(outbound, 0);
});

test('a tool call for a listed but ungranted tool is refused before it leaves Chickpea', async (t) => {
  captureLogs(t);
  const server = pagedServer('json', [['alpha', 'extra']]);
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    await assert.rejects(definition.fetch!(URL_, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'extra', arguments: {} } }),
    }), /not selected for this Agent/);
  });
  assert.deepEqual(server.calls, []);
});

// --- the standalone GET stream is answered locally -------------------------

function preparedMcpExecutor(tool: object): (args: unknown) => Promise<string> {
  const symbol = Object.getOwnPropertySymbols(tool).find((candidate) => candidate.description === 'flue.preparedToolAdapter');
  assert.ok(symbol);
  return (args) => (Reflect.get(tool, symbol) as { execute(args: unknown): Promise<string> }).execute(args);
}

test('the standalone GET stream never reaches the server, and the connection still mounts and calls', async (t) => {
  const logs = captureLogs(t);
  const server = pagedServer('json', [['extra', 'alpha']]);
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    const connection = await createMcpConnection(definition);
    try {
      assert.deepEqual(connection.tools.map(({ name }) => name), ['mcp__srv__alpha']);
      assert.equal(await preparedMcpExecutor(connection.tools[0]!)({}), 'done');
    } finally {
      await connection.close();
    }
    const standalone = await definition.fetch!(URL_, { method: 'GET', headers: { accept: 'text/event-stream' } });
    assert.equal(standalone.status, 405);
  });
  assert.deepEqual(server.gets, []);
  assert.deepEqual(server.calls, ['alpha']);
  assert.deepEqual(logs.http.filter(({ httpMethod }) => httpMethod === 'GET'), [], 'the local answer is not logged');
});

// --- the listing window ------------------------------------------------------
// Until the last tools/list page is filtered, the client reads only each
// request POST's own response, up to its own answer, and nothing from a GET.

/** The mounted names, or the error message when the connection fails. */
async function mountOutcome(definition: McpConnectionDefinition): Promise<string[] | string> {
  return createMcpConnection(definition).then(async (connection) => {
    const names = connection.tools.map(({ name }) => name);
    await connection.close();
    return names;
  }, (error: Error) => error.message);
}

const unsupported = (reason: string) => `Example Tools tool discovery returned an unsupported response (${reason}).`;
const resumeGet = (definition: McpConnectionDefinition) => definition.fetch!(URL_, {
  method: 'GET', headers: { accept: 'text/event-stream', 'last-event-id': '7' },
});

test('a listing pushed on the held-open initialize stream never reaches the client', { timeout: 10_000 }, async (t) => {
  captureLogs(t);
  let push: ((text: string) => void) | undefined;
  let cancelled = 0;
  const fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const rpc = await request.json() as Rpc;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(encoder.encode(text));
          push(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: initializeResult(rpc.params as Record<string, unknown>) })}\n\n`);
        },
        cancel() {
          push = undefined;
          cancelled += 1;
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    const listing = { jsonrpc: '2.0', id: rpc.id, result: { tools: ['extra', 'alpha'].map(listedTool) } };
    push?.(`data: ${JSON.stringify(listing)}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return Response.json(listing);
  }) as typeof globalThis.fetch;
  await withRuntimeConnection(connectionConfig(), fetch, async (definition) => {
    assert.deepEqual(await mountOutcome(definition), ['mcp__srv__alpha']);
    assert.deepEqual(await mountOutcome(definition), ['mcp__srv__alpha'], 'a second connection on the same definition');
  });
  assert.equal(cancelled, 2, 'each initialize stream is let go at its own answer');
});

test('a malformed error answer fails the listing, and its stream cannot be resumed from a GET', { timeout: 10_000 }, async (t) => {
  const logs = captureLogs(t);
  const gets: Request[] = [];
  let listId: number | undefined;
  const fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET') {
      gets.push(request);
      return eventStream([`data: ${JSON.stringify({ jsonrpc: '2.0', id: listId, result: { tools: ['extra', 'alpha'].map(listedTool) } })}\n\n`]);
    }
    const rpc = await request.json() as Rpc;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') {
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: initializeResult(rpc.params as Record<string, unknown>) });
    }
    listId = rpc.id;
    return eventStream([`retry: 1\n\nid: 5\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: 'nope' })}\n\n`]);
  }) as typeof globalThis.fetch;
  await withRuntimeConnection(connectionConfig(), fetch, async (definition) => {
    assert.deepEqual(await mountOutcome(definition), unsupported('json-rpc'));
  });
  assert.deepEqual(gets, []);
  assert.deepEqual(logs.refused, [refusedLine('json-rpc')]);
});

test('a response to another request on a request stream fails the connection', { timeout: 10_000 }, async (t) => {
  const logs = captureLogs(t);
  const server = pagedServer('json', [['extra', 'alpha']]);
  const fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      const rpc = await request.clone().json() as Rpc;
      if (rpc.method === 'initialize') {
        const next = { jsonrpc: '2.0', id: Number(rpc.id) + 1, result: { tools: ['extra', 'alpha'].map(listedTool) } };
        return eventStream([
          `data: ${JSON.stringify(next)}\n\n`,
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: initializeResult(rpc.params as Record<string, unknown>) })}\n\n`,
        ]);
      }
    }
    return server.fetch(request);
  }) as typeof globalThis.fetch;
  await withRuntimeConnection(connectionConfig(), fetch, async (definition) => {
    assert.deepEqual(await mountOutcome(definition), unsupported('response-id'));
  });
  assert.deepEqual(logs.refused, [refusedLine('response-id')]);
});

test('a GET that resumes a stream waits for the listing to finish, then reaches the server', async (t) => {
  const logs = captureLogs(t);
  const server = pagedServer('json', [['alpha']]);
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    assert.equal((await resumeGet(definition)).status, 405, 'no GET goes upstream while the listing is open');
    assert.deepEqual(await mountOutcome(definition), ['mcp__srv__alpha']);
    const resumed = await resumeGet(definition);
    assert.equal(resumed.status, 200);
    assert.equal(await resumed.text(), ': resumed\n\n');
  });
  assert.deepEqual(server.gets.map((request) => request.headers.get('last-event-id')), ['7']);
  assert.deepEqual(logs.http.filter(({ httpMethod }) => httpMethod === 'GET').map(({ status }) => status), [200]);
});

test('a page whose next cursor repeats ends the listing, as the MCP client ends it', async (t) => {
  const logs = captureLogs(t);
  const looping = (tools: readonly string[]) => mcpServer((rpc) => Response.json({
    jsonrpc: '2.0', id: rpc.id, result: { tools: tools.map(listedTool), nextCursor: 'again' },
  }));
  const server = looping(['gamma', 'extra', 'alpha']);
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    assert.deepEqual(await mountOutcome(definition), ['mcp__srv__alpha', 'mcp__srv__gamma']);
    assert.equal((await resumeGet(definition)).status, 200, 'the listing window closed');
  });
  assert.deepEqual(logs.missing, [missingLine(['beta'], 6)]);
  await withRuntimeConnection(connectionConfig(), looping(['extra']).fetch, async (definition) => {
    assert.equal(await mountOutcome(definition), NO_GRANTED_TOOLS);
  });
  assert.deepEqual(logs.refused, [refusedLine('no-granted-tools')]);
});

test('a server that declares no tools fails the connection instead of mounting none', async (t) => {
  const logs = captureLogs(t);
  const server = pagedServer('json', [['alpha']]);
  const fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      const rpc = await request.clone().json() as Rpc;
      if (rpc.method === 'initialize') {
        const result = { ...initializeResult(rpc.params as Record<string, unknown>), capabilities: { logging: {} } };
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
      }
    }
    return server.fetch(request);
  }) as typeof globalThis.fetch;
  await withRuntimeConnection(connectionConfig(), fetch, async (definition) => {
    assert.equal(await mountOutcome(definition), NO_GRANTED_TOOLS);
  });
  assert.deepEqual(logs.refused, [refusedLine('no-tools-capability')]);
});

test('an answer the MCP client would not read as one is refused', async (t) => {
  const logs = captureLogs(t);
  const malformed: Array<(rpc: Rpc) => Record<string, unknown>> = [
    (rpc) => ({ jsonrpc: '2.0', id: rpc.id, error: 'nope' }),
    (rpc) => ({ jsonrpc: '2.0', id: rpc.id, error: { code: '-32000', message: 'no' } }),
    (rpc) => ({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000.5, message: 'no' } }),
    (rpc) => ({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000 } }),
    (rpc) => ({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'no' }, extra: true }),
    (rpc) => ({ jsonrpc: '2.0', id: rpc.id, result: { tools: [listedTool('alpha')] }, extra: true }),
    (rpc) => ({ jsonrpc: '2.0', id: rpc.id, result: { tools: [listedTool('alpha')], _meta: 1 } }),
    (rpc) => ({ jsonrpc: '2.0', id: rpc.id, result: { tools: [listedTool('alpha')], _meta: null } }),
  ];
  for (const answer of malformed) {
    for (const wire of ['json', 'sse'] as const) {
      const server = mcpServer((rpc) => reply(wire, answer(rpc)));
      await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
        assert.equal(await mountOutcome(definition), unsupported('json-rpc'), `${wire} ${JSON.stringify(answer({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))}`);
      });
    }
  }
  assert.deepEqual(logs.refused, malformed.flatMap(() => [refusedLine('json-rpc'), refusedLine('json-rpc')]));
});

// --- the legacy SSE transport ----------------------------------------------
// Every answer arrives on the GET event stream, so that stream is filtered.

const sseConfig = (overrides: Partial<McpConnectionConfig> = {}) => connectionConfig({ transport: 'sse', ...overrides });

test('on legacy SSE a granted tool the server stopped listing leaves the rest mounted, and an ungranted one stays out', async (t) => {
  const logs = captureLogs(t);
  const server = legacySseServer([['gamma', 'extra', 'alpha']]);
  await withRuntimeConnection(sseConfig(), server.fetch, async (definition) => {
    assert.equal(definition.tools, undefined, 'Flue mounts the filtered listing, not a strict allowlist');
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha', 'mcp__srv__gamma']);
  });
  assert.deepEqual(logs.missing, [missingLine(['beta'], 3)]);
  assert.deepEqual(logs.refused, []);
});

test('a legacy SSE grant split across two pages mounts what each page lists and reports what is missing after the last', async (t) => {
  const logs = captureLogs(t);
  const server = legacySseServer([['extra', 'gamma'], ['alpha']]);
  await withRuntimeConnection(sseConfig(), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__gamma', 'mcp__srv__alpha']);
  });
  assert.deepEqual(logs.missing, [missingLine(['beta'], 3)]);
});

test('a name a legacy SSE listing repeats mounts its first copy once, on one page and across two', async (t) => {
  captureLogs(t);
  const later = { ...listedTool('alpha'), description: 'A later copy.' };
  for (const pages of [[['alpha', 'gamma', later]], [['alpha'], ['gamma', later]]]) {
    const server = legacySseServer(pages);
    await withRuntimeConnection(sseConfig(), server.fetch, async (definition) => {
      const connection = await createMcpConnection(definition);
      try {
        assert.deepEqual(connection.tools.map(({ name, description }) => [name, description]), [
          ['mcp__srv__alpha', 'The alpha tool.'],
          ['mcp__srv__gamma', 'The gamma tool.'],
        ]);
      } finally {
        await connection.close();
      }
    });
  }
});

test('a legacy SSE test run mounts the same intersection', async (t) => {
  captureLogs(t);
  const server = legacySseServer([['gamma', 'extra', 'alpha']]);
  const reads = Object.fromEntries(GRANT.map((name) => [name, { effect: 'read' as const }]));
  await withRuntimeConnection(sseConfig({ toolPolicies: reads }), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha', 'mcp__srv__gamma']);
  }, { readOnlyTools: GRANT }, { readsOnly: true });
});

test('a legacy SSE tool call works after the listing, and an ungranted one never leaves Chickpea', async (t) => {
  captureLogs(t);
  const server = legacySseServer([['extra', 'alpha']]);
  await withRuntimeConnection(sseConfig(), server.fetch, async (definition) => {
    const connection = await createMcpConnection(definition);
    try {
      assert.deepEqual(connection.tools.map(({ name }) => name), ['mcp__srv__alpha']);
      assert.equal(await preparedMcpExecutor(connection.tools[0]!)({}), 'done');
    } finally {
      await connection.close();
    }
    await assert.rejects(definition.fetch!(URL_, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'extra', arguments: {} } }),
    }), /not selected for this Agent/);
  });
  assert.deepEqual(server.calls, ['alpha']);
});

test('a legacy SSE listing pushed ahead of other events is still filtered, and the events after it reach the client', async (t) => {
  captureLogs(t);
  const server = legacySseServer([['extra', 'alpha', 'gamma']], (rpc, plain, stream) => stream.send(rpc.method === 'tools/list'
    ? plain +
      sseMessage({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'listed' } }) +
      sseMessage({ jsonrpc: '2.0', id: 'server-ping', method: 'ping' })
    : plain));
  await withRuntimeConnection(sseConfig(), server.fetch, async (definition) => {
    const connection = await createMcpConnection(definition);
    try {
      assert.deepEqual(connection.tools.map(({ name }) => name), ['mcp__srv__alpha', 'mcp__srv__gamma']);
      await until(() => server.posts.some((rpc) => rpc.id === 'server-ping' && 'result' in rpc));
    } finally {
      await connection.close();
    }
  });
});

test('a listing a legacy SSE server pushes while the client waits, before Chickpea sends the request, never mounts', async (t) => {
  const logs = captureLogs(t);
  let stream!: LegacyStream;
  const server = legacySseServer([['extra', 'alpha']], (_rpc, plain, open) => {
    stream = open;
    open.send(plain);
  });
  await withRuntimeConnection(sseConfig(), server.fetch, async (definition) => {
    // The client holds its tools/list request from before this fetch; a server can guess the id.
    const pushedFirst = (async (input, init) => {
      const rpc = typeof init?.body === 'string' ? JSON.parse(init.body) as Rpc : undefined;
      if (rpc?.method === 'tools/list') {
        for (const id of [rpc.id, String(rpc.id)]) {
          stream.send(sseMessage({ jsonrpc: '2.0', id, result: { tools: ['extra', 'alpha', 'gamma'].map(listedTool) } }));
        }
        await until(() => logs.refused.length === 2);
      }
      return definition.fetch!(input, init);
    }) as typeof globalThis.fetch;
    assert.deepEqual(await mountedNames({ ...definition, fetch: pushedFirst }), ['mcp__srv__alpha']);
  });
  assert.deepEqual(logs.refused, [refusedLine('response-id'), refusedLine('response-id')]);
});

test('a legacy SSE listing the filter cannot read fails the connection at once and mounts nothing', { timeout: 10_000 }, async (t) => {
  const logs = captureLogs(t);
  const listing = (rpc: Rpc) => ({ jsonrpc: '2.0', id: rpc.id, result: { tools: ['extra', 'alpha'].map(listedTool) } });
  const cases: Array<[string, (rpc: Rpc) => string]> = [
    ['batch', (rpc) => `data: [${JSON.stringify(listing(rpc))}]\n\n`],
    ['invalid-json', () => 'data: {"jsonrpc":\n\n'],
    ['response-id', (rpc) => sseMessage({ ...listing(rpc), id: Number(rpc.id) + 100 })],
    ['json-rpc', (rpc) => sseMessage({ jsonrpc: '2.0', id: rpc.id, result: { tools: 'alpha' } })],
    ['json-rpc', (rpc) => sseMessage({ jsonrpc: '2.0', id: rpc.id, error: 'nope' })],
    ['json-rpc', (rpc) => sseMessage({ ...listing(rpc), extra: true })],
    ['tool', (rpc) => sseMessage({ jsonrpc: '2.0', id: rpc.id, result: { tools: [listedTool('alpha'), 'beta'] } })],
  ];
  for (const [reason, events] of cases) {
    const server = legacySseServer([['alpha']], (rpc, plain, stream) => stream.send(rpc.method === 'tools/list' ? events(rpc) : plain));
    await withRuntimeConnection(sseConfig(), server.fetch, async (definition) => {
      assert.equal(await mountOutcome(definition), unsupported(reason), reason);
    });
  }
  assert.deepEqual(logs.refused, cases.map(([reason]) => refusedLine(reason)));
});

test('a legacy SSE connection that lists none of its grant, or declares no tools, fails with a reason a person can act on', async (t) => {
  const logs = captureLogs(t);
  await withRuntimeConnection(sseConfig(), legacySseServer([['extra']]).fetch, async (definition) => {
    assert.equal(await mountOutcome(definition), NO_GRANTED_TOOLS);
  });
  const noTools = legacySseServer([['alpha']], (rpc, plain, stream) => stream.send(rpc.method === 'initialize'
    ? sseMessage({ jsonrpc: '2.0', id: rpc.id, result: {
      ...initializeResult(rpc.params as Record<string, unknown>), capabilities: { logging: {} },
    } })
    : plain));
  await withRuntimeConnection(sseConfig(), noTools.fetch, async (definition) => {
    assert.equal(await mountOutcome(definition), NO_GRANTED_TOOLS);
  });
  assert.deepEqual(logs.refused, [refusedLine('no-granted-tools'), refusedLine('no-tools-capability')]);
});

test('a listing a legacy SSE server sends on its stream after a reconnect is filtered the same way', { timeout: 10_000 }, async (t) => {
  captureLogs(t);
  const server = legacySseServer([['extra', 'gamma', 'alpha']], (rpc, plain, stream) => {
    stream.send(plain);
    if (rpc.method === 'initialize') stream.end();
  });
  await withRuntimeConnection(sseConfig(), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha', 'mcp__srv__gamma']);
  });
  assert.equal(server.gets.length, 2, 'the listing arrived on the second GET stream');
});

// --- Meta ------------------------------------------------------------------

const metaHelperSchema = {
  propertyNames: ['advertiser_request', 'client_conversation_id'],
  accountFields: [],
  ambiguous: false,
  fingerprint: 'c'.repeat(64),
};
const metaScope = { [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['123450001'] };

test("Meta's account helper keeps its rewritten contract when another granted Meta tool disappears", async (t) => {
  const logs = captureLogs(t);
  const providerHelper = {
    name: META_ADS_ACCOUNT_HELPER,
    description: 'Provider pagination instructions.',
    inputSchema: { type: 'object', properties: { advertiser_request: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { accounts: { type: 'array' } }, required: ['accounts'] },
  };
  const server = pagedServer('json', [[providerHelper, 'ads_synthetic_unreviewed']]);
  const grant = [META_ADS_ACCOUNT_HELPER, META_ADS_FIELD_HELPER];
  const meta = connectionConfig({
    id: 'meta', url: 'https://mcp.facebook.com/ads', presetId: 'meta-ads', displayName: 'Meta Ads',
    allowedTools: grant,
    discoveredTools: grant.map((name) => ({ name, inputSchema: metaHelperSchema })),
    toolPolicies: Object.fromEntries(grant.map((name) => [name, { effect: 'read' as const, argumentConstraints: metaScope }])),
  });
  await withRuntimeConnection(meta, server.fetch, async (definition) => {
    const connection = await createMcpConnection(definition);
    try {
      assert.deepEqual(connection.tools.map(({ name }) => name), [`mcp__meta__${META_ADS_ACCOUNT_HELPER}`]);
      assert.equal(connection.tools[0]!.description, META_ADS_ACCOUNT_HELPER_DESCRIPTION);
    } finally {
      await connection.close();
    }
    const listing = await definition.fetch!('https://mcp.facebook.com/ads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const { result } = await listing.json() as { result: { tools: Array<Record<string, unknown>> } };
    assert.deepEqual(result.tools.map(({ name }) => name), [META_ADS_ACCOUNT_HELPER]);
    assert.deepEqual((result.tools[0]!.outputSchema as { required: string[] }).required, ['ad_accounts']);
  }, {
    readOnlyTools: grant,
    toolArgumentConstraints: Object.fromEntries(grant.map((name) => [name, metaScope])),
  });
  assert.deepEqual(logs.missing.map(({ missing, listedCount }) => ({ missing, listedCount })), [
    { missing: [META_ADS_FIELD_HELPER], listedCount: 2 },
    { missing: [META_ADS_FIELD_HELPER], listedCount: 2 },
  ], 'once for the mount and once for the direct listing');
});

test("a listing Meta's rewrite refuses is logged before the connection fails", async (t) => {
  const logs = captureLogs(t);
  const helper = { ...listedTool(META_ADS_ACCOUNT_HELPER) };
  const server = pagedServer('json', [[helper, helper]]);
  const meta = connectionConfig({
    id: 'meta', url: 'https://mcp.facebook.com/ads', presetId: 'meta-ads', displayName: 'Meta Ads',
    allowedTools: [META_ADS_ACCOUNT_HELPER],
    discoveredTools: [{ name: META_ADS_ACCOUNT_HELPER, inputSchema: metaHelperSchema }],
    toolPolicies: { [META_ADS_ACCOUNT_HELPER]: { effect: 'read', argumentConstraints: metaScope } },
  });
  await withRuntimeConnection(meta, server.fetch, async (definition) => {
    await assert.rejects(createMcpConnection(definition), /\(duplicate-account-helper\)/);
  }, {
    readOnlyTools: [META_ADS_ACCOUNT_HELPER],
    toolArgumentConstraints: { [META_ADS_ACCOUNT_HELPER]: metaScope },
  });
  assert.deepEqual(logs.refused, [{ event: 'chickpea.mcp.tools_list_refused', connectionId: 'meta', reason: 'rewrite' }]);
});

// Meta adds optional arguments to tools Chickpea reviewed at connect time.
// Synthetic data shaped like Meta's: `advertiser_job` and `scheduled_task_run`
// stand for the new correlation arguments, and `entity_ids` and `object_ids`
// are reviewed filters Chickpea never lets a call send.
const META_REPORT = 'ads_insights_performance_trend';
const META_ENTITIES = 'ads_get_ad_entities';
const META_GRANT = [META_ADS_ACCOUNT_HELPER, META_REPORT, META_ENTITIES];
const metaAccount = { ad_account_id: ['123450001'] };
const metaConstraints: Record<string, Record<string, string[]>> = {
  [META_ADS_ACCOUNT_HELPER]: metaScope, [META_REPORT]: metaAccount, [META_ENTITIES]: metaAccount,
};
const reportSchema = (propertyNames: string[], fingerprint: string) => ({
  propertyNames,
  accountFields: [{ name: 'ad_account_id' as const, type: 'string' as const, required: true }],
  ambiguous: false,
  fingerprint,
});
const META_STORED = [
  { name: META_ADS_ACCOUNT_HELPER, inputSchema: { ...metaHelperSchema,
    propertyNames: ['advertiser_request', 'client_conversation_id', 'cursor', 'limit'] } },
  { name: META_REPORT, inputSchema: reportSchema(
    ['ad_account_id', 'client_conversation_id', 'date_preset', 'entity_ids'], 'd'.repeat(64)) },
  { name: META_ENTITIES, inputSchema: reportSchema(
    ['ad_account_id', 'client_conversation_id', 'fields', 'object_ids'], 'e'.repeat(64)) },
];

function metaConnection(overrides: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  const grant = overrides.allowedTools ?? META_GRANT;
  return connectionConfig({
    id: 'meta', url: 'https://mcp.facebook.com/ads', presetId: 'meta-ads', displayName: 'Meta Ads',
    allowedTools: grant,
    discoveredTools: META_STORED,
    toolPolicies: Object.fromEntries(grant.map((name) =>
      [name, { effect: 'read' as const, argumentConstraints: metaConstraints[name]! }])),
    ...overrides,
  });
}

const metaDeclaration = (grant: readonly string[] = META_GRANT): Partial<RuntimePlanMcpConnectionV2> => ({
  readOnlyTools: [...grant],
  toolArgumentConstraints: Object.fromEntries(grant.map((name) => [name, metaConstraints[name]!])),
});

const text = { type: 'string' };
const list = { type: 'array', items: text };
const metaAdditions = { advertiser_job: { type: 'string', description: 'Synthetic job reference.' }, scheduled_task_run: text };

/** A tool as Meta lists it today: its reviewed arguments plus the new ones. */
function liveMetaTool(name: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    name,
    description: `Synthetic ${name}.`,
    inputSchema: {
      type: 'object', properties: { ...properties, ...metaAdditions }, required, additionalProperties: false,
    },
  };
}

const liveHelper = {
  ...liveMetaTool(META_ADS_ACCOUNT_HELPER, {
    advertiser_request: text, client_conversation_id: text, cursor: text, limit: { type: 'integer' },
  }),
  description: 'Provider pagination instructions.',
  outputSchema: { type: 'object', properties: { accounts: { type: 'array' } }, required: ['accounts'] },
};
const liveReport = (required = ['ad_account_id']) => liveMetaTool(META_REPORT, {
  ad_account_id: text, client_conversation_id: text, date_preset: text, entity_ids: list,
}, required);
const liveEntities = liveMetaTool(META_ENTITIES, {
  ad_account_id: text, client_conversation_id: text, fields: list, object_ids: list,
}, ['ad_account_id']);

/** The input schema Flue gives the model for a mounted tool. */
function shownSchema(tool: object): { properties: Record<string, { type?: string }>; required?: unknown } {
  const symbol = Object.getOwnPropertySymbols(tool).find((candidate) => candidate.description === 'flue.preparedToolAdapter');
  assert.ok(symbol);
  return (Reflect.get(tool, symbol) as { parameters: ReturnType<typeof shownSchema> }).parameters;
}

const mounted = (connection: { tools: readonly { name: string }[] }, name: string) =>
  connection.tools.find((tool) => tool.name === `mcp__meta__${name}`)!;

test('each mounted Meta tool shows the model only its reviewed arguments, never a blocked one', async (t) => {
  const logs = captureLogs(t);
  const server = pagedServer('json', [[liveHelper, liveReport(), liveEntities, 'ads_synthetic_unreviewed']]);
  await withRuntimeConnection(metaConnection(), server.fetch, async (definition) => {
    const connection = await createMcpConnection(definition);
    try {
      assert.deepEqual(connection.tools.map(({ name }) => name), META_GRANT.map((name) => `mcp__meta__${name}`));
      assert.deepEqual(shownSchema(mounted(connection, META_REPORT)), {
        type: 'object',
        properties: { ad_account_id: text, client_conversation_id: text, date_preset: text },
        required: ['ad_account_id'],
        additionalProperties: false,
      });
      assert.deepEqual(Object.keys(shownSchema(mounted(connection, META_ENTITIES)).properties),
        ['ad_account_id', 'client_conversation_id', 'fields']);
      // The helper's reviewed runtime arguments leave out the stored cursor and limit.
      const helper = mounted(connection, META_ADS_ACCOUNT_HELPER) as { name: string; description?: string };
      assert.deepEqual(Object.keys(shownSchema(helper).properties), ['advertiser_request', 'client_conversation_id']);
      assert.equal(helper.description, META_ADS_ACCOUNT_HELPER_DESCRIPTION);
    } finally {
      await connection.close();
    }
    const listing = await definition.fetch!('https://mcp.facebook.com/ads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const { result } = await listing.json() as { result: { tools: Array<Record<string, unknown>> } };
    const helper = result.tools.find(({ name }) => name === META_ADS_ACCOUNT_HELPER)!;
    assert.equal(helper.description, META_ADS_ACCOUNT_HELPER_DESCRIPTION);
    assert.deepEqual((helper.outputSchema as { required: string[] }).required, ['ad_accounts']);
  }, metaDeclaration());
  assert.deepEqual(logs.missing, [], 'an ungranted tool is not reported');
});

test('a Meta call built from every argument the model is shown passes the key check and reaches Meta', async (t) => {
  captureLogs(t);
  const server = pagedServer('json', [[liveHelper, liveReport(), liveEntities]]);
  await withRuntimeConnection(metaConnection(), server.fetch, async (definition) => {
    const connection = await createMcpConnection(definition);
    try {
      const report = mounted(connection, META_REPORT);
      // The model fills in what it is shown, as it filled in advertiser_job.
      const args = Object.fromEntries(Object.entries(shownSchema(report).properties).map(([name, schema]) =>
        [name, name === 'ad_account_id' ? '123450001' : schema.type === 'array' ? ['synthetic'] : 'synthetic']));
      assert.equal(await preparedMcpExecutor(report)(args), 'done');
      // The call-time key check still refuses an argument nobody reviewed.
      await assert.rejects(preparedMcpExecutor(report)({ ...args, advertiser_job: 'synthetic' }),
        /does not permit the argument advertiser_job/);
    } finally {
      await connection.close();
    }
  }, metaDeclaration());
  assert.deepEqual(server.calls, [META_REPORT]);
  assert.deepEqual(server.callArguments, [{
    ad_account_id: '123450001', client_conversation_id: 'synthetic', date_preset: 'synthetic',
  }]);
});

test("after a fresh discovery stores Meta's added helper arguments, the helpers mount with only reviewed ones", async (t) => {
  const logs = captureLogs(t);
  const liveFields = liveMetaTool(META_ADS_FIELD_HELPER, {
    advertiser_request: text, client_conversation_id: text, field_names: list,
  }, ['field_names']);
  const grant = [META_ADS_ACCOUNT_HELPER, META_ADS_FIELD_HELPER];
  // What a reconnect or a new Meta connection stores from today's listing.
  const fresh = [liveHelper, liveFields].map(({ name, inputSchema }) =>
    ({ name, inputSchema: projectMcpToolInputSchema(inputSchema, name) }));
  const meta = metaConnection({
    allowedTools: grant, discoveredTools: fresh,
    toolPolicies: Object.fromEntries(grant.map((name) => [name, { effect: 'read' as const, argumentConstraints: metaScope }])),
  });
  const listed = { ad_accounts: [
    { ad_account_id: 'act_123450001', is_ads_mcp_enabled: true, is_queryable: true, ad_account_name: 'Synthetic Advertiser' },
    { ad_account_id: 'act_999000999', is_ads_mcp_enabled: true, is_queryable: true, ad_account_name: 'Not Approved' },
  ] };
  const server = mcpServer(
    (rpc) => Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: [liveHelper, liveFields] } }),
    (rpc) => Response.json({ jsonrpc: '2.0', id: rpc.id, result: rpc.params?.name === META_ADS_ACCOUNT_HELPER
      ? { content: [{ type: 'text', text: JSON.stringify(listed) }], structuredContent: listed }
      : { content: [{ type: 'text', text: 'done' }] } }),
  );
  await withRuntimeConnection(meta, server.fetch, async (definition) => {
    const connection = await createMcpConnection(definition);
    try {
      assert.deepEqual(connection.tools.map(({ name }) => name), grant.map((name) => `mcp__meta__${name}`));
      // The account answer is still rebuilt from the approved accounts only.
      const accounts = preparedMcpExecutor(mounted(connection, META_ADS_ACCOUNT_HELPER));
      const answer = await accounts({ advertiser_request: 'Synthetic request.' });
      assert.match(answer, /"ad_account_id": "123450001"/);
      assert.doesNotMatch(answer, /999000999|Not Approved/);
      for (const unsent of ['cursor', 'limit', 'advertiser_job', 'scheduled_task_run']) {
        await assert.rejects(accounts({ [unsent]: 'synthetic' }), new RegExp(`does not permit the argument ${unsent}`));
      }
      assert.deepEqual(Object.keys(shownSchema(mounted(connection, META_ADS_ACCOUNT_HELPER)).properties),
        ['advertiser_request', 'client_conversation_id']);
      const fields = mounted(connection, META_ADS_FIELD_HELPER);
      assert.deepEqual(shownSchema(fields), {
        type: 'object',
        properties: { advertiser_request: text, client_conversation_id: text, field_names: list },
        required: ['field_names'],
        additionalProperties: false,
      });
      assert.equal(await preparedMcpExecutor(fields)({ field_names: ['spend'] }), 'done');
      await assert.rejects(preparedMcpExecutor(fields)({ field_names: ['spend'], advertiser_job: 'synthetic' }),
        /does not permit the argument advertiser_job/);
    } finally {
      await connection.close();
    }
  }, {
    readOnlyTools: grant,
    toolArgumentConstraints: Object.fromEntries(grant.map((name) => [name, metaScope])),
  });
  assert.deepEqual(server.calls, [META_ADS_ACCOUNT_HELPER, META_ADS_FIELD_HELPER]);
  assert.deepEqual(server.callArguments, [{ advertiser_request: 'Synthetic request.' }, { field_names: ['spend'] }]);
  assert.deepEqual(logs.missing, []);
});

test('a Meta tool whose live schema requires an unreviewed argument is not mounted, and the rest are', async (t) => {
  const logs = captureLogs(t);
  const server = pagedServer('json', [[liveHelper, liveReport(['ad_account_id', 'advertiser_job']), liveEntities]]);
  await withRuntimeConnection(metaConnection(), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition),
      [`mcp__meta__${META_ADS_ACCOUNT_HELPER}`, `mcp__meta__${META_ENTITIES}`]);
  }, metaDeclaration());
  assert.deepEqual(logs.missing, [{
    event: 'chickpea.mcp.tools_missing', connectionId: 'meta', missing: [], taskOnly: [], listedCount: 3,
    schemaRequires: { [META_REPORT]: ['advertiser_job'] },
  }]);
});

test('a granted Meta tool with no usable reviewed schema is not mounted, and the rest are', async (t) => {
  const logs = captureLogs(t);
  const server = pagedServer('json', [[liveHelper, liveReport(), liveEntities]]);
  // The helper's live schema requires nothing; the entities tool's requires its account.
  const stored = META_STORED.map((tool) => tool.name === META_REPORT ? tool : { name: tool.name });
  await withRuntimeConnection(metaConnection({ discoveredTools: stored }), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), [`mcp__meta__${META_REPORT}`]);
  }, metaDeclaration());
  assert.deepEqual(logs.missing, [{
    event: 'chickpea.mcp.tools_missing', connectionId: 'meta', missing: [], taskOnly: [], listedCount: 3,
    schemaRequires: { [META_ADS_ACCOUNT_HELPER]: [], [META_ENTITIES]: [] },
  }]);
});

test('a Meta name listed twice stays unmounted after a withheld first copy, and stays mounted after a mounted one', async (t) => {
  const logs = captureLogs(t);
  const grant = [META_REPORT, META_ENTITIES];
  const unusable = liveReport(['ad_account_id', 'advertiser_job']);
  const withheldFirst = pagedServer('json', [[unusable, liveReport(), liveEntities]]);
  await withRuntimeConnection(metaConnection({ allowedTools: grant }), withheldFirst.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), [`mcp__meta__${META_ENTITIES}`]);
  }, metaDeclaration(grant));
  assert.deepEqual(logs.missing.map(({ missing, schemaRequires }) => ({ missing, schemaRequires })), [
    { missing: [], schemaRequires: { [META_REPORT]: ['advertiser_job'] } },
  ]);

  logs.missing.length = 0;
  const mountedFirst = pagedServer('json', [[liveReport()], [unusable, liveEntities]]);
  await withRuntimeConnection(metaConnection({ allowedTools: grant }), mountedFirst.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), [`mcp__meta__${META_REPORT}`, `mcp__meta__${META_ENTITIES}`]);
  }, metaDeclaration(grant));
  assert.deepEqual(logs.missing, [], 'a later copy of a mounted name is ignored, not reported');
});

test('a malformed tool in a Meta listing still fails the listing instead of disappearing', async (t) => {
  const logs = captureLogs(t);
  const server = pagedServer('json', [[liveReport(), { description: 'A synthetic tool without a name.' }]]);
  await withRuntimeConnection(metaConnection(), server.fetch, async (definition) => {
    await assert.rejects(createMcpConnection(definition), /Meta Ads tool discovery returned an unsupported response \(tool\)/);
  }, metaDeclaration());
  assert.deepEqual(logs.refused, [{ event: 'chickpea.mcp.tools_list_refused', connectionId: 'meta', reason: 'tool' }]);
});

test('a Meta connection whose every granted tool is withheld fails with a reason a person can act on', async (t) => {
  const logs = captureLogs(t);
  const server = pagedServer('json', [[liveHelper, liveReport(['ad_account_id', 'scheduled_task_run'])]]);
  await withRuntimeConnection(metaConnection({ allowedTools: [META_REPORT] }), server.fetch, async (definition) => {
    await assert.rejects(createMcpConnection(definition),
      /^Error: Meta Ads no longer offers any of the tools this Agent may use\./);
  }, metaDeclaration([META_REPORT]));
  assert.deepEqual(logs.missing.map(({ schemaRequires }) => schemaRequires), [{ [META_REPORT]: ['scheduled_task_run'] }]);
  assert.deepEqual(logs.refused, [{ event: 'chickpea.mcp.tools_list_refused', connectionId: 'meta', reason: 'no-granted-tools' }]);
});

test('a withheld Meta tool logs only short identifier names from the live schema, and at most 20', async (t) => {
  const logs = captureLogs(t);
  const many = Array.from({ length: 30 }, (_, index) => `synthetic_${index}`);
  const server = pagedServer('json', [[
    liveHelper, liveReport(['ad_account_id', 'synthetic private sentence', { nested: true }, ...many] as string[]),
  ]]);
  await withRuntimeConnection(metaConnection({ allowedTools: [META_REPORT] }), server.fetch, async (definition) => {
    await assert.rejects(createMcpConnection(definition), /no longer offers any of the tools/);
  }, metaDeclaration([META_REPORT]));
  assert.deepEqual(logs.missing.map(({ schemaRequires }) => schemaRequires), [{
    [META_REPORT]: ['(other)', '(other)', ...many.slice(0, 18)],
  }]);
});

/** Meta's account list, as structured content and as text, the way Meta answers. */
function accountAnswer(accounts: Record<string, unknown>) {
  return (rpc: Rpc) => Response.json({
    jsonrpc: '2.0', id: rpc.id,
    result: { content: [{ type: 'text', text: JSON.stringify(accounts) }], structuredContent: accounts },
  });
}

const metaAccounts = [
  { ad_account_id: 'act_123450001', is_ads_mcp_enabled: true, is_queryable: true, ad_account_name: 'Synthetic Advertiser' },
  { ad_account_id: 'act_999000999', is_ads_mcp_enabled: true, is_queryable: true, ad_account_name: 'Not Approved' },
];

test('an account answer with a new top-level key verifies, without that key, and logs its name once', async (t) => {
  const logs = captureLogs(t);
  const server = mcpServer(
    (rpc) => Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: [liveHelper] } }),
    accountAnswer({ accounts: metaAccounts, has_more: false, request_context: { trace: 'synthetic-private-trace' } }),
  );
  const grant = [META_ADS_ACCOUNT_HELPER];
  await withRuntimeConnection(metaConnection({ allowedTools: grant }), server.fetch, async (definition) => {
    const connection = await createMcpConnection(definition);
    try {
      const answer = await preparedMcpExecutor(mounted(connection, META_ADS_ACCOUNT_HELPER))({});
      assert.match(answer, /"ad_account_id": "123450001"/);
      assert.doesNotMatch(answer, /request_context|synthetic-private-trace|999000999|Not Approved/);
    } finally {
      await connection.close();
    }
  }, metaDeclaration(grant));
  assert.deepEqual(logs.envelopeKeys, [{
    event: 'chickpea.meta_ads.account_envelope_extra_keys', connectionId: 'meta', keys: ['request_context'],
  }]);
});

test('an account answer that signals more pages is still refused, whatever new keys it holds', async (t) => {
  captureLogs(t);
  const server = mcpServer(
    (rpc) => Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: [liveHelper] } }),
    accountAnswer({ accounts: metaAccounts, has_more: true, request_context: {} }),
  );
  const grant = [META_ADS_ACCOUNT_HELPER];
  await withRuntimeConnection(metaConnection({ allowedTools: grant }), server.fetch, async (definition) => {
    const connection = await createMcpConnection(definition);
    try {
      await assert.rejects(preparedMcpExecutor(mounted(connection, META_ADS_ACCOUNT_HELPER))({}),
        /unsupported response \(incomplete-pagination;/);
    } finally {
      await connection.close();
    }
  }, metaDeclaration(grant));
});

// --- the filter on its own ------------------------------------------------

const filter = () => createMcpToolsListFilter({ connectionId: 'srv', grant: ['alpha', 'gamma'], transport: 'streamable-http' });
/** One tools/list answer through a fresh filter. */
const readListing = (response: Response) => filter().request({ id: 3, method: 'tools/list' }, 'Example Tools')!(response);
const answer = (id: number, tools: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result: { tools } });

/** A legacy SSE filter's view of one GET stream: `push` writes upstream, `read` takes what the client gets next. */
async function legacyStream() {
  const sse = createMcpToolsListFilter({ connectionId: 'srv', grant: ['alpha', 'gamma'], transport: 'sse' });
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  let upstreamCancelled = false;
  const get = sse.guardGets((async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      upstream = controller;
    },
    cancel() {
      upstreamCancelled = true;
    },
  }), { headers: { 'content-type': 'text/event-stream' } })) as typeof globalThis.fetch);
  const reader = (await get(URL_, { method: 'GET' })).body!.getReader();
  const decoder = new TextDecoder();
  return {
    sse,
    push: (text: string) => upstream.enqueue(encoder.encode(text)),
    read: async () => decoder.decode((await reader.read()).value),
    close: () => reader.cancel(),
    upstreamCancelled: () => upstreamCancelled,
  };
}
const note = 'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"x"}}\n\n';

test('on a legacy SSE stream an answer that comes before its request is dropped, and the one after is filtered', async (t) => {
  const logs = captureLogs(t);
  const stream = await legacyStream();
  stream.push(`event: endpoint\ndata: /messages\n\ndata: ${answer(3, [{ name: 'extra' }, { name: 'alpha' }])}\n\n${note}`);
  assert.equal(await stream.read(), `event: endpoint\ndata: /messages\n\n${note}`);
  assert.equal(stream.sse.request({ id: 3, method: 'tools/list' }, 'Example Tools'), undefined,
    'the POST carries no answer on this transport');
  stream.push(`data: ${answer(3, [{ name: 'extra' }, { name: 'alpha' }, { name: 'gamma' }])}\n\n`);
  assert.equal(await stream.read(), `data: ${answer(3, [{ name: 'alpha' }, { name: 'gamma' }])}\n\n`);
  assert.deepEqual(logs.refused, [refusedLine('response-id')]);
  await stream.close();
});

test('a refused legacy SSE answer reaches the client as an error for every request the stream still owes', async (t) => {
  captureLogs(t);
  const stream = await legacyStream();
  stream.sse.request({ id: 3, method: 'tools/list' }, 'Example Tools');
  stream.push(`data: [${answer(3, [{ name: 'alpha' }])}]\n\n`);
  assert.equal(await stream.read(), `data: ${JSON.stringify({
    jsonrpc: '2.0', id: 3, error: { code: -32603, message: unsupported('batch') },
  })}\n\n`);
  stream.push(`data: ${answer(3, [{ name: 'alpha' }])}\n\n${note}`);
  assert.equal(await stream.read(), note, 'an answer it no longer owes is dropped while the listing is open');
  await stream.close();
});

test('after the last legacy SSE page, the stream passes answers without reading them', async (t) => {
  captureLogs(t);
  const stream = await legacyStream();
  stream.sse.request({ id: 3, method: 'tools/list' }, 'Example Tools');
  stream.push(`data: ${answer(3, [{ name: 'alpha' }, { name: 'gamma' }])}\n\n`);
  await stream.read();
  assert.equal(stream.sse.request({ id: 4, method: 'tools/call' }, 'Example Tools'), undefined);
  const call = 'data: {"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"done"}]}}\n\n';
  stream.push(`${call}data: not json\n\n`);
  assert.equal(await stream.read(), `${call}data: not json\n\n`);
  await stream.close();
  assert.ok(stream.upstreamCancelled(), "letting go of the client's stream lets go of the server's");
});

test('a legacy SSE listing still owed when another closes the window is filtered, and other answers pass', async (t) => {
  captureLogs(t);
  const stream = await legacyStream();
  stream.sse.request({ id: 3, method: 'tools/list' }, 'Example Tools');
  stream.sse.request({ id: 5, method: 'tools/list' }, 'Example Tools');
  stream.push(`data: ${answer(3, [{ name: 'alpha' }, { name: 'gamma' }])}\n\n`);
  await stream.read();
  const call = 'data: {"jsonrpc":"2.0","id":4,"result":{"content":[]}}\n\n';
  stream.push(`${call}data: ${answer(5, [{ name: 'extra' }, { name: 'gamma' }])}\n\n`);
  assert.equal(await stream.read(), `${call}data: ${answer(5, [{ name: 'gamma' }])}\n\n`);
  await stream.close();
});

test('an event stream is split the way the MCP client splits it, loses its event ids, and ends at the answer', async (t) => {
  captureLogs(t);
  const listing = answer(3, [{ name: 'extra' }, { name: 'alpha' }]);
  const response = await readListing(eventStream([
    '﻿: comment\r',
    '\nretry: 250\rid: 8\n\nunknown: field\r\nevent: message\ndata: {"jsonrpc":"2.0",\r',
    '\ndata:"method":"notifications/progress"}\n\n',
    `id: 7\r\nevent: message\r\ndata: ${listing.slice(0, 10)}`,
    `${listing.slice(10)}\r\n\r`,
    '\ndata: {"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"gamma"}]}}\n\n',
  ]));
  assert.equal(await response.text(),
    'retry: 250\n\n' +
    'event: message\ndata: {"jsonrpc":"2.0",\ndata: "method":"notifications/progress"}\n\n' +
    `event: message\ndata: ${answer(3, [{ name: 'alpha' }])}\n\n`);
});

test('an answer in an event the client ignores does not end the listing', async (t) => {
  captureLogs(t);
  const response = await readListing(eventStream([
    `event: other\ndata: ${answer(3, [{ name: 'extra' }])}\n\n`,
    `data: ${answer(3, [{ name: 'extra' }, { name: 'gamma' }])}\n\n`,
  ]));
  assert.equal(await response.text(),
    `event: other\ndata: ${answer(3, [{ name: 'extra' }])}\n\ndata: ${answer(3, [{ name: 'gamma' }])}\n\n`);
});

test('an HTTP error passes through for the client to fail or retry', async (t) => {
  captureLogs(t);
  const unauthorized = new Response('unauthorized', { status: 401 });
  assert.equal(await readListing(unauthorized), unauthorized);
});

test('a listing larger than the cap is refused on both bodies', async (t) => {
  const logs = captureLogs(t);
  await assert.rejects(readListing(new Response('{}', {
    headers: { 'content-type': 'application/json', 'content-length': '8000001' },
  })), /\(response-size\)/);
  await assert.rejects(readListing(new Response('{}', {
    headers: { 'content-type': 'text/event-stream', 'content-length': '8000001' },
  })), /\(response-size\)/);
  await assert.rejects(readListing(eventStream([
    `data: ${'x'.repeat(4_000_000)}`, 'x'.repeat(4_000_001),
  ])), /\(response-size\)/);
  assert.deepEqual(logs.refused.map(({ reason }) => reason), ['response-size', 'response-size', 'response-size']);
});

test('an answer whose id is the request id as a string is read, as the MCP client reads it', async (t) => {
  const logs = captureLogs(t);
  const server = mcpServer((rpc) => Response.json({
    jsonrpc: '2.0', id: String(rpc.id), result: { tools: ['extra', 'gamma', 'alpha'].map(listedTool) },
  }));
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha', 'mcp__srv__gamma']);
  });
  await assert.rejects(readListing(new Response(answer(3, []).replace('"id":3', '"id":"4"'), {
    headers: { 'content-type': 'application/json' },
  })), /\(response-id\)/);
  assert.deepEqual(logs.refused.map(({ reason }) => reason), ['response-id']);
});

test('a JSON-RPC error with a result too, or another JSON-RPC version, is refused', async (t) => {
  captureLogs(t);
  for (const payload of [
    { jsonrpc: '2.0', id: 3, error: { code: -1, message: 'no' }, result: { tools: [] } },
    { jsonrpc: '1.0', id: 3, result: { tools: [{ name: 'alpha' }] } },
  ]) {
    await assert.rejects(readListing(Response.json(payload)), /\(json-rpc\)/);
  }
});

test('media type parameters and case do not change how the answer is read', async (t) => {
  captureLogs(t);
  for (const contentType of ['Application/JSON; charset=utf-8', 'text/event-stream; charset=utf-8']) {
    const body = contentType.startsWith('text/') ? `data: ${answer(3, [{ name: 'extra' }, { name: 'alpha' }])}\n\n`
      : answer(3, [{ name: 'extra' }, { name: 'alpha' }]);
    const response = await readListing(new Response(body, {
      headers: { 'content-type': contentType },
    }));
    assert.doesNotMatch(await response.text(), /extra/, contentType);
  }
});

test('an event-stream answer with no body is refused', async (t) => {
  const logs = captureLogs(t);
  await assert.rejects(readListing(new Response(null, {
    headers: { 'content-type': 'text/event-stream' },
  })), /\(no-response\)/);
  assert.deepEqual(logs.refused.map(({ reason }) => reason), ['no-response']);
});
