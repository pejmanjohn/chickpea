import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mcpClientConfig, mcpConfigJson, MCP_CLIENTS } from '../src/mcp-config.ts';
import { runCli, temporaryStore } from './helpers/run-cli.ts';

const origin = 'https://chickpea.example';

test('every client printer targets <origin>/mcp over streamable HTTP with no token', () => {
  for (const client of MCP_CLIENTS) {
    const { text } = mcpClientConfig(origin, client);
    assert.match(text, /https:\/\/chickpea\.example\/mcp/, client);
    assert.doesNotMatch(text, /token|bearer|secret/i, client);
  }
  assert.match(mcpClientConfig(origin, 'claude-code').text, /claude mcp add --transport http chickpea https:\/\/chickpea\.example\/mcp/);
  assert.deepEqual(JSON.parse(mcpClientConfig(origin, 'cursor').text), { mcpServers: { chickpea: { url: `${origin}/mcp` } } });
  assert.match(mcpClientConfig(origin, 'codex').text, /^\[mcp_servers\.chickpea\]\nurl = "https:\/\/chickpea\.example\/mcp"/);
  assert.equal((mcpConfigJson(origin) as { mcpServers: { chickpea: { transport: string } } }).mcpServers.chickpea.transport, 'streamable-http');
});

test('mcp config prints all clients by default, one with --client, and a record with --json', async () => {
  const all = await runCli(['mcp', 'config', origin], { store: temporaryStore() });
  assert.equal(all.code, 0);
  for (const heading of ['## Claude Code', '## Codex', '## Cursor', '## Generic']) assert.match(all.stdout, new RegExp(heading));

  const one = await runCli(['mcp', 'config', `${origin}/mcp`, '--client', 'cursor'], { store: temporaryStore() });
  assert.equal(one.code, 0);
  assert.deepEqual(JSON.parse(one.stdout), { mcpServers: { chickpea: { url: `${origin}/mcp` } } });

  const json = await runCli(['mcp', 'config', origin, '--json'], { store: temporaryStore() });
  assert.equal(json.code, 0);
  const record = JSON.parse(json.stdout) as { url: string; clients: Record<string, string> };
  assert.equal(record.url, `${origin}/mcp`);
  assert.deepEqual(Object.keys(record.clients), [...MCP_CLIENTS]);

  const bad = await runCli(['mcp', 'config', origin, '--client', 'vscode'], { store: temporaryStore() });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /^chickpea: INVALID_ARGUMENT: Unknown client "vscode"\. Choose one of: claude-code, codex, cursor, json\.\n$/);
});

test('credential-bearing flags are refused with a pointer at login', async () => {
  const result = await runCli(['workspace', 'inspect', origin, '--token', 'xoxb-secret'], { store: temporaryStore() });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /UNSUPPORTED_FLAG/);
  assert.doesNotMatch(result.stderr, /xoxb-secret/);
});
