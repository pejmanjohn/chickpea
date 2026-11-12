import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  init, instrument, observe, useMcpConnection, useModel,
  type AgentProps, type FlueObservation, type McpConnectionDefinition,
} from '@flue/runtime';
import { start } from '@flue/runtime/node';

import { createCloudflareBindingProvider } from '../src/cloudflare-provider.ts';
import {
  boundMcpToolResultText,
  MCP_TOOL_RESULT_MAX_BYTES,
  mcpToolResultBoundInterceptor,
} from '../src/config/mcp-tool-result-bound.ts';
import { resolveRuntimePlanMcpConnections } from '../src/config/profile-mcp.ts';
import { observingProviderStreamErrors } from '../src/model-compat/provider-stream-errors.ts';
import { closeNodeStateStores, getConfigStore } from '../src/config/state-backend.ts';
import { withEnv } from './helpers/env.ts';

// Synthetic content only.
const MODEL = '@cf/zai-org/glm-5.3-flash';
const TOOL = 'mcp__srv__alpha';
const LIMIT = MCP_TOOL_RESULT_MAX_BYTES;
const NOTE = /\n\n\[Cut at the 128 KiB limit: this result was \d+ KiB, and only its beginning is shown above\. To get a complete result, narrow the request: fewer rows, a shorter time range, or fewer fields\.\]$/;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;

/** Rows of synthetic data, with two- and four-byte characters so a cut can land inside one. */
function rows(count: number): string {
  return Array.from({ length: count }, (_, index) => `row ${index}: café ☕ 𝄞 ${'x'.repeat(40)}`).join('\n');
}

test('a result under the bound is untouched; over it, it is cut on a character boundary and ends with the note', () => {
  for (const text of ['', 'small', 'é'.repeat(LIMIT / 2), 'x'.repeat(LIMIT)]) {
    assert.equal(boundMcpToolResultText(text), undefined, `${bytes(text)} bytes fit`);
  }
  for (const text of ['x'.repeat(LIMIT + 1), rows(5_000), '𝄞'.repeat(LIMIT)]) {
    const bounded = boundMcpToolResultText(text)!;
    assert.ok(bounded.cut);
    assert.equal(bounded.duplicateDropped, false);
    assert.equal(bounded.originalBytes, bytes(text));
    assert.equal(bounded.keptBytes, bytes(bounded.text));
    assert.ok(bounded.keptBytes <= LIMIT, 'the note fits inside the bound');
    assert.ok(bounded.keptBytes > LIMIT - 4 - 300, 'nearly the whole bound is kept');
    assert.match(bounded.text, NOTE);
    const kept = bounded.text.replace(NOTE, '');
    assert.ok(text.startsWith(kept), 'the kept text is the start of the result');
    assert.ok(!kept.includes('�'), 'no character is split');
    assert.match(bounded.text, new RegExp(`this result was ${Math.ceil(bytes(text) / 1024)} KiB`));
  }
});

test('a structured copy that a text block repeats is dropped before anything is cut', () => {
  const data = { rows: Array.from({ length: 1_500 }, (_, index) => ({ id: index, name: `row ${index}`, note: 'café' })) };
  const compact = JSON.stringify(data);
  const flue = (text: string) => `Structured content:\n${JSON.stringify(data, null, 2)}\n\n${text}`;
  assert.ok(bytes(compact) < LIMIT && bytes(flue(compact)) > LIMIT, 'one copy fits and two do not');

  const deduplicated = boundMcpToolResultText(flue(compact))!;
  assert.deepEqual(
    { ...deduplicated, text: undefined },
    { text: undefined, originalBytes: bytes(flue(compact)), keptBytes: bytes(compact), duplicateDropped: true, cut: false },
  );
  assert.equal(deduplicated.text, compact, 'the server\'s own text, once, and no note');
  const trailing = `${compact}\n\nSee the next page with cursor 2.`;
  assert.equal(boundMcpToolResultText(flue(trailing))!.text, trailing, 'blocks after the copy stay');

  // A text block holding other data is not a copy: the whole result is cut.
  const other = JSON.stringify({ ...data, extra: true });
  const cut = boundMcpToolResultText(flue(other))!;
  assert.equal(cut.duplicateDropped, false);
  assert.ok(cut.cut && cut.text.startsWith('Structured content:\n{'));

  // Two copies of data too large for one copy: one copy, cut.
  const large = { rows: [...data.rows, ...data.rows, ...data.rows] };
  const both = `Structured content:\n${JSON.stringify(large, null, 2)}\n\n${JSON.stringify(large)}`;
  const largeCut = boundMcpToolResultText(both)!;
  assert.deepEqual([largeCut.duplicateDropped, largeCut.cut], [true, true]);
  assert.ok(largeCut.text.startsWith('{"rows":[{"id":0,'), 'the kept copy is the server\'s compact one');
  assert.match(largeCut.text, NOTE);
});

test('only an MCP tool\'s one-text-block result is bounded; any other tool or shape passes as it is', async () => {
  const big = { content: [{ type: 'text', text: 'x'.repeat(LIMIT + 1) }], details: { customTool: 'x' } };
  const run = (toolName: string, result: unknown) => mcpToolResultBoundInterceptor(
    { type: 'tool', toolCallId: 'call_1', toolName }, {}, async () => result,
  );
  const info = console.info;
  console.info = () => {};
  try {
    assert.equal(await run('read_slack_thread', big), big, 'a Chickpea tool is not an MCP tool');
    const twoBlocks = { content: [...big.content, { type: 'text', text: 'y' }] };
    assert.equal(await run(TOOL, twoBlocks), twoBlocks);
    const bounded = await run(TOOL, big) as typeof big;
    assert.match(bounded.content[0]!.text, NOTE);
    assert.deepEqual(bounded.details, big.details, 'the rest of the result is kept');
    assert.equal(big.content[0]!.text.length, LIMIT + 1, 'the original is not changed in place');
    const failure = new Error('x'.repeat(LIMIT + 1));
    await assert.rejects(mcpToolResultBoundInterceptor({ type: 'tool', toolCallId: 'call_2', toolName: TOOL }, {},
      async () => { throw failure; }), (error) => error === failure);
  } finally {
    console.info = info;
  }
});

/** Streamable HTTP server whose one tool answers with `result`, as JSON or as an event stream. */
function server(result: Record<string, unknown>, answer: 'json' | 'sse'): typeof fetch {
  return (async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const rpc = await request.json() as { id?: number; method: string; params?: Record<string, unknown> };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') {
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: {
        protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'synthetic', version: '1.0.0' },
      } });
    }
    if (rpc.method === 'tools/list') {
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{
        name: 'alpha', description: 'Read synthetic rows.', inputSchema: { type: 'object', properties: {} },
      }] } });
    }
    assert.equal(rpc.method, 'tools/call');
    const body = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
    if (answer === 'json') return new Response(body, { headers: { 'content-type': 'application/json' } });
    // Streamed in pieces, without a Content-Length, as Meta streams its answers.
    const event = encoder.encode(`event: message\ndata: ${body}\n\n`);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < event.byteLength; at += 16_384) controller.enqueue(event.slice(at, at + 16_384));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}

function modelAnswer(delta: Record<string, unknown>): Response {
  return new Response(`data: ${JSON.stringify({
    choices: [{ index: 0, delta, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

interface Case {
  result: Record<string, unknown>;
  answer: 'json' | 'sse';
}

interface Seen {
  /** The tool result text in the model's next request. */
  toolText: string;
  isError: boolean;
  bound: Array<Record<string, unknown>>;
  http: Array<Record<string, unknown>>;
}

/** Each case on its own Agent through Flue's runtime: the model calls alpha once, then answers. */
async function runCases(
  cases: Record<string, Case>,
  options: { registerBound?: boolean; importApp?: boolean; onModelCall?: () => void } = {},
): Promise<Map<string, Seen>> {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-mcp-result-bound-'));
  const seen = new Map<string, Seen>();
  const instanceOf = new Map<string, string>();
  const lines: Array<Record<string, unknown>> = [];
  const stopObserving = observe((observation: FlueObservation) => {
    if (observation.type !== 'turn_request' || !observation.instanceId) return;
    const result = observation.request.input.messages.find((message) => message.role === 'toolResult');
    if (!result || result.role !== 'toolResult') return;
    const name = instanceOf.get(observation.instanceId)!;
    seen.set(name, {
      toolText: result.content.map((part) => part.type === 'text' ? part.text : '').join(''),
      isError: result.isError,
      bound: [], http: [],
    });
  });
  const disposeBound = options.registerBound ?? true
    ? instrument({ key: Symbol('mcp-tool-result-bound'), interceptor: mcpToolResultBoundInterceptor, observe() {}, dispose() {} })
    : () => {};
  const info = console.info;
  console.info = (line: unknown) => {
    if (line && typeof line === 'object') lines.push(line as Record<string, unknown>);
  };
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
      if (options.importApp) await import('../src/app.ts');
      const definitions = new Map<string, McpConnectionDefinition>();
      for (const [index, [name, testCase]] of Object.entries(cases).entries()) {
        const agentId = `agent_bound_${index}`;
        const created = await getConfigStore().createAgent({
          id: agentId, name: `Bound ${index}`, instructions: 'Answer briefly.', enabled: true, skills: [],
          mcpServers: [{
            id: 'srv', credentialRef: 'connection_44444444444444444444444444444444', displayName: 'Example Tools',
            url: 'https://mcp.example.com/mcp', transport: 'streamable-http', authMode: 'none', headerNames: [],
            enabled: true, lifecycleStatus: 'ready', statusText: '', discoveredTools: [{ name: 'alpha' }],
            allowedTools: ['alpha'],
          }],
          apiConnections: [], repositories: [],
        });
        const stored = created.mcpServers[0]!;
        const [definition] = resolveRuntimePlanMcpConnections(agentId, [{
          id: stored.id, url: stored.url, transport: stored.transport, credentialRef: stored.credentialRef!,
          authMode: stored.authMode, headerNames: [], optional: false, allowedTools: [...stored.allowedTools],
        }], undefined, undefined, { createGuardedFetch: () => server(testCase.result, testCase.answer) });
        const id = `bound-${index}`;
        definitions.set(id, definition!);
        instanceOf.set(id, name);
      }

      function BoundProbe({ id }: AgentProps) {
        useModel(`cloudflare/${MODEL}`);
        useMcpConnection(definitions.get(id)!);
        return 'Read the rows.';
      }
      let calls = 0;
      const provider = createCloudflareBindingProvider({ run: async (_model, inputs) => {
        calls += 1;
        options.onModelCall?.();
        const toolResultSent = (inputs.messages as Array<{ role?: string }>).some((message) => message.role === 'tool');
        return modelAnswer(toolResultSent ? { content: 'Done.' } : {
          tool_calls: [{ index: 0, id: `call_${calls}`, type: 'function', function: { name: TOOL, arguments: '{}' } }],
        });
      } });
      const runtime = await start({ agents: [{ agent: BoundProbe, name: 'mcp-result-bound-probe' }], providers: [provider] });
      try {
        for (const id of definitions.keys()) {
          const agent = init(BoundProbe, { id });
          assert.equal((await agent.read(await agent.dispatch('Synthetic request.'))).text, 'Done.');
          const entry = seen.get(instanceOf.get(id)!);
          assert.ok(entry, `${instanceOf.get(id)}: the model got a tool result`);
          entry.bound = lines.filter((line) => line.event === 'chickpea.mcp.tool_result_bounded');
          entry.http = lines.filter((line) => line.event === 'chickpea.mcp.http' && line.rpcMethod === 'tools/call');
          lines.length = 0;
        }
      } finally {
        await runtime.stop();
      }
    });
  } finally {
    console.info = info;
    disposeBound();
    stopObserving();
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
  return seen;
}

const oversized = rows(6_000);
const undersized = rows(1_000);
const data = { rows: Array.from({ length: 2_500 }, (_, index) => ({ id: index, name: `row ${index}` })) };

test('every MCP tool result the model sees through Flue is bounded, and a streamed answer\'s bytes are counted', { timeout: 60_000 }, async () => {
  const cases: Record<string, Case> = {
    'JSON over the bound': { answer: 'json', result: { content: [{ type: 'text', text: oversized }] } },
    'event stream over the bound': { answer: 'sse', result: { content: [{ type: 'text', text: oversized }] } },
    'event stream under the bound': { answer: 'sse', result: { content: [{ type: 'text', text: undersized }] } },
    'an error over the bound': { answer: 'json', result: { content: [{ type: 'text', text: oversized }], isError: true } },
    'structured content and its text copy': {
      answer: 'sse',
      result: { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] },
    },
  };
  const seen = await runCases(cases);
  const answerBytes = (name: string) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 0, result: cases[name]!.result });
    return { json: bytes(body), sse: bytes(`event: message\ndata: ${body}\n\n`) }[cases[name]!.answer];
  };

  for (const name of ['JSON over the bound', 'event stream over the bound']) {
    const { toolText, isError, bound, http } = seen.get(name)!;
    assert.equal(isError, false, name);
    assert.ok(bytes(toolText) <= LIMIT, `${name}: the model sees at most the bound`);
    assert.match(toolText, NOTE, name);
    assert.ok(oversized.startsWith(toolText.replace(NOTE, '')), `${name}: the start of the result, unchanged`);
    assert.deepEqual(bound, [{
      event: 'chickpea.mcp.tool_result_bounded', connectionId: 'srv', toolName: 'alpha',
      originalBytes: bytes(oversized), keptBytes: bytes(toolText), duplicateDropped: false, cut: true,
    }], name);
    assert.equal(http.length, 1, name);
    // The request id in the answer is the client's; the size differs only by its digits.
    assert.ok(Math.abs(Number(http[0]!.responseBytes) - answerBytes(name)) < 4, `${name}: the bytes the client read`);
  }

  const under = seen.get('event stream under the bound')!;
  assert.equal(under.toolText, undersized, 'a result under the bound reaches the model byte for byte');
  assert.deepEqual(under.bound, []);
  assert.ok(Math.abs(Number(under.http[0]!.responseBytes) - answerBytes('event stream under the bound')) < 4,
    'a streamed answer without a Content-Length is counted');

  const error = seen.get('an error over the bound')!;
  assert.equal(error.isError, true, 'an error stays an error');
  assert.ok(error.toolText.includes(oversized), 'the error\'s whole text reaches the model');
  assert.doesNotMatch(error.toolText, NOTE);
  assert.deepEqual(error.bound, []);

  const structured = seen.get('structured content and its text copy')!;
  assert.equal(structured.toolText, JSON.stringify(data), 'one copy, in the server\'s own form, and nothing cut');
  assert.equal(structured.bound.length, 1);
  assert.equal(structured.bound[0]!.duplicateDropped, true);
  assert.equal(structured.bound[0]!.cut, false);

  for (const { bound } of seen.values()) {
    assert.doesNotMatch(JSON.stringify(bound), /row \d|café/, 'the bound line carries no content');
  }
});

test('without the bound, Flue sends the model the whole result: the bound is what cuts it', { timeout: 60_000 }, async () => {
  const turnScoped: boolean[] = [];
  const seen = await runCases({
    'JSON over the bound': { answer: 'json', result: { content: [{ type: 'text', text: oversized }] } },
  }, { registerBound: false, onModelCall: () => turnScoped.push(observingProviderStreamErrors(undefined) !== undefined) });
  assert.equal(seen.get('JSON over the bound')!.toolText, oversized);
  assert.deepEqual(turnScoped, [false, false], 'without src/app.ts no model turn is in scope for the provider');
});

// Last: once src/app.ts is imported its interceptor stays registered.
test('the interceptors registered in src/app.ts bound MCP tool results and scope each model turn', { timeout: 60_000 }, async () => {
  const turnScoped: boolean[] = [];
  const seen = await runCases({
    'JSON over the bound': { answer: 'json', result: { content: [{ type: 'text', text: oversized }] } },
  }, { registerBound: false, importApp: true,
    onModelCall: () => turnScoped.push(observingProviderStreamErrors(undefined) !== undefined) });
  const { toolText, bound } = seen.get('JSON over the bound')!;
  assert.match(toolText, NOTE);
  assert.equal(bound.length, 1);
  // The provider opens its stream with the Flue model turn in scope, so an
  // in-stream error's code can be kept for that turn's failure line.
  assert.deepEqual(turnScoped, [true, true], 'src/app.ts puts each model turn in scope');
});
