import { declaredContentLength, readBoundedText } from '../http/bounded-body.ts';

/**
 * Meta's Ads server sends the largest tool list Chickpea mounts. Every server
 * gets the same cap, so none that mounts today fails on size.
 */
const MAX_TOOLS_LIST_BYTES = 8_000_000;
/** Flue's per-request MCP timeout; reading an answer during the listing never takes longer. */
const TOOLS_LIST_DEADLINE_MS = 30_000;
const JSON_RPC_INTERNAL_ERROR = -32603;

export type ToolsListResult = Record<string, unknown> & { tools: unknown[] };

export interface ToolsListAnswer {
  /** The tools/list request's JSON-RPC id. The answer must carry the same one. */
  id: unknown;
  /** The result to forward for this page. Throws to refuse the listing. */
  page: (result: ToolsListResult) => Record<string, unknown>;
  /** The error for an answer that cannot be read, by a fixed reason code. */
  refuse: (reason: string) => Error;
}

/** The answer one request's response must hold, and what to forward for its result. */
interface RequestAnswer {
  id: unknown;
  /** The result to forward. Throws to refuse the answer. */
  result: (result: Record<string, unknown>) => Record<string, unknown>;
  refuse: (reason: string) => Error;
}

/**
 * Rewrites each listed page before the grant, such as Meta's reviewed
 * schemas. Returns the tools to list and, by name, the ones it withholds,
 * each with the arguments its live schema requires that Chickpea never
 * reviewed: none when Chickpea holds no reviewed schema for it.
 */
export type ToolsRewrite = (tools: unknown[]) => { tools: unknown[]; withheld?: ReadonlyMap<string, string[]> };

/** Reads one request's response before the MCP client sees it. */
export type McpAnswerReader = (response: Response) => Promise<Response>;

interface McpToolsListFilterOptions {
  connectionId: string;
  /** The tools this Agent may use, in the order the model sees them. */
  grant: readonly string[];
  /** Streamable HTTP answers a request on its own POST; legacy SSE answers every request on the GET stream. */
  transport: 'streamable-http' | 'sse';
}

/**
 * Narrow every tools/list answer of one MCP connection to the granted tools
 * the server still lists, in grant order, first listing of a name only,
 * without a name the request's rewrite withholds.
 *
 * The MCP client resolves a pending request from any stream it reads, so the
 * listing has a window: it opens with the connection's first request (again
 * with `initialize` or any tools/list) and closes once a last page has passed
 * the filter. On Streamable HTTP, inside it the client reads only each
 * request's own response up to that request's answer, and nothing from a GET.
 * On legacy SSE every answer arrives on the GET stream; inside the window
 * each answer there must answer a request sent while it was open, and one
 * the filter cannot read fails every answer still owed. After it, tool calls
 * and their streams pass unread.
 */
export function createMcpToolsListFilter(options: McpToolsListFilterOptions) {
  let listing = newListing();
  let listingOpen = true;
  /** Legacy SSE: the answers the GET stream owes, by request id. */
  const owed = new Map<unknown, { answer: RequestAnswer; displayName: string }>();
  const logRefusal = (reason: string) => {
    console.info({ event: 'chickpea.mcp.tools_list_refused', connectionId: options.connectionId, reason });
  };
  const noGrantedTools = (displayName: string, reason: string) => {
    logRefusal(reason);
    return new Error(
      `${displayName} no longer offers any of the tools this Agent may use. ` +
      'An Admin can pick its tools again in Chickpea Admin.',
    );
  };

  const filterPage = (
    result: ToolsListResult, displayName: string, refuse: (reason: string) => Error, rewriteTools?: ToolsRewrite,
  ) => {
    let page: ReturnType<ToolsRewrite>;
    try {
      page = rewriteTools ? rewriteTools(result.tools) : { tools: result.tools };
    } catch (error) {
      logRefusal('rewrite');
      throw error;
    }
    const listed = new Map<string, Record<string, unknown>>();
    for (const tool of page.tools) {
      if (!isRecord(tool) || typeof tool.name !== 'string') throw refuse('tool');
      // Flue would adapt both copies of a name and fail the connection.
      if (!listed.has(tool.name)) listed.set(tool.name, tool);
    }
    listing.listedCount += result.tools.length;
    // A name with a withheld copy stays unmounted, unless an earlier page mounted it.
    for (const [name, required] of page.withheld ?? []) {
      if (options.grant.includes(name) && !listing.granted.has(name)) listing.withheld.set(name, required);
    }
    const kept = options.grant.filter((name) =>
      listed.has(name) && !listing.granted.has(name) && !listing.withheld.has(name));
    for (const name of kept) {
      listing.granted.add(name);
      // Flue skips a task-only tool with a warning; count it so the log explains the gap.
      const execution = listed.get(name)!.execution;
      if (isRecord(execution) && execution.taskSupport === 'required') listing.taskOnly.push(name);
    }
    // The MCP client stops paging at a cursor it already sent, without an error.
    if (result.nextCursor === undefined || listing.cursors.has(result.nextCursor)) {
      const { granted, taskOnly, listedCount, withheld } = listing;
      listing = newListing();
      const missing = options.grant.filter((name) => !granted.has(name) && !withheld.has(name));
      if (missing.length > 0 || taskOnly.length > 0 || withheld.size > 0) {
        console.info({
          event: 'chickpea.mcp.tools_missing', connectionId: options.connectionId, missing, taskOnly, listedCount,
          ...(withheld.size > 0 ? { schemaRequires: Object.fromEntries(withheld) } : {}),
        });
      }
      if (granted.size === taskOnly.length) throw noGrantedTools(displayName, 'no-granted-tools');
      listingOpen = false;
    }
    return { ...result, tools: kept.map((name) => listed.get(name)) };
  };

  /** Without the tools capability the MCP client lists nothing and Flue mounts nothing, silently. */
  const requireTools = (result: Record<string, unknown>, displayName: string) => {
    if (!isRecord(result.capabilities) || !result.capabilities.tools) {
      throw noGrantedTools(displayName, 'no-tools-capability');
    }
    return result;
  };

  /** Every answer the stream owes becomes this error, so the client fails each request now, not at its timeout. */
  const failOwed = (error: (displayName: string) => Error): StreamEvent[] => {
    const failed = [...owed.values()].map(({ answer, displayName }) => ({
      data: JSON.stringify({
        jsonrpc: '2.0', id: answer.id, error: { code: JSON_RPC_INTERNAL_ERROR, message: error(displayName).message },
      }),
    }));
    owed.clear();
    return failed;
  };
  const refuseOnStream = (reason: string) => {
    logRefusal(reason);
    return failOwed((displayName) => unsupportedResponse(displayName, reason));
  };

  /**
   * One legacy SSE GET stream event as the client may read it. While the
   * listing is open or an answer is owed, a message event is a request, a
   * notification, an answer the stream owes, or, after the listing, another
   * request's answer; anything else is dropped and fails every owed answer.
   */
  const streamEvent = (event: StreamEvent): StreamEvent[] => {
    if ((!listingOpen && owed.size === 0) || 'retry' in event || !isMessageType(event.event)) return [event];
    let value: unknown;
    try {
      value = JSON.parse(event.data) as unknown;
    } catch {
      return refuseOnStream('invalid-json');
    }
    if (isRecord(value) && !('result' in value) && !('error' in value)) return [event];
    if (!isRecord(value)) return refuseOnStream(Array.isArray(value) ? 'batch' : 'json-rpc');
    const owing = [...owed.values()].find(({ answer }) => answersRequest(value.id, answer.id));
    // Inside the window the client may hold a listing request it has not sent yet.
    if (!owing) return listingOpen ? refuseOnStream('response-id') : [event];
    let rewritten: unknown;
    try {
      rewritten = rewriteAnswer(value, owing.answer);
    } catch (error) {
      return failOwed(() => error instanceof Error ? error : new Error(String(error)));
    }
    owed.delete(owing.answer.id);
    return [{ ...event, data: JSON.stringify(rewritten) }];
  };

  return {
    /**
     * Note a POST's JSON-RPC request right before it is sent. Every
     * tools/list answer, and while the listing is open every request's
     * answer, must pass the filter: on Streamable HTTP through the reader
     * returned for its response, on legacy SSE on the GET stream.
     * Notifications and the client's own responses carry no answer and pass.
     */
    request(
      rpc: { id?: unknown; method?: unknown; params?: unknown } | undefined,
      displayName: string,
      rewriteTools?: ToolsRewrite,
    ): McpAnswerReader | undefined {
      if (rpc?.id === undefined || typeof rpc.method !== 'string') return undefined;
      const { id, method } = rpc;
      if (method === 'initialize' || method === 'tools/list') listingOpen = true;
      if (method === 'tools/list') {
        const cursor = isRecord(rpc.params) ? rpc.params.cursor : undefined;
        if (cursor === undefined) listing = newListing();
        else listing.cursors.add(cursor);
      }
      if (!listingOpen) return undefined;
      const refuse = (reason: string) => {
        logRefusal(reason);
        return unsupportedResponse(displayName, reason);
      };
      const answer: RequestAnswer = method === 'tools/list'
        ? toolsListAnswer({ id, refuse, page: (page) => filterPage(page, displayName, refuse, rewriteTools) })
        : {
            id, refuse,
            result: method === 'initialize' ? (value) => requireTools(value, displayName) : (value) => value,
          };
      if (options.transport === 'sse') {
        owed.set(id, { answer, displayName });
        return undefined;
      }
      // An HTTP error carries no answer the client reads; it fails or retries it.
      return async (response) => response.ok ? readRequestAnswer(response, answer) : response;
    },
    /**
     * On Streamable HTTP, answer locally, with the 405 the MCP client reads
     * as "no stream", every GET while the listing is open, and the
     * standalone GET stream always: Flue uses nothing it carries. After the
     * listing, a GET with `Last-Event-ID` resumes a tool call's own stream
     * and goes through. On legacy SSE, every GET stream, a reconnect's too,
     * reaches the client only through the filter.
     */
    guardGets(fetchFn: typeof fetch): typeof fetch {
      return async (input, init) => {
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (method.toUpperCase() !== 'GET') return fetchFn(input, init);
        if (options.transport === 'sse') {
          const response = await fetchFn(input, init);
          // The client reads only a 200 stream.
          return response.status === 200 && response.body ? filteredEventStream(response, streamEvent) : response;
        }
        if (listingOpen || !new Request(input, init).headers.has('last-event-id')) {
          return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
        }
        return fetchFn(input, init);
      };
    },
  };
}

function unsupportedResponse(displayName: string, reason: string): Error {
  return new Error(`${displayName} tool discovery returned an unsupported response (${reason}).`);
}

/**
 * Read the answer to one tools/list POST from its own response and rewrite
 * its result. Only a 200 with a JSON or event-stream body that holds the
 * answer to `answer.id` passes; a JSON-RPC error answer passes unchanged.
 */
export function readToolsListAnswer(response: Response, answer: ToolsListAnswer): Promise<Response> {
  return readRequestAnswer(response, toolsListAnswer(answer));
}

function toolsListAnswer(answer: ToolsListAnswer): RequestAnswer {
  return {
    id: answer.id,
    refuse: answer.refuse,
    result: (result) => {
      if (!Array.isArray(result.tools)) throw answer.refuse('json-rpc');
      return answer.page(result as ToolsListResult);
    },
  };
}

/**
 * Read one request's answer from its own response. Only a 200 with a JSON or
 * event-stream body that holds the answer to `answer.id` passes, and an event
 * stream ends at that answer.
 */
async function readRequestAnswer(response: Response, answer: RequestAnswer): Promise<Response> {
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

/**
 * The answer as forwarded. Only the envelope the MCP client reads as an
 * answer passes: anything else leaves the request open for another stream.
 */
function rewriteAnswer(value: unknown, answer: RequestAnswer): unknown {
  if (Array.isArray(value)) throw answer.refuse('batch');
  if (!isRecord(value) || value.jsonrpc !== '2.0') throw answer.refuse('json-rpc');
  if (!answersRequest(value.id, answer.id)) throw answer.refuse('response-id');
  if ('error' in value) {
    const { error } = value;
    if (!hasOnlyKeys(value, ['jsonrpc', 'id', 'error']) || !isRecord(error) ||
        !Number.isInteger(error.code) || typeof error.message !== 'string') {
      throw answer.refuse('json-rpc');
    }
    return value;
  }
  // The client drops a result whose `_meta` is not an object, which would leave its request open.
  if (!hasOnlyKeys(value, ['jsonrpc', 'id', 'result']) || !isRecord(value.result) ||
      (value.result._meta !== undefined && !isRecord(value.result._meta))) {
    throw answer.refuse('json-rpc');
  }
  const result = answer.result(value.result);
  return result === value.result ? value : { ...value, result };
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** The MCP client matches an answer to its request by `Number(id)`, so `"3"` answers request 3. */
function answersRequest(id: unknown, requestId: unknown): boolean {
  return id === requestId || (typeof id === 'string' && typeof requestId === 'number' && Number(id) === requestId);
}

/**
 * Read events as they arrive and stop at the answer: a server may hold the
 * stream open after it. Events up to the answer are forwarded in one
 * canonical form, so the client reads exactly the events read here, and
 * without their ids, so the client holds no token to resume this stream
 * with a GET that would bring it an answer read nowhere here.
 */
async function readEventStreamAnswer(response: Response, answer: RequestAnswer): Promise<Response> {
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

/**
 * A GET event stream as the client will read it: split as it splits events,
 * each event passed through `read` when the client asks for more, and
 * written back in one canonical form without event ids, which the SDK never
 * sends back when it reconnects.
 */
function filteredEventStream(response: Response, read: (event: StreamEvent) => StreamEvent[]): Response {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const parse = eventStreamParser();
  return rebuiltResponse(response, new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return controller.close();
        const text = parse(decoder.decode(chunk.value, { stream: true })).flatMap(read).map(serializeEvent).join('');
        if (text) return controller.enqueue(encoder.encode(text));
      }
    },
    cancel: (reason) => reader.cancel(reason),
  }, { highWaterMark: 0 }));
}

type StreamEvent = { id?: string; event?: string; data: string } | { retry: string };

/** The MCP client reads only message events. */
function isMessageType(type: string | undefined): boolean {
  return type === undefined || type === 'message';
}

/** The event rewritten when it holds a response; undefined to forward it as it is. */
function answerIn(event: StreamEvent, answer: RequestAnswer): StreamEvent | undefined {
  if ('retry' in event || !isMessageType(event.event)) return undefined;
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
  return (event.event === undefined ? '' : `event: ${event.event}\n`) +
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
  return {
    granted: new Set<string>(), withheld: new Map<string, string[]>(), taskOnly: [] as string[], listedCount: 0,
    cursors: new Set<unknown>(),
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
