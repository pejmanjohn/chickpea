import type { GatewayDeploymentClient, GatewayLogicalSession } from './client.ts';
import type { GatewayInboundDelivery } from './protocol.ts';
import {
  GATEWAY_HEARTBEAT_TIMEOUT_MS,
  gatewaySessionHealthy,
} from './session.ts';

export interface GatewaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
}

export interface GatewaySessionRunnerOptions {
  client: GatewayDeploymentClient;
  onEvent(delivery: GatewayInboundDelivery): Promise<'accepted' | 'duplicate' | 'rejected'>;
  createSocket?: (url: string) => GatewaySocket;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Keeps exactly one renewable, credential-free delivery socket per process. */
export class GatewaySessionRunner {
  private socket: GatewaySocket | undefined;
  private session: GatewayLogicalSession | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<GatewaySessionRunnerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<GatewaySessionRunnerOptions['clearTimer']>;

  constructor(private readonly options: GatewaySessionRunnerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  async start(): Promise<boolean> {
    this.stopped = false;
    const [binding, prior] = await Promise.all([
      this.options.client.loadBinding(),
      this.options.client.loadSessionCheckpoint(),
    ]);
    if (!binding) {
      this.stopped = true;
      return false;
    }
    const connecting = { health: 'connecting' as const, attempt: prior?.attempt ?? 0 };
    await this.options.client.recordSessionCheckpoint(connecting);
    this.clearScheduled();
    this.clearHeartbeat();
    let socket: GatewaySocket | undefined;
    const session = await this.options.client.createSession(
      (frame) => {
        if (this.socket === socket && socket?.readyState === 1) {
          socket.send(JSON.stringify(frame));
        }
      },
      this.options.onEvent,
      connecting,
    );
    const connectedSocket = (this.options.createSocket ?? defaultSocket)(binding.sessionUrl);
    socket = connectedSocket;
    this.socket = connectedSocket;
    this.session = session;
    connectedSocket.addEventListener('open', () => {
      if (this.socket !== connectedSocket || this.stopped) return;
      void session.hello().catch(() => this.reconnect(connectedSocket, 'hello_failed'));
    });
    connectedSocket.addEventListener('message', (event) => {
      if (this.socket !== connectedSocket || this.stopped) return;
      const raw = typeof event.data === 'string' ? event.data : '';
      void session.handle(raw).then(() => {
        void this.options.client.recordSessionCheckpoint(session.state());
        const rotateAt = session.state().rotateAt;
        if (rotateAt) this.schedule(() => connectedSocket.close(1000, 'rotate'), rotateAt - this.now());
        this.scheduleHeartbeat(connectedSocket, session);
      }).catch(() => this.reconnect(connectedSocket, 'invalid_frame'));
    });
    connectedSocket.addEventListener('close', () => this.reconnect(connectedSocket, 'closed'));
    connectedSocket.addEventListener('error', () => this.reconnect(connectedSocket, 'network'));
    // A completed WebSocket upgrade is not a usable session until the gateway
    // authenticates it with session.ready. Cover the half-open-before-first-
    // frame case instead of waiting forever for heartbeat state that does not
    // exist yet.
    this.schedule(
      () => this.reconnect(connectedSocket, 'ready_timeout'),
      GATEWAY_HEARTBEAT_TIMEOUT_MS,
    );
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.clearScheduled();
    this.clearHeartbeat();
    this.socket?.close(1000, 'shutdown');
    this.socket = undefined;
    this.session = undefined;
  }

  state(): ReturnType<GatewayLogicalSession['state']> | undefined {
    return this.session?.state();
  }

  private reconnect(socket: GatewaySocket, reason: string): void {
    if (this.stopped || this.socket !== socket) return;
    this.socket = undefined;
    this.clearHeartbeat();
    try {
      socket.close(1012, 'reconnect');
    } catch {
      // Already closed.
    }
    const checkpoint = this.session?.close(reason);
    if (checkpoint) void this.options.client.recordSessionCheckpoint(checkpoint);
    this.session = undefined;
    const delay = Math.max(0, (checkpoint?.retryAt ?? this.now() + 1_000) - this.now());
    this.schedule(() => void this.start().catch(() => this.scheduleRetry()), delay);
  }

  private scheduleRetry(): void {
    if (!this.stopped) this.schedule(() => void this.start().catch(() => this.scheduleRetry()), 5_000);
  }

  private schedule(callback: () => void, delayMs: number): void {
    this.clearScheduled();
    this.timer = this.setTimer(callback, Math.max(0, delayMs));
  }

  private clearScheduled(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private scheduleHeartbeat(socket: GatewaySocket, session: GatewayLogicalSession): void {
    this.clearHeartbeat();
    const lastHeartbeatAt = session.state().lastHeartbeatAt;
    if (lastHeartbeatAt === undefined) return;
    const delay = Math.max(0, lastHeartbeatAt + GATEWAY_HEARTBEAT_TIMEOUT_MS - this.now());
    this.heartbeatTimer = this.setTimer(() => {
      if (this.stopped || this.socket !== socket) return;
      if (!gatewaySessionHealthy(session.state(), this.now())) {
        this.reconnect(socket, 'heartbeat_timeout');
        return;
      }
      this.scheduleHeartbeat(socket, session);
    }, delay);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) this.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}

function defaultSocket(url: string): GatewaySocket {
  if (typeof WebSocket !== 'function') {
    throw new Error('This runtime does not provide outbound WebSockets.');
  }
  return new WebSocket(url) as unknown as GatewaySocket;
}
