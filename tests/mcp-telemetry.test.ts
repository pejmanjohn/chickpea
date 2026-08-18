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

  await fetchFn('https://example.com/mcp?token=secret', {
    method: 'POST',
    headers: { authorization: 'Bearer secret-token' },
    body,
  });

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
