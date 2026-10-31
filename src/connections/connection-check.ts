import { createConnectionScopedFetch, matchesEgressPrefix } from '../config/egress.ts';
import { classifyMcpError, safeMcpFailureText, type McpErrorCode } from '../config/mcp-errors.ts';
import { McpOAuthError } from '../config/mcp-oauth.ts';
import { discoverMcpTools, type McpConnectInput, type McpDiscoveryResult } from '../config/mcp-test.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import type { ConnectionAccountApiPolicy, McpConnectionToolInfo } from '../config/types.ts';
import { bytesToBase64 } from '../security/base64url.ts';
import { connectionFetchFailureReason, redactConnectionText } from './response.ts';

export type ConnectionCheckFailure =
  | 'key_rejected'
  | 'not_permitted'
  | 'path_not_found'
  | 'unreachable'
  | 'inconclusive';

/** What one GET with an API connection's key found. `url` and `detail` never carry the key. */
export type ApiConnectionCheck =
  | { kind: 'ok'; url: string; status: number }
  | { [K in ConnectionCheckFailure]: { kind: K; url: string; status?: number; detail: string } }[ConnectionCheckFailure];

export type McpConnectionCheck =
  | { kind: 'ok'; tools: McpConnectionToolInfo[] }
  | { kind: ConnectionCheckFailure; status?: number; detail: string };

export type ConnectionCheckOutcome = ApiConnectionCheck | McpConnectionCheck;

/**
 * How a key reaches an API: `header` sends the header value prefix and the
 * key; `basic_username` sends it as HTTP Basic credentials, the key as the
 * username with an empty password, base64-encoded host-side.
 */
export type ConnectionAuthShape = 'header' | 'basic_username';

export type ApiConnectionScope = Pick<
  ConnectionAccountApiPolicy,
  'allowedHosts' | 'pathPrefixes' | 'headerName' | 'headerValuePrefix' | 'allowedMethods'
>;

export interface ApiCheckTarget {
  kind: 'api';
  connection: ApiConnectionScope;
  credential: string;
  /** `basic_username` sends `credential` as an HTTP Basic username with an empty password. */
  authShape?: ConnectionAuthShape;
  /** A path on the connection's first host. Defaults to its first path prefix. */
  path?: string;
  /** Live fence run before the request leaves, as a turn's connection scope runs it. */
  authorize?: () => Promise<boolean>;
}

export interface McpCheckTarget {
  kind: 'mcp';
  server: McpConnectInput;
}

export interface ConnectionCheckOptions {
  /** Defaults to the running target: Workers resolve DNS over HTTPS. */
  cloudflare?: boolean;
  timeoutMs?: number;
  discoverMcp?: (input: McpConnectInput) => Promise<McpDiscoveryResult>;
}

const CONNECTION_CHECK_TIMEOUT_MS = 15_000;
const MAX_DETAIL_CHARS = 200;
const EXCERPT_WINDOW_BYTES = 8 * 1024;

const STATUS_FAILURES: Partial<Record<number, ConnectionCheckFailure>> = {
  401: 'key_rejected',
  403: 'not_permitted',
  404: 'path_not_found',
};

const FAILURE_DETAIL: Record<ConnectionCheckFailure, string> = {
  key_rejected: 'The service rejected the key.',
  not_permitted: 'The service refused this request, which usually means the key works but lacks a scope.',
  path_not_found: 'The service did not find this path, so the key could not be checked.',
  unreachable: 'The service could not be reached or had an error.',
  inconclusive: 'The answer does not show whether the key works.',
};

const MCP_FAILURES: Record<McpErrorCode, ConnectionCheckFailure> = {
  unauthorized: 'key_rejected',
  timeout: 'unreachable',
  network: 'unreachable',
  blocked_url: 'inconclusive',
  tool_name_collision: 'inconclusive',
  discovery_failed: 'inconclusive',
  mcp_connection_failed: 'inconclusive',
};

/**
 * Check that a credential works with its connection. An API connection gets
 * one GET inside its own hosts, path prefixes and methods; an MCP connection
 * lists its tools. Nothing is written and the credential is never returned.
 */
export function checkConnection(target: ApiCheckTarget, options?: ConnectionCheckOptions): Promise<ApiConnectionCheck>;
export function checkConnection(target: McpCheckTarget, options?: ConnectionCheckOptions): Promise<McpConnectionCheck>;
export function checkConnection(
  target: ApiCheckTarget | McpCheckTarget,
  options?: ConnectionCheckOptions,
): Promise<ConnectionCheckOutcome>;
export function checkConnection(
  target: ApiCheckTarget | McpCheckTarget,
  options: ConnectionCheckOptions = {},
): Promise<ConnectionCheckOutcome> {
  return target.kind === 'api' ? checkApi(target, options) : checkMcp(target, options);
}

/** Every `https://<host><prefix>` the connection sends its key to. */
export function connectionUrlPrefixes(connection: Pick<ApiConnectionScope, 'allowedHosts' | 'pathPrefixes'>): string[] {
  const prefixes = connection.pathPrefixes.length > 0 ? connection.pathPrefixes : [''];
  return connection.allowedHosts.flatMap((host) =>
    prefixes.map((prefix) => 'https://' + host + prefix.replace(/\/+$/, '')));
}

/** The URL a check GETs: `path` on the first host, or the first host and path prefix. */
export function connectionCheckUrl(
  connection: Pick<ApiConnectionScope, 'allowedHosts' | 'pathPrefixes'>,
  path?: string,
): string | undefined {
  const host = connection.allowedHosts[0];
  if (host === undefined) return undefined;
  return path === undefined ? connectionUrlPrefixes(connection)[0] : 'https://' + host + path;
}

/** Whether `path` on the connection's first host sits inside one of its URL prefixes. */
export function pathInsideConnection(
  connection: Pick<ApiConnectionScope, 'allowedHosts' | 'pathPrefixes'>,
  path: string,
): boolean {
  const url = connectionCheckUrl(connection, path);
  return url !== undefined && connectionUrlPrefixes(connection).some((prefix) => matchesEgressPrefix(url, prefix));
}

/** Whether a path carries the key, as typed, percent-encoded or as Basic credentials. */
export function keyInPath(path: string, key: string): boolean {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape leaves the raw path to check.
  }
  return [key, connectionHeaderCredential(key, 'basic_username')].some((form) =>
    path.includes(form) || decoded.includes(form));
}

/** The credential part of the header value: the key, or for `basic_username` base64 of `key:`. */
export function connectionHeaderCredential(key: string, authShape: ConnectionAuthShape = 'header'): string {
  return authShape === 'basic_username' ? bytesToBase64(new TextEncoder().encode(`${key}:`)) : key;
}

async function checkApi(target: ApiCheckTarget, options: ConnectionCheckOptions): Promise<ApiConnectionCheck> {
  const { connection } = target;
  const credential = connectionHeaderCredential(target.credential, target.authShape);
  const headerValue = (connection.headerValuePrefix ?? '') + credential;
  const secrets = [...new Set([headerValue, credential, target.credential])];
  const requested = connectionCheckUrl(connection, target.path);
  if (requested === undefined) {
    return { kind: 'inconclusive', url: '', detail: 'This connection has no host, so nothing was sent.' };
  }
  const url = redactConnectionText(requested, secrets);
  if (!connection.allowedMethods.some((method) => method.toUpperCase() === 'GET')) {
    return { kind: 'inconclusive', url, detail: 'This connection does not allow GET requests, so nothing was sent.' };
  }
  const fetch = await createConnectionScopedFetch([{
    allowedHosts: [...connection.allowedHosts],
    pathPrefixes: [...connection.pathPrefixes],
    headerName: connection.headerName,
    headerValue,
    // The check's own scope holds only GET, so neither it nor a redirect can write.
    allowedMethods: ['GET'],
    ...(target.authorize ? { authorize: target.authorize } : {}),
  }], {
    cloudflare: options.cloudflare ?? isCloudflareTarget(),
    timeoutMs: options.timeoutMs ?? CONNECTION_CHECK_TIMEOUT_MS,
  });
  if (!fetch) return { kind: 'inconclusive', url, detail: 'Chickpea could not prepare a request for this connection.' };
  let result: Awaited<ReturnType<typeof fetch>>;
  try {
    result = await fetch(requested, { method: 'GET', headers: { accept: 'application/json' }, followRedirects: true });
  } catch (error) {
    return connectionFetchFailureReason(error) === 'failed'
      ? { kind: 'unreachable', url, detail: 'The request did not complete (network error or timeout).' }
      : { kind: 'inconclusive', url, detail: 'The request left this connection\'s hosts and paths, so Chickpea stopped it.' };
  }
  const kind = statusKind(result.status);
  if (kind === 'ok') return { kind, url, status: result.status };
  return {
    kind,
    url,
    status: result.status,
    detail: responseExcerpt(result.body, result.headers['content-type'], secrets) ?? FAILURE_DETAIL[kind],
  };
}

async function checkMcp(target: McpCheckTarget, options: ConnectionCheckOptions): Promise<McpConnectionCheck> {
  try {
    const { tools } = await (options.discoverMcp ?? discoverMcpTools)(target.server);
    return { kind: 'ok', tools };
  } catch (error) {
    return mcpCheckFailure(error);
  }
}

/** A failed MCP check, from discovery or from resolving its credential first; never the server's own text. */
export function mcpCheckFailure(error: unknown): McpConnectionCheck {
  if (error instanceof McpOAuthError && error.code === 'reauthorization_required') {
    return { kind: 'key_rejected', detail: 'This connection needs OAuth authorization.' };
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const status = typeof code === 'number' && code >= 100 && code <= 599 ? code : undefined;
  const kind = status === undefined ? MCP_FAILURES[classifyMcpError(error)] : statusKind(status);
  return {
    kind: kind === 'ok' ? 'inconclusive' : kind,
    ...(status === undefined ? {} : { status }),
    detail: safeMcpFailureText(error),
  };
}

function statusKind(status: number): ApiConnectionCheck['kind'] {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 500) return 'unreachable';
  return STATUS_FAILURES[status] ?? 'inconclusive';
}

function responseExcerpt(
  body: Uint8Array,
  contentType: string | undefined,
  secrets: readonly string[],
): string | undefined {
  if (!/json|text\/plain/i.test(contentType ?? '')) return undefined;
  // redactConnectionText leaves secrets under 8 characters in place.
  if (secrets.some((secret) => secret.length > 0 && secret.length < 8)) return undefined;
  let text = new TextDecoder().decode(body.subarray(0, EXCERPT_WINDOW_BYTES));
  if (body.byteLength > EXCERPT_WINDOW_BYTES) {
    // A secret cut in half at the window's end would escape redaction.
    text = text.slice(0, Math.max(0, text.length - Math.max(...secrets.map(({ length }) => length))));
  }
  const excerpt = redactConnectionText(text, secrets).replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
  return excerpt || undefined;
}
