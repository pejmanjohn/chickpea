/**
 * Error taxonomy for MCP connections. Raw error strings never reach the DB,
 * API responses, or the admin UI — callers classify() first and surface only
 * the safe sentence from safeMcpFailureText().
 */
export type McpErrorCode =
  | 'blocked_url'
  | 'unauthorized'
  | 'timeout'
  | 'network'
  | 'tool_name_collision'
  | 'discovery_failed'
  | 'mcp_connection_failed';

/** Thrown by callers when the SSRF guard rejects a URL, so classify() can tag it. */
export class McpBlockedUrlError extends Error {
  constructor(reason: string) {
    super('blocked url: ' + reason);
    this.name = 'McpBlockedUrlError';
  }
}

export function classifyMcpError(err: unknown): McpErrorCode {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (message.includes('blocked url')) return 'blocked_url';
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'number' && (code === 401 || code === 403)) return 'unauthorized';
  if (message.includes('unauthorized') || message.includes('401')) return 'unauthorized';
  if (message.includes('timed') || message.includes('timeout')) return 'timeout';
  if (message.includes('failed to fetch') || message.includes('fetch failed') || message.includes('network')) {
    return 'network';
  }
  // Flue's connectMcpServer throws "… produced duplicate tool name …" when two
  // tools collide after name sanitization — a server-side naming problem that
  // must not be reported as a bad URL.
  if (message.includes('duplicate tool name')) return 'tool_name_collision';
  if (message.includes('discover')) return 'discovery_failed';
  return 'mcp_connection_failed';
}

export function safeMcpFailureText(err: unknown): string {
  switch (classifyMcpError(err)) {
    case 'blocked_url':
      return 'This URL targets a private or internal address and was blocked.';
    case 'unauthorized':
      return 'The MCP server rejected the connection. Check the token or headers.';
    case 'timeout':
      return 'The MCP server did not respond in time.';
    case 'network':
      return 'The MCP server could not be reached.';
    case 'tool_name_collision':
      return 'Two of this server’s tools collide after name sanitization. Rename one on the server.';
    case 'discovery_failed':
      return 'Connected, but tool discovery failed.';
    default:
      return 'Could not connect to this MCP server. Check the URL.';
  }
}

/**
 * Operator-log companion to safeMcpFailureText: the classified code plus a
 * bounded, whitespace-collapsed slice of the raw message. Logs only — never
 * the DB, API responses, or the admin UI. Without this, a live connect
 * failure is undebuggable even with observability on (learned on deepwiki:
 * the safe sentence said "check the URL" while the URL was fine).
 */
export function mcpDebugText(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err))
    .replace(/\s+/g, ' ')
    .slice(0, 200);
  return classifyMcpError(err) + ': ' + raw;
}
