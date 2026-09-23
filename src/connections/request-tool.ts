import { defineTool, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';

import { matchesEgressPrefix, type ConnectionScopedFetch } from '../config/egress.ts';
import { assertConnectionWriteAllowed } from '../memory/tool-policy.ts';
import type { ConnectionAccess, ConnectionDeclaration } from './access.ts';
import {
  connectionFetchFailureReason,
  connectionRefusal,
  readConnectionResponse,
  redactConnectionText,
} from './response.ts';

export const CONNECTION_REQUEST_TOOL_NAME = 'connection_request';

/** The network bound for one request, inside the connection's egress scope. */
export const CONNECTION_REQUEST_TIMEOUT_MS = 60_000;
/** The whole call, including resolving the connection's credential. */
const CONNECTION_REQUEST_TOOL_TIMEOUT_MS = 90_000;
/** How much of the service's response the model reads back. */
export const MAX_CONNECTION_RESPONSE_CHARS = 48_000;
export const MAX_CONNECTION_REQUEST_BODY_BYTES = 256 * 1024;
const MAX_URL_CHARS = 2048;
const MAX_QUERY_KEYS = 50;
const MAX_HEADERS = 20;

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = (typeof METHODS)[number];
const READ_METHODS = new Set<Method>(['GET', 'HEAD']);

/** Credential-bearing or transport-owned headers a request may never set. */
const BLOCKED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'api-key',
  'host',
  'content-length',
  'transfer-encoding',
]);

/** Response headers worth the model's attention: paging, rate limits, redirects. */
const ECHOED_RESPONSE_HEADERS = [
  'content-type',
  'link',
  'location',
  'retry-after',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'etag',
];

export interface ConnectionRequestToolOptions {
  /** This turn's live connections; resolved per call. */
  resolveAccess(): Promise<ConnectionAccess>;
  agentId: string;
  /** Operator log line; defaults to console.info. Never receives credentials or bodies. */
  log?: (event: ConnectionRequestLogEvent) => void;
}

export interface ConnectionRequestLogEvent {
  agentId: string;
  connectionId?: string;
  method: string;
  host?: string;
  pathname?: string;
  status?: number;
  durationMs: number;
  responseBytes?: number;
  truncated?: boolean;
  refusal?: string;
}

const DESCRIPTION = [
  "Call one of this Agent's API connections (for example Asana, Zendesk, or Google Workspace) over HTTPS.",
  "Chickpea adds the connection's credential, so never send authorization headers, cookies, or API keys.",
  '`url` is the full https URL; it must be on a host, path prefix, and method the connection allows. Put query parameters in `url` or in `query`.',
  'Send a JSON body with `json`, or a text body with `body`. Omit `connection` when only one connection matches the URL.',
  'Returns `ok`, `status`, and the response (parsed JSON when it fits). A result with ok: false did not succeed: report the reason or the service error rather than claiming success.',
  'Files cannot be sent through this tool; use attach_file_to_connection for those.',
].join(' ');

const scalar = v.union([v.string(), v.number(), v.boolean()]);

const INPUT = v.pipe(
  v.object({
    connection: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
    method: v.optional(v.picklist(METHODS)),
    url: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_URL_CHARS)),
    query: v.optional(v.pipe(
      v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(200)), v.union([scalar, v.array(v.string())])),
      v.check((query) => Object.keys(query).length <= MAX_QUERY_KEYS, `at most ${MAX_QUERY_KEYS} query keys`),
    )),
    headers: v.optional(v.pipe(
      v.record(
        v.pipe(v.string(), v.regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/, 'invalid header name')),
        v.pipe(v.string(), v.maxLength(1024)),
      ),
      v.check((headers) => Object.keys(headers).length <= MAX_HEADERS, `at most ${MAX_HEADERS} headers`),
    )),
    json: v.optional(v.unknown()),
    body: v.optional(v.string()),
  }),
  v.check((input) => input.json === undefined || input.body === undefined, 'send either json or body, not both'),
);

type RefusalReason =
  | 'no_connection'
  | 'ambiguous_connection'
  | 'url_not_allowed'
  | 'method_not_allowed'
  | 'headers_not_allowed'
  | 'body_too_large'
  | 'body_not_allowed'
  | 'write_not_allowed'
  | 'failed';

export function createConnectionRequestTool(options: ConnectionRequestToolOptions) {
  const log = options.log ?? ((event) => console.info('[chickpea] connection_request', event));
  return defineTool({
    name: CONNECTION_REQUEST_TOOL_NAME,
    description: DESCRIPTION,
    input: INPUT,
    timeoutMs: CONNECTION_REQUEST_TOOL_TIMEOUT_MS,
    async run({ data }) {
      const started = Date.now();
      const method: Method = data.method ?? 'GET';
      let connectionId: string | undefined;
      let target: URL | undefined;
      const refuse = (reason: RefusalReason, message: string, extra: Record<string, JsonValue> = {}) => {
        log({
          agentId: options.agentId,
          ...(connectionId ? { connectionId } : {}),
          method,
          ...(target ? { host: target.host, pathname: target.pathname } : {}),
          durationMs: Date.now() - started,
          refusal: reason,
        });
        return connectionRefusal(reason, message, extra);
      };

      try {
        target = new URL(data.url);
      } catch {
        return refuse('url_not_allowed', 'url must be an absolute https URL.');
      }
      if (target.protocol !== 'https:' || target.username || target.password) {
        return refuse('url_not_allowed', 'url must be an https URL without credentials.');
      }
      target.hash = '';
      for (const [key, value] of Object.entries(data.query ?? {})) {
        for (const item of Array.isArray(value) ? value : [value]) {
          target.searchParams.append(key, String(item));
        }
      }
      if (target.href.length > MAX_URL_CHARS * 2) {
        return refuse('url_not_allowed', 'The URL with its query is too long.');
      }

      const access = await options.resolveAccess();
      const selected = selectConnection(access.connections, data.connection, target.href);
      if (!selected.ok) {
        return refuse(selected.reason, selected.message, selected.extra ?? {});
      }
      const connection = selected.connection;
      connectionId = connection.id;
      if (!connection.allowedMethods.includes(method)) {
        return refuse('method_not_allowed', `The ${connection.displayName} connection does not allow ${method} requests.`, {
          allowedMethods: connection.allowedMethods,
        });
      }

      const blockedHeader = Object.keys(data.headers ?? {}).find((name) => {
        const lower = name.toLowerCase();
        return BLOCKED_HEADERS.has(lower) || lower === connection.headerName.toLowerCase();
      });
      if (blockedHeader !== undefined) {
        return refuse('headers_not_allowed', `Remove the ${blockedHeader} header: Chickpea adds the connection's credential itself.`);
      }

      let body: Uint8Array | undefined;
      let contentType: string | undefined;
      if (data.json !== undefined) {
        body = new TextEncoder().encode(JSON.stringify(data.json));
        contentType = 'application/json';
      } else if (data.body !== undefined) {
        body = new TextEncoder().encode(data.body);
        contentType = 'text/plain; charset=utf-8';
      }
      if (body && READ_METHODS.has(method)) {
        return refuse('body_not_allowed', `${method} requests cannot carry a body; put parameters in the URL or query.`);
      }
      if (body && body.byteLength > MAX_CONNECTION_REQUEST_BODY_BYTES) {
        return refuse('body_too_large', 'The request body is larger than Chickpea sends to a connection.', {
          byteLength: body.byteLength, maxBytes: MAX_CONNECTION_REQUEST_BODY_BYTES,
        });
      }

      if (!READ_METHODS.has(method)) {
        try {
          assertConnectionWriteAllowed('request');
        } catch {
          return refuse('write_not_allowed', 'Changing data through a connection is unavailable for this response.');
        }
      }

      const scoped = await access.fetchFor(connection.id);
      if (!scoped) {
        return refuse('no_connection', `The ${connection.displayName} connection is not available to this Agent right now.`);
      }
      const headers: Record<string, string> = { accept: 'application/json' };
      for (const [name, value] of Object.entries(data.headers ?? {})) headers[name.toLowerCase()] = value;
      if (contentType && headers['content-type'] === undefined) headers['content-type'] = contentType;

      let result: Awaited<ReturnType<ConnectionScopedFetch>>;
      try {
        result = await scoped.fetch(target.href, {
          method,
          headers,
          ...(body ? { body } : {}),
          // Reads follow redirects; the scope re-checks every hop. A write is
          // never replayed at another location: the redirect is reported.
          followRedirects: READ_METHODS.has(method),
        });
      } catch (error) {
        const reason = connectionFetchFailureReason(error);
        return reason === 'method_not_allowed'
          ? refuse(reason, `The ${connection.displayName} connection does not allow ${method} requests to that URL.`)
          : reason === 'url_not_allowed'
            ? refuse(reason, `That URL is not an endpoint the ${connection.displayName} connection allows.`)
            : refuse('failed', 'The request did not complete (network error or timeout). Nothing is known about whether a write took effect; check before retrying.');
      }

      const response = readConnectionResponse(result.body, result.headers['content-type'], scoped.secrets, {
        maxChars: MAX_CONNECTION_RESPONSE_CHARS,
        summarizeBinary: true,
      });
      const truncated = response.responseTruncated === true;
      const echoedHeaders: Record<string, string> = {};
      for (const name of ECHOED_RESPONSE_HEADERS) {
        const value = result.headers[name];
        if (value !== undefined) echoedHeaders[name] = redactConnectionText(value, scoped.secrets);
      }
      log({
        agentId: options.agentId,
        connectionId: connection.id,
        method,
        host: target.host,
        pathname: target.pathname,
        status: result.status,
        durationMs: Date.now() - started,
        responseBytes: result.body.byteLength,
        truncated,
      });
      return {
        output: {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          connection: connection.id,
          displayName: connection.displayName,
          method,
          url: redactConnectionText(result.url || target.href, scoped.secrets),
          headers: echoedHeaders,
          ...(result.status >= 300 && result.status < 400 && !READ_METHODS.has(method)
            ? { note: 'The service redirected the request; Chickpea does not follow redirects for writes, so check whether it took effect.' }
            : {}),
          ...response,
          ...(truncated
            ? { hint: 'Narrow the request (fields/opt_fields, limit, page size) or paginate; the connection skill describes this service\'s cursor.' }
            : {}),
        } as JsonValue,
      };
    },
  });
}

type Selection =
  | { ok: true; connection: ConnectionDeclaration }
  | { ok: false; reason: RefusalReason; message: string; extra?: Record<string, JsonValue> };

function selectConnection(
  connections: readonly ConnectionDeclaration[],
  requested: string | undefined,
  url: string,
): Selection {
  const listing = connections.map(({ id, displayName }) => ({ id, displayName }));
  const governs = (connection: ConnectionDeclaration) =>
    connection.urlPrefixes.some((prefix) => matchesEgressPrefix(url, prefix));
  if (requested !== undefined) {
    const connection = connections.find(({ id }) => id === requested);
    if (!connection) {
      return {
        ok: false,
        reason: 'no_connection',
        message: 'That connection is not available to this Agent right now.',
        extra: { connections: listing },
      };
    }
    if (!governs(connection)) {
      return {
        ok: false,
        reason: 'url_not_allowed',
        message: `That URL is not an endpoint the ${connection.displayName} connection allows.`,
        extra: { urlPrefixes: connection.urlPrefixes },
      };
    }
    return { ok: true, connection };
  }
  if (connections.length === 0) {
    return { ok: false, reason: 'no_connection', message: 'No API connection is available to this Agent right now.' };
  }
  const matches = connections.filter(governs);
  if (matches.length === 0) {
    return {
      ok: false,
      reason: 'url_not_allowed',
      message: "That URL is not an endpoint this Agent's connections allow.",
      extra: { connections: listing },
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous_connection',
      message: 'More than one connection serves that URL; pass `connection` with one of these ids.',
      extra: { connections: matches.map(({ id, displayName }) => ({ id, displayName })) },
    };
  }
  return { ok: true, connection: matches[0]! };
}
