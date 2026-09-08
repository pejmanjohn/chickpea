import { mcpUrl } from './origin.ts';

export const MCP_CLIENTS = ['claude-code', 'codex', 'cursor', 'json'] as const;
export type McpClient = typeof MCP_CLIENTS[number];
export const MCP_SERVER_NAME = 'chickpea';

export function isMcpClient(value: string): value is McpClient {
  return (MCP_CLIENTS as readonly string[]).includes(value);
}

/**
 * Every snippet points the client at `<origin>/mcp` over streamable HTTP
 * with no token. The client discovers OAuth itself, registers as a public
 * PKCE client, and opens the browser for Slack sign-in and consent.
 */
export function mcpClientConfig(origin: string, client: McpClient): { title: string; text: string } {
  const url = mcpUrl(origin);
  switch (client) {
    case 'claude-code':
      return {
        title: 'Claude Code',
        text: [
          `claude mcp add --transport http ${MCP_SERVER_NAME} ${url}`,
          '',
          '# or in .mcp.json',
          JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url } } }, null, 2),
        ].join('\n'),
      };
    case 'codex':
      return {
        title: 'Codex (~/.codex/config.toml)',
        text: [
          `[mcp_servers.${MCP_SERVER_NAME}]`,
          `url = "${url}"`,
          '',
          `# then: codex mcp login ${MCP_SERVER_NAME}`,
        ].join('\n'),
      };
    case 'cursor':
      return {
        title: 'Cursor (.cursor/mcp.json)',
        text: JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url } } }, null, 2),
      };
    case 'json':
      return {
        title: 'Generic (streamable HTTP)',
        text: JSON.stringify(mcpConfigJson(origin), null, 2),
      };
  }
}

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
