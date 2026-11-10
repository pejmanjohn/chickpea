const MCP_CLIENT_NAME_DISPLAY_LIMIT = 60;

/**
 * Apps Chickpea names itself, by exact client ID. Any other app's name is its
 * own claim, so a stranger's document that calls itself ChatGPT gets the
 * generic text, as does ChatGPT's per-callback client ID.
 */
const KNOWN_MCP_APPS: ReadonlyMap<string, string> = new Map([['https://chatgpt.com/oauth/client.json', 'ChatGPT']]);

export function knownMcpAppName(clientId: string | undefined): string | undefined {
  return KNOWN_MCP_APPS.get(clientId ?? '');
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
