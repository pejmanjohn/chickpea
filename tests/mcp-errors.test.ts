import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  McpBlockedUrlError,
  classifyMcpError,
  mcpDebugText,
  safeMcpFailureText,
} from '../src/config/mcp-errors.ts';
import type { McpErrorCode } from '../src/config/mcp-errors.ts';

const CASES: { input: unknown; code: McpErrorCode }[] = [
  { input: new Error('fetch failed'), code: 'network' },
  { input: new Error('Failed to fetch'), code: 'network' },
  { input: new Error('some network error'), code: 'network' },
  { input: new Error('Request timed out'), code: 'timeout' },
  { input: new Error('connect timeout after 8000ms'), code: 'timeout' },
  { input: new Error('HTTP 401 Unauthorized'), code: 'unauthorized' },
  { input: new Error('server said 401'), code: 'unauthorized' },
  {
    input: Object.assign(
      new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token"}'),
      { code: 401 },
    ),
    code: 'unauthorized',
  },
  {
    input: Object.assign(new Error('bad request: missing required Authorization header'), {
      code: 403,
    }),
    code: 'unauthorized',
  },
  { input: Object.assign(new Error('not found'), { code: 404 }), code: 'mcp_connection_failed' },
  { input: Object.assign(new Error('fetch failed'), { code: undefined }), code: 'network' },
  { input: new McpBlockedUrlError('Private and internal IP addresses are not allowed.'), code: 'blocked_url' },
  { input: new Error('failed to discover tools'), code: 'discovery_failed' },
  { input: new Error('Error compiling schema, function code: ...'), code: 'discovery_failed' },
  { input: new Error('structured content does not match the tool output schema'), code: 'discovery_failed' },
  { input: new Error('weird ECONNRESET blob'), code: 'mcp_connection_failed' },
  { input: 'boom', code: 'mcp_connection_failed' },
];

test('classifyMcpError maps errors to the expected codes', () => {
  for (const { input, code } of CASES) {
    const label = input instanceof Error ? input.message : String(input);
    assert.equal(classifyMcpError(input), code, label + ' should classify as ' + code);
  }
});

test('McpBlockedUrlError message starts with the blocked-url marker', () => {
  const err = new McpBlockedUrlError('Local and internal hostnames are not allowed.');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'McpBlockedUrlError');
  assert.ok(err.message.startsWith('blocked url: '), 'message must start with "blocked url: "');
  assert.equal(classifyMcpError(err), 'blocked_url');
});

test('safeMcpFailureText yields a distinct non-empty sentence per code', () => {
  const seen = new Map<McpErrorCode, string>();
  for (const { input, code } of CASES) {
    const text = safeMcpFailureText(input);
    assert.ok(text.length > 0, code + ' should have non-empty safe text');
    const prior = seen.get(code);
    if (prior !== undefined) {
      assert.equal(text, prior, code + ' should map to a stable sentence');
    } else {
      seen.set(code, text);
    }
  }
  // Each classified code produces a different user-facing sentence.
  const sentences = [...seen.values()];
  assert.equal(new Set(sentences).size, sentences.length, 'safe sentences must be distinct per code');
});

test('safe text never leaks the raw error message', () => {
  const rawFragments = [
    'ECONNRESET',
    'connect timeout after 8000ms',
    'HTTP 401 Unauthorized',
    'fetch failed',
    'failed to discover tools',
    'Error compiling schema',
    'boom',
  ];
  for (const fragment of rawFragments) {
    const text = safeMcpFailureText(new Error(fragment));
    assert.ok(
      !text.includes(fragment),
      'safe text must not contain the raw fragment "' + fragment + '"',
    );
  }
  assert.ok(!safeMcpFailureText('boom').includes('boom'), 'non-Error input must not leak');
});

test('mcpDebugText drops URLs plus path, query, and userinfo credentials', () => {
  const text = mcpDebugText(
    new Error(
      'POST https://url-user:url-password@mcp.example.com/capability;path-secret,tail?token=query%2Fsecret;query-secret,tail&scope=admin failed; ' +
        'upstream echoed capability;path-secret,tail, query/secret;query-secret,tail, and query%2Fsecret;query-secret,tail',
    ),
    {
      url: 'https://url-user:url-password@mcp.example.com/capability;path-secret,tail?token=query%2Fsecret;query-secret,tail&scope=admin',
    },
  );

  assert.equal(text, 'mcp_connection_failed: [redacted]');
  assert.ok(!text.includes('url-user'));
  assert.ok(!text.includes('url-password'));
  assert.ok(!text.includes('capability'));
  assert.ok(!text.includes('path-secret'));
  assert.ok(!text.includes(';path-secret'));
  assert.ok(!text.includes('query/secret'));
  assert.ok(!text.includes('query%2Fsecret'));
  assert.ok(!text.includes(';query-secret'));
  assert.ok(!text.includes('scope=admin'));
});

test('mcpDebugText drops server-controlled SDK response bodies', () => {
  const text = mcpDebugText(
    new Error(
      'Streamable HTTP error: Error POSTing to endpoint: ' +
        '{"request":"https://mcp.example.com/capability/path-secret","internal":"unregistered-server-secret"}',
    ),
    { url: 'https://mcp.example.com/capability/path-secret' },
  );

  assert.equal(text, 'mcp_connection_failed: [redacted]');
  assert.ok(!text.includes('path-secret'));
  assert.ok(!text.includes('unregistered-server-secret'));
});

test('mcpDebugText drops SSE SDK response bodies', () => {
  const text = mcpDebugText(
    new Error(
      'Error POSTing to endpoint (HTTP 500): ' +
        '{"internal":"unregistered-sse-server-secret"}',
    ),
  );

  assert.equal(text, 'mcp_connection_failed: HTTP 500');
  assert.ok(!text.includes('unregistered-sse-server-secret'));
});

test('mcpDebugText drops remote JSON-RPC error messages and data', () => {
  const text = mcpDebugText(
    new McpError(-32603, 'unregistered-jsonrpc-server-secret', {
      internal: 'unregistered-jsonrpc-data-secret',
    }),
  );

  assert.equal(
    text,
    'mcp_connection_failed: MCP error -32603: [remote detail redacted]',
  );
  assert.ok(!text.includes('unregistered-jsonrpc-server-secret'));
  assert.ok(!text.includes('unregistered-jsonrpc-data-secret'));
});

test('mcpDebugText redacts bearer credentials and caller-supplied secret values', () => {
  const text = mcpDebugText(
    new Error(
      'HTTP 401 Authorization: Bearer bearer-secret, X-Custom-Credential: opaque-secret; ' +
        'upstream echoed only bearer-secret',
    ),
    {
      headers: {
        Authorization: 'Bearer bearer-secret',
        'X-Custom-Credential': 'opaque-secret',
      },
    },
  );

  assert.ok(!text.includes('bearer-secret'));
  assert.ok(!text.includes('opaque-secret'));
  assert.equal(text, 'unauthorized: [redacted]');
});

test('mcpDebugText preserves only an allowlisted local diagnostic marker', () => {
  const text = mcpDebugText(
    new Error(
      'Code generation from strings disallowed ' +
        'x'.repeat(145) +
        ' secret-that-crosses-the-limit',
    ),
    { headers: { 'X-Custom-Credential': 'secret-that-crosses-the-limit' } },
  );

  assert.equal(
    text,
    'mcp_connection_failed: Code generation from strings disallowed',
  );
  assert.ok(!text.includes('secret-that'));
});

test('mcpDebugText drops generic remote discovery metadata', () => {
  const cursor = mcpDebugText(
    new Error('Repeated tools/list cursor: unregistered-remote-cursor-secret'),
  );
  const schema = mcpDebugText(
    new Error('invalid schema for remote-secret-tool-name'),
  );

  assert.equal(cursor, 'mcp_connection_failed: [redacted]');
  assert.equal(schema, 'discovery_failed: tool discovery or schema validation failed');
  assert.ok(!cursor.includes('unregistered-remote-cursor-secret'));
  assert.ok(!schema.includes('remote-secret-tool-name'));
});
