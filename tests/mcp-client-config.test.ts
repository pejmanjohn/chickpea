import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONNECT_CLIENTS, connectPrompt } from '../src/management/connect.ts';
import {
  MCP_CLIENT_IDS,
  cursorInstallLink,
  mcpClientConfigs,
  mcpClientsPayload,
  vscodeInstallLink,
} from '../src/management/mcp-client-config.ts';
import {
  MCP_CLIENTS as CLI_MCP_CLIENTS,
  mcpClientConfig as cliClientConfig,
} from '../packages/cli/src/mcp-config.ts';

const ORIGIN = 'https://chickpea.example.test';
const MCP_URL = `${ORIGIN}/mcp`;

// Settings → Coding agents is authenticated but still customer-facing: it may
// carry no credential and no internal identifier (AGENTS.md).
const SECRET_MARKERS = ['xoxb', 'Bearer ', 'Authorization:', 'sk-', 'client_secret', 'api_key', 'apiKey'];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test('the client table lists nine clients in the settled display order', () => {
  assert.deepEqual([...MCP_CLIENT_IDS], [
    'claude-code',
    'codex',
    'cursor',
    'vscode',
    'windsurf',
    'gemini-cli',
    'claude-ai',
    'chatgpt',
    'json',
  ]);
  const configs = mcpClientConfigs(ORIGIN);
  assert.deepEqual(configs.map((client) => client.id), [...MCP_CLIENT_IDS]);
  for (const client of configs) {
    assert.ok(client.title.length > 0, client.id);
    assert.ok(client.text.length > 0, client.id);
    assert.ok(client.note.length > 0, client.id);
    assert.ok(['bash', 'json', 'text'].includes(client.language), `${client.id}: ${client.language}`);
    assert.ok(client.text.includes(MCP_URL), `${client.id} points at this deployment`);
  }
});

test('every connect-guide client renders the guide\'s own snippet and sign-in sentence', () => {
  const configs = new Map(mcpClientConfigs(ORIGIN).map((client) => [client.id, client]));
  for (const connect of CONNECT_CLIENTS) {
    const rendered = configs.get(connect.id);
    assert.ok(rendered, `${connect.id} is rendered in Settings`);
    assert.equal(rendered.text, connect.snippet(MCP_URL), connect.id);
    assert.equal(rendered.note, connect.login, connect.id);
    assert.equal(rendered.language, connect.language, connect.id);
  }
});

test('the two hosted clients take the bare MCP URL with where-to-paste directions', () => {
  const configs = new Map(mcpClientConfigs(ORIGIN).map((client) => [client.id, client]));
  for (const id of ['claude-ai', 'chatgpt']) {
    const client = configs.get(id)!;
    assert.equal(client.language, 'text', id);
    assert.equal(client.text, MCP_URL, id);
    assert.match(client.note, /paste this URL and sign in with Slack\./, id);
    assert.equal(client.deepLink, undefined, id);
  }
  assert.match(configs.get('claude-ai')!.note, /Customize → Connectors/);
  assert.match(configs.get('chatgpt')!.note, /Developer mode/);
});

test('the Cursor install link carries a base64 config for this deployment', () => {
  const link = new URL(cursorInstallLink(MCP_URL));
  assert.equal(link.origin + link.pathname, 'https://cursor.com/en/install-mcp');
  assert.equal(link.searchParams.get('name'), 'chickpea');
  const config = link.searchParams.get('config');
  assert.ok(config, 'config parameter is present');
  assert.deepEqual(JSON.parse(Buffer.from(config, 'base64').toString('utf8')), { url: MCP_URL });

  const cursor = mcpClientConfigs(ORIGIN).find((client) => client.id === 'cursor')!;
  assert.deepEqual(cursor.deepLink, { href: cursorInstallLink(MCP_URL), label: 'Add to Cursor' });
});

test('the VS Code install link carries a URL-encoded http config for this deployment', () => {
  const link = new URL(vscodeInstallLink(MCP_URL));
  assert.equal(link.origin + link.pathname, 'https://vscode.dev/redirect/mcp/install');
  assert.equal(link.searchParams.get('name'), 'chickpea');
  const config = link.searchParams.get('config');
  assert.ok(config, 'config parameter is present');
  assert.deepEqual(JSON.parse(config), { type: 'http', url: MCP_URL });

  const vscode = mcpClientConfigs(ORIGIN).find((client) => client.id === 'vscode')!;
  assert.deepEqual(vscode.deepLink, { href: vscodeInstallLink(MCP_URL), label: 'Add to VS Code' });
});

test('the payload is built entirely from the public origin', () => {
  const payload = mcpClientsPayload(ORIGIN);
  assert.equal(payload.url, MCP_URL);
  assert.equal(payload.guideUrl, `${ORIGIN}/connect.md`);
  assert.equal(payload.connectUrl, `${ORIGIN}/connect`);
  assert.equal(payload.prompt, connectPrompt(ORIGIN));
  assert.equal(payload.clients.length, MCP_CLIENT_IDS.length);

  // A different origin moves every URL with it; nothing is pinned to a build.
  const other = mcpClientsPayload('http://127.0.0.1:8787');
  assert.equal(other.url, 'http://127.0.0.1:8787/mcp');
  assert.ok(!JSON.stringify(other).includes('chickpea.example.test'));
});

test('the payload carries no credential and no internal identifier', () => {
  const body = JSON.stringify(mcpClientsPayload(ORIGIN));
  for (const marker of SECRET_MARKERS) assert.ok(!body.includes(marker), marker);
  assert.doesNotMatch(body, UUID);
  assert.doesNotMatch(body, /token/i);
});

test('the published CLI prints byte-identical snippets for every client it offers', () => {
  const configs = new Map(mcpClientConfigs(ORIGIN).map((client) => [client.id, client]));
  for (const id of CLI_MCP_CLIENTS) {
    const server = configs.get(id);
    assert.ok(server, `${id} exists in the server table`);
    assert.equal(cliClientConfig(ORIGIN, id).text, server.text, id);
  }
});
