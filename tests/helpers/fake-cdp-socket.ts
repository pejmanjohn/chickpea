import type { CdpSocket } from '../../src/browser/cdp.ts';
import type { BrowserProvider } from '../../src/browser/provider.ts';

export interface SentCdpMessage {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export type CdpResponder = (message: SentCdpMessage) =>
  | { result?: Record<string, unknown>; error?: { code: number; message: string }; noReply?: boolean }
  | undefined;

/**
 * An in-memory CDP WebSocket. Each sent command is answered on a microtask
 * by the responder registered for its method (an empty result by default);
 * tests push events and closes through the dispatch helpers.
 */
export class FakeCdpSocket implements CdpSocket {
  readonly sent: SentCdpMessage[] = [];
  /** Sent methods and emitted events (`event:<method>`), in order. */
  readonly log: string[] = [];
  readonly responders = new Map<string, CdpResponder>();
  closedWith: { code?: number | undefined; reason?: string | undefined } | null = null;
  private readonly handlers: Record<string, Array<(event: any) => void>> = { message: [], close: [], error: [] };

  /** A browser-level socket with one page target that attaches as `pageSessionId`. */
  static withPage(pageSessionId = 'page-1'): FakeCdpSocket {
    const socket = new FakeCdpSocket();
    socket.responders.set('Target.getTargets', () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page' }] } }));
    socket.responders.set('Target.attachToTarget', () => ({ result: { sessionId: pageSessionId } }));
    return socket;
  }

  get closed(): boolean {
    return this.closedWith !== null;
  }

  addEventListener(type: 'message' | 'close' | 'error', listener: (event: any) => void): void {
    this.handlers[type]!.push(listener);
  }

  send(data: string): void {
    const message = JSON.parse(data) as SentCdpMessage;
    this.sent.push(message);
    this.log.push(message.method);
    const reply = this.responders.get(message.method)?.(message) ?? {};
    if (reply.noReply) return;
    queueMicrotask(() => {
      const payload: Record<string, unknown> = { id: message.id };
      if (message.sessionId) payload.sessionId = message.sessionId;
      if (reply.error) payload.error = reply.error;
      else payload.result = reply.result ?? {};
      this.deliver(payload);
    });
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.dispatch('close', {});
  }

  methods(): string[] {
    return this.sent.map((message) => message.method);
  }

  deliver(payload: unknown): void {
    this.dispatch('message', { data: JSON.stringify(payload) });
  }

  emitEvent(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    this.log.push(`event:${method}`);
    this.deliver(sessionId ? { method, params, sessionId } : { method, params });
  }

  /** The remote end closed the connection. */
  remoteClose(): void {
    this.dispatch('close', {});
  }

  private dispatch(type: string, event: unknown): void {
    for (const handler of this.handlers[type] ?? []) handler(event);
  }
}

/**
 * A BrowserProvider whose sessions are numbered `sess-1`, `sess-2`, ... and
 * whose recordings are always ready. Override any method per test.
 */
export function fakeBrowserProvider(overrides: Partial<BrowserProvider> = {}) {
  const created: Parameters<BrowserProvider['createSession']>[0][] = [];
  const ended: string[] = [];
  let counter = 0;
  const provider: BrowserProvider = {
    id: 'browserbase',
    async createSession(options) {
      created.push(options);
      counter += 1;
      return { id: `sess-${counter}`, connectUrl: `wss://connect.example/?signingKey=secret-${counter}` };
    },
    async endSession(sessionId) {
      ended.push(sessionId);
    },
    async sessionStatus() {
      return 'COMPLETED';
    },
    async liveView() {
      return { fullscreenUrl: '', url: '', pages: [] };
    },
    async requestRecordingDownloads() {},
    async listRecordingDownloads() {
      return [];
    },
    async createContext() {
      return { id: 'ctx' };
    },
    ...overrides,
  };
  return { provider, created, ended };
}

/** A fetch that records each call and answers with `respond`. */
export function fakeFetch(respond: (call: FakeFetchCall) => Response | Promise<Response>) {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FakeFetchCall = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

export interface FakeFetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
