import { readBoundedText } from '../http/bounded-body.ts';

/**
 * Meta's Ads server sends the largest tool list Chickpea mounts. Every server
 * gets the same cap, so none that mounts today fails on size.
 */
const MAX_TOOLS_LIST_BYTES = 8_000_000;

export type ToolsListResult = Record<string, unknown> & { tools: unknown[] };

export interface ToolsListRewrite {
  /** tools/list request ids, keyed as the MCP client matches answers: `Number(id)`. */
  ids: ReadonlySet<number>;
  /** The result to forward for one listed page. Throws to refuse the listing. */
  page: (result: ToolsListResult) => Record<string, unknown>;
  /** The error for a listing that is not a well-formed JSON-RPC answer. */
  unsupported: (reason: string) => Error;
}

interface McpToolsListFilterOptions {
  connectionId: string;
  transport: 'streamable-http' | 'sse';
  /** The tools this Agent may use, in the order the model sees them. */
  grant: readonly string[];
  /** Runs on each listed page before the grant, such as Meta's account helper contract. */
  rewriteTools?: ((tools: unknown[]) => unknown[]) | undefined;
}

/**
 * Narrow every tools/list answer one MCP connection receives to the tools
 * the Agent may use that the server still lists, in grant order. Answers
 * arrive in a POST's JSON or SSE body, or on a GET event stream: the legacy
 * SSE transport answers there, and Streamable HTTP resumes there.
 */
export function createMcpToolsListFilter(options: McpToolsListFilterOptions) {
  const pending = new Set<number>();
  let listing = { granted: new Set<string>(), listedCount: 0 };

  const filterPage = (result: ToolsListResult, displayName: string, unsupported: (reason: string) => Error) => {
    const tools = options.rewriteTools ? options.rewriteTools(result.tools) : result.tools;
    const listed = new Map<string, unknown>();
    for (const tool of tools) {
      if (!isRecord(tool) || typeof tool.name !== 'string') throw unsupported('tool');
      if (!listed.has(tool.name)) listed.set(tool.name, tool);
    }
    listing.listedCount += tools.length;
    const kept = options.grant.filter((name) => listed.has(name) && !listing.granted.has(name));
    for (const name of kept) listing.granted.add(name);
    if (result.nextCursor === undefined) {
      const { granted, listedCount } = listing;
      listing = { granted: new Set(), listedCount: 0 };
      if (granted.size === 0) {
        throw new Error(
          `${displayName} no longer offers any of the tools this Agent may use. ` +
          'An Admin can pick its tools again in Chickpea Admin.',
        );
      }
      const missing = options.grant.filter((name) => !granted.has(name));
      if (missing.length > 0) {
        console.info({ event: 'chickpea.mcp.tools_missing', connectionId: options.connectionId, missing, listedCount });
      }
    }
    return { ...result, tools: kept.map((name) => listed.get(name)) };
  };

  return {
    /** Call before the request is sent, so an answer on another stream is never missed. */
    async noteRequest(request: Request): Promise<boolean> {
      const rpc = await jsonRpcRequest(request);
      if (rpc?.method === 'initialize') pending.clear();
      if (rpc?.method !== 'tools/list') return false;
      if (!isRecord(rpc.params) || rpc.params.cursor === undefined) {
        pending.clear();
        listing = { granted: new Set(), listedCount: 0 };
      }
      pending.add(Number(rpc.id));
      return true;
    },

    async filterResponse(
      request: Request,
      response: Response,
      displayName: string,
      listsTools: boolean,
    ): Promise<Response> {
      if (!response.ok) return response;
      const unsupported = (reason: string) =>
        new Error(`${displayName} tool discovery returned an unsupported response (${reason}).`);
      const rewrite: ToolsListRewrite = {
        ids: pending,
        page: (result) => filterPage(result, displayName, unsupported),
        unsupported,
      };
      // The MCP client reads any successful GET as an event stream.
      if (request.method === 'GET') return rewriteEventStream(response, rewrite);
      // A 202, and every POST body on the legacy SSE transport, carries no answer.
      if (!listsTools || options.transport === 'sse' || response.status === 202) return response;
      return rewriteToolsListResponse(response, rewrite, request.signal);
    },
  };
}

/** The request id of a POST tools/list request. */
export async function toolsListRequestId(request: Request): Promise<number | undefined> {
  const rpc = await jsonRpcRequest(request);
  return rpc?.method === 'tools/list' ? Number(rpc.id) : undefined;
}

/** Rewrite the answer to a tools/list POST, by the media type the MCP client reads it as. */
export async function rewriteToolsListResponse(
  response: Response,
  rewrite: ToolsListRewrite,
  signal?: AbortSignal,
): Promise<Response> {
  const essence = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (essence === 'text/event-stream') return rewriteEventStream(response, rewrite);
  if (essence !== 'application/json') throw rewrite.unsupported('content-type');
  const text = await readBoundedText(response, {
    maxBytes: MAX_TOOLS_LIST_BYTES,
    onOversize: () => rewrite.unsupported('response-size'),
    signal,
  });
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw rewrite.unsupported('invalid-json');
  }
  const rewritten = rewriteToolsListMessage(value, rewrite);
  return rebuiltResponse(response, rewritten === value ? text : JSON.stringify(rewritten));
}

async function jsonRpcRequest(request: Request): Promise<Record<string, unknown> | undefined> {
  if (request.method !== 'POST') return undefined;
  try {
    const value = await request.clone().json() as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A message known to answer tools/list: an error passes, a result is rewritten. */
function rewriteToolsListMessage(value: unknown, rewrite: ToolsListRewrite): unknown {
  if (!isRecord(value) || value.jsonrpc !== '2.0' ||
      !(typeof value.id === 'string' || typeof value.id === 'number' || value.id === null)) {
    throw rewrite.unsupported('json-rpc');
  }
  if ('error' in value) {
    if ('result' in value) throw rewrite.unsupported('json-rpc');
    return value;
  }
  if (!isRecord(value.result) || !Array.isArray(value.result.tools)) throw rewrite.unsupported('json-rpc');
  return { ...value, result: rewrite.page(value.result as ToolsListResult) };
}

/**
 * Rewrite tools/list answers in an event stream as each event completes, so
 * a stream the server keeps open still delivers every event on time.
 */
function rewriteEventStream(response: Response, rewrite: ToolsListRewrite): Response {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const push = eventStreamRewriter(
    (data) => rewriteEventData(data, rewrite),
    () => rewrite.unsupported('response-size'),
  );
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = push(decoder.decode(chunk, { stream: true }));
      if (text) controller.enqueue(encoder.encode(text));
    },
    flush(controller) {
      const text = push(decoder.decode());
      if (text) controller.enqueue(encoder.encode(text));
    },
  }));
  return rebuiltResponse(response, body);
}

function rewriteEventData(data: string, rewrite: ToolsListRewrite): string {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    return data;
  }
  const messages = Array.isArray(value) ? value : [value];
  const rewritten = messages.map((message) => rewriteStreamedMessage(message, rewrite));
  if (rewritten.every((message, index) => message === messages[index])) return data;
  return JSON.stringify(Array.isArray(value) ? rewritten : rewritten[0]);
}

function rewriteStreamedMessage(message: unknown, rewrite: ToolsListRewrite): unknown {
  if (!isRecord(message) || !('result' in message || 'error' in message) ||
      !rewrite.ids.has(Number(message.id))) {
    return message;
  }
  try {
    return rewriteToolsListMessage(message, rewrite);
  } catch (error) {
    // A stream cannot throw to the caller: answer the listing with the error,
    // so the client fails it with this reason instead of waiting out a timeout.
    return {
      jsonrpc: '2.0',
      id: Number(message.id),
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * Split an event stream as the MCP client's parser (eventsource-parser) does:
 * lines end in CR, LF, or CRLF; an event needs a data line; comments, unknown
 * fields, and an unfinished last event are dropped. Each event is written back
 * in one canonical form, so the client reads exactly the events read here.
 */
function eventStreamRewriter(
  rewriteData: (data: string) => string,
  tooLarge: () => Error,
): (text: string) => string {
  let pending = '';
  let id: string | undefined;
  let type: string | undefined;
  let data: string[] = [];
  let size = 0;

  const dispatch = (): string => {
    const event = { id, type, data };
    id = undefined;
    type = undefined;
    data = [];
    size = 0;
    if (event.data.length === 0) return '';
    return (event.id === undefined ? '' : `id: ${event.id}\n`) +
      (event.type === undefined ? '' : `event: ${event.type}\n`) +
      rewriteData(event.data.join('\n')).split('\n').map((line) => `data: ${line}\n`).join('') + '\n';
  };

  const line = (text: string): string => {
    if (text === '') return dispatch();
    if (text.startsWith(':')) return '';
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    const value = colon === -1 ? '' : text.slice(text.charCodeAt(colon + 1) === 32 ? colon + 2 : colon + 1);
    if (field === 'data') {
      data.push(value);
      size += value.length + 1;
    } else if (field === 'event') {
      type = value || undefined;
    } else if (field === 'id') {
      id = value.includes('\0') ? undefined : value;
    } else if (field === 'retry' && /^\d+$/.test(value)) {
      return `retry: ${value}\n\n`;
    }
    return '';
  };

  return (text) => {
    // A long line arrives in many chunks; do not rescan it for each one.
    if (!pending.endsWith('\r') && !text.includes('\n') && !text.includes('\r')) {
      pending += text;
      if (pending.length + size > MAX_TOOLS_LIST_BYTES) throw tooLarge();
      return '';
    }
    const input = pending + text;
    let output = '';
    let start = 0;
    while (start < input.length) {
      const lf = input.indexOf('\n', start);
      const cr = input.indexOf('\r', start);
      if (lf === -1 && cr === -1) break;
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        // A final CR may be the first half of a CRLF in the next chunk.
        if (cr === input.length - 1) break;
        output += line(input.slice(start, cr));
        start = input.charCodeAt(cr + 1) === 10 ? cr + 2 : cr + 1;
      } else {
        output += line(input.slice(start, lf));
        start = lf + 1;
      }
    }
    pending = input.slice(start);
    if (pending.length + size > MAX_TOOLS_LIST_BYTES) throw tooLarge();
    return output;
  };
}

function rebuiltResponse(response: Response, body: BodyInit): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
