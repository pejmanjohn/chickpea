import type { SlackStatusUpdate } from './replies.ts';
import { THREAD_TTL_MS } from './state-limits.ts';
import {
  emitSemanticActivityTelemetry,
  semanticTelemetryForStatus,
  type SemanticActivityQueueDisposition,
  type SemanticActivityTelemetrySink,
} from '../activity/telemetry.ts';
import { activityShowsProgress, isSafeTypedActivityStatus } from '../activity/status.ts';

/**
 * A run with no real progress for this long is quiet: its turn stops
 * refreshing the custom status and hands the thread back to Slack's native
 * working indicator, which carries the Stop button (KTD7). The next progress
 * brings the custom status back.
 */
export const SLACK_RUN_QUIET_AFTER_MS = 5 * 60_000;

/**
 * Slack moves an Agent Session out of `processing` an hour after its status
 * was last sent, and its Stop button goes with it. While a run's thread shows
 * the native indicator (its start, and every quiet stretch), the turn sends
 * `processing` again at most this often, well inside that hour (KTD6).
 */
export const SLACK_NATIVE_PROCESSING_KEEPALIVE_MS = 45 * 60_000;

/** A keepalive Slack did not take is tried again this much later. */
const NATIVE_KEEPALIVE_RETRY_MS = 5 * 60_000;

/** The time since a run's last real progress, as a check-in says it (KTD8). */
export type SlackRunQuietBucket = '5+' | '10+' | '15+' | '30+' | '60+';

const QUIET_BUCKETS: ReadonlyArray<readonly [minutes: number, bucket: SlackRunQuietBucket]> = [
  [60, '60+'],
  [30, '30+'],
  [15, '15+'],
  [10, '10+'],
  [5, '5+'],
];

/** The bucket for a time since progress, or undefined under five minutes. */
export function slackRunQuietBucket(sinceProgressMs: number): SlackRunQuietBucket | undefined {
  for (const [minutes, bucket] of QUIET_BUCKETS) {
    if (sinceProgressMs >= minutes * 60_000) return bucket;
  }
  return undefined;
}

/**
 * What a check-in reports about one run (KTD8). The registry keeps them per
 * turn generation (the TurnJob id), and its owner persists them (a thread
 * runner in its own storage) so an admission can answer after an eviction.
 */
export interface SlackRunFacts {
  /** When the run's first attempt registered its status. */
  startedAt: number;
  /** The fixed-copy phrase the status line shows, or would show while quiet. */
  step?: string;
  /** The run's last real progress; its start while it has made none. */
  progressAt: number;
  /** Workspace milestones already counted, by position in the reply. */
  milestones: number;
}

/** Where run facts outlive a turn registration, keyed by turn generation. */
export interface SlackRunFactsStore {
  load(generation: string): SlackRunFacts | undefined;
  save(generation: string, facts: SlackRunFacts): void;
}

/** Run facts as a check-in reads them. Content-free: fixed copy and times. */
export interface SlackRunFactsView {
  startedAt: number;
  step?: string;
  progressAt: number;
  /** The time since the last progress; absent under five minutes. */
  quietFor?: SlackRunQuietBucket;
  /** When they were read, on the clock of `startedAt` (run time: `at - startedAt`). */
  at: number;
}

export function slackRunFactsView(facts: SlackRunFacts, now: number): SlackRunFactsView {
  const quietFor = slackRunQuietBucket(now - facts.progressAt);
  return {
    startedAt: facts.startedAt,
    ...(facts.step === undefined ? {} : { step: facts.step }),
    progressAt: facts.progressAt,
    ...(quietFor ? { quietFor } : {}),
    at: now,
  };
}

/**
 * Real progress a turn reports itself; tool activity and the coding worker's
 * stages arrive as observed status instead.
 */
export type SlackRunProgress = {
  kind: 'milestone';
  /** How many distinct workspace milestone records the reply has shown. */
  sequence: number;
};

export interface SlackStatusRegistryOptions {
  /** Where run facts outlive a turn registration; this isolate's memory by default. */
  runFacts?: SlackRunFactsStore;
  /** Overrides SLACK_RUN_QUIET_AFTER_MS for deterministic focused tests. */
  quietAfterMs?: number;
  /** Overrides SLACK_NATIVE_PROCESSING_KEEPALIVE_MS for deterministic focused tests. */
  nativeKeepaliveMs?: number;
}

interface SlackStatusTurnRegistration {
  setStatus(update: SlackStatusUpdate): Promise<boolean>;
  drain(): Promise<void>;
  /** Fence narration and drop queued work before final delivery. */
  prepareFinal(): Promise<void>;
  close(): void;
  /** Fence new writes, clear now, and clear once more if an in-flight write lands late. */
  finish(clearStatus: (late: boolean) => Promise<void>): Promise<void>;
  /**
   * Route observed activity for this turn under another instance id. A turn
   * registers before its agent instance is known so it can show its admitted
   * status at once; observations only arrive after dispatch.
   */
  rebind(instanceId: string): void;
  /**
   * Real progress the turn reports itself. A workspace milestone counts by
   * its position in the reply: a reattached turn replays the reply from its
   * start, and a replayed record must not restart the quiet clock.
   */
  progress(event: SlackRunProgress): void;
  /** This run's facts now. */
  runFacts(): SlackRunFacts;
  /**
   * Slack's native indicator now shows for this run: keep it alive (KTD6)
   * until a custom status takes over (`releaseNative`) or the turn ends.
   * `sent`: this attempt just sent `processing`. Otherwise it carries over
   * from an earlier attempt, and the keepalive counts from the last send this
   * registry saw for the run, else from the run's start.
   */
  holdNative(sent: boolean): void;
  /**
   * A custom status is about to take over from the native indicator: stop
   * keeping it alive. Resolves once a keepalive already in flight has landed,
   * so the hand-over's release reaches Slack after it.
   */
  releaseNative(): Promise<void>;
}

interface StatusPresenter {
  setStatus(update: SlackStatusUpdate): Promise<boolean>;
  /** Native-only same-fact refresh; absent presenters simply stop refreshing. */
  refreshStatus?(update: SlackStatusUpdate): Promise<boolean>;
  /**
   * After a failed write: whether the status already shown is still valid
   * (a failed reservation or refresh preparation, not a latched Slack
   * rejection), so the refresh must be re-armed before Slack expires it.
   */
  refreshRetryable?(): boolean;
  /**
   * The run went quiet: show Slack's native working indicator, with its Stop
   * button, instead of the custom status. True once it shows; the next custom
   * write hands the thread back from it. Without it (or when it cannot show)
   * the turn keeps its custom status rather than showing nothing.
   */
  showNativeIndicator?(): Promise<boolean>;
  /**
   * The native indicator shows: send `processing` again so Slack keeps it,
   * and its Stop button, past its one-hour timeout (KTD6). True once Slack
   * took it. The indicator stays held: the next custom write releases it first.
   */
  keepNativeIndicator?(): Promise<boolean>;
}

interface SlackStatusTurnOptions {
  /** Opaque identity for the logical turn that owns observed activity. */
  generation: string;
  /** Monotonic admitted-message generation used by canonical V3 turns. */
  sessionGeneration?: number;
  /** Slack thread/session key whose visible status is shared across Agent handoffs. */
  ownershipKey?: string;
  /** Deterministic clock for focused generation-history and run-facts tests. */
  now?: () => number;
  /**
   * Detailed observations can arrive several times within one model/tool
   * burst. Keep their Slack writes to at most one per second by default while
   * still allowing the turn's own deliberate lifecycle statuses immediately.
   * The override exists for deterministic focused tests.
   */
  observedMinIntervalMs?: number;
  /** Refresh a still-current native phrase before Slack's two-minute expiry. */
  refreshIntervalMs?: number;
  /** Durable proof that this exact phrase is already visible from admission. */
  initialAppliedStatus?: SlackStatusUpdate;
  /** A rehydrated receipt has no visibility age, so refresh it immediately. */
  refreshInitialStatus?: boolean;
  /** Fixed-schema content-free observability; injectable for focused tests. */
  telemetry?: SemanticActivityTelemetrySink;
}

interface QueuedStatusWrite {
  update: SlackStatusUpdate;
  observed: boolean;
  refresh: false | 'ordinary' | 'validated';
  result: Promise<boolean>;
  resolve(result: boolean): void;
}

/** One run's quiet clock, as its turn registers. */
interface SlackRunClock {
  now: () => number;
  quietAfterMs: number;
  nativeKeepaliveMs: number;
  facts: SlackRunFacts;
  /** No earlier attempt saved them: save at once. */
  fresh: boolean;
}

const DEFAULT_OBSERVED_STATUS_MIN_INTERVAL_MS = 1_000;
const DEFAULT_STATUS_REFRESH_INTERVAL_MS = 90_000;
const STATUS_REFRESH_RETRY_MS = 15_000;
/** Run facts are saved at most this often; a new milestone is saved at once. */
const RUN_FACTS_SAVE_INTERVAL_MS = 30_000;
const MEMORY_RUN_FACTS_LIMIT = 256;

class ActiveSlackStatusTurn implements SlackStatusTurnRegistration {
  private active: QueuedStatusWrite | undefined;
  private pending: QueuedStatusWrite | undefined;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private lastObservedWriteStartedAt: number | undefined;
  private lastAppliedText: string | undefined;
  /** The last custom status Slack accepted, reasserted when a quiet stretch ends. */
  private shown: SlackStatusUpdate | undefined;
  private closed = false;
  private finished = false;
  private terminalizing = false;
  private ownershipReady: boolean;
  private readonly now: () => number;
  private readonly quietAfterMs: number;
  private readonly facts: SlackRunFacts;
  /**
   * The run is quiet and Slack's native indicator shows (see `enterQuiet`):
   * no custom write reaches Slack until the next progress.
   */
  private quiet = false;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  /** The native hand-back in flight; custom writes wait behind it. */
  private handingBack: Promise<void> | undefined;
  private factsTimer: ReturnType<typeof setTimeout> | undefined;
  private factsDirty = false;
  private factsSavedAt: number | undefined;
  private readonly nativeKeepaliveMs: number;
  /** Slack's native indicator shows and is kept alive (KTD6). */
  private nativeHeld = false;
  private nativeTimer: ReturnType<typeof setTimeout> | undefined;
  /** A keepalive in flight: the hand-over and the settle wait for it. */
  private nativeKeepalive: Promise<void> | undefined;

  constructor(
    private readonly registry: SlackStatusRegistry,
    private instanceId: string,
    private readonly ownershipKey: string,
    private readonly generation: string,
    private readonly presenter: StatusPresenter,
    private readonly observedMinIntervalMs: number,
    private readonly refreshIntervalMs: number,
    private readonly telemetry: SemanticActivityTelemetrySink,
    private readonly sessionGeneration: number | undefined,
    private acceptsWrites: boolean,
    ownershipBarrier: Promise<void> | undefined,
    initialAppliedStatus: SlackStatusUpdate | undefined,
    refreshInitialStatus: boolean | undefined,
    clock: SlackRunClock,
  ) {
    this.now = clock.now;
    this.quietAfterMs = clock.quietAfterMs;
    this.nativeKeepaliveMs = clock.nativeKeepaliveMs;
    this.facts = clock.facts;
    this.ownershipReady = ownershipBarrier === undefined;
    if (ownershipBarrier) {
      void ownershipBarrier.finally(() => {
        this.ownershipReady = true;
        this.scheduleNext();
      });
    }
    if (clock.fresh) this.saveFacts(true);
    if (initialAppliedStatus) {
      this.lastAppliedText = initialAppliedStatus.text;
      this.shown = initialAppliedStatus;
      // A reattached run that is already quiet shows the native indicator
      // (below), not its old phrase again.
      if (!this.quietDue()) {
        this.scheduleRefresh(
          initialAppliedStatus,
          refreshInitialStatus ? 0 : this.refreshIntervalMs,
          'validated',
        );
      }
    }
    this.armQuiet();
  }

  setStatus(update: SlackStatusUpdate): Promise<boolean> {
    return this.enqueue(update, false, false);
  }

  setObservedStatus(update: SlackStatusUpdate): Promise<boolean> {
    // Observed activity arrives live from the Agent (a tool starting or
    // settling, a coding worker's stage), timed as it lands.
    if (activityShowsProgress(update)) this.noteProgress(update);
    return this.enqueue(update, true, false);
  }

  progress(event: SlackRunProgress): void {
    if (event.kind !== 'milestone') return;
    // Only a record past those already counted is new: the rest are the
    // reply replayed from its start by a reattached read.
    if (!(event.sequence > this.facts.milestones)) return;
    this.facts.milestones = event.sequence;
    this.noteProgress();
    this.saveFacts(true);
  }

  runFacts(): SlackRunFacts {
    return { ...this.facts };
  }

  holdNative(sent: boolean): void {
    if (this.closed || this.terminalizing || !this.presenter.keepNativeIndicator) return;
    const now = this.now();
    if (sent) this.registry.noteNativeProcessing(this.generation, now);
    const sentAt = sent
      ? now
      : this.registry.nativeProcessingAt(this.generation) ?? this.facts.startedAt;
    this.nativeHeld = true;
    this.armNativeKeepalive(sentAt + this.nativeKeepaliveMs - now);
  }

  async releaseNative(): Promise<void> {
    this.endNative();
    await this.nativeKeepalive;
  }

  rebind(instanceId: string): void {
    if (this.closed || instanceId === this.instanceId) return;
    this.registry.rekey(this, this.instanceId, instanceId);
    this.instanceId = instanceId;
  }

  belongsTo(generation: string): boolean {
    return this.generation === generation;
  }

  admittedGeneration(): number | undefined {
    return this.sessionGeneration;
  }

  fenceByNewerGeneration(): Promise<void> {
    this.acceptsWrites = false;
    this.cancelRefresh();
    this.cancelQuiet();
    this.endNative();
    this.discardPending('stale_dropped');
    return this.active?.result.then(() => undefined) ?? Promise.resolve();
  }

  private enqueue(
    update: SlackStatusUpdate,
    observed: boolean,
    refresh: false | 'ordinary' | 'validated',
    retry = false,
  ): Promise<boolean> {
    if (!refresh && !retry && isSafeTypedActivityStatus(update)) {
      const produced = semanticTelemetryForStatus(update);
      emitSemanticActivityTelemetry({
        event: 'activity.produced',
        family: produced.family,
        phase: produced.phase,
        observed,
      }, this.telemetry);
    }
    if (this.closed || this.terminalizing) {
      this.emitQueue('terminal_dropped', observed);
      return Promise.resolve(false);
    }
    if (!this.ownsVisibleWrites()) {
      this.emitQueue('stale_dropped', observed);
      return Promise.resolve(false);
    }
    // While the run is quiet, Slack's native indicator (and its Stop button)
    // shows; only progress (which ends the quiet stretch first) writes again.
    if (this.quiet) return Promise.resolve(false);
    if (!refresh && isSafeTypedActivityStatus(update)) this.recordStep(update.text);
    if (!this.active && !this.pending && this.lastAppliedText === update.text) {
      this.emitQueue('duplicate', observed);
      return Promise.resolve(true);
    }

    // If the newest fact matches the write already in flight, that in-flight
    // value is already the desired final state. Discard any older queued fact.
    if (this.active?.update.text === update.text) {
      this.discardPending('superseded');
      this.emitQueue('coalesced', observed);
      return this.active.result;
    }
    if (this.pending?.update.text === update.text) {
      this.emitQueue('coalesced', observed);
      return this.pending.result;
    }

    this.cancelRefresh();

    // One in-flight write plus one replaceable pending value is the complete
    // queue. Rapid distinct events resolve their superseded promises false and
    // never replay stale intermediate statuses after the useful newest fact.
    const deferred = Promise.withResolvers<boolean>();
    const queued: QueuedStatusWrite = {
      update,
      observed,
      refresh,
      result: deferred.promise,
      resolve: deferred.resolve,
    };
    if (this.pending) {
      this.pending.resolve(false);
      this.emitQueue('superseded', this.pending.observed);
    }
    this.pending = queued;
    this.emitQueue('enqueued', observed);

    // A turn-owned lifecycle update takes precedence over a delayed observed
    // detail and should not inherit its throttle timer.
    if (!observed && this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    this.scheduleNext();
    return queued.result;
  }

  /**
   * The final answer supersedes any status that has not started. Drop that
   * pending value rather than making final delivery wait for a throttle timer,
   * then wait only for the single Slack write already in flight.
   */
  async drain(): Promise<void> {
    this.discardPending('terminal_dropped');
    if (this.active) {
      await this.active.result;
    }
    // A native hand-back or keepalive landing after the session settles
    // would show the working indicator on a finished run.
    if (this.handingBack) await this.handingBack;
    if (this.nativeKeepalive) await this.nativeKeepalive;
  }

  async prepareFinal(): Promise<void> {
    this.terminalizing = true;
    this.cancelRefresh();
    this.cancelQuiet();
    this.endNative();
    this.discardPending('terminal_dropped');
    // The final lands after a keepalive already in flight, never before it.
    if (this.nativeKeepalive) await this.nativeKeepalive;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelRefresh();
    this.cancelQuiet();
    this.endNative();
    // A yield ends this registration mid-run: the next attempt reads the
    // facts back, including what the throttle still held.
    if (this.factsDirty) this.saveFacts(true);
    this.discardPending('terminal_dropped');
    // Two turns in the same Slack conversation share one registry key
    // (workspace:channel:thread — and ALL DM turns share workspace:dm-channel:dm),
    // so each key holds a SET of live turns. Closing removes only this turn;
    // an earlier turn finishing never drops a later, still-running turn.
    this.registry.release(this, this.instanceId, this.ownershipKey);
  }

  async finish(clearStatus: (late: boolean) => Promise<void>): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.terminalizing = true;
    this.cancelRefresh();
    this.cancelQuiet();
    this.endNative();
    this.registry.forgetNativeProcessing(this.generation);
    const clearAuthority = this.ownsVisibleWrites();
    const activeResult = this.active?.result;
    this.close();
    const firstClear = this.clearIfUnowned(() => clearStatus(false), clearAuthority);
    if (activeResult) {
      void activeResult.finally(() => {
        return this.clearIfUnowned(() => clearStatus(true), clearAuthority);
      });
    }
    // The ordinary no-write-in-flight path must reach Slack before the Worker
    // turn settles. A late in-flight status still gets its second clear above
    // without delaying final delivery.
    await firstClear;
  }

  private scheduleNext(): void {
    if (
      this.closed ||
      !this.ownershipReady ||
      !this.ownsVisibleWrites() ||
      this.active ||
      this.handingBack ||
      this.pendingTimer ||
      !this.pending
    ) {
      return;
    }
    const waitMs = this.waitBefore(this.pending);
    if (waitMs > 0) {
      this.emitQueue('throttled', this.pending.observed, waitMs);
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = undefined;
        this.startNext();
      }, waitMs);
      return;
    }
    this.startNext();
  }

  private waitBefore(next: QueuedStatusWrite): number {
    if (!next.observed || this.lastObservedWriteStartedAt === undefined) {
      return 0;
    }
    return Math.max(
      0,
      this.observedMinIntervalMs - (Date.now() - this.lastObservedWriteStartedAt),
    );
  }

  private startNext(): void {
    if (this.closed || !this.ownsVisibleWrites() || this.active || this.handingBack || !this.pending) {
      if (!this.ownsVisibleWrites()) this.discardPending('stale_dropped');
      return;
    }
    const queued = this.pending;
    this.pending = undefined;
    this.active = queued;
    if (queued.observed) {
      this.lastObservedWriteStartedAt = Date.now();
    }

    let attempt: Promise<boolean>;
    try {
      // A refresh reasserts the fact already shown. A presenter with its own
      // same-fact path uses it (a durable writer would otherwise treat the
      // unchanged fact as already written and skip it).
      attempt = queued.refresh && this.presenter.refreshStatus
        ? this.presenter.refreshStatus(queued.update)
        : queued.refresh === 'validated'
          ? Promise.resolve(false)
          : this.presenter.setStatus(queued.update);
    } catch {
      attempt = Promise.resolve(false);
    }
    void attempt
      .catch(() => false)
      .then((succeeded) => {
        if (succeeded) {
          this.shown = queued.update;
          // A write that lands as the run goes quiet is what the hand-back
          // (queued behind it) replaces; it is reasserted on the next progress.
          if (!this.quiet) {
            this.lastAppliedText = queued.update.text;
            if (!this.pending || this.pending.update.text === queued.update.text) {
              this.scheduleRefresh(queued.update);
            }
          }
        } else if (!this.pending && !this.quiet && this.refreshRetryable()) {
          // The status shown is still valid, so retry this write well before
          // Slack's two-minute expiry instead of letting it lapse mid-task. A
          // failed refresh re-arms the fact it reasserted; a failed new fact
          // retries itself, since the durable record now names that fact and
          // a refresh of the older phrase can no longer be validated.
          if (queued.refresh) this.lastAppliedText = queued.update.text;
          this.scheduleRefresh(
            queued.update,
            Math.min(this.refreshIntervalMs, STATUS_REFRESH_RETRY_MS),
            queued.refresh,
          );
        }
        if (this.active === queued) {
          this.active = undefined;
        }
        queued.resolve(succeeded);
        this.scheduleNext();
      });
  }

  private refreshRetryable(): boolean {
    try {
      return this.presenter.refreshRetryable?.() === true;
    } catch {
      return false;
    }
  }

  /**
   * Real progress now. Refresh writes and turn-owned lifecycle writes never
   * come here, so they cannot hold the clock back from going quiet.
   */
  private noteProgress(update?: SlackStatusUpdate): void {
    if (this.closed || this.terminalizing) return;
    const at = this.now();
    if (at > this.facts.progressAt) this.facts.progressAt = at;
    this.saveFacts();
    this.armQuiet();
    if (this.quiet) this.leaveQuiet(update);
  }

  private recordStep(text: string): void {
    if (this.facts.step === text) return;
    this.facts.step = text;
    this.saveFacts();
  }

  private quietDue(): boolean {
    return this.now() - this.facts.progressAt >= this.quietAfterMs;
  }

  private armQuiet(): void {
    this.cancelQuiet();
    if (this.closed || this.terminalizing) return;
    const delayMs = Math.max(0, this.facts.progressAt + this.quietAfterMs - this.now());
    this.quietTimer = setTimeout(() => {
      this.quietTimer = undefined;
      this.enterQuiet();
    }, delayMs);
    this.quietTimer.unref?.();
  }

  private cancelQuiet(): void {
    if (!this.quietTimer) return;
    clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
  }

  /**
   * No progress for the quiet interval: stop refreshing the custom status and
   * hand the thread back to Slack's native indicator, which shows the Stop
   * button. Slack shows one or the other, never both (KTD7). The status text
   * itself never gains a clock; the check-in reports the time instead.
   */
  private enterQuiet(): void {
    if (this.quiet || this.closed || this.terminalizing || !this.ownsVisibleWrites()) return;
    if (!this.quietDue()) {
      this.armQuiet();
      return;
    }
    // With nothing to hand back to, the custom status stays.
    if (!this.presenter.showNativeIndicator) return;
    this.quiet = true;
    this.cancelRefresh();
    this.discardPending('superseded');
    this.lastAppliedText = undefined;
    const handBack = async () => {
      // The one write in flight lands first, so native is the last word.
      await this.active?.result;
      if (!this.quiet || this.closed || this.terminalizing || !this.ownsVisibleWrites()) return;
      let native = false;
      try {
        native = await this.presenter.showNativeIndicator!();
      } catch {
        native = false;
      }
      // Native processing could not show (Agent Sessions unavailable): keep
      // the custom status rather than none, until progress and a new quiet
      // stretch try again.
      if (!native && this.quiet) this.leaveQuiet();
    };
    this.handingBack = handBack().finally(() => {
      this.handingBack = undefined;
      this.scheduleNext();
    });
  }

  /**
   * Progress after a quiet stretch. A new phrase is written as usual, and the
   * presenter hands the thread over from native first. The phrase shown before
   * the stretch is reasserted as a refresh, because its durable writer skips
   * an unchanged fact.
   */
  private leaveQuiet(update?: SlackStatusUpdate): void {
    this.quiet = false;
    const shown = this.shown;
    if (shown && (!update || update.text === shown.text)) {
      void this.enqueue(shown, false, 'ordinary');
    }
  }

  /**
   * Send native `processing` again after `delayMs` (at once when overdue),
   * then every keepalive interval while it stays held. A keepalive Slack did
   * not take is tried again sooner, still inside Slack's hour.
   */
  private armNativeKeepalive(delayMs: number): void {
    this.cancelNativeKeepalive();
    if (!this.nativeHeld || this.closed || this.terminalizing) return;
    this.nativeTimer = setTimeout(() => {
      this.nativeTimer = undefined;
      if (!this.nativeHeld || this.closed || this.terminalizing || !this.ownsVisibleWrites()) return;
      this.nativeKeepalive = this.keepNative().finally(() => {
        this.nativeKeepalive = undefined;
      });
    }, Math.max(0, delayMs));
    this.nativeTimer.unref?.();
  }

  private async keepNative(): Promise<void> {
    let kept = false;
    try {
      kept = await this.presenter.keepNativeIndicator!();
    } catch {
      kept = false;
    }
    if (kept) this.registry.noteNativeProcessing(this.generation, this.now());
    this.armNativeKeepalive(kept
      ? this.nativeKeepaliveMs
      : Math.min(this.nativeKeepaliveMs, NATIVE_KEEPALIVE_RETRY_MS));
  }

  /** Stop keeping native processing alive; a keepalive in flight still lands. */
  private endNative(): void {
    this.nativeHeld = false;
    this.cancelNativeKeepalive();
  }

  private cancelNativeKeepalive(): void {
    if (!this.nativeTimer) return;
    clearTimeout(this.nativeTimer);
    this.nativeTimer = undefined;
  }

  /**
   * Save the run facts: at once when `now` (a start, a milestone, a close),
   * else at most once per interval with the newest facts at its end. A lost
   * trailing save costs the clock at most that interval after an eviction.
   */
  private saveFacts(now = false): void {
    this.factsDirty = true;
    const at = this.now();
    if (!now && this.factsSavedAt !== undefined &&
        at - this.factsSavedAt < RUN_FACTS_SAVE_INTERVAL_MS) {
      if (!this.factsTimer) {
        this.factsTimer = setTimeout(() => {
          this.factsTimer = undefined;
          this.saveFacts(true);
        }, this.factsSavedAt + RUN_FACTS_SAVE_INTERVAL_MS - at);
        this.factsTimer.unref?.();
      }
      return;
    }
    if (this.factsTimer) {
      clearTimeout(this.factsTimer);
      this.factsTimer = undefined;
    }
    this.factsDirty = false;
    this.factsSavedAt = at;
    this.registry.saveRunFacts(this.generation, this.facts);
  }

  private discardPending(disposition: SemanticActivityQueueDisposition): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    if (this.pending) {
      this.pending.resolve(false);
      this.emitQueue(disposition, this.pending.observed);
      this.pending = undefined;
    }
  }

  /**
   * Reassert `update` after `delayMs`: a refresh of the fact already shown, or
   * (`refresh` false) a retry of a write that failed while an older fact stays
   * shown. Any newer distinct write cancels the timer.
   */
  private scheduleRefresh(
    update: SlackStatusUpdate,
    delayMs = this.refreshIntervalMs,
    refresh: false | 'ordinary' | 'validated' = 'ordinary',
  ): void {
    this.cancelRefresh();
    if (this.closed || this.terminalizing || this.quiet || !this.ownsVisibleWrites()) return;
    emitSemanticActivityTelemetry({
      event: 'activity.refresh',
      outcome: 'scheduled',
      durationMs: delayMs,
    }, this.telemetry);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      // A refresh must still be reasserting the shown fact; a retry is moot
      // once that fact has been applied by another write.
      const stale = refresh
        ? this.lastAppliedText !== update.text
        : this.lastAppliedText === update.text;
      if (this.closed || this.terminalizing || this.quiet || !this.ownsVisibleWrites() || stale) {
        emitSemanticActivityTelemetry({
          event: 'activity.refresh',
          outcome: 'stale_dropped',
        }, this.telemetry);
        return;
      }
      // The timer belongs to this bounded turn registration. It reuses the
      // normal one-active/one-pending queue, but intentionally bypasses the
      // same-text short circuit so Slack does not expire truthful status.
      if (refresh) this.lastAppliedText = undefined;
      emitSemanticActivityTelemetry({
        event: 'activity.refresh',
        outcome: 'attempted',
        durationMs: this.refreshIntervalMs,
      }, this.telemetry);
      void this.enqueue(update, true, refresh, !refresh);
    }, delayMs);
    this.refreshTimer.unref?.();
  }

  private cancelRefresh(): void {
    if (!this.refreshTimer) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    emitSemanticActivityTelemetry({
      event: 'activity.refresh',
      outcome: 'canceled',
    }, this.telemetry);
  }

  private emitQueue(
    disposition: SemanticActivityQueueDisposition,
    observed: boolean,
    durationMs?: number,
  ): void {
    emitSemanticActivityTelemetry({
      event: 'activity.queue',
      layer: 'presentation',
      disposition,
      observed,
      ...(durationMs === undefined ? {} : { durationMs }),
    }, this.telemetry);
  }

  private async clearBestEffort(clearStatus: () => Promise<void>): Promise<void> {
    try {
      await clearStatus();
    } catch {
      // Status cleanup is cosmetic and must never interfere with final delivery.
    }
  }

  private clearIfUnowned(
    clearStatus: () => Promise<void>,
    clearAuthority: boolean,
  ): Promise<void> {
    if (!clearAuthority) return Promise.resolve();
    if (this.sessionGeneration !== undefined) {
      const latest = this.registry.latestGeneration(this.ownershipKey);
      if (latest !== undefined && latest > this.sessionGeneration) {
        return Promise.resolve();
      }
      const turns = this.registry.owners(this.ownershipKey);
      if (turns && [...turns].some((turn) =>
        turn.admittedGeneration() !== undefined &&
        turn.admittedGeneration()! >= this.sessionGeneration!
      )) return Promise.resolve();
      return this.clearBestEffort(clearStatus);
    }
    // A later turn owns the shared Slack thread status once registered.
    // Never let cleanup from this generation clear that newer turn.
    if ((this.registry.turns(this.instanceId)?.size ?? 0) > 0) {
      return Promise.resolve();
    }
    return this.clearBestEffort(clearStatus);
  }

  private ownsVisibleWrites(): boolean {
    if (this.closed || !this.acceptsWrites) return false;
    return this.sessionGeneration === undefined ||
      this.registry.latestGeneration(this.ownershipKey) === this.sessionGeneration;
  }
}

interface SlackStatusGenerationHistory {
  generation: number;
  lastSeenAt: number;
}

/**
 * The live status turns of one isolate's presenters. Turns that share a
 * Slack conversation coordinate through the registry they registered in, so
 * each owner of presentation (the shared state owner's alarm today, one
 * thread runner later) holds its own instance. Node and the alarm use
 * `defaultSlackStatusRegistry`.
 */
export class SlackStatusRegistry {
  private readonly activeTurns = new Map<string, Set<ActiveSlackStatusTurn>>();
  private readonly activeOwners = new Map<string, Set<ActiveSlackStatusTurn>>();
  private readonly latestGenerations = new Map<string, SlackStatusGenerationHistory>();
  private readonly runFactsStore: SlackRunFactsStore;
  private readonly quietAfterMs: number;
  private readonly nativeKeepaliveMs: number;
  /** When native `processing` was last sent for a run, by turn generation (KTD6). */
  private readonly nativeSentAt = new Map<string, number>();

  constructor(options: SlackStatusRegistryOptions = {}) {
    this.runFactsStore = options.runFacts ?? memoryRunFactsStore();
    this.quietAfterMs = options.quietAfterMs ?? SLACK_RUN_QUIET_AFTER_MS;
    this.nativeKeepaliveMs = Math.max(
      1,
      Math.floor(options.nativeKeepaliveMs ?? SLACK_NATIVE_PROCESSING_KEEPALIVE_MS),
    );
  }

  registerTurn(
    instanceId: string,
    presenter: StatusPresenter,
    options: SlackStatusTurnOptions,
  ): SlackStatusTurnRegistration {
    const clock = options.now ?? (() => Date.now());
    const now = clock();
    this.pruneInactiveGenerationHistory(now);
    const turns = this.activeTurns.get(instanceId) ?? new Set<ActiveSlackStatusTurn>();
    const ownershipKey = options.ownershipKey ?? instanceId;
    const owners = this.activeOwners.get(ownershipKey) ?? new Set<ActiveSlackStatusTurn>();
    let acceptsWrites = true;
    let ownershipBarrier: Promise<void> | undefined;
    if (options.sessionGeneration !== undefined) {
      const latest = this.latestGenerations.get(ownershipKey);
      if (latest === undefined || options.sessionGeneration > latest.generation) {
        this.latestGenerations.set(ownershipKey, {
          generation: options.sessionGeneration,
          lastSeenAt: now,
        });
        const barriers = [...owners]
          .filter((candidate) =>
            candidate.admittedGeneration() !== undefined &&
            candidate.admittedGeneration()! < options.sessionGeneration!
          )
          .map((candidate) => candidate.fenceByNewerGeneration());
        if (barriers.length > 0) {
          ownershipBarrier = Promise.all(barriers).then(() => undefined);
        }
      } else if (options.sessionGeneration === latest.generation) {
        this.latestGenerations.set(ownershipKey, { ...latest, lastSeenAt: now });
        // A persisted TurnJob retry re-registers the same admitted generation
        // after its prior in-memory owner closed. It may resume idempotent work
        // on the stored coordinate, but a concurrent duplicate stays silent.
        acceptsWrites = ![...owners].some((candidate) =>
          candidate.admittedGeneration() === options.sessionGeneration
        );
      } else {
        this.latestGenerations.set(ownershipKey, { ...latest, lastSeenAt: now });
        acceptsWrites = false;
      }
    }
    const stored = this.loadRunFacts(options.generation);
    const turn = new ActiveSlackStatusTurn(
      this,
      instanceId,
      ownershipKey,
      options.generation,
      presenter,
      options.observedMinIntervalMs ?? DEFAULT_OBSERVED_STATUS_MIN_INTERVAL_MS,
      Math.max(1, Math.floor(options.refreshIntervalMs ?? DEFAULT_STATUS_REFRESH_INTERVAL_MS)),
      options.telemetry ?? console,
      options.sessionGeneration,
      acceptsWrites,
      ownershipBarrier,
      options.initialAppliedStatus,
      options.refreshInitialStatus,
      {
        now: clock,
        quietAfterMs: this.quietAfterMs,
        nativeKeepaliveMs: this.nativeKeepaliveMs,
        // A retry or a reattach of the same run keeps its start and its clock.
        ...(stored
          ? { facts: stored, fresh: false }
          : { facts: { startedAt: now, progressAt: now, milestones: 0 }, fresh: true }),
      },
    );
    turns.add(turn);
    this.activeTurns.set(instanceId, turns);
    owners.add(turn);
    this.activeOwners.set(ownershipKey, owners);
    return turn;
  }

  /**
   * Route an observed tool status only to the live turn carrying the same opaque
   * generation. A mismatch is intentionally consumed instead of falling back to
   * whichever turn happens to be live now: an old cross-isolate RPC can arrive
   * after its turn closes and a later turn registers under the same conversation
   * key. Duplicate live registrations for one generation remain ambiguous and
   * are likewise suppressed.
   * Returning true for either suppression prevents a pointless cross-isolate
   * relay; the turn's own generic/model statuses remain visible.
   * Returns false on a miss so the caller can relay cross-isolate (on Cloudflare
   * the agent DO and the turn's alarm isolate never share this registry — see
   * relayObservedStatus).
   */
  setObservedStatus(
    instanceId: string,
    generation: string,
    update: SlackStatusUpdate,
  ): boolean {
    const turns = this.activeTurns.get(instanceId);
    if (!turns || turns.size === 0) {
      return false;
    }

    let matchingTurn: ActiveSlackStatusTurn | undefined;
    for (const turn of turns) {
      if (!turn.belongsTo(generation)) continue;
      if (matchingTurn) return true;
      matchingTurn = turn;
    }
    if (!matchingTurn) return true;
    void matchingTurn.setObservedStatus(update);
    return true;
  }

  /**
   * The facts of one run (its turn generation, the TurnJob id): its live
   * turn's, else those its last registration saved. A check-in reads them
   * without touching the run.
   */
  runFacts(generation: string): SlackRunFacts | undefined {
    let live: ActiveSlackStatusTurn | undefined;
    for (const turns of this.activeTurns.values()) {
      for (const turn of turns) {
        if (turn.belongsTo(generation)) live = turn;
      }
    }
    return live ? live.runFacts() : this.loadRunFacts(generation);
  }

  /** `runFacts` as a check-in reads them, at `now`. */
  runFactsView(generation: string, now = Date.now()): SlackRunFactsView | undefined {
    const facts = this.runFacts(generation);
    return facts ? slackRunFactsView(facts, now) : undefined;
  }

  /** @internal Save one run's facts; a failed save never fails a turn. */
  saveRunFacts(generation: string, facts: SlackRunFacts): void {
    try {
      this.runFactsStore.save(generation, { ...facts });
    } catch {
      console.warn('[chickpea] run facts could not be saved');
    }
  }

  /**
   * @internal When native `processing` was last sent for one run, as far as
   * this isolate saw: a reattached attempt keeps the keepalive's cadence.
   */
  nativeProcessingAt(generation: string): number | undefined {
    return this.nativeSentAt.get(generation);
  }

  /** @internal Record a native `processing` send; bounded like memory run facts. */
  noteNativeProcessing(generation: string, at: number): void {
    this.nativeSentAt.delete(generation);
    this.nativeSentAt.set(generation, at);
    while (this.nativeSentAt.size > MEMORY_RUN_FACTS_LIMIT) {
      const oldest = this.nativeSentAt.keys().next().value;
      if (oldest === undefined) break;
      this.nativeSentAt.delete(oldest);
    }
  }

  /** @internal The run has ended: nothing keeps its native indicator alive. */
  forgetNativeProcessing(generation: string): void {
    this.nativeSentAt.delete(generation);
  }

  private loadRunFacts(generation: string): SlackRunFacts | undefined {
    try {
      const facts = this.runFactsStore.load(generation);
      return facts ? { ...facts } : undefined;
    } catch {
      return undefined;
    }
  }

  /** @internal Live turns registered under one instance id. */
  turns(instanceId: string): ReadonlySet<ActiveSlackStatusTurn> | undefined {
    return this.activeTurns.get(instanceId);
  }

  /** @internal Live turns sharing one visible Slack status. */
  owners(ownershipKey: string): ReadonlySet<ActiveSlackStatusTurn> | undefined {
    return this.activeOwners.get(ownershipKey);
  }

  /** @internal The newest admitted generation seen for one visible status. */
  latestGeneration(ownershipKey: string): number | undefined {
    return this.latestGenerations.get(ownershipKey)?.generation;
  }

  /** @internal Move one live turn to another instance id. */
  rekey(turn: ActiveSlackStatusTurn, from: string, to: string): void {
    const previous = this.activeTurns.get(from);
    if (previous) {
      previous.delete(turn);
      if (previous.size === 0) this.activeTurns.delete(from);
    }
    const turns = this.activeTurns.get(to) ?? new Set<ActiveSlackStatusTurn>();
    turns.add(turn);
    this.activeTurns.set(to, turns);
  }

  /** @internal Remove one closed turn; later turns under the same keys stay. */
  release(turn: ActiveSlackStatusTurn, instanceId: string, ownershipKey: string): void {
    const turns = this.activeTurns.get(instanceId);
    if (turns) {
      turns.delete(turn);
      if (turns.size === 0) {
        this.activeTurns.delete(instanceId);
      }
    }
    const owners = this.activeOwners.get(ownershipKey);
    if (owners) {
      owners.delete(turn);
      if (owners.size === 0) this.activeOwners.delete(ownershipKey);
    }
  }

  private pruneInactiveGenerationHistory(now: number): void {
    for (const [ownershipKey, history] of this.latestGenerations) {
      if (now - history.lastSeenAt <= THREAD_TTL_MS) continue;
      if ((this.activeOwners.get(ownershipKey)?.size ?? 0) > 0) continue;
      this.latestGenerations.delete(ownershipKey);
    }
  }
}

/** Run facts in this isolate's memory, for a registry whose owner persists none. */
function memoryRunFactsStore(): SlackRunFactsStore {
  const entries = new Map<string, SlackRunFacts>();
  return {
    load: (generation) => {
      const facts = entries.get(generation);
      return facts ? { ...facts } : undefined;
    },
    save: (generation, facts) => {
      entries.delete(generation);
      entries.set(generation, { ...facts });
      while (entries.size > MEMORY_RUN_FACTS_LIMIT) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

/** The registry of this isolate's Node relay and Cloudflare alarm turns. */
export const defaultSlackStatusRegistry = new SlackStatusRegistry();

export function registerSlackStatusTurn(
  instanceId: string,
  presenter: StatusPresenter,
  options: SlackStatusTurnOptions,
): SlackStatusTurnRegistration {
  return defaultSlackStatusRegistry.registerTurn(instanceId, presenter, options);
}

/** `SlackStatusRegistry.setObservedStatus` on the default registry. */
export function setObservedSlackStatus(
  instanceId: string,
  generation: string,
  update: SlackStatusUpdate,
): boolean {
  return defaultSlackStatusRegistry.setObservedStatus(instanceId, generation, update);
}
