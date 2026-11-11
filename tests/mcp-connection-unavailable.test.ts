import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  init, observe, useMcpConnection, useModel,
  type AgentProps, type FlueObservation, type McpConnectionDefinition,
} from '@flue/runtime';
import { start } from '@flue/runtime/node';

import type { RuntimePlanMcpConnectionV2 } from '../src/agents/runtime-plan.ts';
import { createCloudflareBindingProvider } from '../src/cloudflare-provider.ts';
import { McpBlockedUrlError } from '../src/config/mcp-errors.ts';
import { emitMcpConnectionUnavailable, withMcpFailureCause } from '../src/config/mcp-unavailable.ts';
import { resolveRuntimePlanMcpConnections } from '../src/config/profile-mcp.ts';
import { closeNodeStateStores, getConfigStore } from '../src/config/state-backend.ts';
import type { McpConnectionConfig } from '../src/config/types.ts';
import { opaqueId } from '../src/work/admission.ts';
import { withEnv } from './helpers/env.ts';

// Synthetic content only. Every server's words, and every tool name it lists
// beyond the grant, carry RAW so a test can prove none reaches the line.
const RAW = 'RAW-server-text';
const UNGRANTED = 'RAW_ungranted_tool';
const GRANT = ['alpha', 'beta'];
const MODEL = '@cf/zai-org/glm-5.3-flash';

type Rpc = { jsonrpc: '2.0'; id?: number; method: string; params?: Record<string, unknown> };
type Answer = (rpc: Rpc, request: Request) => Response | Promise<Response>;
type Listed = string | Record<string, unknown>;

const encoder = new TextEncoder();
const tool = (listed: Listed) => typeof listed === 'string'
  ? { name: listed, description: `The ${listed} tool.`, inputSchema: { type: 'object', properties: {} } }
  : { description: 'A tool.', inputSchema: { type: 'object', properties: {} }, ...listed };
const initializeResult = (rpc: Rpc) => ({
  protocolVersion: rpc.params?.protocolVersion,
  capabilities: { tools: {} },
  serverInfo: { name: 'synthetic', version: '1.0.0' },
});
const listing = (tools: readonly Listed[]): Answer => (rpc) =>
  Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: tools.map(tool) } });

/** A Streamable HTTP server that answers initialize, then tools/list with `list`. */
function server(answers: { initialize?: Answer; list?: Answer } = {}): typeof fetch {
  return (async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const rpc = await request.json() as Rpc;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') {
      return answers.initialize?.(rpc, request) ??
        Response.json({ jsonrpc: '2.0', id: rpc.id, result: initializeResult(rpc) });
    }
    if (rpc.method === 'tools/list') return (answers.list ?? listing(GRANT))(rpc, request);
    throw new Error(`Unexpected synthetic MCP request: ${rpc.method}`);
  }) as typeof fetch;
}

/** A legacy SSE server: every answer arrives on the GET stream. */
function legacySseServer(tools: readonly Listed[]): typeof fetch {
  let push: ((text: string) => void) | undefined;
  return (async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET') {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(encoder.encode(text));
          push('event: endpoint\ndata: /messages?session=synthetic\n\n');
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    const rpc = await request.json() as Rpc;
    if (rpc.id !== undefined) {
      const result = rpc.method === 'initialize' ? initializeResult(rpc) : { tools: tools.map(tool) };
      push?.(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`);
    }
    return new Response('Accepted', { status: 202 });
  }) as typeof fetch;
}

/** Never answer; give up only when the MCP client aborts the request. */
function hang(request: Request): Promise<Response> {
  return new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  });
}

interface Case {
  reason: string;
  status?: number;
  fetch: typeof fetch;
  connection?: Partial<McpConnectionConfig>;
  declaration?: Partial<RuntimePlanMcpConnectionV2>;
  timeoutMs?: number;
}

const CASES: Record<string, Case> = {
  'a 401 to initialize': { reason: 'auth', status: 401, fetch: server({ initialize: () => new Response(RAW, { status: 401 }) }) },
  'a 403 to tools/list': { reason: 'auth', status: 403, fetch: server({ list: () => new Response(RAW, { status: 403 }) }) },
  'a missing bearer credential': {
    reason: 'auth', fetch: server(), connection: { authMode: 'bearer' }, declaration: { authMode: 'bearer' },
  },
  'a 502 to initialize': { reason: 'http_error', status: 502, fetch: server({ initialize: () => new Response(RAW, { status: 502 }) }) },
  'a fetch that rejects': { reason: 'network', fetch: async () => { throw new TypeError(`fetch failed: ${RAW}`); } },
  'a refused socket': {
    reason: 'network',
    fetch: async () => { throw Object.assign(new Error(`connect ECONNREFUSED ${RAW}`), { code: 'ECONNREFUSED' }); },
  },
  'a blocked redirect': { reason: 'blocked_url', fetch: async () => { throw new McpBlockedUrlError(RAW); } },
  'a tools/list that never answers': { reason: 'timeout', timeoutMs: 250, fetch: server({ list: (_rpc, request) => hang(request) }) },
  'a connection changed since the plan': { reason: 'policy_changed', fetch: server(), declaration: { displayName: 'Renamed Tools' } },
  'a listing without any granted tool': { reason: 'tools_list_refused', fetch: server({ list: listing([UNGRANTED]) }) },
  'a legacy SSE listing without a granted tool': {
    reason: 'allowlist', fetch: legacySseServer(['alpha', UNGRANTED]), connection: { transport: 'sse' }, declaration: { transport: 'sse' },
  },
  'a legacy SSE granted tool that needs tasks': {
    reason: 'task_support',
    fetch: legacySseServer(['alpha', { name: 'beta', execution: { taskSupport: 'required' } }, UNGRANTED]),
    connection: { transport: 'sse' }, declaration: { transport: 'sse' },
  },
  'two granted names that collide in Flue': {
    reason: 'duplicate_tool_name', fetch: server({ list: listing(['a.b', 'a_b']) }), connection: { allowedTools: ['a.b', 'a_b'] },
  },
  'a JSON-RPC error answer to tools/list': {
    reason: 'other',
    fetch: server({ list: (rpc) => Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: RAW } }) }),
  },
};

function connectionConfig(overrides: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  const allowedTools = overrides.allowedTools ?? GRANT;
  return {
    id: 'srv',
    credentialRef: 'connection_44444444444444444444444444444444',
    displayName: 'Example Tools',
    url: 'https://mcp.example.com/mcp',
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

function modelAnswer(): Response {
  return new Response(`data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('each optional connection Flue drops logs one line with its reason, and none of the failure text', { timeout: 60_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-mcp-unavailable-'));
  const lines: Array<{ line: Record<string, unknown>; observation: FlueObservation }> = [];
  const warnings: FlueObservation[] = [];
  const stopObserving = observe((observation) => {
    if (observation.type === 'log' && observation.message.startsWith('MCP server "')) warnings.push(observation);
    emitMcpConnectionUnavailable(observation, { info: (line) => lines.push({ line, observation }) });
  });
  t.after(() => {
    stopObserving();
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  });
  // The filter's own refusal line and per-request telemetry are covered elsewhere.
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'warn', () => {});

  await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
    const definitions = new Map<string, McpConnectionDefinition>();
    for (const [index, [name, testCase]] of Object.entries(CASES).entries()) {
      const agentId = `agent_unavailable_${index}`;
      const created = await getConfigStore().createAgent({
        id: agentId, name: `Unavailable ${index}`, instructions: 'Answer briefly.', enabled: true,
        skills: [], mcpServers: [connectionConfig(testCase.connection)], apiConnections: [], repositories: [],
      });
      const stored = created.mcpServers[0]!;
      const [definition] = resolveRuntimePlanMcpConnections(agentId, [{
        id: stored.id, url: stored.url, transport: stored.transport, credentialRef: stored.credentialRef!,
        authMode: stored.authMode, headerNames: [], optional: true, allowedTools: [...stored.allowedTools],
        ...testCase.declaration,
      }], undefined, undefined, { createGuardedFetch: () => testCase.fetch });
      assert.ok(definition, name);
      definitions.set(`unavailable-${index}`, {
        ...definition, ...(testCase.timeoutMs ? { timeoutMs: testCase.timeoutMs } : {}),
      });
    }

    function UnavailableProbe({ id }: AgentProps) {
      useModel(`cloudflare/${MODEL}`);
      // As the Slack Agent mounts each of its connections.
      useMcpConnection(withMcpFailureCause(definitions.get(id)!, id));
      return 'Answer briefly.';
    }
    const provider = createCloudflareBindingProvider({ run: async () => modelAnswer() });
    const runtime = await start({ agents: [{ agent: UnavailableProbe, name: 'mcp-unavailable-probe' }], providers: [provider] });
    try {
      for (const id of definitions.keys()) {
        const agent = init(UnavailableProbe, { id });
        // The connection is optional: the turn still answers without it.
        assert.ok(await agent.read(await agent.dispatch('Synthetic request.')));
      }
    } finally {
      await runtime.stop();
    }
  });

  for (const [index, [name, testCase]] of Object.entries(CASES).entries()) {
    const id = `unavailable-${index}`;
    assert.equal(warnings.filter((warning) => warning.instanceId === id).length, 1, `${name}: Flue drops it once`);
    const mine = lines.filter(({ observation }) => observation.instanceId === id);
    assert.equal(mine.length, 1, `${name}: one line`);
    const [{ line, observation }] = mine as [typeof mine[number]];
    assert.deepEqual(line, {
      event: 'chickpea.mcp.connection_unavailable',
      connectionId: 'srv',
      reason: testCase.reason,
      ...(testCase.status === undefined ? {} : { status: testCase.status }),
      flueInstanceRef: opaqueId('flueinstance', id),
      flueSubmissionRef: opaqueId('fluesubmission', observation.submissionId!),
    }, name);
    const text = JSON.stringify(line);
    assert.equal(observation.type, 'log');
    const flueReason = String(observation.type === 'log' ? observation.attributes?.reason : '');
    for (const leaked of [RAW, UNGRANTED, 'Discovered tools', flueReason]) {
      assert.ok(!text.includes(leaked), `${name}: the line carries ${JSON.stringify(leaked)}`);
    }
  }
});

test('a later request on the same attempt replaces an earlier failure, and an abort records none', async () => {
  const lines: Array<Record<string, unknown>> = [];
  let status = 401;
  const definition = withMcpFailureCause({
    name: 'srv', url: 'https://mcp.example.com/mcp',
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      return new Response(RAW, { status });
    }) as typeof fetch,
  }, 'instance-retry');
  const drop = (reason: string) => emitMcpConnectionUnavailable({
    type: 'log', level: 'warn', instanceId: 'instance-retry',
    message: 'MCP server "srv" is unavailable; its tools are not mounted for this submission.',
    attributes: { server: 'srv', reason },
  } as unknown as FlueObservation, { info: (line) => lines.push(line) });
  const post = (signal?: AbortSignal) => definition.fetch!('https://mcp.example.com/mcp', { method: 'POST', body: '{}', ...(signal ? { signal } : {}) });

  await post();
  drop('Server returned 401 after re-authentication');
  status = 200;
  await post();
  drop(`[flue] MCP server "srv" does not expose "beta" named in the tools allowlist. Discovered tools: ${UNGRANTED}.`);
  status = 401;
  await post();
  await assert.rejects(post(AbortSignal.abort()));
  drop('Request timed out');
  // A GET the transport answers itself with 405 neither fails nor clears anything.
  status = 500;
  await post();
  status = 405;
  await definition.fetch!('https://mcp.example.com/mcp', { method: 'GET' });
  drop(RAW);

  assert.deepEqual(lines.map(({ reason, status }) => ({ reason, status })), [
    { reason: 'auth', status: 401 },
    { reason: 'allowlist', status: undefined },
    { reason: 'timeout', status: undefined },
    { reason: 'http_error', status: 500 },
  ]);
});

test('an auth callback that fails records auth, or policy_changed when the connection changed', async () => {
  const { McpConnectionChangedError } = await import('../src/config/mcp-errors.ts');
  const lines: Array<Record<string, unknown>> = [];
  for (const [instanceId, error, reason] of [
    ['instance-auth', new Error(RAW), 'auth'],
    ['instance-changed', new McpConnectionChangedError(RAW), 'policy_changed'],
  ] as const) {
    const definition = withMcpFailureCause({
      name: 'srv', url: 'https://mcp.example.com/mcp', auth: async () => { throw error; },
    }, instanceId);
    await assert.rejects(Promise.resolve((definition.auth as () => Promise<string>)()));
    emitMcpConnectionUnavailable({
      type: 'log', level: 'warn', instanceId,
      message: 'MCP server "srv" is unavailable; its tools are not mounted for this submission.',
      attributes: { server: 'srv', reason: RAW },
    } as unknown as FlueObservation, { info: (line) => lines.push(line) });
    assert.equal(lines.at(-1)?.reason, reason);
  }
});

test('Flue messages fall back to fixed shapes only for the server they name; anything else is other', () => {
  const lines: Array<Record<string, unknown>> = [];
  const drop = (server: string, reason: string, message = `MCP server "${server}" is unavailable; its tools are not mounted for this submission.`) =>
    emitMcpConnectionUnavailable({
      type: 'log', level: 'warn', instanceId: 'instance-without-attempt', submissionId: 'submission-1',
      message, attributes: { server, reason },
    } as unknown as FlueObservation, { info: (line) => lines.push(line) });

  drop('srv', 'Maximum total timeout exceeded');
  drop('srv', '[flue] MCP server "srv" tools allowlist repeats "alpha".');
  drop('srv', '[flue] MCP server "other" does not expose "beta" named in the tools allowlist. Discovered tools: alpha.');
  drop('srv', `[flue] MCP tools from server "srv" produced duplicate tool name "mcp__srv__a_b".`);
  drop('srv', `Version negotiation failed: ${RAW} (HTTP 401) timed out`);
  drop('a server name with spaces', 'Request timed out');
  drop('srv', 'Request timed out', 'Some other warning');
  emitMcpConnectionUnavailable({ type: 'log', level: 'info', message: 'MCP server "srv" is unavailable; its tools are not mounted for this submission.', attributes: { server: 'srv', reason: 'x' } } as unknown as FlueObservation, { info: (line) => lines.push(line) });

  assert.deepEqual(lines.map(({ connectionId, reason }) => [connectionId, reason]), [
    ['srv', 'timeout'],
    ['srv', 'allowlist'],
    ['srv', 'other'],
    ['srv', 'duplicate_tool_name'],
    ['srv', 'other'],
    ['(other)', 'timeout'],
  ]);
  assert.deepEqual(Object.keys(lines[0]!), ['event', 'connectionId', 'reason', 'flueInstanceRef', 'flueSubmissionRef']);
  assert.doesNotThrow(() => emitMcpConnectionUnavailable({
    type: 'log', level: 'warn', message: 'MCP server "srv" is unavailable; its tools are not mounted for this submission.',
    attributes: { server: 'srv', reason: 'x' },
  } as unknown as FlueObservation, { info: () => { throw new Error('sink down'); } }));
});
