import { createHash } from 'node:crypto';

/**
 * Content-free latency logs for the turn relay (see
 * docs/runbooks/runtime-observability.md, "Turn latency and relay alarm logs").
 *
 * Each event is one structured console object so Cloudflare Workers Logs can
 * index its fields, and the same object reads directly in a Node log. Only
 * finite non-negative numbers, booleans, fixed machine tokens, and opaque
 * hashed references cross this boundary: never message text, Slack user or
 * channel IDs, settings keys or values, or error text. Emission never throws.
 */

export type RuntimeLatencyEvent = 'relay_alarm' | 'turn_latency' | 'state_rpc';

type RuntimeLatencyValue = number | boolean | string;

export interface RuntimeLatencySink {
  info(record: Record<string, unknown>): void;
}

const TOKEN = /^[a-z][a-z0-9_]{0,63}$/i;
const OPAQUE_REF = /^(run|turn)_[0-9a-f]{24}$/;

/** The only string fields any event may carry, and their allowed shapes. */
const STRING_FIELDS: Readonly<Record<string, RegExp>> = {
  outcome: TOKEN,
  lane: TOKEN,
  executor: TOKEN,
  firstWrite: TOKEN,
  final: TOKEN,
  method: TOKEN,
  op: TOKEN,
  runRef: OPAQUE_REF,
  turnRef: OPAQUE_REF,
};

export function emitRuntimeLatency(
  event: RuntimeLatencyEvent,
  fields: Readonly<Record<string, RuntimeLatencyValue | undefined>>,
  sink: RuntimeLatencySink = console,
): void {
  try {
    const record: Record<string, RuntimeLatencyValue> = { component: 'runtime', event };
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'number') {
        if (Number.isFinite(value)) record[key] = Math.max(0, Math.round(value));
      } else if (typeof value === 'boolean') {
        record[key] = value;
      } else if (typeof value === 'string') {
        const shape = STRING_FIELDS[key];
        if (shape?.test(value)) record[key] = value;
      }
    }
    sink.info(record);
  } catch {
    // Observability is best effort and never changes relay behavior.
  }
}

/** Same reference the `Slack presentation finalized` record carries. */
export function opaqueRunRef(runId: string | undefined): string | undefined {
  return runId ? `run_${sha256(runId).slice(0, 24)}` : undefined;
}

export function opaqueTurnRef(turnJobId: string | undefined): string | undefined {
  return turnJobId ? `turn_${sha256(turnJobId).slice(0, 24)}` : undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------------------
// relay_alarm: one record per TagStateStore.alarm() invocation.

export interface RelayAlarmMetrics {
  startedAt: number;
  /** `idle`: no pending turns; `drained`: turns ran; `threw`: store unavailable. */
  outcome: 'idle' | 'drained' | 'threw';
  jobsListed: number;
  groups: number;
  jobsRun: number;
  jobsSettled: number;
  jobsRetained: number;
  /** Still running at the alarm's hard cap; they settle after this record. */
  jobsCarried: number;
  longestJobMs: number;
  turnsMs: number;
  needsRetry: boolean;
  rearmed: boolean;
  /** Set when the drain stops observing a turn before the alarm wall-time limit. */
  yielded: boolean;
}

export function startRelayAlarmMetrics(now: () => number = Date.now): RelayAlarmMetrics {
  return {
    startedAt: now(),
    outcome: 'idle',
    jobsListed: 0,
    groups: 0,
    jobsRun: 0,
    jobsSettled: 0,
    jobsRetained: 0,
    jobsCarried: 0,
    longestJobMs: 0,
    turnsMs: 0,
    needsRetry: false,
    rearmed: false,
    yielded: false,
  };
}

export function emitRelayAlarm(
  metrics: RelayAlarmMetrics,
  now: () => number = Date.now,
  sink?: RuntimeLatencySink,
): void {
  emitRuntimeLatency('relay_alarm', {
    outcome: metrics.outcome,
    durationMs: now() - metrics.startedAt,
    jobsListed: metrics.jobsListed,
    groups: metrics.groups,
    jobsRun: metrics.jobsRun,
    jobsSettled: metrics.jobsSettled,
    jobsRetained: metrics.jobsRetained,
    jobsCarried: metrics.jobsCarried,
    longestJobMs: metrics.longestJobMs,
    turnsMs: metrics.turnsMs,
    needsRetry: metrics.needsRetry,
    rearmed: metrics.rearmed,
    yielded: metrics.yielded,
  }, sink);
}

// ---------------------------------------------------------------------------
// turn_latency: one record per relay attempt of one turn.

export type TurnLatencyLane = 'cloudflare' | 'node';
export type TurnLatencyExecutor = 'alarm' | 'node';

/** The first Slack-visible effect this attempt had acknowledged. */
export type TurnFirstWrite =
  | 'agent_session'
  | 'activity_status'
  | 'reaction'
  | 'stream'
  | 'final';

export interface TurnLatencyContext {
  /** `turn_jobs.enqueued_at`: when the relay durably admitted the turn. */
  admittedAt?: number;
  /** `turn_jobs.received_at`: gateway inbox acceptance, else admission. */
  receivedAt?: number;
  lane: TurnLatencyLane;
  executor: TurnLatencyExecutor;
}

export class TurnLatencyTracker {
  private readonly startedAt: number;
  private firstWrite: { surface: TurnFirstWrite; at: number } | undefined;
  private final: { kind: 'delivered' | 'deferred'; at: number } | undefined;
  private emitted = false;

  constructor(
    private readonly context: TurnLatencyContext,
    private readonly ids: { turnJobId?: string; runId?: string; attempt?: number },
    private readonly now: () => number = Date.now,
    private readonly sink?: RuntimeLatencySink,
  ) {
    this.startedAt = now();
  }

  /** Record an acknowledged Slack write; only the first one is kept. */
  markSlackWrite(surface: TurnFirstWrite): void {
    if (!this.firstWrite) this.firstWrite = { surface, at: this.now() };
  }

  /** The terminal was delivered, or handed to a durable outbox. */
  markFinal(kind: 'delivered' | 'deferred'): void {
    if (this.final) return;
    const at = this.now();
    this.final = { kind, at };
    if (kind === 'delivered' && !this.firstWrite) this.firstWrite = { surface: 'final', at };
  }

  /** Emit exactly once, when the attempt returns or throws. */
  emit(outcome: 'returned' | 'threw'): void {
    if (this.emitted) return;
    this.emitted = true;
    const { admittedAt, receivedAt } = this.context;
    const since = (at: number | undefined) =>
      admittedAt === undefined || at === undefined ? undefined : at - admittedAt;
    const sinceReceipt = (at: number | undefined) =>
      receivedAt === undefined || at === undefined ? undefined : at - receivedAt;
    const end = this.now();
    emitRuntimeLatency('turn_latency', {
      turnRef: opaqueTurnRef(this.ids.turnJobId),
      runRef: opaqueRunRef(this.ids.runId),
      lane: this.context.lane,
      executor: this.context.executor,
      attempt: this.ids.attempt,
      outcome,
      firstWrite: this.firstWrite?.surface ?? 'none',
      final: this.final?.kind ?? 'none',
      admissionToStartMs: since(this.startedAt),
      admissionToFirstWriteMs: since(this.firstWrite?.at),
      admissionToFinalMs: this.final?.kind === 'delivered' ? since(this.final.at) : undefined,
      receiptToAdmissionMs: sinceReceipt(admittedAt),
      receiptToFirstWriteMs: sinceReceipt(this.firstWrite?.at),
      attemptMs: end - this.startedAt,
    }, this.sink);
  }
}

// ---------------------------------------------------------------------------
// state_rpc: sampled timing of calls from the Cf*Store proxies into TagStateStore.

/** Calls at least this slow are always logged. */
export const STATE_RPC_SLOW_MS = 250;
/** Otherwise one call in this many is logged, as a baseline sample. */
export const STATE_RPC_SAMPLE_EVERY = 100;

const stateRpcCounters = { calls: 0, slow: 0 };

/**
 * Time one RPC at the Cf*Store class boundary. Callers pass the in-flight
 * promise from a direct `this.stub.<method>(...)` call; the stub, its methods,
 * and D1 handles are never wrapped, which is what keeps this safe in workerd.
 */
export async function timedStateRpc<T>(
  method: string,
  pending: Promise<T>,
  op?: string,
): Promise<T> {
  const startedAt = Date.now();
  let ok = false;
  try {
    const result = await pending;
    ok = true;
    return result;
  } finally {
    recordStateRpc(method, Date.now() - startedAt, ok, op);
  }
}

export function recordStateRpc(
  method: string,
  ms: number,
  ok: boolean,
  op?: string,
  sink?: RuntimeLatencySink,
): void {
  try {
    stateRpcCounters.calls += 1;
    const slow = ms >= STATE_RPC_SLOW_MS;
    if (slow) stateRpcCounters.slow += 1;
    if (!slow && ok && stateRpcCounters.calls % STATE_RPC_SAMPLE_EVERY !== 0) return;
    emitRuntimeLatency('state_rpc', {
      method,
      op,
      ms,
      slow,
      ok,
      isolateCalls: stateRpcCounters.calls,
      isolateSlowCalls: stateRpcCounters.slow,
    }, sink);
  } catch {
    // Timing must never change the RPC result.
  }
}

/** Focused tests only: reset the per-isolate counters. */
export function resetStateRpcCountersForTest(): void {
  stateRpcCounters.calls = 0;
  stateRpcCounters.slow = 0;
}
