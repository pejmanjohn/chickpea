import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
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
export const FAKE_PROVIDER_KEYS = {
  anthropic: 'anthropic-valid-key',
  openai: 'openai-valid-key',
  openrouter: 'openrouter-valid-key',
} as const;

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
  /** Channels served by conversations.list / conversations.info. */
  channels?: FakeSlackChannel[];
  /** Page size for conversations.list cursor pagination (default 100). */
  conversationsListPageSize?: number;
  /**
   * Force `conversations.join` to answer `{ ok:false, error }` (e.g.
   * `missing_scope` for installs that predate the `channels:join` scope). When
   * unset, a join of a known public channel succeeds and flips its membership.
   */
  conversationsJoinError?: string;
}

export interface FakeSlackIdentityConfig {
  appId?: string;
  botUserId?: string;
  teamId?: string;
  teamName?: string;
  displayName?: string;
  realName?: string;
  image512Url?: string;
  image72Url?: string;
}

/** A channel the fake exposes via conversations.list / conversations.info. */
export interface FakeSlackChannel {
  id: string;
  name: string;
  isPrivate?: boolean;
  isMember?: boolean;
}

export interface FakeProviderConfig {
  mode: 'ok' | 'http_500';
  replyText?: string;
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
      // toContextMessages and is excluded ONLY by its `bot_id` filter — the
      // row S07 asserts must never reach the provider.
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
  private providerDelayMs: number;
  private channels: FakeSlackChannel[];
  private conversationsListPageSize: number;
  private conversationsJoinError: string | undefined;
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
      teamId: slack.identity?.teamId ?? 'T_FAKE',
      teamName: slack.identity?.teamName ?? 'Fake Workspace',
      displayName: slack.identity?.displayName ?? 'Tag',
      realName: slack.identity?.realName ?? 'Tag',
      image512Url: slack.identity?.image512Url ?? 'https://avatars.slack-edge.com/fake/flue_512.png',
      image72Url: slack.identity?.image72Url ?? 'https://avatars.slack-edge.com/fake/flue_72.png',
    };
    this.repliesPages = slack.repliesPages ?? DEFAULT_REPLIES_PAGES;
    this.historyMessages = slack.historyMessages ?? DEFAULT_HISTORY_MESSAGES;
    this.channels = slack.channels ?? [];
    this.conversationsListPageSize = slack.conversationsListPageSize ?? 100;
    this.conversationsJoinError = slack.conversationsJoinError;
    this.providerMode = config.provider?.mode ?? 'ok';
    this.replyText = config.provider?.replyText ?? STUB_REPLY_MARKER;
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
      const request = input instanceof Request ? input : new Request(input, init);
      const result = this.route(request.url, await request.clone().text(), headersObject(request.headers));
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
        const result = this.route(req.url ?? '/', bodyString, normalizeNodeHeaders(req.headers));
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
      if (config.slack.channels !== undefined) {
        this.channels = config.slack.channels;
      }
      if (config.slack.conversationsListPageSize !== undefined) {
        this.conversationsListPageSize = config.slack.conversationsListPageSize;
      }
      if (config.slack.conversationsJoinError !== undefined) {
        this.conversationsJoinError = config.slack.conversationsJoinError;
      }
    }
    if (config.provider) {
      if (config.provider.mode !== undefined) {
        this.providerMode = config.provider.mode;
      }
      if (config.provider.replyText !== undefined) {
        this.replyText = config.provider.replyText;
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

  private route(
    url: string,
    bodyString: string,
    headers: Record<string, string> = {},
  ): RouteResult {
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
    // Anthropic-messages surface. The official Anthropic SDK
    // posts to `<base>/v1/messages` and pi-ai parses the SSE event stream.
    const isAnthropicMessages = !isSlack && pathname.endsWith('/v1/messages');
    let method: string;
    if (isSlack) {
      method = pathname.slice(apiIndex + '/api/'.length);
    } else if (isOpenAiCompletions) {
      method = 'chat/completions';
    } else if (isAnthropicMessages) {
      method = 'messages';
    } else if (this.isProviderModelsPath(pathname)) {
      method = 'models';
    } else if (this.isOpenRouterAuthPath(pathname)) {
      method = 'auth/key';
    } else {
      method = 'provider.run';
    }
    const body = decodeWireBody(bodyString);

    const entry: WireEntry = { kind: isSlack ? 'slack' : 'provider', method, url, body };
    this.wireLog.push(entry);

    if (!isSlack) {
      const providerAdmin = this.providerAdminResponse(pathname, headers);
      if (providerAdmin) {
        return providerAdmin;
      }
      if (isOpenAiCompletions) {
        return this.openAiCompletionsResponse();
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

  private providerAdminResponse(
    pathname: string,
    headers: Record<string, string>,
  ): RouteResult | null {
    if (pathname === '/v1/models') {
      return this.anthropicModelsResponse(headers);
    }
    if (pathname === '/openai/v1/models') {
      return this.openAiModelsResponse(headers);
    }
    if (pathname === '/openrouter/auth/key') {
      return this.openRouterAuthResponse(headers);
    }
    if (pathname === '/openrouter/models') {
      return this.openRouterModelsResponse();
    }
    if (pathname.endsWith('/ai/models/search')) {
      return {
        status: 200,
        body: {
          result: [
            { id: '11111111-1111-4111-8111-111111111111', name: '@cf/moonshotai/kimi-k2.6' },
            { id: '22222222-2222-4222-8222-222222222222', name: '@cf/zai-org/glm-5.2' },
          ],
        },
      };
    }
    return null;
  }

  private isProviderModelsPath(pathname: string): boolean {
    return (
      pathname === '/v1/models' ||
      pathname === '/openai/v1/models' ||
      pathname === '/openrouter/models' ||
      pathname.endsWith('/ai/models/search')
    );
  }

  private isOpenRouterAuthPath(pathname: string): boolean {
    return pathname === '/openrouter/auth/key';
  }

  private anthropicModelsResponse(headers: Record<string, string>): RouteResult {
    if (
      headers['x-api-key'] !== FAKE_PROVIDER_KEYS.anthropic ||
      headers['anthropic-version'] !== '2023-06-01'
    ) {
      return {
        status: 401,
        body: {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        },
      };
    }
    return {
      status: 200,
      body: {
        data: [
          { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
          { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
        ],
      },
    };
  }

  private openAiModelsResponse(headers: Record<string, string>): RouteResult {
    if (bearer(headers) !== FAKE_PROVIDER_KEYS.openai) {
      return {
        status: 401,
        body: {
          error: {
            message: 'Incorrect API key provided',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
      };
    }
    return {
      status: 200,
      body: {
        object: 'list',
        data: [
          { id: 'gpt-4.1', object: 'model', owned_by: 'openai' },
          { id: 'text-embedding-3-large', object: 'model', owned_by: 'openai' },
          { id: 'gpt-4.1-mini', object: 'model', owned_by: 'openai' },
          { id: 'whisper-1', object: 'model', owned_by: 'openai' },
        ],
      },
    };
  }

  private openRouterAuthResponse(headers: Record<string, string>): RouteResult {
    if (bearer(headers) !== FAKE_PROVIDER_KEYS.openrouter) {
      return { status: 401, body: { error: { message: 'invalid OpenRouter key' } } };
    }
    return { status: 200, body: { data: { label: 'fake-openrouter-key', usage: 0 } } };
  }

  private openRouterModelsResponse(): RouteResult {
    return {
      status: 200,
      body: {
        data: [
          {
            id: 'anthropic/claude-sonnet-4',
            name: 'Claude Sonnet 4',
            context_length: 200000,
            pricing: { prompt: '0.000003', completion: '0.000015' },
          },
          {
            id: 'meta-llama/llama-3.3-70b-instruct',
            name: 'Llama 3.3 70B Instruct',
            context_length: 131072,
            pricing: { prompt: '0.00000013', completion: '0.0000004' },
          },
        ],
      },
    };
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
        return {
          ok: true,
          user_id: this.identity.botUserId,
          app_id: this.identity.appId,
          team_id: this.identity.teamId,
          team: this.identity.teamName,
        };
      case 'conversations.list':
        return this.conversationsListResponse(body);
      case 'conversations.info': {
        const channelId = String(body.channel ?? '');
        const found = this.channels.find((channel) => channel.id === channelId);
        return found
          ? { ok: true, channel: channelPayload(found) }
          : { ok: false, error: 'channel_not_found' };
      }
      case 'conversations.join': {
        // A configured error (e.g. missing_scope on installs predating the
        // channels:join scope) short-circuits without joining.
        if (this.conversationsJoinError) {
          return { ok: false, error: this.conversationsJoinError };
        }
        const channelId = String(body.channel ?? '');
        const found = this.channels.find((channel) => channel.id === channelId);
        if (!found) {
          return { ok: false, error: 'channel_not_found' };
        }
        // Slack forbids self-joining a private channel.
        if (found.isPrivate) {
          return { ok: false, error: 'method_not_supported_for_channel_type' };
        }
        // Mutate the fixture so a follow-up conversations.info reports membership.
        found.isMember = true;
        return { ok: true, channel: channelPayload(found) };
      }
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

  // Cursor-paginated conversations.list over the configured channel fixture.
  // The cursor is simply the next offset encoded as a string — enough to drive
  // the proxy's multi-page merge deterministically.
  private conversationsListResponse(body: Record<string, unknown>): Record<string, unknown> {
    const pageSize = this.conversationsListPageSize;
    const cursor = body.cursor ? Number(body.cursor) : 0;
    const start = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
    const slice = this.channels.slice(start, start + pageSize);
    const nextIndex = start + pageSize;
    const hasMore = nextIndex < this.channels.length;
    return {
      ok: true,
      channels: slice.map(channelPayload),
      response_metadata: hasMore ? { next_cursor: String(nextIndex) } : {},
    };
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
   */
  private openAiCompletionsResponse(): RouteResult {
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

    return this.openAiTextStream(this.replyText);
  }

  /** OpenAI SSE stream carrying a single assistant text block. */
  private openAiTextStream(text: string): RouteResult {
    return { status: 200, contentType: 'text/event-stream', rawBody: openAiTextStreamBody(text) };
  }

  /**
   * Anthropic-messages streaming response. pi-ai's anthropic
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
   */
  private tryStreamDelayedProvider(url: string, bodyString: string, res: ServerResponse): boolean {
    const pathname = url.startsWith('http') ? new URL(url).pathname : (url.split('?')[0] ?? url);
    if (!pathname.endsWith('/chat/completions')) return false;
    if (this.providerMode !== 'ok' || this.providerDelayMs <= 0) return false;
    const body = decodeWireBody(bodyString);

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

/** Raw Slack conversation object shape (subset the proxy reads). */
function channelPayload(channel: FakeSlackChannel): Record<string, unknown> {
  return {
    id: channel.id,
    name: channel.name,
    is_private: channel.isPrivate ?? false,
    is_member: channel.isMember ?? false,
    is_archived: false,
  };
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

function headersObject(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
}

function normalizeNodeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      normalized[key.toLowerCase()] = value.join(', ');
    } else if (value !== undefined) {
      normalized[key.toLowerCase()] = value;
    }
  }
  return normalized;
}

function bearer(headers: Record<string, string>): string | undefined {
  const match = headers.authorization?.match(/^Bearer (.+)$/);
  return match?.[1];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
