import type { McpConnectionConfig } from './types.ts';

type McpHttpOutcome = 'ok' | 'stream_unavailable' | 'http_error' | 'network_error';
type McpAuthMode = McpConnectionConfig['authMode'];

interface McpHttpTelemetryEvent {
  event: 'chickpea.mcp.http';
  connectionId: string;
  authMode: McpAuthMode;
  rpcMethod: 'initialize' | 'tools/list' | 'tools/call' | null;
  toolName: string | null;
  httpMethod: string;
  status: number | null;
  outcome: McpHttpOutcome;
  durationMs: number;
  requestBytes: number | null;
  responseBytes: number | null;
}

interface McpHttpTelemetryContext {
  connectionId: string;
  authMode: McpAuthMode;
}

interface McpHttpTelemetryDependencies {
  now?: () => number;
  emit?: (event: McpHttpTelemetryEvent) => void;
}

const MAX_INSPECTED_BODY_BYTES = 64 * 1024;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:/-]{1,128}$/;
/** A `Response` with these cannot have a body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Observe one MCP HTTP attempt without recording URLs, headers, arguments,
 * SQL, prompts, results, tokens, or error text. `durationMs` runs to the
 * headers. A tool call is logged when its body ends, with the bytes read:
 * a streamed result may have no `Content-Length`.
 */
export function withMcpHttpTelemetry(
  fetchFn: typeof fetch,
  context: McpHttpTelemetryContext,
  dependencies: McpHttpTelemetryDependencies = {},
): typeof fetch {
  const now = dependencies.now ?? Date.now;
  const emit = dependencies.emit ?? ((event) => console.info(event));
  return async (input, init) => {
    const startedAt = now();
    const request = requestFacts(input, init);
    try {
      const response = await fetchFn(input, init);
      const durationMs = elapsed(startedAt, now());
      const line = (responseBytes: number | null): McpHttpTelemetryEvent => ({
        event: 'chickpea.mcp.http',
        connectionId: context.connectionId,
        authMode: context.authMode,
        ...request,
        status: response.status,
        outcome: httpOutcome(request.httpMethod, response),
        durationMs,
        responseBytes,
      });
      if (request.rpcMethod === 'tools/call' && response.body && !NULL_BODY_STATUSES.has(response.status)) {
        return countedResponse(response, (bytes) => safelyEmit(emit, line(bytes)));
      }
      safelyEmit(emit, line(contentLength(response.headers)));
      return response;
    } catch (error) {
      safelyEmit(emit, {
        event: 'chickpea.mcp.http',
        connectionId: context.connectionId,
        authMode: context.authMode,
        ...request,
        status: null,
        outcome: 'network_error',
        durationMs: elapsed(startedAt, now()),
        responseBytes: null,
      });
      throw error;
    }
  };
}

function requestFacts(
  input: RequestInfo | URL,
  init?: RequestInit,
): Pick<McpHttpTelemetryEvent, 'rpcMethod' | 'toolName' | 'httpMethod' | 'requestBytes'> {
  const body = typeof init?.body === 'string' ? init.body : undefined;
  const request = input instanceof Request ? input : undefined;
  const bytes = body === undefined
    ? contentLength(request?.headers)
    : new TextEncoder().encode(body).byteLength;
  const rpc = body !== undefined && bytes !== null && bytes <= MAX_INSPECTED_BODY_BYTES
    ? rpcFacts(body)
    : { rpcMethod: null, toolName: null };
  return {
    ...rpc,
    httpMethod: String(init?.method ?? request?.method ?? 'GET').toUpperCase().slice(0, 16),
    requestBytes: bytes,
  };
}

function rpcFacts(body: string): Pick<McpHttpTelemetryEvent, 'rpcMethod' | 'toolName'> {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { rpcMethod: null, toolName: null };
    }
    const record = value as Record<string, unknown>;
    const method = record.method;
    const rpcMethod = method === 'initialize' || method === 'tools/list' || method === 'tools/call'
      ? method
      : null;
    const params = record.params;
    const name = params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>).name
      : undefined;
    const toolName = rpcMethod === 'tools/call' && typeof name === 'string' && TOOL_NAME_PATTERN.test(name)
      ? name
      : null;
    return { rpcMethod, toolName };
  } catch {
    return { rpcMethod: null, toolName: null };
  }
}

/**
 * A 405 to the optional GET means the server offers no server-initiated
 * stream, which the MCP spec allows and the client expects.
 */
function httpOutcome(httpMethod: string, response: Response): McpHttpOutcome {
  if (response.ok) return 'ok';
  return httpMethod === 'GET' && response.status === 405 ? 'stream_unavailable' : 'http_error';
}

/** The same response; `done` gets the bytes the client read, once: at the body's end, failure or cancel. */
function countedResponse(response: Response, done: (bytes: number) => void): Response {
  const reader = response.body!.getReader();
  let bytes = 0;
  let open = true;
  const end = () => {
    if (open) done(bytes);
    open = false;
  };
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read().catch((error: unknown) => {
        end();
        throw error;
      });
      if (chunk.done) {
        end();
        return controller.close();
      }
      bytes += chunk.value.byteLength;
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  }), response);
}

function contentLength(headers: Headers | undefined): number | null {
  const value = headers?.get('content-length');
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function elapsed(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

function safelyEmit(
  emit: (event: McpHttpTelemetryEvent) => void,
  event: McpHttpTelemetryEvent,
): void {
  try {
    emit(event);
  } catch {
    // Observability must not alter connector behavior.
  }
}
