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

interface GatewaySessionRunnerOptions {
  client: GatewayDeploymentClient;
  onEvent(delivery: GatewayInboundDelivery): Promise<'accepted' | 'duplicate' | 'rejected'>;
  createSocket?: (url: string) => GatewaySocket;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  capabilities?: readonly GatewaySessionCapability[];
  waitUntil?: (promise: Promise<unknown>) => void;
}

type GatewaySessionRunnerPhase =
  | 'stopped'
  | 'starting'
  | 'connecting'
  | 'retrying'
  | 'healthy'
  | 'needs_attention'
  | 'stale';

type GatewaySessionScheduledAction = 'ready_timeout' | 'rotate' | 'retry';

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

interface GatewaySessionRunnerHealthInput {
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

interface GatewaySessionEndpoint {
  socket: GatewaySocket;
  session: GatewayLogicalSession;
  messageChain: Promise<void>;
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
  private active: GatewaySessionEndpoint | undefined;
  private candidate: GatewaySessionEndpoint | undefined;
  private handoffPredecessor: GatewaySessionEndpoint | undefined;
  private lastCheckpoint: GatewaySessionCheckpoint | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private candidateTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduledAction: GatewaySessionScheduledAction | undefined;
  private scheduledAt: number | undefined;
  private candidateOpeningGeneration: number | undefined;
  private candidateOpeningDeadline: number | undefined;
  private renewalPending = false;
  private starting = false;
  private stopped = true;
  private generation = 0;
  private checkpointWrites = Promise.resolve();
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
    this.clearCandidateTimer();
    this.candidateOpeningGeneration = undefined;
    this.candidateOpeningDeadline = undefined;
    this.retireCandidate('restart');
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
      await this.recordCheckpoint(connecting, () => this.current(generation));
      this.lastCheckpoint = connecting;
      if (!this.current(generation)) return false;
      const endpoint = await this.createEndpoint(binding.sessionUrl, connecting, generation);
      if (!endpoint) return false;
      if (!this.current(generation)) {
        this.closeSocket(endpoint.socket, 1000, 'superseded');
        return false;
      }
      this.active = endpoint;
      this.attachEndpoint(endpoint, generation);
      // A completed WebSocket upgrade is not a usable session until the gateway
      // authenticates it with session.ready. Cover the half-open-before-first-
      // frame case instead of waiting forever for heartbeat state that does not
      // exist yet.
      this.schedule(
        () => this.failEndpoint(endpoint, 'ready_timeout'),
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
    this.clearCandidateTimer();
    this.candidateOpeningGeneration = undefined;
    this.candidateOpeningDeadline = undefined;
    this.retireCandidate('shutdown');
    this.retireCurrentSocket('shutdown');
  }

  state(): ReturnType<GatewayLogicalSession['state']> | undefined {
    return this.active?.session.state() ?? (this.lastCheckpoint ? { ...this.lastCheckpoint } : undefined);
  }

  healthSnapshot(): GatewaySessionRunnerHealthSnapshot {
    const checkpoint = this.state();
    if (this.renewalPending && !this.stopped) {
      const active = this.active;
      const candidateOpening = this.candidateOpeningGeneration === this.generation;
      // Creating a successor can stall before there is a socket to time out.
      // Let the normal heartbeat supervisor retire this entire generation;
      // late async completion is fenced by current(generation).
      if (candidateOpening && this.candidateOpeningDeadline !== undefined
        && this.now() >= this.candidateOpeningDeadline) {
        return {
          generation: this.generation,
          phase: 'stale', healthy: false, shouldReplace: true,
          reason: 'candidate_open_timeout',
          ...(checkpoint ? { checkpoint } : {}),
        };
      }
      if (!active && !this.candidate && !candidateOpening) {
        return {
          generation: this.generation,
          phase: 'stale',
          healthy: false,
          shouldReplace: true,
          reason: 'session_unavailable',
          ...(checkpoint ? { checkpoint } : {}),
        };
      }
      if (active?.socket.readyState === 1 && checkpoint?.health === 'healthy' &&
          checkpoint.lastHeartbeatAt !== undefined &&
          checkpoint.lastHeartbeatAt > this.now() - GATEWAY_HEARTBEAT_TIMEOUT_MS) {
        return {
          generation: this.generation,
          phase: 'healthy',
          healthy: true,
          shouldReplace: false,
          socketState: active.socket.readyState,
          checkpoint,
          ...(this.scheduledAction ? { scheduledAction: this.scheduledAction } : {}),
          ...(this.scheduledAt !== undefined ? { scheduledAt: this.scheduledAt } : {}),
        };
      }
      return {
        generation: this.generation,
        phase: 'connecting',
        healthy: false,
        shouldReplace: false,
        ...(this.candidate ? { socketState: this.candidate.socket.readyState } : {}),
        ...(checkpoint ? { checkpoint } : {}),
      };
    }
    return classifyGatewaySessionRunnerHealth({
      generation: this.generation,
      stopped: this.stopped,
      starting: this.starting,
      now: this.now(),
      ...(this.active ? { socketState: this.active.socket.readyState } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(this.scheduledAction ? { scheduledAction: this.scheduledAction } : {}),
      ...(this.scheduledAt !== undefined ? { scheduledAt: this.scheduledAt } : {}),
    });
  }

  private async createEndpoint(
    sessionUrl: string,
    checkpoint: GatewaySessionCheckpoint,
    generation: number,
  ): Promise<GatewaySessionEndpoint | undefined> {
    let endpoint: GatewaySessionEndpoint | undefined;
    const session = await this.options.client.createSession(
      (frame) => {
        if (this.current(generation) && endpoint && this.endpointCurrent(endpoint) &&
            endpoint.socket.readyState === 1) {
          endpoint.socket.send(JSON.stringify(frame));
        }
      },
      this.options.onEvent,
      checkpoint,
      this.options.capabilities,
    );
    if (!this.current(generation)) return undefined;
    const socket = (this.options.createSocket ?? defaultSocket)(sessionUrl);
    endpoint = { socket, session, messageChain: Promise.resolve() };
    return endpoint;
  }

  private attachEndpoint(endpoint: GatewaySessionEndpoint, generation: number): void {
    endpoint.socket.addEventListener('open', () => {
      if (!this.current(generation) || !this.endpointCurrent(endpoint)) return;
      void endpoint.session.hello().catch(() => this.failEndpoint(endpoint, 'hello_failed'));
    });
    endpoint.socket.addEventListener('message', (event) => {
      if (!this.current(generation) || !this.endpointCurrent(endpoint)) return;
      const raw = typeof event.data === 'string' ? event.data : '';
      // WebSocket callbacks are synchronous, while event admission is async.
      // Keep one chain per socket so delivery and receipt order is preserved.
      endpoint.messageChain = endpoint.messageChain.then(async () => {
        if (!this.current(generation) || !this.endpointCurrent(endpoint)) return;
        await endpoint.session.handle(raw);
        if (!this.current(generation) || !this.endpointCurrent(endpoint)) return;
        if (this.candidate === endpoint) {
          if (endpoint.session.state().health === 'healthy') await this.promoteCandidate(endpoint);
          return;
        }
        const checkpoint = endpoint.session.state();
        this.lastCheckpoint = checkpoint;
        await this.recordCheckpoint(checkpoint, () => this.active === endpoint);
        if (!this.current(generation) || this.active !== endpoint) return;
        const rotateAt = checkpoint.rotateAt;
        if (rotateAt && !this.renewalPending) {
          this.schedule(() => this.beginRotation(endpoint), rotateAt - this.now(), 'rotate');
        }
        this.scheduleHeartbeat(endpoint);
      }).catch(() => this.failEndpoint(endpoint, 'invalid_frame'));
      this.options.waitUntil?.(endpoint.messageChain);
    });
    endpoint.socket.addEventListener('close', () => this.failEndpoint(endpoint, 'closed'));
    endpoint.socket.addEventListener('error', () => this.failEndpoint(endpoint, 'network'));
  }

  private beginRotation(predecessor: GatewaySessionEndpoint): void {
    if (this.stopped || this.active !== predecessor || this.candidate ||
        this.candidateOpeningGeneration !== undefined) return;
    this.renewalPending = true;
    this.handoffPredecessor = predecessor;
    const generation = this.generation;
    this.candidateOpeningGeneration = generation;
    this.candidateOpeningDeadline = this.now() + GATEWAY_HEARTBEAT_TIMEOUT_MS;
    void this.openCandidate(generation)
      .catch(() => {
        if (this.current(generation)) this.failCandidate(undefined, 'candidate_start_failed');
      })
      .finally(() => {
        if (this.candidateOpeningGeneration !== generation) return;
        this.candidateOpeningGeneration = undefined;
        this.candidateOpeningDeadline = undefined;
        if (this.current(generation) && this.renewalPending && !this.candidate) {
          this.failCandidate(undefined, 'candidate_start_failed');
        }
      });
  }

  private async openCandidate(generation: number): Promise<void> {
    const binding = await this.options.client.loadBinding();
    if (!binding || !this.current(generation) || !this.renewalPending || this.candidate) return;
    const connecting = {
      health: 'connecting' as const,
      attempt: this.handoffPredecessor?.session.state().attempt ?? 0,
    };
    const candidate = await this.createEndpoint(binding.sessionUrl, connecting, generation);
    if (!candidate) return;
    if (!this.current(generation) || !this.renewalPending || this.candidate) {
      this.closeSocket(candidate.socket, 1000, 'superseded');
      return;
    }
    this.candidate = candidate;
    this.attachEndpoint(candidate, generation);
    this.clearCandidateTimer();
    this.candidateTimer = this.setTimer(
      () => this.failCandidate(candidate, 'ready_timeout'),
      GATEWAY_HEARTBEAT_TIMEOUT_MS,
    );
  }

  private async promoteCandidate(candidate: GatewaySessionEndpoint): Promise<void> {
    if (this.stopped || this.candidate !== candidate) return;
    const predecessor = this.handoffPredecessor;
    this.clearCandidateTimer();
    this.candidate = undefined;
    this.active = candidate;
    this.handoffPredecessor = undefined;
    this.renewalPending = false;
    const checkpoint = candidate.session.state();
    this.lastCheckpoint = checkpoint;
    try {
      await this.recordCheckpoint(checkpoint, () => this.active === candidate);
    } finally {
      if (predecessor && predecessor !== candidate) {
        this.closeSocket(predecessor.socket, 1000, 'rotation_complete');
      }
    }
    if (this.stopped || this.active !== candidate) return;
    const rotateAt = checkpoint.rotateAt;
    if (rotateAt) this.schedule(() => this.beginRotation(candidate), rotateAt - this.now(), 'rotate');
    this.scheduleHeartbeat(candidate);
  }

  private failEndpoint(endpoint: GatewaySessionEndpoint, reason: string): void {
    if (this.stopped) return;
    if (this.candidate === endpoint) {
      this.failCandidate(endpoint, reason);
      return;
    }
    if (this.active !== endpoint) return;
    if (this.renewalPending && this.handoffPredecessor === endpoint &&
        (this.candidate || this.candidateOpeningGeneration === this.generation)) {
      this.active = undefined;
      this.clearHeartbeat();
      this.closeSocket(endpoint.socket, 1012, 'handoff');
      return;
    }
    this.reconnect(endpoint, reason);
  }

  private failCandidate(candidate: GatewaySessionEndpoint | undefined, reason: string): void {
    if (this.stopped || (candidate && this.candidate !== candidate)) return;
    const failed = candidate ?? this.candidate;
    if (failed) this.closeSocket(failed.socket, 1012, 'candidate_failed');
    this.candidate = undefined;
    this.clearCandidateTimer();
    const active = this.active;
    if (active?.socket.readyState === 1 && active.session.state().health === 'healthy') {
      this.handoffPredecessor = active;
      this.renewalPending = true;
      this.schedule(() => this.beginRotation(active), 5_000, 'rotate');
      return;
    }
    const predecessor = this.handoffPredecessor;
    this.handoffPredecessor = undefined;
    this.renewalPending = false;
    const checkpoint = (predecessor ?? failed)?.session.close(reason);
    if (checkpoint) {
      this.lastCheckpoint = checkpoint;
      void this.recordCheckpoint(checkpoint);
    }
    const delay = Math.max(0, (checkpoint?.retryAt ?? this.now() + 1_000) - this.now());
    this.schedule(() => void this.start().catch(() => this.scheduleRetry()), delay, 'retry');
  }

  private reconnect(endpoint: GatewaySessionEndpoint, reason: string): void {
    if (this.stopped || this.active !== endpoint) return;
    this.active = undefined;
    this.handoffPredecessor = undefined;
    this.renewalPending = false;
    this.clearScheduled();
    this.clearHeartbeat();
    this.closeSocket(endpoint.socket, 1012, 'reconnect');
    const checkpoint = endpoint.session.close(reason);
    if (checkpoint) {
      this.lastCheckpoint = checkpoint;
      void this.recordCheckpoint(checkpoint);
    }
    if (checkpoint?.health === 'needs_attention') return;
    const delay = Math.max(0, (checkpoint?.retryAt ?? this.now() + 1_000) - this.now());
    this.schedule(() => void this.start().catch(() => this.scheduleRetry()), delay, 'retry');
  }

  private current(generation: number): boolean {
    return !this.stopped && this.generation === generation;
  }

  private retireCurrentSocket(reason: string): void {
    const active = this.active;
    if (active) this.lastCheckpoint = active.session.state();
    this.active = undefined;
    this.renewalPending = false;
    const predecessor = this.handoffPredecessor;
    this.handoffPredecessor = undefined;
    if (active) this.closeSocket(active.socket, 1000, reason);
    if (predecessor && predecessor !== active) this.closeSocket(predecessor.socket, 1000, reason);
  }

  private retireCandidate(reason: string): void {
    const candidate = this.candidate;
    this.candidate = undefined;
    if (candidate) this.closeSocket(candidate.socket, 1000, reason);
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

  private scheduleHeartbeat(endpoint: GatewaySessionEndpoint): void {
    this.clearHeartbeat();
    const lastHeartbeatAt = endpoint.session.state().lastHeartbeatAt;
    if (lastHeartbeatAt === undefined) return;
    const delay = Math.max(0, lastHeartbeatAt + GATEWAY_HEARTBEAT_TIMEOUT_MS - this.now());
    this.heartbeatTimer = this.setTimer(() => {
      if (this.stopped || this.active !== endpoint) return;
      if (!gatewaySessionHealthy(endpoint.session.state(), this.now())) {
        this.failEndpoint(endpoint, 'heartbeat_timeout');
        return;
      }
      this.scheduleHeartbeat(endpoint);
    }, delay);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) this.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearCandidateTimer(): void {
    if (this.candidateTimer !== undefined) this.clearTimer(this.candidateTimer);
    this.candidateTimer = undefined;
  }

  private endpointCurrent(endpoint: GatewaySessionEndpoint): boolean {
    return this.active === endpoint || this.candidate === endpoint;
  }

  private recordCheckpoint(
    checkpoint: GatewaySessionCheckpoint,
    allowed: () => boolean = () => true,
  ): Promise<void> {
    const write = this.checkpointWrites.then(async () => {
      if (allowed()) await this.options.client.recordSessionCheckpoint(checkpoint);
    });
    this.checkpointWrites = write.catch(() => undefined);
    return write;
  }
}

function defaultSocket(url: string): GatewaySocket {
  if (typeof WebSocket !== 'function') {
    throw new Error('This runtime does not provide outbound WebSockets.');
  }
  return new WebSocket(url) as unknown as GatewaySocket;
}
