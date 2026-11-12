import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withMcpHttpTelemetry } from '../src/config/mcp-telemetry.ts';

test('MCP HTTP telemetry records bounded timing and sizes without request or response content', async () => {
  const events: unknown[] = [];
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'run_query', arguments: { sql: 'select secret from users' } },
  });
  const times = [1_000, 1_037];
  const fetchFn = withMcpHttpTelemetry(
    async () => new Response('{"result":{"password":"hidden"}}', {
      status: 200,
      headers: { 'content-length': '32' },
    }),
    { connectionId: 'sql-dash', authMode: 'oauth' },
    { now: () => times.shift()!, emit: (event) => events.push(event) },
  );

  const response = await fetchFn('https://example.com/mcp?token=secret', {
    method: 'POST',
    headers: { authorization: 'Bearer secret-token' },
    body,
  });
  assert.deepEqual(events, [], 'a tool call is logged once its body is read');
  assert.equal(await response.text(), '{"result":{"password":"hidden"}}');

  assert.deepEqual(events, [{
    event: 'chickpea.mcp.http',
    connectionId: 'sql-dash',
    authMode: 'oauth',
    rpcMethod: 'tools/call',
    toolName: 'run_query',
    httpMethod: 'POST',
    status: 200,
    outcome: 'ok',
    durationMs: 37,
    requestBytes: Buffer.byteLength(body),
    responseBytes: 32,
  }]);
  assert.doesNotMatch(JSON.stringify(events), /select secret|password|secret-token|example\.com/);
});

test('MCP HTTP telemetry records network failures and rethrows the original error', async () => {
  const events: unknown[] = [];
  const failure = new Error('private upstream detail');
  const times = [2_000, 2_011];
  const fetchFn = withMcpHttpTelemetry(
    async () => { throw failure; },
    { connectionId: 'custom', authMode: 'none' },
    { now: () => times.shift()!, emit: (event) => events.push(event) },
  );

  await assert.rejects(() => fetchFn('https://example.com/mcp'), (error) => error === failure);
  assert.deepEqual(events, [{
    event: 'chickpea.mcp.http',
    connectionId: 'custom',
    authMode: 'none',
    rpcMethod: null,
    toolName: null,
    httpMethod: 'GET',
    status: null,
    outcome: 'network_error',
    durationMs: 11,
    requestBytes: null,
    responseBytes: null,
  }]);
  assert.doesNotMatch(JSON.stringify(events), /private upstream detail/);
});

// The MCP spec lets a server answer the client's optional GET stream with
// 405; the SDK carries on, so only a 405 elsewhere is an HTTP error.
test('MCP HTTP telemetry records a 405 to the optional GET stream as stream_unavailable', async () => {
  const events: Array<{ httpMethod: string; status: number | null; outcome: string }> = [];
  const fetchFn = withMcpHttpTelemetry(
    async () => new Response(null, { status: 405 }),
    { connectionId: 'custom', authMode: 'none' },
    { now: () => 0, emit: ({ httpMethod, status, outcome }) => events.push({ httpMethod, status, outcome }) },
  );

  await fetchFn('https://example.com/mcp', { method: 'GET', headers: { accept: 'text/event-stream' } });
  await fetchFn('https://example.com/mcp', { method: 'POST', body: '{}' });

  assert.deepEqual(events, [
    { httpMethod: 'GET', status: 405, outcome: 'stream_unavailable' },
    { httpMethod: 'POST', status: 405, outcome: 'http_error' },
  ]);
});

test('a streamed tool call counts the bytes the client read; other requests log at their headers', async () => {
  const events: Array<Record<string, unknown>> = [];
  const encoder = new TextEncoder();
  const call = JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'activity_log', arguments: {} } });
  const chunks = ['event: message\n', `data: {"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"${'é'.repeat(5_000)}"}]}}\n`, '\n'];
  const streamed = () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const times = [0, 9, 100, 104, 200, 203];
  let answer: () => Response = streamed;
  const fetchFn = withMcpHttpTelemetry(
    async () => answer(),
    { connectionId: 'meta-ads', authMode: 'oauth' },
    { now: () => times.shift()!, emit: (event) => events.push({ ...event }) },
  );
  const facts = () => events.map(({ rpcMethod, toolName, status, durationMs, responseBytes }) =>
    ({ rpcMethod, toolName, status, durationMs, responseBytes }));

  const response = await fetchFn('https://mcp.example.com/mcp', { method: 'POST', body: call });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const text = await response.text();
  assert.equal(text, chunks.join(''), 'the client reads the same bytes');
  assert.deepEqual(facts(), [{
    rpcMethod: 'tools/call', toolName: 'activity_log', status: 200, durationMs: 9,
    responseBytes: encoder.encode(chunks.join('')).byteLength,
  }]);

  // A body the client cancels part way is logged once, with what it read.
  answer = () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode('event: message\n')); },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const cancelled = (await fetchFn('https://mcp.example.com/mcp', { method: 'POST', body: call })).body!.getReader();
  await cancelled.read();
  await cancelled.cancel();
  await cancelled.cancel().catch(() => undefined);
  assert.deepEqual(facts().at(-1), { rpcMethod: 'tools/call', toolName: 'activity_log', status: 200, durationMs: 4, responseBytes: 15 });
  assert.equal(events.length, 2);

  // Any other request is logged at its headers, its body unread.
  answer = () => Response.json({ jsonrpc: '2.0', id: 5, result: { tools: [] } });
  await fetchFn('https://mcp.example.com/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }) });
  assert.deepEqual(facts().at(-1), { rpcMethod: 'tools/list', toolName: null, status: 200, durationMs: 3, responseBytes: null });
  assert.doesNotMatch(JSON.stringify(events), /é|activity_log.*text/);
});

test('a tool call body that fails mid-stream is logged once, with the bytes read before the failure', async () => {
  const events: Array<Record<string, unknown>> = [];
  const call = JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'run_query', arguments: {} } });
  let pulls = 0;
  const fetchFn = withMcpHttpTelemetry(
    async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array(10));
        else controller.error(new Error('private connection reset'));
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
    { connectionId: 'custom', authMode: 'none' },
    { now: () => 0, emit: (event) => events.push({ ...event }) },
  );
  const response = await fetchFn('https://mcp.example.com/mcp', { method: 'POST', body: call });
  await assert.rejects(response.arrayBuffer(), /private connection reset/);
  assert.deepEqual(events.map(({ responseBytes, outcome }) => ({ responseBytes, outcome })), [{ responseBytes: 10, outcome: 'ok' }]);
});
