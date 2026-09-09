import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMcpToolArguments, mcpToolEffect } from '../src/config/mcp-tool-policy.ts';
import { resolveRuntimePlanMcpConnections } from '../src/config/profile-mcp.ts';

test('owner effects override server hints without guessing unknown tools', () => {
  assert.equal(mcpToolEffect({ discoveredTools: [{ name: 'query', readOnlyHint: true }],
    toolPolicies: { query: { effect: 'write' } } }, 'query'), false);
  assert.equal(mcpToolEffect({ discoveredTools: [], toolPolicies: { query: { effect: 'read' } } }, 'query'), true);
  assert.equal(mcpToolEffect({ discoveredTools: [{ name: 'run_query' }] }, 'run_query'), undefined);
});

test('exact argument restrictions reject missing, wrong-type and unapproved inputs', () => {
  const rules = { run_query: { data_source: ['postgres'] } };
  assert.doesNotThrow(() => assertMcpToolArguments('run_query', { data_source: 'postgres', sql_text: 'SELECT 1' }, rules));
  for (const args of [{}, null, { data_source: ['postgres'] }, { data_source: 'redshift' }, { data_source: 'POSTGRES' }]) {
    assert.throws(() => assertMcpToolArguments('run_query', args, rules), /approved value/);
  }
});

test('the production MCP fetch seam rejects unapproved input before outbound network I/O', async () => {
  const [connection] = resolveRuntimePlanMcpConnections('missing-agent', [{
    id: 'connection_test', url: 'https://mcp.example.com/mcp', transport: 'streamable-http',
    authMode: 'none', headerNames: [], optional: true, allowedTools: ['run_query'], readOnlyTools: ['run_query'],
    toolArgumentConstraints: { run_query: { data_source: ['postgres'] } },
  }]);
  await assert.rejects(connection!.fetch!('https://mcp.example.com/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'run_query', arguments: { data_source: 'redshift', sql_text: 'SELECT 1' } } }),
  }), /approved value/);
});
