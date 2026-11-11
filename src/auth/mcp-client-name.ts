const MCP_CLIENT_NAME_DISPLAY_LIMIT = 60;

/**
 * App properties keyed by exact OAuth client ID, never an app's claimed name.
 * Consent and return-page names are independent of whether the app draws cards.
 */
const KNOWN_MCP_APPS: ReadonlyMap<string, { name: string; consent?: true; cards?: true }> = new Map([
  ['https://chatgpt.com/oauth/client.json', { name: 'ChatGPT', consent: true, cards: true }],
  ['https://chatgpt.com/oauth/codex/client.json', { name: 'Codex' }],
  ['https://claude.ai/oauth/mcp-oauth-client-metadata', { name: 'Claude', cards: true }],
  ['https://claude.ai/oauth/claude-code-client-metadata', { name: 'Claude Code' }],
  ['https://cursor.com/oauth/mcp-client.json', { name: 'Cursor' }],
  ['https://vscode.dev/oauth/client-metadata.json', { name: 'VS Code' }],
  ['https://insiders.vscode.dev/oauth/client-metadata.json', { name: 'VS Code' }],
  ['https://zed.dev/oauth/client-metadata.json', { name: 'Zed' }],
  ['https://goose-docs.ai/oauth/client-metadata.json', { name: 'Goose' }],
]);

/** Lowercase registered names, as the clients send them, without a trailing "(server name)". */
const RETURN_APPS_BY_REGISTERED_NAME: ReadonlyMap<string, string> = new Map([
  ['claude', 'Claude'],
  ['claude code', 'Claude Code'],
  ['codex', 'Codex'],
  ['cursor', 'Cursor'],
  ['vs code', 'VS Code'],
  ['visual studio code', 'VS Code'],
  ['gemini cli', 'Gemini CLI'],
  ['gemini cli mcp client', 'Gemini CLI'],
  ['zed', 'Zed'],
  ['goose', 'Goose'],
]);

export function knownMcpAppName(clientId: string | undefined): string | undefined {
  const app = KNOWN_MCP_APPS.get(clientId ?? '');
  return app?.consent ? app.name : undefined;
}

export function knownMcpCardClient(clientId: string): boolean {
  return KNOWN_MCP_APPS.get(clientId)?.cards === true;
}

export function returnAppForClientId(clientId: string): string | undefined {
  return KNOWN_MCP_APPS.get(clientId)?.name;
}

/** The app to name in Chickpea's own words: a known client ID, else a known registered name, else none. */
export function returnAppName(clientId: string | undefined, registeredName: string | undefined): string | undefined {
  return returnAppForClientId(clientId ?? '') ?? returnAppForRegisteredName(registeredName);
}

export function returnAppForRegisteredName(name: string | undefined): string | undefined {
  const cleaned = displayMcpClientName(name)?.replace(/ \([^()]*\)$/u, '').toLowerCase();
  return cleaned ? RETURN_APPS_BY_REGISTERED_NAME.get(cleaned) : undefined;
}

/** Untrusted, app-chosen text: strip controls and bidi overrides, collapse, bound. */
export function displayMcpClientName(name: string | undefined): string | undefined {
  if (typeof name !== 'string') return undefined;
  const cleaned = name
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return undefined;
  const chars = [...cleaned];
  if (chars.length <= MCP_CLIENT_NAME_DISPLAY_LIMIT) return cleaned;
  return `${chars.slice(0, MCP_CLIENT_NAME_DISPLAY_LIMIT - 1).join('').trimEnd()}…`;
}
