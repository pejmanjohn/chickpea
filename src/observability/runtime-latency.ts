import { createHash } from 'node:crypto';

import type { GatewayInboundDelivery } from '../slack/gateway/protocol.ts';
import type { GatewaySessionRunnerHealthSnapshot } from '../slack/gateway/session-runner.ts';

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

export type RuntimeLatencyEvent =
  | 'relay_alarm'
  | 'turn_latency'
  | 'state_rpc'
  | 'gateway_delivery'
  | 'thread_runner_alarm';

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
  transport: TOKEN,
  deliveryKind: TOKEN,
  sessionPhase: TOKEN,
  sessionHealth: TOKEN,
  reason: TOKEN,
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
  /** Turns handed to their thread runners (the default executor). */
  jobsDispatched: number;
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
    jobsDispatched: 0,
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
    jobsDispatched: metrics.jobsDispatched,
  }, sink);
}

// ---------------------------------------------------------------------------
// thread_runner_alarm: one record per SlackThreadRunner alarm invocation.

/** One SlackThreadRunner alarm invocation (the per-thread turn executor). */
export interface ThreadRunnerAlarmRecord {
  /** Unsettled jobs the runner held when the alarm started. */
  jobs: number;
  /** Turn attempts this alarm ran. */
  ran: number;
  /** The observation budget ended with a turn still observing. */
  yielded: boolean;
  /** Turns still running at the hard cap; they settle after this record. */
  carried: number;
  durationMs: number;
  /** `idle`, `drained`, or `threw` (the alarm failed and re-armed with a backoff). */
  outcome: 'idle' | 'drained' | 'threw';
  /** With `threw`: the failure's error class name, a fixed token. */
  reason?: string;
}

export function emitThreadRunnerAlarm(
  record: ThreadRunnerAlarmRecord,
  sink?: RuntimeLatencySink,
): void {
  emitRuntimeLatency('thread_runner_alarm', { ...record }, sink);
}

// ---------------------------------------------------------------------------
// turn_latency: one record per relay attempt of one turn.

export type TurnLatencyLane = 'cloudflare' | 'node';
export type TurnLatencyExecutor = 'alarm' | 'runner' | 'node';

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

// ---------------------------------------------------------------------------
// gateway_delivery: one record per gateway delivery reaching Worker admission.

export type GatewayDeliveryTransport = 'http' | 'socket';

export interface GatewayDeliveryObservation {
  transport: GatewayDeliveryTransport;
  /** When the Worker received the delivery, before admission. */
  receivedAt: number;
  delivery: GatewayInboundDelivery;
  /** HTTP only: the gateway's signed `issuedAt` for this delivery attempt. */
  issuedAt?: number | undefined;
  /** Socket only: the delivering runner's health when the frame arrived. */
  session?: GatewaySessionRunnerHealthSnapshot | undefined;
  outcome: 'accepted' | 'duplicate' | 'rejected' | 'failed';
}

const DELIVERY_KIND: Readonly<Record<GatewayInboundDelivery['kind'], string>> = {
  'event.deliver': 'event',
  'interaction.agent_selected': 'agent_selected',
  'interaction.channel_agent_add': 'channel_agent_add',
};

const SLACK_TS = /^\d{1,12}(?:\.\d{1,6})?$/;

/**
 * When Slack says the event happened, in epoch ms. Prefers the event's own
 * `event_ts` (sub-second) and falls back to the envelope's whole-second
 * `event_time`. Only the difference is logged, never the timestamp itself.
 */
function slackEventAt(delivery: GatewayInboundDelivery): number | undefined {
  if (delivery.kind !== 'event.deliver') return undefined;
  const eventTs = (delivery.envelope.event as { event_ts?: unknown } | undefined)?.event_ts;
  if (typeof eventTs === 'string' && SLACK_TS.test(eventTs)) return Number(eventTs) * 1000;
  const eventTime = delivery.envelope.eventTime;
  return Number.isSafeInteger(eventTime) && eventTime > 0 ? eventTime * 1000 : undefined;
}

export function emitGatewayDelivery(
  observation: GatewayDeliveryObservation,
  sink?: RuntimeLatencySink,
): void {
  try {
    const { receivedAt, issuedAt, session } = observation;
    const slackAt = slackEventAt(observation.delivery);
    const connectedAt = session?.checkpoint?.connectedAt;
    emitRuntimeLatency('gateway_delivery', {
      transport: observation.transport,
      deliveryKind: DELIVERY_KIND[observation.delivery.kind],
      outcome: observation.outcome,
      lagMs: issuedAt === undefined ? undefined : receivedAt - issuedAt,
      slackLagMs: slackAt === undefined ? undefined : receivedAt - slackAt,
      sessionPhase: session?.phase,
      sessionHealth: session?.checkpoint?.health,
      sessionAttempt: session?.checkpoint?.attempt,
      sessionGeneration: session?.generation,
      sessionAgeMs: connectedAt === undefined ? undefined : receivedAt - connectedAt,
    }, sink);
  } catch {
    // Observability is best effort and never changes admission.
  }
}
