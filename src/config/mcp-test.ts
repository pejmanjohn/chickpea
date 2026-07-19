import { connectMcpServer, type McpServerConnection, type ToolDefinition } from '@flue/runtime';

import { McpBlockedUrlError } from './mcp-errors.ts';
import { validateMcpUrl } from './mcp-url.ts';

/**
 * Shared connect + discover routine for MCP connections. Reused by the admin
 * test-connection route and the turn-time resolver so the SSRF guard, connect
 * deadline, prefix stripping, and truncation live in exactly one place.
 *
 * Both entry points run the SSRF guard first (turn-time re-check) and throw a
 * classifiable `McpBlockedUrlError` on reject. Flue's `timeoutMs` bounds MCP
 * *requests*, not the initial connect, so we wrap `connect(...)` in our own
 * `Promise.race` deadline; the `timeoutMs` we pass through only bounds tool
 * calls. Raw errors from `connect` propagate unchanged — callers classify them
 * via `classifyMcpError`/`safeMcpFailureText`.
 */

const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_TOOLS = 50;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 400;
const TOOL_NAME_PREFIX = /^mcp__[^_]+(?:_[^_]+)*__/;

export interface McpDiscoveredTool {
  name: string;
  title?: string;
  description?: string;
}

export interface McpDiscoveryResult {
  tools: McpDiscoveredTool[];
}

export interface McpConnectInput {
  /** Used as the Flue server name, which becomes the `mcp__<id>__` tool prefix. */
  id: string;
  url: string;
  transport: 'streamable-http' | 'sse';
  headers: Record<string, string>;
  /** Deadline around the initial connect (Flue's timeoutMs does not bound it). */
  connectTimeoutMs?: number;
  /** Per-request timeout passed to `connectMcpServer` (bounds tool calls). */
  callTimeoutMs?: number;
}

/**
 * Connect + list tools + close. Returns truncated, prefix-stripped tool
 * metadata (max 50). Throws classifiable errors; callers map via
 * classify/safeText. The connection is always closed in `finally`.
 */
export async function discoverMcpTools(
  input: McpConnectInput,
  connect: typeof connectMcpServer = connectMcpServer,
): Promise<McpDiscoveryResult> {
  const connection = await connectMcp(input, connect);
  try {
    return { tools: mapTools(input.id, connection.tools) };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

/**
 * Connect and RETURN the live connection — the caller owns closing it. Used by
 * the turn-time resolver, which holds the connection open for tool calls.
 */
export async function connectMcp(
  input: McpConnectInput,
  connect: typeof connectMcpServer = connectMcpServer,
): Promise<McpServerConnection> {
  const validated = validateMcpUrl(input.url);
  if (!validated.ok) {
    throw new McpBlockedUrlError(validated.reason);
  }
  const deadlineMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const callTimeoutMs = input.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  return raceDeadline(
    connect(input.id, {
      url: validated.url,
      transport: input.transport,
      headers: input.headers,
      timeoutMs: callTimeoutMs,
    }),
    deadlineMs,
  );
}

function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('connect timeout after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function mapTools(id: string, tools: ToolDefinition[]): McpDiscoveredTool[] {
  const mapped: McpDiscoveredTool[] = [];
  for (const raw of tools) {
    if (mapped.length >= MAX_TOOLS) break;
    mapped.push(toDiscovered(id, raw));
  }
  return mapped;
}

function toDiscovered(id: string, raw: ToolDefinition): McpDiscoveredTool {
  // The name is required. Fall back to the raw stripped value if collapse
  // yields empty (a name should never be blank, but stay defensive).
  const stripped = stripPrefix(id, raw.name);
  const name = truncate(stripped, NAME_MAX) ?? stripped.slice(0, NAME_MAX);
  // Flue's adapter folds any MCP tool title into the description string, so the
  // adapted ToolDefinition never exposes a title field — we surface description
  // only. The stored McpDiscoveredTool keeps an optional `title` for schema
  // symmetry, populated if a future runtime ever surfaces one directly.
  const description = truncate(raw.description, DESCRIPTION_MAX);
  return {
    name,
    ...(description ? { description } : {}),
  };
}

/**
 * Flue names adapted tools `mcp__<server>__<tool>`. Strip that prefix for the
 * stored/displayed name so the profile allowlist matches the bare tool name.
 * Falls back to a generic strip if the id-specific prefix does not match.
 */
function stripPrefix(id: string, name: string): string {
  const specific = 'mcp__' + id + '__';
  if (name.startsWith(specific)) {
    return name.slice(specific.length);
  }
  return name.replace(TOOL_NAME_PREFIX, '');
}

/** Collapse whitespace runs to single spaces, trim, and slice to `max`. */
function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return undefined;
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}
