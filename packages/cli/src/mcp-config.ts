import { mcpUrl } from './origin.ts';

export const MCP_CLIENTS = ['claude-code', 'codex', 'cursor', 'vscode', 'windsurf', 'gemini-cli', 'json'] as const;
export type McpClient = typeof MCP_CLIENTS[number];
export const MCP_SERVER_NAME = 'chickpea';

export function isMcpClient(value: string): value is McpClient {
  return (MCP_CLIENTS as readonly string[]).includes(value);
}

/**
 * The snippets a deployment serves at `/connect.md` and in Admin Settings →
 * Coding agents. This package is published separately and cannot import the
 * server's `src/management/connect.ts`, so the table is mirrored here and the
 * root suite (`tests/mcp-client-config.test.ts`) asserts every `text` is
 * byte-identical to the server's.
 *
 * Every snippet points the client at `<origin>/mcp` over streamable HTTP
 * with no token. The client discovers OAuth itself, registers as a public
 * PKCE client, and opens the browser for Slack sign-in and consent.
 */
const CLIENT_TABLE: Record<McpClient, { title: string; text: (url: string) => string }> = {
  'claude-code': {
    title: 'Claude Code (terminal)',
    text: (url) => `claude mcp add --transport http ${MCP_SERVER_NAME} ${url}`,
  },
  codex: {
    title: 'Codex (terminal)',
    text: (url) => `codex mcp add ${MCP_SERVER_NAME} --url ${url}\ncodex mcp login ${MCP_SERVER_NAME}`,
  },
  cursor: {
    title: 'Cursor (.cursor/mcp.json)',
    text: (url) => JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url } } }, null, 2),
  },
  vscode: {
    title: 'VS Code (terminal, or .vscode/mcp.json)',
    text: (url) => `code --add-mcp '${JSON.stringify({ name: MCP_SERVER_NAME, type: 'http', url })}'`,
  },
  windsurf: {
    title: 'Windsurf (~/.codeium/windsurf/mcp_config.json)',
    text: (url) => JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { serverUrl: url } } }, null, 2),
  },
  'gemini-cli': {
    title: 'Gemini CLI (terminal)',
    text: (url) => `gemini mcp add --transport http ${MCP_SERVER_NAME} ${url}`,
  },
  json: {
    title: 'Generic (streamable HTTP)',
    text: (url) => JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url } } }, null, 2),
  },
};

export function mcpClientConfig(origin: string, client: McpClient): { title: string; text: string } {
  const entry = CLIENT_TABLE[client];
  return { title: entry.title, text: entry.text(mcpUrl(origin)) };
}

/**
 * The `--json` record's own server entry, which keeps the transport, auth, and
 * scope metadata a script may want. The human-readable `json` client snippet
 * above is the one an MCP client actually accepts.
 */
export function mcpConfigJson(origin: string): Record<string, unknown> {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        transport: 'streamable-http',
        url: mcpUrl(origin),
        auth: 'oauth2',
        scope: 'chickpea:workspace',
      },
    },
  };
}

export function renderMcpConfig(origin: string, clients: readonly McpClient[]): string {
  if (clients.length === 1) return mcpClientConfig(origin, clients[0]!).text;
  return clients
    .map((client) => {
      const { title, text } = mcpClientConfig(origin, client);
      return `## ${title}\n${text}`;
    })
    .join('\n\n');
}

export function mcpConfigRecord(origin: string): Record<string, unknown> {
  return {
    origin,
    url: mcpUrl(origin),
    transport: 'streamable-http',
    auth: 'oauth2 (PKCE S256, dynamic public-client registration, no token in the config)',
    clients: Object.fromEntries(MCP_CLIENTS.map((client) => [client, mcpClientConfig(origin, client).text])),
  };
}
