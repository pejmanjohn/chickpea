/**
 * The client table Admin Settings → Coding agents renders, and the body
 * `GET /admin/api/mcp-clients` returns.
 *
 * `src/management/connect.ts` owns the facts: the snippet text, the sign-in
 * sentence, and the server name. This module reuses those verbatim so the
 * Settings page, `/connect.md`, and the CLI never drift, and adds the two
 * hosted clients (claude.ai/Claude Desktop and ChatGPT) that take a bare URL
 * rather than a configuration file, plus the one-click install links Cursor
 * and VS Code publish.
 *
 * Pure: no I/O, no store, no request. Everything here is derived from the
 * public origin, so nothing rendered may carry a secret or an internal id.
 */

import {
  CONNECT_CLIENTS,
  MCP_SERVER_NAME,
  connectGuideUrl,
  connectMcpUrl,
  connectPrompt,
  CONNECT_PAGE_PATH,
} from './connect.ts';

export interface McpClientConfig {
  id: string;
  /** Display name for the card heading. */
  title: string;
  /** Language hint for the code block. */
  language: 'bash' | 'json' | 'text';
  /** Exact text the person copies. */
  text: string;
  /** One sentence: how sign-in starts, or where to paste. */
  note: string;
  /** One-click install handoff, where the client publishes one. */
  deepLink?: { href: string; label: string };
}

/** Display order on the Settings page and in the API body. */
export const MCP_CLIENT_IDS = Object.freeze([
  'claude-code',
  'codex',
  'cursor',
  'vscode',
  'windsurf',
  'gemini-cli',
  'claude-ai',
  'chatgpt',
  'json',
] as const);

export type McpClientId = typeof MCP_CLIENT_IDS[number];

const TITLES: Record<McpClientId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  'gemini-cli': 'Gemini CLI',
  'claude-ai': 'claude.ai and Claude Desktop',
  chatgpt: 'ChatGPT',
  json: 'JSON (any MCP client)',
};

/** Clients that take a URL in their own UI rather than a configuration file. */
const HOSTED_NOTES: Record<'claude-ai' | 'chatgpt', string> = {
  'claude-ai': 'Customize → Connectors → Add custom connector, then paste this URL and sign in with Slack.',
  chatgpt: 'Settings → Connectors (Developer mode) → Create, then paste this URL and sign in with Slack.',
};

function base64(value: string): string {
  // workerd and Node both provide btoa; the payload is ASCII JSON.
  return btoa(value);
}

/**
 * Cursor's published one-click install link. `config` is base64 of the single
 * server entry (no wrapping `mcpServers`), `name` is the server name.
 * Scheme form: cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=…
 */
export function cursorInstallLink(url: string): string {
  const config = base64(JSON.stringify({ url }));
  return `https://cursor.com/en/install-mcp?name=${encodeURIComponent(MCP_SERVER_NAME)}&config=${encodeURIComponent(config)}`;
}

/**
 * VS Code's published one-click install link. `config` is the URL-encoded
 * server entry. Scheme form: vscode:mcp/install?<urlencoded {name,type,url}>
 */
export function vscodeInstallLink(url: string): string {
  const config = JSON.stringify({ type: 'http', url });
  return `https://vscode.dev/redirect/mcp/install?name=${encodeURIComponent(MCP_SERVER_NAME)}&config=${encodeURIComponent(config)}`;
}

function connectClient(id: string) {
  const client = CONNECT_CLIENTS.find((candidate) => candidate.id === id);
  if (!client) throw new Error(`connect client "${id}" is missing`);
  return client;
}

/** The nine client cards, in display order, for one deployment origin. */
export function mcpClientConfigs(origin: string): McpClientConfig[] {
  const url = connectMcpUrl(origin);
  return MCP_CLIENT_IDS.map((id) => {
    if (id === 'claude-ai' || id === 'chatgpt') {
      return {
        id,
        title: TITLES[id],
        language: 'text' as const,
        text: url,
        note: HOSTED_NOTES[id],
      };
    }
    const client = connectClient(id);
    const config: McpClientConfig = {
      id,
      title: TITLES[id],
      language: client.language,
      text: client.snippet(url),
      note: client.login,
    };
    if (id === 'cursor') config.deepLink = { href: cursorInstallLink(url), label: 'Add to Cursor' };
    if (id === 'vscode') config.deepLink = { href: vscodeInstallLink(url), label: 'Add to VS Code' };
    return config;
  });
}

export interface McpClientsPayload {
  url: string;
  guideUrl: string;
  connectUrl: string;
  prompt: string;
  clients: McpClientConfig[];
}

/** The `GET /admin/api/mcp-clients` body. Public facts only. */
export function mcpClientsPayload(origin: string): McpClientsPayload {
  return {
    url: connectMcpUrl(origin),
    guideUrl: connectGuideUrl(origin),
    connectUrl: `${origin}${CONNECT_PAGE_PATH}`,
    prompt: connectPrompt(origin),
    clients: mcpClientConfigs(origin),
  };
}
