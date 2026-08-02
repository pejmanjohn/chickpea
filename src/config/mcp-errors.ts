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
  // Flue's MCP adapter throws "… produced duplicate tool name …" when two
  // tools collide after name sanitization — a server-side naming problem that
  // must not be reported as a bad URL.
  if (message.includes('duplicate tool name')) return 'tool_name_collision';
  if (
    message.includes('discover') ||
    message.includes('compiling schema') ||
    message.includes('invalid schema') ||
    message.includes('output schema')
  ) {
    return 'discovery_failed';
  }
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

/** Operator-log context retained for call-site compatibility only. Sensitive
 * values are deliberately never interpolated into the resulting diagnostic.
 */
export interface McpDebugRedactionContext {
  /** The configured endpoint; accepted so callers do not need a second API. */
  url?: string;
  /** Outbound auth/header values; accepted but never inspected or logged. */
  headers?: Readonly<Record<string, string>>;
}

/**
 * Operator-log companion to safeMcpFailureText. Remote MCP servers control
 * response bodies, JSON-RPC messages/data, tool metadata, schemas, cursors,
 * headers, and sometimes capability-bearing URLs. Scrubbing arbitrary prose is
 * not a stable security boundary, so this formatter uses a local allowlist:
 * fixed diagnostic markers and numeric protocol/status codes only. Every other
 * detail is discarded rather than copied into observability logs.
 */
export function mcpDebugText(
  err: unknown,
  _context: McpDebugRedactionContext = {},
): string {
  const classification = classifyMcpError(err);
  const message = err instanceof Error ? err.message : String(err);
  const numericCode = (err as { code?: unknown } | null | undefined)?.code;
  const remoteMcpCode =
    err instanceof Error &&
    err.name === 'McpError' &&
    typeof numericCode === 'number'
      ? numericCode
      : undefined;
  if (remoteMcpCode !== undefined) {
    return `${classification}: MCP error ${remoteMcpCode}: [remote detail redacted]`;
  }

  if (
    typeof numericCode === 'number' &&
    Number.isInteger(numericCode) &&
    numericCode >= 100 &&
    numericCode <= 599
  ) {
    return `${classification}: HTTP ${numericCode}`;
  }
  const sseStatus = /Error POSTing to endpoint \(HTTP (\d{3})\):/iu.exec(message)?.[1];
  if (sseStatus !== undefined) {
    return `${classification}: HTTP ${sseStatus}`;
  }
  if (/Code generation from strings disallowed/iu.test(message)) {
    return `${classification}: Code generation from strings disallowed`;
  }
  if (classification === 'discovery_failed') {
    return `${classification}: tool discovery or schema validation failed`;
  }
  return `${classification}: [redacted]`;
}
