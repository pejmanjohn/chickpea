const MCP_CLIENT_NAME_DISPLAY_LIMIT = 60;

/**
 * Apps Chickpea names itself, by exact client ID. Any other app's name is its
 * own claim, so a stranger's document that calls itself ChatGPT gets the
 * generic text, as does ChatGPT's per-callback client ID.
 */
const KNOWN_MCP_APPS: ReadonlyMap<string, string> = new Map([['https://chatgpt.com/oauth/client.json', 'ChatGPT']]);

/**
 * Apps a finished setup link sends the person back to by name, in Chickpea's
 * own words. The page never repeats an app's claim, so an unlisted or
 * look-alike app reads "your app". ChatGPT is named only by its client ID.
 */
const RETURN_APPS_BY_CLIENT_ID: ReadonlyMap<string, string> = new Map([
  ...KNOWN_MCP_APPS,
  ['https://chatgpt.com/oauth/codex/client.json', 'Codex'],
  ['https://claude.ai/oauth/mcp-oauth-client-metadata', 'Claude'],
  ['https://claude.ai/oauth/claude-code-client-metadata', 'Claude Code'],
  ['https://cursor.com/oauth/mcp-client.json', 'Cursor'],
  ['https://vscode.dev/oauth/client-metadata.json', 'VS Code'],
  ['https://insiders.vscode.dev/oauth/client-metadata.json', 'VS Code'],
  ['https://zed.dev/oauth/client-metadata.json', 'Zed'],
  ['https://goose-docs.ai/oauth/client-metadata.json', 'Goose'],
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
  return KNOWN_MCP_APPS.get(clientId ?? '');
}

export function returnAppForClientId(clientId: string): string | undefined {
  return RETURN_APPS_BY_CLIENT_ID.get(clientId);
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
