import { createHash } from 'node:crypto';

import type { GatewayInboundDelivery } from '../slack/gateway/protocol.ts';
import type { GatewaySessionRunnerHealthSnapshot } from '../slack/gateway/session-runner.ts';
import type { SlackThreadRunnerRpc } from '../slack/thread-runner-rpc.ts';

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
  | 'turn_fold'
  | 'state_rpc'
  | 'gateway_delivery'
  | 'thread_runner_alarm'
  | 'thread_runner_superseded'
  | 'runner_boot'
  | 'agent_boot'
  | 'slack_read'
  | 'interaction_judgment';

type RuntimeLatencyValue = number | boolean | string;

export interface RuntimeLatencySink {
  info(record: Record<string, unknown>): void;
}

const TOKEN = /^[a-z][a-z0-9_]{0,63}$/i;
const OPAQUE_REF = /^(run|turn)_[0-9a-f]{24}$/;
/** A Cloudflare Worker version id (a UUID), or a fixed token instead of one. */
const VERSION_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z][a-z0-9_]{0,63})$/i;

/** The only string fields any event may carry, and their allowed shapes. */
const STRING_FIELDS: Readonly<Record<string, RegExp>> = {
  outcome: TOKEN,
  lane: TOKEN,
  executor: TOKEN,
  firstWrite: TOKEN,
  final: TOKEN,
  method: TOKEN,
  firstMethod: TOKEN,
  op: TOKEN,
  transport: TOKEN,
  deliveryKind: TOKEN,
  sessionPhase: TOKEN,
  sessionHealth: TOKEN,
  eventType: TOKEN,
  subtype: TOKEN,
  source: TOKEN,
  filterReason: TOKEN,
  order: TOKEN,
  reason: TOKEN,
  recordedBy: TOKEN,
  basis: TOKEN,
  clef: TOKEN,
  clefChoice: TOKEN,
  management: TOKEN,
  gate: TOKEN,
  model: TOKEN,
  refinement: TOKEN,
  runRef: OPAQUE_REF,
  turnRef: OPAQUE_REF,
  versionId: VERSION_ID,
  supersededBy: VERSION_ID,
  agentClass: TOKEN,
  agentWakeSource: TOKEN,
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
  /**
   * An idle firing's parts, in milliseconds: the management retention sweep,
   * then the ledger, interaction-cleanup, presentation-repair,
   * schedule-action and management-receipt drains. Absent on a drained
   * record, whose drains run among its turns.
   */
  retentionMs?: number;
  ledgerMs?: number;
  cleanupsMs?: number;
  repairsMs?: number;
  scheduleMs?: number;
  receiptsMs?: number;
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
    retentionMs: metrics.retentionMs,
    ledgerMs: metrics.ledgerMs,
    cleanupsMs: metrics.cleanupsMs,
    repairsMs: metrics.repairsMs,
    scheduleMs: metrics.scheduleMs,
    receiptsMs: metrics.receiptsMs,
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
  /**
   * Queued turns that stopped runs' endings dropped since the runner's last
   * record (each counted once, however often its ending replays).
   */
  dropped?: number;
  durationMs: number;
  /** `idle`, `drained`, or `threw` (the alarm failed and re-armed with a backoff). */
  outcome: 'idle' | 'drained' | 'threw';
  /** With `threw`: the failure's error class name, a fixed token. */
  reason?: string;
  /** This runner's Worker version id, when known. */
  versionId?: string;
  /**
   * The alarm yielded its turn for a code update: the serving Worker version
   * id, or `storage_lost` when this instance lost its storage.
   */
  supersededBy?: string;
}

export function emitThreadRunnerAlarm(
  record: ThreadRunnerAlarmRecord,
  sink?: RuntimeLatencySink,
): void {
  emitRuntimeLatency('thread_runner_alarm', { ...record }, sink);
}

/**
 * A runner saw that a code update replaced its version and yields its turn:
 * `supersededBy` is the serving version id, or `storage_lost`.
 */
export function emitThreadRunnerSuperseded(
  record: { versionId?: string; supersededBy: string; running: boolean },
  sink?: RuntimeLatencySink,
): void {
  emitRuntimeLatency('thread_runner_superseded', { ...record }, sink);
}

// ---------------------------------------------------------------------------
// runner_boot and agent_boot: one record per in-memory activation of a
// SlackThreadRunner, or of a Flue agent's Durable Object.

/** What a runner activation served first: an RPC, its alarm, or a host function. */
export type RunnerBootMethod = keyof SlackThreadRunnerRpc | 'alarm' | 'host';

/**
 * What an agent activation served first: the runner's wake once the turn's
 * plan froze, a staged turn input, a request (a Flue dispatch or
 * observation), its alarm, or a host function. Naming the object (`setName`)
 * precedes the first of these and is not one.
 */
export type AgentBootMethod = 'wake' | 'stage' | 'fetch' | 'alarm' | 'host';

/** Activations this isolate has constructed, by kind. */
const activations = { runner_boot: 0, agent_boot: 0 };

/**
 * The marks of one object activation (an instance constructed in memory),
 * logged once when it serves its first call. Workers clocks read 0 while a
 * script evaluates and advance only on I/O, so placement, isolate start and
 * script evaluation all fall in `sentToConstructMs`, and a span without I/O
 * reads 0.
 */
class ObjectBootMarks<Method extends string> {
  /** The first object of its kind this isolate constructed. */
  private readonly cold: boolean;
  private readonly constructStartedAt: number;
  private constructedAt: number | undefined;
  private served = false;

  constructor(
    private readonly event: keyof typeof activations,
    private readonly fields: { agentClass?: string },
    private readonly now: () => number,
    private readonly sink: RuntimeLatencySink | undefined,
  ) {
    activations[event] += 1;
    this.cold = activations[event] === 1;
    this.constructStartedAt = now();
  }

  /** The constructor finished. */
  constructed(): void {
    this.constructedAt ??= this.now();
  }

  /**
   * The activation serves a call; only the first is logged. `sentAt` is the
   * caller's clock when it sent the call.
   */
  call(
    method: Method,
    from: { sentAt?: number | undefined; turnJobId?: string | undefined } = {},
  ): void {
    if (this.served) return;
    this.served = true;
    const at = this.now();
    const constructedAt = this.constructedAt ?? at;
    emitRuntimeLatency(this.event, {
      ...this.fields,
      firstMethod: method,
      cold: this.cold,
      turnRef: opaqueTurnRef(from.turnJobId),
      sentToConstructMs: from.sentAt === undefined ? undefined : this.constructStartedAt - from.sentAt,
      constructMs: constructedAt - this.constructStartedAt,
      constructToFirstCallMs: at - constructedAt,
    }, this.sink);
  }
}

/** A SlackThreadRunner activation's marks, logged as `runner_boot`; `constructed` follows its `blockConcurrencyWhile`. */
export class RunnerBootMarks extends ObjectBootMarks<RunnerBootMethod> {
  constructor(now: () => number = Date.now, sink?: RuntimeLatencySink) {
    super('runner_boot', {}, now, sink);
  }
}

/**
 * A Flue agent object's activation marks, logged as `agent_boot`. A wake and
 * a staged turn input carry the runner's clock from before it addressed the
 * object, so `sentToConstructMs` covers activating it.
 */
export class AgentBootMarks extends ObjectBootMarks<AgentBootMethod> {
  constructor(agentClass: string, now: () => number = Date.now, sink?: RuntimeLatencySink) {
    super('agent_boot', { agentClass }, now, sink);
  }
}

/** Focused tests only: the next activation of each kind is this isolate's first. */
export function resetRunnerActivationsForTest(): void {
  activations.runner_boot = 0;
  activations.agent_boot = 0;
}

// ---------------------------------------------------------------------------
// turn_latency: one record per relay attempt of one turn.

export type TurnLatencyLane = 'cloudflare' | 'node';
export type TurnLatencyExecutor = 'alarm' | 'runner' | 'node';

/**
 * The first Slack-visible effect this attempt had acknowledged:
 * `admission_status` is the status the state store showed before the turn's
 * hand-off (TurnLatencyContext.admissionStatusAt).
 */
export type TurnFirstWrite =
  | 'admission_status'
  | 'agent_session'
  | 'activity_status'
  | 'reaction'
  | 'stream'
  | 'midrun_reply'
  | 'final';

export interface TurnLatencyContext {
  /** `turn_jobs.enqueued_at`: when the relay durably admitted the turn. */
  admittedAt?: number;
  /** `turn_jobs.received_at`: gateway inbox acceptance, else admission. */
  receivedAt?: number;
  /** A runner turn's first attempt: the runner's `admit` start minus the state store's send time (two clocks). */
  handoffMs?: number;
  /**
   * A runner turn's first attempt, when the state store woke that runner at
   * the delivery's receipt: the hand-off's send time minus the wake's (both
   * the state store's clock).
   */
  runnerWakeLeadMs?: number;
  /**
   * A runner turn's first attempt, when the state store tried to show its
   * status before the hand-off: how long the hand-off waited for that write.
   */
  admissionStatusMs?: number;
  /** When that status showed (the state store's clock): the attempt's first write. */
  admissionStatusAt?: number;
  lane: TurnLatencyLane;
  executor: TurnLatencyExecutor;
}

export class TurnLatencyTracker {
  private readonly startedAt: number;
  private firstWrite: { surface: TurnFirstWrite; at: number } | undefined;
  private final: { kind: 'delivered' | 'deferred'; at: number } | undefined;
  private folded = 0;
  private foldedInformed = 0;
  private read = 0;
  private midRunReplies = 0;
  private agentStageMs: number | undefined;
  private agentWake: { sentAt: number; source: 'admission' | 'plan' } | undefined;
  private agentWakeLeadMs: number | undefined;
  private startToStageMs: number | undefined;
  private emitted = false;

  constructor(
    private readonly context: TurnLatencyContext,
    private readonly ids: { turnJobId?: string; runId?: string; attempt?: number },
    private readonly now: () => number = Date.now,
    private readonly sink?: RuntimeLatencySink,
  ) {
    this.startedAt = now();
    if (context.admissionStatusAt !== undefined) {
      this.firstWrite = { surface: 'admission_status', at: context.admissionStatusAt };
    }
  }

  /** Record an acknowledged Slack write; only the first one is kept. */
  markSlackWrite(surface: TurnFirstWrite): void {
    if (!this.firstWrite) this.firstWrite = { surface, at: this.now() };
  }

  /** The turn took this many queued messages as follow-ups. */
  markFolded(count: number): void {
    this.folded = count;
  }

  /** Of those, this many reached it as information only. */
  markFoldedInformed(count: number): void {
    this.foldedInformed = count;
  }

  /** A 👀 on a message this turn read became 👍. */
  markRead(): void {
    this.read += 1;
  }

  /** The Agent posted a reply mid-run (KTD14). */
  markMidRunReply(): void {
    this.midRunReplies += 1;
  }

  /**
   * The turn's Agent object was woken: by admission at `admissionSentAt` (the
   * state store's clock), or by the turn now. Only the first wake is kept.
   */
  markAgentWake(admissionSentAt?: number): void {
    this.agentWake ??= admissionSentAt === undefined
      ? { sentAt: this.now(), source: 'plan' }
      : { sentAt: admissionSentAt, source: 'admission' };
  }

  /** Staging the turn's input beside its Agent took this long; only the first staging is kept. */
  markAgentStage(ms: number): void {
    if (this.agentStageMs !== undefined) return;
    this.agentStageMs = ms;
    if (this.agentWake !== undefined) this.agentWakeLeadMs = this.now() - ms - this.agentWake.sentAt;
    this.startToStageMs = Math.max(0, this.now() - ms - this.startedAt);
  }

  /** The terminal was delivered, or handed to a durable outbox. */
  markFinal(kind: 'delivered' | 'deferred'): void {
    if (this.final) return;
    const at = this.now();
    this.final = { kind, at };
    if (kind === 'delivered' && !this.firstWrite) this.firstWrite = { surface: 'final', at };
  }

  /**
   * Emit exactly once, when the attempt returns or throws. `stopped`: it
   * returned with a stopped run's ending (KTD3), which is not a failure.
   */
  emit(outcome: 'returned' | 'threw' | 'stopped'): void {
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
      handoffMs: this.context.handoffMs,
      runnerWakeLeadMs: this.context.runnerWakeLeadMs,
      admissionStatusMs: this.context.admissionStatusMs,
      agentStageMs: this.agentStageMs,
      agentWakeLeadMs: this.agentWakeLeadMs,
      agentWakeSource: this.agentWakeLeadMs === undefined ? undefined : this.agentWake?.source,
      startToStageMs: this.startToStageMs,
      attemptMs: end - this.startedAt,
      folded: this.folded > 0 ? this.folded : undefined,
      foldedInformed: this.foldedInformed > 0 ? this.foldedInformed : undefined,
      read: this.read > 0 ? this.read : undefined,
      midRunReplies: this.midRunReplies > 0 ? this.midRunReplies : undefined,
    }, this.sink);
  }
}

// ---------------------------------------------------------------------------
// turn_fold: messages a running turn read after a tool batch or in its would-stop phase.

/**
 * A running turn's model read `late` more queued messages, sent while it
 * worked: `informed` of them as information only, `turn` of them after a
 * tool batch rather than as it was about to reply. `edits` counts the
 * edits of messages it had already read, apart from `late`.
 * `turn_latency.folded` and `foldedInformed` count the ones it took at its
 * start. Emitted when the state store confirms the Agent read them.
 */
export function emitTurnFold(
  record: { turnJobId: string; late: number; informed: number; turn: number; edits: number },
  sink?: RuntimeLatencySink,
): void {
  emitRuntimeLatency('turn_fold', {
    turnRef: opaqueTurnRef(record.turnJobId),
    late: record.late,
    informed: record.informed > 0 ? record.informed : undefined,
    turn: record.turn > 0 ? record.turn : undefined,
    edits: record.edits > 0 ? record.edits : undefined,
  }, sink);
}

/**
 * One delivery of a person's edit of a message: `admitted`, or
 * `already_admitted` for a redelivery, when it will steer its message's
 * turn; otherwise why not (a SlackEditRefusal), `unsupported` for a state
 * store without edit admission, or `failed` when admission threw and the
 * delivery is retried. On `turn_fold` with `op` `edit_admission`.
 */
export function emitSlackEditAdmission(record: { outcome: string }, sink?: RuntimeLatencySink): void {
  emitRuntimeLatency('turn_fold', { op: 'edit_admission', outcome: record.outcome }, sink);
}

/**
 * A coding job's wait during a running turn: `pause` (it returned early so
 * the model could read new messages: `outcome` `messages`, or `unchecked`
 * after the check kept failing), `resume` (a later wait ended: `outcome`
 * `completed`, `paused` or a failure reason), or `relay` (guidance for the
 * running job: `sent`, `finished`, `stopped` or `not_sent`). One record per
 * event, on `turn_fold` with `op` `coding_<kind>`; each counts once.
 */
export function emitCodingTaskSteering(
  record: { turnJobId: string | undefined; op: 'pause' | 'resume' | 'relay'; outcome: string },
  sink?: RuntimeLatencySink,
): void {
  emitRuntimeLatency('turn_fold', {
    turnRef: opaqueTurnRef(record.turnJobId),
    op: `coding_${record.op}`,
    outcome: record.outcome,
  }, sink);
}

/**
 * One guaranteed turn's interaction judgment, once everything it started has
 * ended: who recorded the basis (`shortcut`, `clef`, `model`, `unrecorded`),
 * how Clef ended, its choice and probabilities (in thousandths), the gate's
 * decision, the model's answer and what became of it after a Clef basis, and
 * whether the two agreed. Clef is platform infrastructure, so this event, not
 * a tenant usage record, is where its calls and input tokens are counted.
 */
export function emitInteractionJudgment(
  record: {
    turnJobId?: string | undefined;
    recordedBy: string;
    basis?: string;
    basisMs?: number;
    clef: string;
    clefMs?: number;
    clefInputTokens?: number;
    clefChoice?: string;
    clefTop?: number;
    clefTextMass?: number;
    clefMemory?: number;
    gate?: string;
    clefLate?: boolean;
    model?: string;
    modelFailed?: boolean;
    modelMs?: number;
    refinement?: string;
    agreed?: boolean;
    management?: string;
    managementMs?: number;
    managementInputTokens?: number;
    managementTop?: number;
    managementFired?: boolean;
  },
  sink?: RuntimeLatencySink,
): void {
  const thousandths = (value: number | undefined) => (value === undefined ? undefined : value * 1000);
  emitRuntimeLatency('interaction_judgment', {
    turnRef: opaqueTurnRef(record.turnJobId),
    recordedBy: record.recordedBy,
    basis: record.basis,
    basisMs: record.basisMs,
    clef: record.clef,
    clefMs: record.clefMs,
    clefInputTokens: record.clefInputTokens,
    clefChoice: record.clefChoice,
    clefTop: thousandths(record.clefTop),
    clefTextMass: thousandths(record.clefTextMass),
    clefMemory: thousandths(record.clefMemory),
    gate: record.gate,
    clefLate: record.clefLate,
    model: record.model,
    modelFailed: record.modelFailed,
    modelMs: record.modelMs,
    refinement: record.refinement,
    agreed: record.agreed,
    management: record.management,
    managementMs: record.managementMs,
    managementInputTokens: record.managementInputTokens,
    managementTop: thousandths(record.managementTop),
    managementFired: record.managementFired,
  }, sink);
}

// ---------------------------------------------------------------------------
// state_rpc: sampled timing of calls from the Cf*Store proxies into TagStateStore.

/** Calls at least this slow are always logged. */
export const STATE_RPC_SLOW_MS = 250;
/** Otherwise one call in this many is logged, as a baseline sample. */
export const STATE_RPC_SAMPLE_EVERY = 100;

const stateRpcCounters = { calls: 0, slow: 0 };

const PERF_STATE_RPC_DELAY_MS = Math.max(0, Number(process.env.CHICKPEA_PERF_STATE_RPC_DELAY_MS ?? 0) || 0);

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
    if (PERF_STATE_RPC_DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, PERF_STATE_RPC_DELAY_MS));
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
  /**
   * `filtered`: a self-generated event acknowledged without admission.
   * A thrown admission is `failed`; the gateway still receives `rejected`.
   */
  outcome: 'accepted' | 'duplicate' | 'rejected' | 'failed' | 'filtered';
  /** Socket only: `store` admission, `recent` in-memory retry hit, or `filter`. */
  source?: 'store' | 'recent' | 'filter' | undefined;
  filterReason?: 'own_message' | 'own_message_changed' | 'own_reaction' | undefined;
  /** Socket only: wait for the delivery's thread order and an admission slot. */
  queueMs?: number | undefined;
  /** Socket only: the durable admission call itself. */
  admitMs?: number | undefined;
  /** Socket only: admissions already running when this delivery arrived. */
  inFlight?: number | undefined;
}

/** Slack's fixed event vocabulary (type and subtype), never content. */
function slackEventTokens(delivery: GatewayInboundDelivery): { eventType?: string; subtype?: string } {
  if (delivery.kind !== 'event.deliver') return {};
  const event = delivery.envelope.event as unknown as Record<string, unknown> | undefined;
  return {
    ...(typeof event?.type === 'string' ? { eventType: event.type } : {}),
    ...(typeof event?.subtype === 'string' ? { subtype: event.subtype } : {}),
  };
}

const DELIVERY_KIND: Readonly<Record<GatewayInboundDelivery['kind'], string>> = {
  'event.deliver': 'event',
  'interaction.agent_selected': 'agent_selected',
  'interaction.channel_agent_add': 'channel_agent_add',
  'interaction.ui_action': 'ui_action',
  'interaction.view_submission': 'view_submission',
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
      ...slackEventTokens(observation.delivery),
      outcome: observation.outcome,
      source: observation.source,
      filterReason: observation.filterReason,
      queueMs: observation.queueMs,
      admitMs: observation.admitMs,
      inFlight: observation.inFlight,
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
