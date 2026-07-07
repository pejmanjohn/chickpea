import { createServer, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * In-memory fake Slack + fake Cloudflare Workers AI backend.
 *
 * A single core records every outbound request to a wire log and is dual-exposed:
 *   - `asFetch()` returns a `fetch`-compatible function, used directly by the
 *     fake-slack unit tests (tests/parity-fake-slack.test.ts).
 *   - `listen()` serves the SAME core over HTTP; Lane B (the real Flue app,
 *     which only speaks HTTP) uses this.
 *
 * Everything asserted by the scenario suite is read back from `wireLog` via the
 * behavioral helpers (`finals`, `statusCalls`, `providerCalls`, `callsOfMethod`,
 * `progressPosts`) so the suite only ever depends on wire-observable behavior.
 */

export const STUB_REPLY_MARKER = 'stub-reply::glm-parity-marker';
export const RAW_PROVIDER_ERROR_MARKER = 'raw_provider_error_marker';

/**
 * Scripted tool-call triggers (Stage 4, part c). When a provider request's
 * messages contain `TOOL_TRIGGER`, the openai-completions surface first emits a
 * `lookup_channel_brief` tool call, then (once the tool result comes back) emits
 * a final that echoes the tool result. `TOOL_TRIGGER_FORBIDDEN` (a superset
 * string) forces the tool call to target `C_FORBIDDEN` so the app-enforced
 * assignment scope denies it — the final then relays the honest denial.
 */
export const TOOL_TRIGGER = 'PLEASE_USE_CHANNEL_BRIEF_TOOL';
export const TOOL_TRIGGER_FORBIDDEN = 'PLEASE_USE_CHANNEL_BRIEF_TOOL_FORBIDDEN';
export const FORBIDDEN_TOOL_CHANNEL = 'C_FORBIDDEN';
/** Default channel id the scripted (allowed) tool call targets. */
export const DEFAULT_TOOL_CHANNEL = 'C_EXEC';

export interface WireEntry {
  kind: 'slack' | 'provider';
  method: string;
  url: string;
  body: Record<string, unknown>;
  /**
   * Outcome of the call as the fake answered it: `false` when the response
   * envelope was `{ ok:false }` (the real WebClient throws on these). Left
   * `undefined` for provider calls. `finals()` uses it so a delivery that the
   * fake rejected is NOT counted as a delivered final (a rejected markdown
   * `chat.postMessage` never reaches the channel in real Slack).
   */
  ok?: boolean;
}

/**
 * Internal route outcome. `body` is JSON-encoded; `rawBody` (with `contentType`)
 * is written verbatim, used for the OpenAI SSE stream.
 */
interface RouteResult {
  status: number;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
}

/**
 * One "final" answer as seen on the wire. Either a `chat.startStream`(markdown_text)
 * paired with a following `chat.stopStream`, or a final `chat.postMessage`.
 */
export interface FinalOnWire {
  channel: string;
  threadTs: string;
  text: string;
  /** The wireLog index of the call that delivered this final (lane-agnostic). */
  index: number;
}

export interface RepliesPage {
  messages: unknown[];
  next_cursor?: string;
}

export interface FakeSlackBehaviorConfig {
  rejectSetStatus?: boolean;
  rejectStartStream?: boolean;
  failStopStreamOnce?: boolean;
  /**
   * Make conversations.history AND conversations.replies return `{ ok:false }`
   * so the product's WebClient throws during hydration. Exercises the
   * context-read-failure degradation path (web-client-context.ts try/catch →
   * current-message-only context; the turn still completes). Default false.
   */
  failConversationReads?: boolean;
  /**
   * Fail the FIRST final delivery at BOTH transports: the first chat.startStream
   * and the first markdown chat.postMessage each return `{ ok:false }` (the
   * WebClient throws on both), so deliverFinal fully fails and runTurn throws.
   * Every subsequent delivery succeeds. Exercises the claim-release-on-delivery-
   * failure + Slack-retry path. Default false.
   */
  failFinalDeliveryOnce?: boolean;
  identity?: FakeSlackIdentityConfig;
  repliesPages?: RepliesPage[];
  historyMessages?: unknown[];
}

export interface FakeSlackIdentityConfig {
  appId?: string;
  botUserId?: string;
  displayName?: string;
  realName?: string;
  image512Url?: string;
  image72Url?: string;
}

export interface FakeProviderConfig {
  mode: 'ok' | 'http_500';
  replyText?: string;
  /** channelId the scripted (allowed) tool call targets. Defaults to `C_EXEC`. */
  toolChannelId?: string;
  /**
   * Hold the openai-completions SSE response open this long BEFORE emitting the
   * reply content, simulating a slow model turn. The stream head + periodic
   * SSE keepalive comments are sent immediately so the connection stays active
   * (an idle stream is reset by workerd/miniflare); only the content is
   * deferred. Used by the cf-smoke slow-turn case to prove a turn that outlives
   * the old ~30s waitUntil horizon still delivers via the DO alarm relay. `0`
   * (default) responds immediately. HTTP transport only.
   */
  delayMs?: number;
}

export interface FakeSlackBackendConfig {
  slack?: FakeSlackBehaviorConfig;
  provider?: FakeProviderConfig;
}

/** Default 2-page cursor fixture copied from tests/slack-events-route.test.ts. */
export const DEFAULT_REPLIES_PAGES: RepliesPage[] = [
  {
    messages: [
      { user: 'U_ALICE', text: 'root thread topic', ts: '1782770400.000100' },
      // Carries `user` so it passes the `!message.user` guard in
      // toContextMessages and is excluded ONLY by the `bot_id` filter
      // (thread-context.ts:303) — the row S07 asserts must never reach the
      // provider.
      { user: 'U_BOTUSER', bot_id: 'B_OTHER', text: 'bot prior reply', ts: '1782770405.000100' },
      // Human `user` but a non-message subtype: excluded by the `subtype` half
      // of the same filter. S07 asserts this text is likewise absent.
      { user: 'U_JOINER', subtype: 'channel_join', text: 'subtype prior row', ts: '1782770405.000200' },
    ],
    next_cursor: 'cursor_2',
  },
  {
    messages: [
      { user: 'U_BOB', text: 'prior thread detail', ts: '1782770406.000100' },
      { user: 'U_ALICE', text: 'continue from the prior answer', ts: '1782770410.000200' },
    ],
  },
];

/** Default channel/DM history messages (human-authored). */
export const DEFAULT_HISTORY_MESSAGES: unknown[] = [
  { user: 'U_BOB', text: 'recent channel context', ts: '1782770300.000100' },
];

export class FakeSlackBackend {
  readonly wireLog: WireEntry[] = [];

  // Behavior knobs are mutable so the HTTP-transport backend can be
  // reconfigured between offline-verification scenarios via `POST /__config`
  // (the constructor still sets them once for backends used directly, e.g.
  // via `asFetch()` in the fake-slack unit tests).
  private rejectSetStatus: boolean;
  private rejectStartStream: boolean;
  private failStopStreamOnce: boolean;
  private failConversationReads: boolean;
  private failFinalDeliveryOnce: boolean;
  private identity: Required<FakeSlackIdentityConfig>;
  private providerMode: 'ok' | 'http_500';
  private replyText: string;
  private toolChannelId: string;
  private providerDelayMs: number;
  private readonly repliesPages: RepliesPage[];
  private readonly historyMessages: unknown[];
  private readonly cursorToIndex = new Map<string, number>();

  private tsCounter = 0;
  private stopStreamCalls = 0;
  // One-shot latches for `failFinalDeliveryOnce`: the first startStream and the
  // first markdown postMessage each fail once, then recover.
  private finalStreamFailedOnce = false;
  private finalPostFailedOnce = false;
  private servers: Server[] = [];

  constructor(config: FakeSlackBackendConfig = {}) {
    const slack = config.slack ?? {};
    this.rejectSetStatus = slack.rejectSetStatus ?? false;
    this.rejectStartStream = slack.rejectStartStream ?? false;
    this.failStopStreamOnce = slack.failStopStreamOnce ?? false;
    this.failConversationReads = slack.failConversationReads ?? false;
    this.failFinalDeliveryOnce = slack.failFinalDeliveryOnce ?? false;
    this.identity = {
      appId: slack.identity?.appId ?? 'A_FAKE',
      botUserId: slack.identity?.botUserId ?? 'U_BOT',
      displayName: slack.identity?.displayName ?? 'Tag',
      realName: slack.identity?.realName ?? 'Tag',
      image512Url: slack.identity?.image512Url ?? 'https://avatars.slack-edge.com/fake/flue_512.png',
      image72Url: slack.identity?.image72Url ?? 'https://avatars.slack-edge.com/fake/flue_72.png',
    };
    this.repliesPages = slack.repliesPages ?? DEFAULT_REPLIES_PAGES;
    this.historyMessages = slack.historyMessages ?? DEFAULT_HISTORY_MESSAGES;
    this.providerMode = config.provider?.mode ?? 'ok';
    this.replyText = config.provider?.replyText ?? STUB_REPLY_MARKER;
    this.toolChannelId = config.provider?.toolChannelId ?? DEFAULT_TOOL_CHANNEL;
    this.providerDelayMs = config.provider?.delayMs ?? 0;

    this.repliesPages.forEach((page, index) => {
      if (page.next_cursor) {
        this.cursorToIndex.set(page.next_cursor, index + 1);
      }
    });
  }

  /** fetch-compatible function that routes into the shared core. */
  asFetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const bodyString = init?.body == null ? '' : String(init.body);
      const result = this.route(url, bodyString);
      if (result.rawBody !== undefined) {
        return new Response(result.rawBody, {
          status: result.status,
          headers: { 'content-type': result.contentType ?? 'text/plain' },
        });
      }
      return Response.json(result.body, { status: result.status });
    }) as typeof fetch;
  }

  /** Serve the SAME core over HTTP (for a future HTTP-transport lane). */
  async listen(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const bodyString = Buffer.concat(chunks).toString('utf8');
        // Slow-turn path streams its own (delayed) response over `res`.
        if (this.tryStreamDelayedProvider(req.url ?? '/', bodyString, res)) {
          return;
        }
        const result = this.route(req.url ?? '/', bodyString);
        if (result.rawBody !== undefined) {
          res.writeHead(result.status, { 'content-type': result.contentType ?? 'text/plain' });
          res.end(result.rawBody);
        } else {
          res.writeHead(result.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result.body));
        }
      });
    });
    this.servers.push(server);

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    return {
      url,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    };
  }

  /** Close any HTTP servers started via listen(). */
  async close(): Promise<void> {
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    this.servers = [];
  }

  /**
   * Resolve once no new wire entries have landed for `idleMs` (cap `capMs`).
   * Lets floating async turn handlers drain before assertions run.
   */
  async quiesce(idleMs = 150, capMs = 5000): Promise<void> {
    const startedAt = Date.now();
    let lastLength = this.wireLog.length;
    let lastChangeAt = Date.now();

    while (Date.now() - startedAt < capMs) {
      await delay(25);
      if (this.wireLog.length !== lastLength) {
        lastLength = this.wireLog.length;
        lastChangeAt = Date.now();
      } else if (Date.now() - lastChangeAt >= idleMs) {
        return;
      }
    }
  }

  callsOfMethod(method: string): WireEntry[] {
    return this.wireLog.filter((entry) => entry.method === method);
  }

  statusCalls(): WireEntry[] {
    return this.callsOfMethod('assistant.threads.setStatus');
  }

  providerCalls(): WireEntry[] {
    return this.wireLog.filter((entry) => entry.kind === 'provider');
  }

  /** Progress placeholder posts (plain-text `chat.postMessage`, i.e. no markdown blocks). */
  progressPosts(): WireEntry[] {
    return this.callsOfMethod('chat.postMessage').filter((entry) => !isMarkdownPost(entry.body));
  }

  /**
   * The finals delivered on the wire. A stream final is a `chat.startStream`
   * carrying `markdown_text` paired with a subsequent `chat.stopStream`; a
   * post final is a markdown `chat.postMessage`. Progress posts are excluded.
   */
  finals(): FinalOnWire[] {
    const finals: FinalOnWire[] = [];
    const pendingStreams: Array<{ entry: WireEntry; index: number }> = [];

    this.wireLog.forEach((entry, index) => {
      if (entry.kind !== 'slack') {
        return;
      }
      if (
        entry.method === 'chat.startStream' &&
        entry.ok !== false &&
        hasText(entry.body.markdown_text)
      ) {
        pendingStreams.push({ entry, index });
      } else if (entry.method === 'chat.stopStream') {
        // Deliberately NOT gated on `entry.ok`: S18 fails the first
        // chat.stopStream call ({ ok:false, error:'timeout' }) and still
        // expects that stream counted as one delivered final (the markdown
        // content already reached the channel via startStream; a stopStream
        // failure is a finalization-signal hiccup, not a lost delivery).
        // Filtering this branch on `ok` would make S18 see zero finals.
        const start = pendingStreams.shift();
        if (start) {
          finals.push({
            channel: String(start.entry.body.channel ?? ''),
            threadTs: String(start.entry.body.thread_ts ?? ''),
            text: String(start.entry.body.markdown_text ?? ''),
            index: start.index,
          });
        }
      } else if (
        entry.method === 'chat.postMessage' &&
        entry.ok !== false &&
        isMarkdownPost(entry.body)
      ) {
        finals.push({
          channel: String(entry.body.channel ?? ''),
          threadTs: String(entry.body.thread_ts ?? ''),
          text: postText(entry.body),
          index,
        });
      }
    });

    return finals;
  }

  /**
   * Reconfigure behavior knobs at runtime (HTTP-transport lanes reuse one
   * backend across scenarios). Merges the same shape as the constructor config.
   */
  configure(config: FakeSlackBackendConfig): void {
    if (config.slack) {
      if (config.slack.rejectSetStatus !== undefined) {
        this.rejectSetStatus = config.slack.rejectSetStatus;
      }
      if (config.slack.rejectStartStream !== undefined) {
        this.rejectStartStream = config.slack.rejectStartStream;
      }
      if (config.slack.failStopStreamOnce !== undefined) {
        this.failStopStreamOnce = config.slack.failStopStreamOnce;
      }
      if (config.slack.failConversationReads !== undefined) {
        this.failConversationReads = config.slack.failConversationReads;
      }
      if (config.slack.failFinalDeliveryOnce !== undefined) {
        this.failFinalDeliveryOnce = config.slack.failFinalDeliveryOnce;
      }
      if (config.slack.identity !== undefined) {
        this.identity = { ...this.identity, ...config.slack.identity };
      }
    }
    if (config.provider) {
      if (config.provider.mode !== undefined) {
        this.providerMode = config.provider.mode;
      }
      if (config.provider.replyText !== undefined) {
        this.replyText = config.provider.replyText;
      }
      if (config.provider.toolChannelId !== undefined) {
        this.toolChannelId = config.provider.toolChannelId;
      }
      if (config.provider.delayMs !== undefined) {
        this.providerDelayMs = config.provider.delayMs;
      }
    }
  }

  /** Clear the wire log and per-turn counters (keeps behavior config). */
  reset(): void {
    this.wireLog.length = 0;
    this.tsCounter = 0;
    this.stopStreamCalls = 0;
    this.finalStreamFailedOnce = false;
    this.finalPostFailedOnce = false;
  }

  private route(url: string, bodyString: string): RouteResult {
    const pathname = url.startsWith('http') ? new URL(url).pathname : (url.split('?')[0] ?? url);

    // Control surface (never recorded to the wire log): reconfigure or reset the
    // backend between HTTP-transport scenarios.
    if (pathname === '/__config') {
      this.configure(decodeWireBody(bodyString) as FakeSlackBackendConfig);
      return { status: 200, body: { ok: true } };
    }
    if (pathname === '/__reset') {
      this.reset();
      return { status: 200, body: { ok: true } };
    }

    const apiIndex = pathname.indexOf('/api/');
    const isSlack = apiIndex >= 0;
    // OpenAI-completions surface for the Flue `local-stub` and
    // `cloudflare-workers-ai` providers. The official OpenAI SDK posts to
    // `<base>/chat/completions` and streams SSE.
    const isOpenAiCompletions = !isSlack && pathname.endsWith('/chat/completions');
    // Anthropic-messages surface (Stage 4, part b). The official Anthropic SDK
    // posts to `<base>/v1/messages` and pi-ai parses the SSE event stream.
    const isAnthropicMessages = !isSlack && pathname.endsWith('/v1/messages');
    const method = isSlack
      ? pathname.slice(apiIndex + '/api/'.length)
      : isOpenAiCompletions
        ? 'chat/completions'
        : isAnthropicMessages
          ? 'messages'
          : 'provider.run';
    const body = decodeWireBody(bodyString);

    const entry: WireEntry = { kind: isSlack ? 'slack' : 'provider', method, url, body };
    this.wireLog.push(entry);

    if (!isSlack) {
      if (isOpenAiCompletions) {
        return this.openAiCompletionsResponse(body);
      }
      if (isAnthropicMessages) {
        return this.anthropicMessagesResponse();
      }
      return this.providerResponse();
    }
    const slackBody = this.slackResponse(method, body);
    // Record the outcome so `finals()` can tell a delivered final from one the
    // fake rejected (a rejected `{ ok:false }` makes the real WebClient throw).
    entry.ok = slackBody.ok !== false;
    return { status: 200, body: slackBody };
  }

  private slackResponse(method: string, body: Record<string, unknown>): Record<string, unknown> {
    switch (method) {
      case 'assistant.threads.setStatus': {
        if (this.rejectSetStatus) {
          return { ok: false, error: 'missing_scope' };
        }
        // Real Slack rejects a loading_messages entry of 51+ characters; mirror
        // that so an over-long status is caught by the parity suite, not only in
        // production (where the rejection trips the presenter's status latch).
        const loadingMessages = Array.isArray(body.loading_messages) ? body.loading_messages : [];
        if (loadingMessages.some((message) => typeof message === 'string' && message.length > 50)) {
          return { ok: false, error: 'invalid_arguments' };
        }
        return { ok: true };
      }
      case 'chat.postMessage':
        // Fail only the FIRST markdown (final) post under failFinalDeliveryOnce;
        // plain progress posts and later finals go through.
        if (this.failFinalDeliveryOnce && isMarkdownPost(body) && !this.finalPostFailedOnce) {
          this.finalPostFailedOnce = true;
          return { ok: false, error: 'internal_error' };
        }
        return { ok: true, ts: this.nextTs() };
      case 'chat.startStream':
        if (this.rejectStartStream) {
          return { ok: false, error: 'missing_scope' };
        }
        if (this.failFinalDeliveryOnce && !this.finalStreamFailedOnce) {
          this.finalStreamFailedOnce = true;
          return { ok: false, error: 'internal_error' };
        }
        return { ok: true, channel: body.channel, ts: this.nextTs() };
      case 'chat.stopStream':
        if (this.failStopStreamOnce && this.stopStreamCalls === 0) {
          this.stopStreamCalls += 1;
          return { ok: false, error: 'timeout' };
        }
        this.stopStreamCalls += 1;
        return { ok: true };
      case 'conversations.replies':
        return this.failConversationReads
          ? { ok: false, error: 'internal_error' }
          : this.repliesResponse(body);
      case 'conversations.history':
        return this.failConversationReads
          ? { ok: false, error: 'internal_error' }
          : { ok: true, messages: this.historyMessages };
      case 'auth.test':
        return { ok: true, user_id: this.identity.botUserId, app_id: this.identity.appId };
      case 'users.info':
        return {
          ok: true,
          user: {
            id: body.user,
            name: this.identity.displayName,
            profile: {
              display_name: this.identity.displayName,
              real_name: this.identity.realName,
              image_512: this.identity.image512Url,
              image_72: this.identity.image72Url,
            },
          },
        };
      default:
        return { ok: true };
    }
  }

  private repliesResponse(body: Record<string, unknown>): Record<string, unknown> {
    const cursor = body.cursor ? String(body.cursor) : undefined;
    const index = cursor ? (this.cursorToIndex.get(cursor) ?? 0) : 0;
    const page = this.repliesPages[index] ?? { messages: [] };
    return {
      ok: true,
      messages: page.messages,
      ...(page.next_cursor ? { response_metadata: { next_cursor: page.next_cursor } } : {}),
    };
  }

  private providerResponse(): RouteResult {
    if (this.providerMode === 'http_500') {
      return {
        status: 500,
        body: {
          success: false,
          errors: [{ message: `${RAW_PROVIDER_ERROR_MARKER} upstream failure`, code: 500 }],
          result: { response: RAW_PROVIDER_ERROR_MARKER },
        },
      };
    }
    return {
      status: 200,
      body: { success: true, result: { response: this.replyText } },
    };
  }

  /**
   * OpenAI chat-completions streaming response. The Flue `local-stub` and
   * `cloudflare-workers-ai` providers use the official OpenAI SDK with
   * `stream: true`, so the reply is delivered as `text/event-stream` chunks
   * terminated by `data: [DONE]`.
   *
   * When the request messages carry a scripted tool trigger (Stage 4, part c),
   * the first response emits a `lookup_channel_brief` tool call and the second
   * (once the tool result is in the messages) emits a final echoing the result.
   */
  private openAiCompletionsResponse(body: Record<string, unknown>): RouteResult {
    if (this.providerMode === 'http_500') {
      return {
        status: 500,
        contentType: 'application/json',
        rawBody: JSON.stringify({
          error: {
            message: `${RAW_PROVIDER_ERROR_MARKER} upstream failure`,
            type: 'server_error',
            code: 500,
          },
        }),
      };
    }

    const scripted = this.scriptedToolResponse(body);
    if (scripted) {
      return scripted;
    }
    return this.openAiTextStream(this.replyText);
  }

  /**
   * If the conversation carries a scripted tool trigger, drive the two-step
   * tool loop; otherwise return null so the caller emits a plain text reply.
   */
  private scriptedToolResponse(body: Record<string, unknown>): RouteResult | null {
    const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
    const conversationText = messages.map((message) => messageText(message)).join('\n');
    if (!conversationText.includes(TOOL_TRIGGER)) {
      return null;
    }

    const toolResults = messages.filter((message) => message?.role === 'tool');
    if (toolResults.length > 0) {
      // Second call: the tool result is back. Echo it into the final so the
      // wire shows the brief (allowed) or the honest denial (forbidden) — never
      // a model-fabricated answer.
      const relayed = toolResults.map((message) => messageText(message)).join('\n');
      return this.openAiTextStream(`Channel brief lookup complete. Tool result: ${relayed}`);
    }

    // First call: emit a tool call. The forbidden trigger targets a channel the
    // agent is not assigned to, so the app-enforced scope denies it.
    const channelId = conversationText.includes(TOOL_TRIGGER_FORBIDDEN)
      ? FORBIDDEN_TOOL_CHANNEL
      : this.toolChannelId;
    return this.openAiToolCallStream('lookup_channel_brief', { channelId });
  }

  /** OpenAI SSE stream carrying a single assistant text block. */
  private openAiTextStream(text: string): RouteResult {
    return { status: 200, contentType: 'text/event-stream', rawBody: openAiTextStreamBody(text) };
  }

  /** OpenAI SSE stream carrying a single function tool call. */
  private openAiToolCallStream(name: string, args: Record<string, unknown>): RouteResult {
    const base = { id: 'chatcmpl-parity', object: 'chat.completion.chunk', created: 0, model: 'parity-stub' };
    const chunks: Record<string, unknown>[] = [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_stub_1',
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    const rawBody = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
    return { status: 200, contentType: 'text/event-stream', rawBody };
  }

  /**
   * Anthropic-messages streaming response (Stage 4, part b). pi-ai's anthropic
   * client posts to `<base>/v1/messages` and parses the SSE event stream
   * (`message_start` → `content_block_*` → `message_delta` → `message_stop`).
   * Text-only; the tool loop runs through the openai-completions surface.
   */
  private anthropicMessagesResponse(): RouteResult {
    if (this.providerMode === 'http_500') {
      return {
        status: 500,
        contentType: 'application/json',
        rawBody: JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `${RAW_PROVIDER_ERROR_MARKER} upstream failure` },
        }),
      };
    }

    const events: Array<[string, Record<string, unknown>]> = [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'anthropic-stub',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: this.replyText } },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      ],
      ['message_stop', { type: 'message_stop' }],
    ];
    const rawBody = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    return { status: 200, contentType: 'text/event-stream', rawBody };
  }

  /**
   * Slow openai-completions turn: hold the SSE response open for
   * `providerDelayMs` before emitting the reply content, keeping the connection
   * alive with immediate + periodic keepalive comments so workerd/miniflare
   * does not reset an idle stream. Returns true if it took over the response.
   * Only plain replies are delayed (a scripted tool trigger stays synchronous).
   */
  private tryStreamDelayedProvider(url: string, bodyString: string, res: ServerResponse): boolean {
    const pathname = url.startsWith('http') ? new URL(url).pathname : (url.split('?')[0] ?? url);
    if (!pathname.endsWith('/chat/completions')) return false;
    if (this.providerMode !== 'ok' || this.providerDelayMs <= 0) return false;
    const body = decodeWireBody(bodyString);
    const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
    if (messages.map((message) => messageText(message)).join('\n').includes(TOOL_TRIGGER)) {
      return false;
    }

    this.wireLog.push({ kind: 'provider', method: 'chat/completions', url, body });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': keepalive\n\n');
    const keepalive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, 2000);
    const content = openAiTextStreamBody(this.replyText);
    setTimeout(() => {
      clearInterval(keepalive);
      if (res.writableEnded) return;
      res.write(content);
      res.end();
    }, this.providerDelayMs);
    return true;
  }

  private nextTs(): string {
    this.tsCounter += 1;
    return `1990000000.${String(this.tsCounter).padStart(6, '0')}`;
  }
}

/** The OpenAI SSE body (content chunks + [DONE]) for a single text reply. */
function openAiTextStreamBody(text: string): string {
  const base = { id: 'chatcmpl-parity', object: 'chat.completion.chunk', created: 0, model: 'parity-stub' };
  const chunks: Record<string, unknown>[] = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

export function isMarkdownPost(body: Record<string, unknown>): boolean {
  return Array.isArray(body.blocks) && body.blocks.length > 0;
}

function postText(body: Record<string, unknown>): string {
  if (Array.isArray(body.blocks) && body.blocks.length > 0) {
    const first = body.blocks[0] as { text?: unknown };
    if (first && typeof first.text === 'string') {
      return first.text;
    }
  }
  return String(body.text ?? '');
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Flatten an OpenAI-style chat message's textual content (string or blocks). */
function messageText(message: Record<string, unknown>): string {
  if (!message || typeof message !== 'object') {
    return '';
  }
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '',
      )
      .join('\n');
  }
  return '';
}

function decodeWireBody(raw: string): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(
    Array.from(new URLSearchParams(raw).entries()).map(([key, value]) => [
      key,
      coerceFormValue(value),
    ]),
  );
}

function coerceFormValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  // Slack Web API clients form-encode complex arguments (e.g. `blocks`,
  // `loading_messages`) as JSON strings; real Slack parses them back. Mirror
  // that so `isMarkdownPost` sees `blocks` as an array under form transport.
  const trimmed = value.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Not actually JSON — fall through to the raw string.
    }
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
