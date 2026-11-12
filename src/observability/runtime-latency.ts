import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import type { FlueExecutionOperation, FlueObservation, ModelRequestInput } from '@flue/runtime';

import type { AnswerReleaseShadowRecord } from '../slack/answer-release.ts';
import type { HostReleaseRecord } from '../slack/host-release-relay.ts';
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
  | 'answer_release'
  | 'turn_fold'
  | 'state_rpc'
  | 'state_rpc_summary'
  | 'state_rpc_fallback'
  | 'slack_store_admission'
  | 'gateway_delivery'
  | 'thread_runner_alarm'
  | 'thread_runner_superseded'
  | 'runner_boot'
  | 'agent_boot'
  | 'store_boot'
  | 'slack_read'
  | 'interaction_judgment'
  | 'model_step';

type RuntimeLatencyValue = number | boolean | string;

export interface RuntimeLatencySink {
  info(record: Record<string, unknown>): void;
}

const TOKEN = /^[a-z][a-z0-9_]{0,63}$/i;
const OPAQUE_REF = /^(run|turn)_[0-9a-f]{24}$/;
/** A Cloudflare Worker version id (a UUID), or a fixed token instead of one. */
const VERSION_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z][a-z0-9_]{0,63})$/i;
/** What `modelToken` returns. */
const MODEL_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;

/** The only string fields any event may carry, and their allowed shapes. */
const STRING_FIELDS: Readonly<Record<string, RegExp>> = {
  outcome: TOKEN,
  lane: TOKEN,
  executor: TOKEN,
  firstWrite: TOKEN,
  firstAnswerText: TOKEN,
  final: TOKEN,
  block: TOKEN,
  late: TOKEN,
  hostRelease: TOKEN,
  hostBlock: TOKEN,
  hostLate: TOKEN,
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
  path: TOKEN,
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
  modelToken: MODEL_TOKEN,
  scope: TOKEN,
  slowestMethod: TOKEN,
  purpose: TOKEN,
  largestToolResultTool: /^[A-Za-z][A-Za-z0-9_-]{0,127}$/,
};

/**
 * A model id as a log token, so records can be read per model:
 * `anthropic/claude-opus-5.5` becomes `anthropic_claude_opus_5_5`. Lowercase,
 * every character outside a-z and 0-9 becomes `_`, cut to 64 characters, and
 * `unknown` when there is no id or it does not start with a letter.
 */
export function modelToken(modelId: string | undefined): string {
  const token = (modelId ?? '').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 64);
  return MODEL_TOKEN.test(token) ? token : 'unknown';
}

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
   * An idle firing inside a conversation's keep-warm window (TagStateStore):
   * it re-armed the tick that keeps the store in memory.
   */
  keepWarm: boolean;
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
    keepWarm: false,
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
    keepWarm: metrics.keepWarm,
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
// runner_boot, agent_boot and store_boot: one record per in-memory activation
// of a SlackThreadRunner, a Flue agent's Durable Object, or a TagStateStore.

/** What a runner activation served first: an RPC, its alarm, or a host function. */
export type RunnerBootMethod = keyof SlackThreadRunnerRpc | 'alarm' | 'host';

/**
 * What an agent activation served first: the runner's wake once the turn's
 * plan froze, a staged turn input, a request (a Flue dispatch or
 * observation), its alarm, or a host function. Naming the object (`setName`)
 * precedes the first of these and is not one.
 */
export type AgentBootMethod = 'wake' | 'stage' | 'fetch' | 'alarm' | 'host';

/** What a state store activation served first: an RPC, or its alarm. */
export type StoreBootMethod = 'rpc' | 'alarm';

/** Activations this isolate has constructed, by kind. */
const activations = { runner_boot: 0, agent_boot: 0, store_boot: 0 };

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
    protected readonly fields: Record<string, RuntimeLatencyValue | undefined>,
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

/**
 * A TagStateStore activation's marks, logged as `store_boot`. No caller sends
 * its clock, so a cold store shows as this record's time against the
 * delivery's arrival. `versionChanged`: this activation installed the schema,
 * the first on its Worker version.
 */
export class StoreBootMarks extends ObjectBootMarks<StoreBootMethod> {
  constructor(now: () => number = Date.now, sink?: RuntimeLatencySink) {
    super('store_boot', {}, now, sink);
  }

  constructedOnVersion(versionChanged: boolean): void {
    this.fields.versionChanged = versionChanged;
    this.constructed();
  }
}

/** Focused tests only: the next activation of each kind is this isolate's first. */
export function resetRunnerActivationsForTest(): void {
  activations.runner_boot = 0;
  activations.agent_boot = 0;
  activations.store_boot = 0;
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

/**
 * Where the attempt first showed answer text: `stream` when Slack
 * acknowledged a stream start with text, or the first text on a task-card
 * stream; `final` when the terminal was delivered.
 */
export type TurnAnswerTextSurface = 'stream' | 'final';

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

/**
 * The model work a turn's reply observation saw for its submission: model
 * steps (Flue's per-step turn ids), tool calls, and the tools' own reported
 * time.
 */
export interface TurnWork {
  modelSteps: number;
  toolCalls: number;
  toolMs: number;
}

export class TurnLatencyTracker {
  private readonly startedAt: number;
  private modelStartAt: number | undefined;
  private work: TurnWork | undefined;
  private stateRpcs: StateRpcSummary | undefined;
  private firstWrite: { surface: TurnFirstWrite; at: number } | undefined;
  private answerText: { surface: TurnAnswerTextSurface; at: number } | undefined;
  private answerVisibleAt: number | undefined;
  private final: { kind: 'delivered' | 'deferred'; at: number } | undefined;
  private folded = 0;
  private foldedInformed = 0;
  private read = 0;
  private midRunReplies = 0;
  private stalledReads = 0;
  private agentStageMs: number | undefined;
  private agentWake: { sentAt: number; source: 'admission' | 'plan' } | undefined;
  private agentWakeLeadMs: number | undefined;
  private startToStageMs: number | undefined;
  private titleMs: number | undefined;
  private taskCardStreamed = false;
  private hostRelease: HostReleaseRecord | undefined;
  private emitted = false;

  /** `model`: the model id the turn runs with, logged as its `modelToken`. */
  constructor(
    private readonly context: TurnLatencyContext,
    private readonly ids: { turnJobId?: string; runId?: string; attempt?: number; model?: string | undefined },
    private readonly now: () => number = Date.now,
    private readonly sink?: RuntimeLatencySink,
  ) {
    this.startedAt = now();
    if (context.admissionStatusAt !== undefined) {
      this.firstWrite = { surface: 'admission_status', at: context.admissionStatusAt };
    }
  }

  /** Run the attempt with its state store calls counted, logged as `state_rpc_summary` (scope `turn`). */
  observeStateRpcs<T>(attempt: () => Promise<T>): Promise<T> {
    this.stateRpcs ??= new StateRpcSummary('turn', this.now, this.sink);
    return this.stateRpcs.run(attempt);
  }

  /** The turn's Flue dispatch is being sent: its model starts. Only the first is kept. */
  markModelStart(): void {
    if (this.modelStartAt !== undefined) return;
    this.modelStartAt = this.now();
    this.stateRpcs?.markModelStart();
  }

  /** The model work observed so far; the latest replaces the last. */
  markWork(work: TurnWork): void {
    this.work = { ...work };
  }

  /** Record an acknowledged Slack write; only the first one is kept. */
  markSlackWrite(surface: TurnFirstWrite): void {
    if (!this.firstWrite) this.firstWrite = { surface, at: this.now() };
  }

  /** Slack acknowledged answer text on a stream; only the first is kept. */
  markStreamedAnswerText(): void {
    this.answerText ??= { surface: 'stream', at: this.now() };
  }

  /** Slack acknowledged the call that completes the final's text; only the first is kept. */
  markAnswerVisible(): void {
    this.answerVisibleAt ??= this.now();
  }

  /** Slack acknowledged native task card rows on the reply's stream before its terminal. */
  markTaskCardStreamed(): void {
    this.taskCardStreamed = true;
  }

  /**
   * What the host answer release did; the latest replaces the last. Text it
   * retired was not the answer, so the answer's first text is the final's.
   */
  markHostRelease(record: HostReleaseRecord): void {
    this.hostRelease = { ...record };
    if (record.outcome === 'retired' && this.answerText?.surface === 'stream') this.answerText = undefined;
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

  /** A read of the reply had not answered in time, and a fresh one joined it. */
  markStalledRead(): void {
    this.stalledReads += 1;
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

  /** Slack answered the thread title's call after this long; only the first is kept. */
  markTitle(ms: number): void {
    this.titleMs ??= ms;
  }

  /** The terminal was delivered, or handed to a durable outbox. */
  markFinal(kind: 'delivered' | 'deferred'): void {
    if (this.final) return;
    const at = this.now();
    this.final = { kind, at };
    if (kind === 'delivered' && !this.firstWrite) this.firstWrite = { surface: 'final', at };
    if (kind === 'delivered') this.answerText ??= { surface: 'final', at };
  }

  /**
   * Emit exactly once, when the attempt returns or throws. `stopped`: it
   * returned with a stopped run's ending (KTD3), which is not a failure.
   * `answerRelease`, the attempt's shadow of the host release rule, adds an
   * `answer_release` record and the time a release would have shown the
   * answer, without changing anything Slack showed. `reason`: why a thrown
   * attempt ended without a final, a fixed token.
   */
  emit(outcome: 'returned' | 'threw' | 'stopped', answerRelease?: AnswerReleaseShadowRecord, reason?: string): void {
    if (this.emitted) return;
    this.emitted = true;
    const { admittedAt, receivedAt } = this.context;
    const since = (at: number | undefined) =>
      admittedAt === undefined || at === undefined ? undefined : at - admittedAt;
    const sinceReceipt = (at: number | undefined) =>
      receivedAt === undefined || at === undefined ? undefined : at - receivedAt;
    const end = this.now();
    const answerTextAt = this.answerText?.at;
    // Only a release nothing followed shows the answer early; a retired one
    // leaves the answer to the terminal.
    const releasedAnswerAt = answerRelease?.outcome === 'released' ? answerRelease.releasedAt : undefined;
    const shadowAnswerTextAt = releasedAnswerAt === undefined ? answerTextAt
      : Math.min(releasedAnswerAt, answerTextAt ?? releasedAnswerAt);
    const model = modelToken(this.ids.model);
    emitRuntimeLatency('turn_latency', {
      turnRef: opaqueTurnRef(this.ids.turnJobId),
      runRef: opaqueRunRef(this.ids.runId),
      lane: this.context.lane,
      executor: this.context.executor,
      attempt: this.ids.attempt,
      modelToken: model,
      outcome,
      reason,
      firstWrite: this.firstWrite?.surface ?? 'none',
      final: this.final?.kind ?? 'none',
      admissionToStartMs: since(this.startedAt),
      admissionToFirstWriteMs: since(this.firstWrite?.at),
      admissionToFinalMs: this.final?.kind === 'delivered' ? since(this.final.at) : undefined,
      admissionToModelStartMs: since(this.modelStartAt),
      receiptToAdmissionMs: sinceReceipt(admittedAt),
      receiptToFirstWriteMs: sinceReceipt(this.firstWrite?.at),
      receiptToModelStartMs: sinceReceipt(this.modelStartAt),
      receiptToFinalMs: this.final?.kind === 'delivered' ? sinceReceipt(this.final.at) : undefined,
      firstAnswerText: this.answerText?.surface ?? 'none',
      admissionToFirstAnswerTextMs: since(answerTextAt),
      receiptToFirstAnswerTextMs: sinceReceipt(answerTextAt),
      admissionToAnswerVisibleMs: since(this.answerVisibleAt),
      receiptToAnswerVisibleMs: sinceReceipt(this.answerVisibleAt),
      admissionToShadowAnswerTextMs: since(shadowAnswerTextAt),
      receiptToShadowAnswerTextMs: sinceReceipt(shadowAnswerTextAt),
      handoffMs: this.context.handoffMs,
      runnerWakeLeadMs: this.context.runnerWakeLeadMs,
      admissionStatusMs: this.context.admissionStatusMs,
      agentStageMs: this.agentStageMs,
      agentWakeLeadMs: this.agentWakeLeadMs,
      agentWakeSource: this.agentWakeLeadMs === undefined ? undefined : this.agentWake?.source,
      startToStageMs: this.startToStageMs,
      titleMs: this.titleMs,
      attemptMs: end - this.startedAt,
      folded: this.folded > 0 ? this.folded : undefined,
      foldedInformed: this.foldedInformed > 0 ? this.foldedInformed : undefined,
      read: this.read > 0 ? this.read : undefined,
      midRunReplies: this.midRunReplies > 0 ? this.midRunReplies : undefined,
      stalledReads: this.stalledReads > 0 ? this.stalledReads : undefined,
      modelSteps: this.work?.modelSteps,
      toolCalls: this.work?.toolCalls,
      toolMs: this.work?.toolMs,
    }, this.sink);
    if (answerRelease) {
      const { releasedAt, ...shadow } = answerRelease;
      emitRuntimeLatency('answer_release', {
        turnRef: opaqueTurnRef(this.ids.turnJobId),
        runRef: opaqueRunRef(this.ids.runId),
        attempt: this.ids.attempt,
        modelToken: model,
        ...shadow,
        taskCardStream: this.taskCardStreamed,
        hostRelease: this.hostRelease?.outcome,
        hostBlock: this.hostRelease?.outcome === 'blocked' ? this.hostRelease.block : undefined,
        hostLate: this.hostRelease && 'late' in this.hostRelease ? this.hostRelease.late : undefined,
        retiredVisibleMs: this.hostRelease && 'retiredVisibleMs' in this.hostRelease
          ? this.hostRelease.retiredVisibleMs
          : undefined,
        admissionToReleaseMs: since(releasedAt),
        receiptToReleaseMs: sinceReceipt(releasedAt),
      }, this.sink);
    }
    this.stateRpcs?.emit({ turnJobId: this.ids.turnJobId });
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
    earlyMs?: number;
    rejudged?: boolean;
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
    earlyMs: record.earlyMs,
    rejudged: record.rejudged,
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
  const tally = stateRpcScopes.getStore();
  const startedAt = Date.now();
  tally?.start(startedAt);
  let ok = false;
  try {
    if (PERF_STATE_RPC_DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, PERF_STATE_RPC_DELAY_MS));
    const result = await pending;
    ok = true;
    return result;
  } finally {
    const endedAt = Date.now();
    tally?.end(method, endedAt - startedAt, ok, endedAt);
    recordStateRpc(method, endedAt - startedAt, ok, op);
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
// state_rpc_summary: every state store call one scope made, timed at the
// caller. `state_rpc` samples only slow calls, so its medians are the slow
// tail's; this record counts them all.

/**
 * `slack_delivery`: a direct delivery from Core's handler to its admission
 * chain's end. `turn`: one turn attempt. `store_admission`: a delivery the
 * state store admits itself, whose calls over RPC must be none.
 */
export type StateRpcScope = 'slack_delivery' | 'turn' | 'store_admission';

/**
 * A scope's calls. A round is a run of overlapping calls: one starts while
 * none is in flight. `busyMs` is the time at least one call was in flight.
 */
class StateRpcTally {
  calls = 0;
  failed = 0;
  rounds = 0;
  totalMs = 0;
  slowest: { method: string; ms: number } | undefined;
  private busyMs = 0;
  private inFlight = 0;
  private busySince = 0;

  start(at: number): void {
    this.calls += 1;
    if (this.inFlight === 0) {
      this.rounds += 1;
      this.busySince = at;
    }
    this.inFlight += 1;
  }

  end(method: string, ms: number, ok: boolean, at: number): void {
    this.totalMs += ms;
    if (!ok) this.failed += 1;
    if (!this.slowest || ms > this.slowest.ms) this.slowest = { method, ms };
    this.inFlight -= 1;
    if (this.inFlight === 0) this.busyMs += at - this.busySince;
  }

  busyAt(at: number): number {
    return this.busyMs + (this.inFlight > 0 ? at - this.busySince : 0);
  }
}

const stateRpcScopes = new AsyncLocalStorage<StateRpcTally>();

/** One scope's state store calls, logged once as `state_rpc_summary`. */
export class StateRpcSummary {
  private readonly tally = new StateRpcTally();
  private readonly startedAt: number;
  private beforeModelStart: { calls: number; rounds: number; busyMs: number } | undefined;
  private emitted = false;

  constructor(
    private readonly scope: StateRpcScope,
    private readonly now: () => number = Date.now,
    private readonly sink?: RuntimeLatencySink,
  ) {
    this.startedAt = now();
  }

  /** Count every state store call `fn` makes, including work it starts and does not await. */
  run<T>(fn: () => T): T {
    return stateRpcScopes.run(this.tally, fn);
  }

  /** The calls counted so far. */
  get calls(): number {
    return this.tally.calls;
  }

  /** The turn's model starts: the calls so far are the ones before it. Only the first is kept. */
  markModelStart(): void {
    this.beforeModelStart ??= {
      calls: this.tally.calls,
      rounds: this.tally.rounds,
      busyMs: this.tally.busyAt(this.now()),
    };
  }

  /**
   * Logged once, and only when the scope made a call (a Node turn makes
   * none). `receivedAt`: the delivery's receipt, so the record shows how long
   * it waited before this scope.
   */
  emit(fields: {
    turnJobId?: string | undefined;
    receivedAt?: number | undefined;
    /** `slack_delivery`: who admitted it (`store`, `worker`, `fallback`), and on a fallback why. */
    path?: 'store' | 'worker' | 'fallback';
    reason?: string | undefined;
  } = {}): void {
    if (this.emitted) return;
    this.emitted = true;
    if (this.tally.calls === 0) return;
    const at = this.now();
    const { tally, beforeModelStart } = this;
    emitRuntimeLatency('state_rpc_summary', {
      scope: this.scope,
      turnRef: opaqueTurnRef(fields.turnJobId),
      calls: tally.calls,
      rounds: tally.rounds,
      totalMs: tally.totalMs,
      busyMs: tally.busyAt(at),
      failed: tally.failed > 0 ? tally.failed : undefined,
      slowestMethod: tally.slowest?.method,
      slowestMs: tally.slowest?.ms,
      spanMs: at - this.startedAt,
      receiptToStartMs: fields.receivedAt === undefined ? undefined : this.startedAt - fields.receivedAt,
      path: fields.path,
      reason: fields.reason,
      callsBeforeModelStart: beforeModelStart?.calls,
      roundsBeforeModelStart: beforeModelStart?.rounds,
      busyMsBeforeModelStart: beforeModelStart?.busyMs,
    }, this.sink);
  }
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

// ---------------------------------------------------------------------------
// model_step: one record per model request, from Flue's observations in the
// object that makes it.

/** Requests started and not yet ended that one isolate keeps marks for. */
const MODEL_STEP_OPEN_LIMIT = 64;
const FIRST_TOKEN_EVENTS: ReadonlySet<FlueObservation['type']> = new Set([
  'text_delta', 'thinking_start', 'thinking_delta', 'toolcall_delta',
]);

interface ModelRequestSize {
  /** UTF-8 bytes of the model input as JSON, as Flue assembled it: system prompt, messages and tools. */
  requestBytes: number;
  toolResults: number;
  /** UTF-8 bytes of the largest tool result's text, and an image's base64 characters. */
  largestToolResultBytes?: number;
  largestToolResultTool?: string;
}

const utf8 = new TextEncoder();

/** Sizes only: the input is measured, never kept. */
function modelRequestSize(input: ModelRequestInput): ModelRequestSize {
  let toolResults = 0;
  let largest: { bytes: number; tool: string } | undefined;
  for (const message of input.messages) {
    if (message.role !== 'toolResult') continue;
    toolResults += 1;
    const bytes = message.content.reduce((sum, part) =>
      sum + (part.type === 'text' ? utf8.encode(part.text).byteLength : part.data.length), 0);
    if (!largest || bytes > largest.bytes) largest = { bytes, tool: message.toolName };
  }
  return {
    // Counted without a second copy of the input: it can hold megabytes of image data.
    requestBytes: Buffer.byteLength(JSON.stringify(input)),
    toolResults,
    ...(largest ? { largestToolResultBytes: largest.bytes, largestToolResultTool: largest.tool } : {}),
  };
}

interface OpenModelStep {
  readonly startedAt: number;
  firstTokenAt?: number;
  firstTextAt?: number;
  upstreamFirstTextAt?: number;
  size?: ModelRequestSize;
}

const upstreamFirstTextMarks = new AsyncLocalStorage<() => void>();

/**
 * Inside a model step's request, stamps the step's `upstreamFirstTextMs` the
 * first time it is called. The model access proxy calls it as the provider's
 * first answer text reaches the Worker, before any parser reads it.
 */
export function upstreamFirstTextMark(): (() => void) | undefined {
  return upstreamFirstTextMarks.getStore();
}

/**
 * Times each model request from Flue's `turn_request` to its first streamed
 * token (text, thinking, or a tool call's arguments), to its first non-empty
 * text, and to the provider's first text on the wire, and logs the model that
 * served it, Flue's duration, its token counts and its tool calls when its
 * `turn` ends, with the request's size measured at `turn_request`.
 * `inputTokens` excludes the cached input that `cachedInputTokens` counts.
 */
export class ModelStepMarks {
  private readonly open = new Map<string, OpenModelStep>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sink?: RuntimeLatencySink,
  ) {}

  /** Runs a Flue model operation with its open step's `upstreamFirstTextMark` in scope. */
  intercept<T>(operation: FlueExecutionOperation, next: () => Promise<T>): Promise<T> {
    const open = operation.type === 'model' ? this.open.get(operation.turnId) : undefined;
    if (!open) return next();
    return upstreamFirstTextMarks.run(() => {
      open.upstreamFirstTextAt ??= this.now();
    }, next);
  }

  /** `turnJobIdOf`: the Slack turn the request belongs to, read only when a request ends. */
  observe(event: FlueObservation, turnJobIdOf: () => string | undefined = () => undefined): void {
    try {
      const { turnId } = event;
      if (turnId === undefined) return;
      if (event.type === 'turn_request') {
        this.open.delete(turnId);
        const startedAt = this.now();
        let size: ModelRequestSize | undefined;
        try {
          size = modelRequestSize(event.request.input);
        } catch {
          // A request that cannot be measured is still timed.
        }
        this.open.set(turnId, { startedAt, ...(size ? { size } : {}) });
        if (this.open.size > MODEL_STEP_OPEN_LIMIT) this.open.delete(this.open.keys().next().value!);
        return;
      }
      if (FIRST_TOKEN_EVENTS.has(event.type)) {
        const open = this.open.get(turnId);
        if (!open) return;
        const at = this.now();
        open.firstTokenAt ??= at;
        if (event.type === 'text_delta' && event.text.length > 0) open.firstTextAt ??= at;
        return;
      }
      if (event.type !== 'turn') return;
      const open = this.open.get(turnId);
      this.open.delete(turnId);
      let turnJobId: string | undefined;
      try {
        turnJobId = turnJobIdOf();
      } catch {
        // A step whose turn cannot be read is still logged, without its turn.
      }
      const { usage, output, finishReason } = event.response;
      const { request } = event;
      emitRuntimeLatency('model_step', {
        turnRef: opaqueTurnRef(turnJobId),
        modelToken: modelToken(request && `${request.providerId}/${request.requestedModel}`),
        purpose: event.purpose,
        outcome: event.isError ? 'error' : finishReason,
        durationMs: event.durationMs,
        firstTokenMs: open?.firstTokenAt === undefined ? undefined : open.firstTokenAt - open.startedAt,
        firstTextMs: open?.firstTextAt === undefined ? undefined : open.firstTextAt - open.startedAt,
        upstreamFirstTextMs: open?.upstreamFirstTextAt === undefined ? undefined : open.upstreamFirstTextAt - open.startedAt,
        inputTokens: usage?.input,
        cachedInputTokens: usage?.cacheRead,
        cacheWriteTokens: usage?.cacheWrite,
        outputTokens: usage?.output,
        toolCalls: output?.content.filter((part) => part.type === 'toolCall').length,
        ...open?.size,
      }, this.sink);
    } catch {
      // Observability is best effort and never changes the model request.
    }
  }
}
