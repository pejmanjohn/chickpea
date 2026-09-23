/**
 * Transport-agnostic Chrome DevTools Protocol client.
 *
 * Works over any WebSocket-like object (workerd WebSocket, Node's global
 * WebSocket, or an in-memory fake in tests).
 */

export interface CdpSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message' | 'close' | 'error', listener: (event: any) => void): void;
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export class CdpError extends Error {
  constructor(message: string, readonly method: string, readonly code?: number) {
    super(message);
    this.name = 'CdpError';
  }
}

interface WorkerdUpgradeResponse extends Response {
  webSocket?: (CdpSocket & { accept(): void }) | null;
}

/**
 * Opens a CDP WebSocket. On Cloudflare Workers (or wherever there is no global
 * WebSocket constructor) it uses the fetch Upgrade handshake; otherwise the
 * standard WebSocket constructor.
 */
export async function connectCdpSocket(connectUrl: string, options: { fetch?: typeof fetch } = {}): Promise<CdpSocket> {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  const useFetchUpgrade = nav?.userAgent === 'Cloudflare-Workers' || typeof WebSocket === 'undefined';
  if (useFetchUpgrade) {
    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const response = (await doFetch(connectUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'), {
      headers: { Upgrade: 'websocket' },
    })) as WorkerdUpgradeResponse;
    const ws = response.webSocket;
    if (!ws) throw new Error(`Browser connection was refused (HTTP ${response.status})`);
    ws.accept();
    return ws;
  }
  return new Promise<CdpSocket>((resolve, reject) => {
    const ws = new WebSocket(connectUrl);
    const onOpen = () => resolve(ws as unknown as CdpSocket);
    const onError = () => reject(new Error('Browser connection failed'));
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
  });
}

interface PendingCall {
  method: string;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CdpClientOptions {
  defaultTimeoutMs?: number;
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Map<string, Set<(event: CdpEvent) => void>>();
  private closed = false;
  private closeReason = 'Browser connection closed';
  private readonly defaultTimeoutMs: number;

  constructor(private readonly socket: CdpSocket, options: CdpClientOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    socket.addEventListener('message', (event) => this.handleMessage(event));
    socket.addEventListener('close', () => this.handleClose('Browser connection closed'));
    socket.addEventListener('error', () => this.handleClose('Browser connection error'));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs: number = this.defaultTimeoutMs,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError(`${this.closeReason} before ${method}`, method));
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP ${method} timed out after ${timeoutMs}ms`, method));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as PendingCall['resolve'], reject, timer });
      try {
        this.socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`CDP ${method} could not be sent: ${error instanceof Error ? error.message : String(error)}`, method));
      }
    });
  }

  /** Subscribes to an event; returns an unsubscribe function. */
  on(method: string, listener: (event: CdpEvent) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Resolves with the next matching event, or null on timeout, abort, or close. */
  waitForEvent(
    method: string,
    sessionId: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CdpEvent | null> {
    if (this.closed || signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: CdpEvent | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        unsubscribeClose();
        resolve(value);
      };
      const unsubscribe = this.on(method, (event) => {
        if (sessionId === undefined || event.sessionId === sessionId) finish(event);
      });
      const unsubscribeClose = this.on('__close__', () => finish(null));
      const timer = setTimeout(() => finish(null), timeoutMs);
      signal?.addEventListener('abort', () => finish(null), { once: true });
    });
  }

  close(): void {
    if (this.closed) return;
    try {
      this.socket.close(1000, 'done');
    } catch {
      // Ignore close errors; the connection is being discarded.
    }
    this.handleClose('Browser connection closed');
  }

  /**
   * Attaches to the first page target of a browser-level connection and
   * returns the flattened CDP sessionId for page-level commands.
   */
  async attachFirstPage(): Promise<string> {
    const result = await this.send<{ targetInfos?: Array<{ targetId?: string; type?: string }> }>('Target.getTargets');
    const page = (result.targetInfos ?? []).find((target) => target.type === 'page' && typeof target.targetId === 'string');
    if (!page?.targetId) throw new Error('The browser has no open page to attach to');
    const attached = await this.send<{ sessionId?: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    if (!attached.sessionId) throw new Error('Attaching to the browser page did not return a session');
    return attached.sessionId;
  }

  private handleMessage(event: { data?: unknown }): void {
    const raw = event?.data;
    let text: string;
    if (typeof raw === 'string') text = raw;
    else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
    else if (ArrayBuffer.isView(raw)) text = new TextDecoder().decode(raw);
    else return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      const error = message.error as { message?: string; code?: number } | undefined;
      if (error) {
        call.reject(new CdpError(`CDP ${call.method} failed: ${error.message ?? 'unknown error'}`, call.method, error.code));
      } else {
        call.resolve((message.result as Record<string, unknown> | undefined) ?? {});
      }
      return;
    }
    if (typeof message.method === 'string') {
      const cdpEvent: CdpEvent = {
        method: message.method,
        params: (message.params as Record<string, unknown> | undefined) ?? {},
      };
      if (typeof message.sessionId === 'string') cdpEvent.sessionId = message.sessionId;
      this.emit(cdpEvent.method, cdpEvent);
    }
  }

  private emit(method: string, event: CdpEvent): void {
    const set = this.listeners.get(method);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // Listener failures must not break the message loop.
      }
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      this.pending.delete(id);
      call.reject(new CdpError(`${reason} during ${call.method}`, call.method));
    }
    this.emit('__close__', { method: '__close__', params: {} });
  }
}
