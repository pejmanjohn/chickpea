import { declaredContentLength, readBoundedText } from '../http/bounded-body.ts';

/**
 * Meta's Ads server sends the largest tool list Chickpea mounts. Every server
 * gets the same cap, so none that mounts today fails on size.
 */
const MAX_TOOLS_LIST_BYTES = 8_000_000;
/** Flue's per-request MCP timeout; reading a listing never takes longer. */
const TOOLS_LIST_DEADLINE_MS = 30_000;

export type ToolsListResult = Record<string, unknown> & { tools: unknown[] };

export interface ToolsListAnswer {
  /** The tools/list request's JSON-RPC id. The answer must carry the same one. */
  id: unknown;
  /** The result to forward for this page. Throws to refuse the listing. */
  page: (result: ToolsListResult) => Record<string, unknown>;
  /** The error for an answer that cannot be read, by a fixed reason code. */
  refuse: (reason: string) => Error;
}

interface McpToolsListFilterOptions {
  connectionId: string;
  /** The tools this Agent may use, in the order the model sees them. */
  grant: readonly string[];
  /** Runs on each listed page before the grant, such as Meta's account helper contract. */
  rewriteTools?: ((tools: unknown[]) => unknown[]) | undefined;
}

/**
 * Narrow every tools/list answer of one Streamable HTTP connection to the
 * granted tools the server still lists, in grant order, first listing of a
 * name only. The answer must arrive in the POST's own response: the MCP
 * client also accepts one from the GET stream, which this never reads, so
 * any other shape is refused.
 */
export function createMcpToolsListFilter(options: McpToolsListFilterOptions) {
  let listing = newListing();
  const logRefusal = (reason: string) => {
    console.info({ event: 'chickpea.mcp.tools_list_refused', connectionId: options.connectionId, reason });
  };

  const filterPage = (result: ToolsListResult, displayName: string, refuse: (reason: string) => Error) => {
    let tools: unknown[];
    try {
      tools = options.rewriteTools ? options.rewriteTools(result.tools) : result.tools;
    } catch (error) {
      logRefusal('rewrite');
      throw error;
    }
    const listed = new Map<string, Record<string, unknown>>();
    for (const tool of tools) {
      if (!isRecord(tool) || typeof tool.name !== 'string') throw refuse('tool');
      // Flue would adapt both copies of a name and fail the connection.
      if (!listed.has(tool.name)) listed.set(tool.name, tool);
    }
    listing.listedCount += tools.length;
    const kept = options.grant.filter((name) => listed.has(name) && !listing.granted.has(name));
    for (const name of kept) {
      listing.granted.add(name);
      // Flue skips a task-only tool with a warning; count it so the log explains the gap.
      const execution = listed.get(name)!.execution;
      if (isRecord(execution) && execution.taskSupport === 'required') listing.taskOnly.push(name);
    }
    if (result.nextCursor === undefined) {
      const { granted, taskOnly, listedCount } = listing;
      listing = newListing();
      const missing = options.grant.filter((name) => !granted.has(name));
      if (missing.length > 0 || taskOnly.length > 0) {
        console.info({
          event: 'chickpea.mcp.tools_missing', connectionId: options.connectionId, missing, taskOnly, listedCount,
        });
      }
      if (granted.size === taskOnly.length) {
        logRefusal('no-granted-tools');
        throw new Error(
          `${displayName} no longer offers any of the tools this Agent may use. ` +
          'An Admin can pick its tools again in Chickpea Admin.',
        );
      }
    }
    return { ...result, tools: kept.map((name) => listed.get(name)) };
  };

  return {
    /** Filter the response to a tools/list POST, `rpc` being the parsed request. */
    async filterResponse(
      rpc: { id?: unknown; params?: unknown },
      response: Response,
      displayName: string,
    ): Promise<Response> {
      if (!isRecord(rpc.params) || rpc.params.cursor === undefined) listing = newListing();
      // An HTTP error carries no listing; the MCP client fails or retries it.
      if (!response.ok) return response;
      const refuse = (reason: string) => {
        logRefusal(reason);
        return new Error(`${displayName} tool discovery returned an unsupported response (${reason}).`);
      };
      return readToolsListAnswer(response, {
        id: rpc.id,
        page: (result) => filterPage(result, displayName, refuse),
        refuse,
      });
    },
  };
}

/**
 * Read the answer to one tools/list POST from its own response and rewrite
 * its result. Only a 200 with a JSON or event-stream body that holds the
 * answer to `answer.id` passes; a JSON-RPC error answer passes unchanged.
 */
export async function readToolsListAnswer(response: Response, answer: ToolsListAnswer): Promise<Response> {
  if (response.status !== 200) throw answer.refuse('status');
  const essence = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (essence === 'text/event-stream') return readEventStreamAnswer(response, answer);
  if (essence !== 'application/json') throw answer.refuse('content-type');
  const text = await readBoundedText(response, {
    maxBytes: MAX_TOOLS_LIST_BYTES,
    onOversize: () => answer.refuse('response-size'),
    signal: AbortSignal.timeout(TOOLS_LIST_DEADLINE_MS),
    onAbort: () => answer.refuse('response-deadline'),
  });
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw answer.refuse('invalid-json');
  }
  const rewritten = rewriteAnswer(value, answer);
  return rebuiltResponse(response, rewritten === value ? text : JSON.stringify(rewritten));
}

function rewriteAnswer(value: unknown, answer: ToolsListAnswer): unknown {
  if (Array.isArray(value)) throw answer.refuse('batch');
  if (!isRecord(value) || value.jsonrpc !== '2.0') throw answer.refuse('json-rpc');
  if (value.id !== answer.id) throw answer.refuse('response-id');
  if ('error' in value) {
    if ('result' in value) throw answer.refuse('json-rpc');
    return value;
  }
  if (!isRecord(value.result) || !Array.isArray(value.result.tools)) throw answer.refuse('json-rpc');
  return { ...value, result: answer.page(value.result as ToolsListResult) };
}

/**
 * Read events as they arrive and stop at the answer: a server may hold the
 * stream open after it. Events before the answer are forwarded in one
 * canonical form, so the client reads exactly the events read here.
 */
async function readEventStreamAnswer(response: Response, answer: ToolsListAnswer): Promise<Response> {
  const declared = declaredContentLength(response.headers);
  if (declared !== undefined && declared > MAX_TOOLS_LIST_BYTES) throw answer.refuse('response-size');
  if (!response.body) throw answer.refuse('no-response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parse = eventStreamParser();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, TOOLS_LIST_DEADLINE_MS);
  let bytes = 0;
  let forwarded = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw answer.refuse(timedOut ? 'response-deadline' : 'no-response');
      bytes += chunk.value.byteLength;
      if (bytes > MAX_TOOLS_LIST_BYTES) throw answer.refuse('response-size');
      for (const event of parse(decoder.decode(chunk.value, { stream: true }))) {
        const rewritten = answerIn(event, answer);
        forwarded += serializeEvent(rewritten ?? event);
        if (rewritten) return rebuiltResponse(response, forwarded);
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
}

type StreamEvent = { id?: string; event?: string; data: string } | { retry: string };

/** The event rewritten when it answers the listing; undefined to forward it as it is. */
function answerIn(event: StreamEvent, answer: ToolsListAnswer): StreamEvent | undefined {
  // The MCP client reads only message events.
  if ('retry' in event || (event.event !== undefined && event.event !== 'message')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(event.data) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) && !(isRecord(value) && ('result' in value || 'error' in value))) return undefined;
  return { ...event, data: JSON.stringify(rewriteAnswer(value, answer)) };
}

function serializeEvent(event: StreamEvent): string {
  if ('retry' in event) return `retry: ${event.retry}\n\n`;
  return (event.id === undefined ? '' : `id: ${event.id}\n`) +
    (event.event === undefined ? '' : `event: ${event.event}\n`) +
    event.data.split('\n').map((line) => `data: ${line}\n`).join('') + '\n';
}

/**
 * Split an event stream as the MCP client's parser (eventsource-parser) does:
 * lines end in CR, LF, or CRLF; an event needs a data line; comments and
 * unknown fields are dropped.
 */
function eventStreamParser(): (text: string) => StreamEvent[] {
  let pending = '';
  let id: string | undefined;
  let type: string | undefined;
  let data: string[] = [];

  const line = (text: string, events: StreamEvent[]): void => {
    if (text === '') {
      if (data.length > 0) {
        events.push({
          ...(id === undefined ? {} : { id }),
          ...(type === undefined ? {} : { event: type }),
          data: data.join('\n'),
        });
      }
      id = undefined;
      type = undefined;
      data = [];
      return;
    }
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    const value = colon === -1 ? '' : text.slice(text.charCodeAt(colon + 1) === 32 ? colon + 2 : colon + 1);
    if (field === 'data') data.push(value);
    else if (field === 'event') type = value || undefined;
    else if (field === 'id') id = value;
    else if (field === 'retry') events.push({ retry: value });
  };

  return (text) => {
    // A long line arrives in many chunks; do not rescan it for each one.
    if (!text.includes('\n') && !text.includes('\r')) {
      pending += text;
      return [];
    }
    const input = pending + text;
    const events: StreamEvent[] = [];
    let start = 0;
    while (start < input.length) {
      const lf = input.indexOf('\n', start);
      const cr = input.indexOf('\r', start);
      if (lf === -1 && cr === -1) break;
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        // A final CR may be the first half of a CRLF in the next chunk.
        if (cr === input.length - 1) break;
        line(input.slice(start, cr), events);
        start = input.charCodeAt(cr + 1) === 10 ? cr + 2 : cr + 1;
      } else {
        line(input.slice(start, lf), events);
        start = lf + 1;
      }
    }
    pending = input.slice(start);
    return events;
  };
}

function newListing() {
  return { granted: new Set<string>(), taskOnly: [] as string[], listedCount: 0 };
}

function rebuiltResponse(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
