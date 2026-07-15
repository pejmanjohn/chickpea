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
  if (message.includes('unauthorized') || message.includes('401')) return 'unauthorized';
  if (message.includes('timed') || message.includes('timeout')) return 'timeout';
  if (message.includes('failed to fetch') || message.includes('fetch failed') || message.includes('network')) {
    return 'network';
  }
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
    case 'discovery_failed':
      return 'Connected, but tool discovery failed.';
    default:
      return 'Could not connect to this MCP server. Check the URL.';
  }
}
