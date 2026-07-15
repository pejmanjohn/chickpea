import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  McpBlockedUrlError,
  classifyMcpError,
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
  { input: new McpBlockedUrlError('Private and internal IP addresses are not allowed.'), code: 'blocked_url' },
  { input: new Error('failed to discover tools'), code: 'discovery_failed' },
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
