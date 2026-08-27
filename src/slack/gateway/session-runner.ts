import type { GatewayDeploymentClient, GatewayLogicalSession } from './client.ts';
import type { GatewayInboundDelivery } from './protocol.ts';
import type { GatewaySessionCapability } from './protocol.ts';
import {
  GATEWAY_HEARTBEAT_TIMEOUT_MS,
  gatewaySessionHealthy,
  type GatewaySessionCheckpoint,
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
  capabilities?: readonly GatewaySessionCapability[];
  waitUntil?: (promise: Promise<unknown>) => void;
}

export type GatewaySessionRunnerPhase =
  | 'stopped'
  | 'starting'
  | 'connecting'
  | 'retrying'
  | 'healthy'
  | 'needs_attention'
  | 'stale';

export type GatewaySessionScheduledAction = 'ready_timeout' | 'rotate' | 'retry';

export interface GatewaySessionRunnerHealthSnapshot {
  generation: number;
  phase: GatewaySessionRunnerPhase;
  healthy: boolean;
  shouldReplace: boolean;
  reason?: string;
  socketState?: number;
  checkpoint?: GatewaySessionCheckpoint;
  scheduledAction?: GatewaySessionScheduledAction;
  scheduledAt?: number;
}

export interface GatewaySessionRunnerHealthInput {
  generation: number;
  stopped: boolean;
  starting: boolean;
  now: number;
  socketState?: number;
  checkpoint?: GatewaySessionCheckpoint;
  scheduledAction?: GatewaySessionScheduledAction;
  scheduledAt?: number;
}

export interface GatewaySessionStatusSnapshot {
  healthy: boolean;
  phase: GatewaySessionRunnerPhase | 'offline';
  detail: 'gateway_session_offline' | 'gateway_session_stale_version' | null;
  generation: number | null;
  /** Absent only while interoperating with a pre-version-metadata deployment. */
  versionId?: string | null;
}

export interface GatewaySessionRunnerControl {
  start(): Promise<boolean>;
  stop(): void;
  healthSnapshot(): GatewaySessionRunnerHealthSnapshot;
}

export function classifyGatewaySessionRunnerHealth(
  input: GatewaySessionRunnerHealthInput,
): GatewaySessionRunnerHealthSnapshot {
  const base = {
    generation: input.generation,
    ...(input.socketState !== undefined ? { socketState: input.socketState } : {}),
    ...(input.checkpoint ? { checkpoint: { ...input.checkpoint } } : {}),
    ...(input.scheduledAction ? { scheduledAction: input.scheduledAction } : {}),
    ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
  };
  const result = (
    phase: GatewaySessionRunnerPhase,
    healthy: boolean,
    shouldReplace: boolean,
    reason?: string,
  ): GatewaySessionRunnerHealthSnapshot => ({
    ...base,
    phase,
    healthy,
    shouldReplace,
    ...(reason ? { reason } : {}),
  });

  if (input.stopped) return result('stopped', false, true, 'stopped');
  if (input.starting) return result('starting', false, false);
  if (input.socketState !== undefined && input.socketState >= 2) {
    return result('stale', false, true, 'socket_closed');
  }
  if (input.checkpoint?.health === 'needs_attention') {
    return result('needs_attention', false, false, input.checkpoint.reason);
  }
  if (input.scheduledAction === 'retry') {
    return input.scheduledAt !== undefined && input.scheduledAt > input.now
      ? result('retrying', false, false)
      : result('stale', false, true, 'retry_expired');
  }
  if (input.checkpoint?.health === 'healthy') {
    if (input.socketState !== 1) {
      return result('stale', false, true, 'socket_unavailable');
    }
    if (
      input.checkpoint.lastHeartbeatAt === undefined ||
      input.checkpoint.lastHeartbeatAt <= input.now - GATEWAY_HEARTBEAT_TIMEOUT_MS
    ) {
      return result('stale', false, true, 'heartbeat_expired');
    }
    if (input.checkpoint.rotateAt === undefined || input.checkpoint.rotateAt <= input.now) {
      return result('stale', false, true, 'rotation_expired');
    }
    return result('healthy', true, false);
  }
  if (
    input.checkpoint?.health === 'connecting' &&
    (input.socketState === 0 || input.socketState === 1) &&
    input.scheduledAction === 'ready_timeout' &&
    input.scheduledAt !== undefined &&
    input.scheduledAt > input.now
  ) {
    return result('connecting', false, false);
  }
  return result('stale', false, true, 'session_unavailable');
}

export function reconcileGatewaySessionStatus(
  live: GatewaySessionRunnerHealthSnapshot | undefined,
  persisted: GatewaySessionCheckpoint | undefined,
): GatewaySessionStatusSnapshot {
  if (live?.healthy) {
    return {
      healthy: true,
      phase: 'healthy',
      detail: null,
      generation: live.generation,
    };
  }
  return {
    healthy: false,
    phase: live?.phase ?? (persisted?.health === 'needs_attention' ? 'needs_attention' : 'offline'),
    detail: 'gateway_session_offline',
    generation: live?.generation ?? null,
  };
}

/** Owns one runner generation and deduplicates concurrent health repairs. */
export class GatewaySessionRunnerSupervisor {
  private runner: GatewaySessionRunnerControl | undefined;
  private ensurePromise: Promise<GatewaySessionRunnerHealthSnapshot | undefined> | undefined;

  constructor(private readonly createRunner: () => GatewaySessionRunnerControl) {}

  ensureHealthy(): Promise<GatewaySessionRunnerHealthSnapshot | undefined> {
    if (this.ensurePromise) return this.ensurePromise;
    const current = this.runner;
    const snapshot = current?.healthSnapshot();
    if (snapshot && !snapshot.shouldReplace) {
      return Promise.resolve(snapshot);
    }
    const pending = this.replace(current);
    this.ensurePromise = pending;
    void pending.finally(() => {
      if (this.ensurePromise === pending) this.ensurePromise = undefined;
    }).catch(() => undefined);
    return pending;
  }

  async restart(): Promise<GatewaySessionRunnerHealthSnapshot | undefined> {
    if (this.ensurePromise) {
      try {
        await this.ensurePromise;
      } catch {
        // The explicit restart below remains the recovery path.
      }
    }
    this.runner?.stop();
    this.runner = undefined;
    return this.ensureHealthy();
  }

  snapshot(): GatewaySessionRunnerHealthSnapshot | undefined {
    return this.runner?.healthSnapshot();
  }

  private async replace(
    stale: GatewaySessionRunnerControl | undefined,
  ): Promise<GatewaySessionRunnerHealthSnapshot | undefined> {
    stale?.stop();
    const replacement = this.createRunner();
    this.runner = replacement;
    try {
      if (!(await replacement.start())) {
        if (this.runner === replacement) this.runner = undefined;
        return undefined;
      }
      return this.runner === replacement ? replacement.healthSnapshot() : this.runner?.healthSnapshot();
    } catch (error) {
      replacement.stop();
      if (this.runner === replacement) this.runner = undefined;
      throw error;
    }
  }
}

/** Keeps exactly one renewable, credential-free delivery socket per process. */
export class GatewaySessionRunner implements GatewaySessionRunnerControl {
  private socket: GatewaySocket | undefined;
  private session: GatewayLogicalSession | undefined;
  private lastCheckpoint: GatewaySessionCheckpoint | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduledAction: GatewaySessionScheduledAction | undefined;
  private scheduledAt: number | undefined;
  private starting = false;
  private stopped = true;
  private generation = 0;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<GatewaySessionRunnerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<GatewaySessionRunnerOptions['clearTimer']>;

  constructor(private readonly options: GatewaySessionRunnerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  async start(): Promise<boolean> {
    const generation = ++this.generation;
    this.stopped = false;
    this.starting = true;
    this.clearScheduled();
    this.clearHeartbeat();
    this.retireCurrentSocket('restart');
    try {
      const [binding, prior] = await Promise.all([
        this.options.client.loadBinding(),
        this.options.client.loadSessionCheckpoint(),
      ]);
      if (!this.current(generation)) return false;
      if (!binding) {
        this.stopped = true;
        return false;
      }
      const connecting = { health: 'connecting' as const, attempt: prior?.attempt ?? 0 };
      await this.options.client.recordSessionCheckpoint(connecting);
      this.lastCheckpoint = connecting;
      if (!this.current(generation)) return false;
      let socket: GatewaySocket | undefined;
      const session = await this.options.client.createSession(
        (frame) => {
          if (this.current(generation) && this.socket === socket && socket?.readyState === 1) {
            socket.send(JSON.stringify(frame));
          }
        },
        this.options.onEvent,
        connecting,
        this.options.capabilities,
      );
      if (!this.current(generation)) return false;
      const connectedSocket = (this.options.createSocket ?? defaultSocket)(binding.sessionUrl);
      if (!this.current(generation)) {
        this.closeSocket(connectedSocket, 1000, 'superseded');
        return false;
      }
      socket = connectedSocket;
      this.socket = connectedSocket;
      this.session = session;
      let messageChain = Promise.resolve();
      connectedSocket.addEventListener('open', () => {
        if (!this.current(generation) || this.socket !== connectedSocket) return;
        void session.hello().catch(() => this.reconnect(connectedSocket, 'hello_failed'));
      });
      connectedSocket.addEventListener('message', (event) => {
        if (!this.current(generation) || this.socket !== connectedSocket) return;
        const raw = typeof event.data === 'string' ? event.data : '';
        // WebSocket message callbacks are synchronous, while handling an event
        // is async. Preserve gateway delivery order so two same-thread events
        // cannot execute and acknowledge out of order on one logical session.
        messageChain = messageChain.then(async () => {
          if (!this.current(generation) || this.socket !== connectedSocket) return;
          await session.handle(raw);
          if (!this.current(generation) || this.socket !== connectedSocket) return;
          this.lastCheckpoint = session.state();
          await this.options.client.recordSessionCheckpoint(this.lastCheckpoint);
          const rotateAt = this.lastCheckpoint.rotateAt;
          if (rotateAt) {
            this.schedule(
              () => connectedSocket.close(1000, 'rotate'),
              rotateAt - this.now(),
              'rotate',
            );
          }
          this.scheduleHeartbeat(connectedSocket, session);
        }).catch(() => this.reconnect(connectedSocket, 'invalid_frame'));
        this.options.waitUntil?.(messageChain);
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
        'ready_timeout',
      );
      return true;
    } finally {
      if (this.generation === generation) this.starting = false;
    }
  }

  stop(): void {
    this.generation += 1;
    this.stopped = true;
    this.clearScheduled();
    this.clearHeartbeat();
    this.retireCurrentSocket('shutdown');
  }

  state(): ReturnType<GatewayLogicalSession['state']> | undefined {
    return this.session?.state() ?? (this.lastCheckpoint ? { ...this.lastCheckpoint } : undefined);
  }

  healthSnapshot(): GatewaySessionRunnerHealthSnapshot {
    const checkpoint = this.state();
    return classifyGatewaySessionRunnerHealth({
      generation: this.generation,
      stopped: this.stopped,
      starting: this.starting,
      now: this.now(),
      ...(this.socket ? { socketState: this.socket.readyState } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(this.scheduledAction ? { scheduledAction: this.scheduledAction } : {}),
      ...(this.scheduledAt !== undefined ? { scheduledAt: this.scheduledAt } : {}),
    });
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
    if (checkpoint) {
      this.lastCheckpoint = checkpoint;
      void this.options.client.recordSessionCheckpoint(checkpoint);
    }
    this.session = undefined;
    if (checkpoint?.health === 'needs_attention') return;
    const delay = Math.max(0, (checkpoint?.retryAt ?? this.now() + 1_000) - this.now());
    this.schedule(() => void this.start().catch(() => this.scheduleRetry()), delay, 'retry');
  }

  private current(generation: number): boolean {
    return !this.stopped && this.generation === generation;
  }

  private retireCurrentSocket(reason: string): void {
    const socket = this.socket;
    if (this.session) this.lastCheckpoint = this.session.state();
    this.socket = undefined;
    this.session = undefined;
    if (socket) this.closeSocket(socket, 1000, reason);
  }

  private closeSocket(socket: GatewaySocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // The socket may already be closed or may reject a duplicate close.
    }
  }

  private scheduleRetry(): void {
    if (!this.stopped) {
      this.schedule(() => void this.start().catch(() => this.scheduleRetry()), 5_000, 'retry');
    }
  }

  private schedule(
    callback: () => void,
    delayMs: number,
    action: GatewaySessionScheduledAction,
  ): void {
    this.clearScheduled();
    const delay = Math.max(0, delayMs);
    this.scheduledAction = action;
    this.scheduledAt = this.now() + delay;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.scheduledAction = undefined;
      this.scheduledAt = undefined;
      callback();
    }, delay);
  }

  private clearScheduled(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.scheduledAction = undefined;
    this.scheduledAt = undefined;
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
