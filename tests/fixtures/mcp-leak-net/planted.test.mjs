// A test file the leak net must fail (tests/mcp-leak-net.test.ts runs it):
// one test's answer names a 4.x tool, inside a suite; the others are clean.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

function server() {
  const mcp = new McpServer({ name: 'chickpea-workspace', version: '0.0.0' });
  mcp.registerTool('get_workspace', { description: 'Planted.' }, async () => ({
    content: [{ type: 'text', text: 'Call inspect_workspace for the rest.' }],
  }));
  mcp.registerTool('get_agent', { description: 'Clean.' }, async () => ({
    content: [{ type: 'text', text: 'Call get_agent again for the rest.' }],
  }));
  return mcp;
}

async function call(name) {
  const response = await createMcpHandler(server, { legacy: 'stateless' }).fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
  }));
  const body = await response.text();
  assert.match(body, /for the rest/, 'the client still gets the answer');
}

describe('a suite', () => {
  test('a planted 4.x name fails its test', () => call('get_workspace'));
  test('a clean answer passes', () => call('get_agent'));
});

test('a clean answer at the top level passes', () => call('get_agent'));
