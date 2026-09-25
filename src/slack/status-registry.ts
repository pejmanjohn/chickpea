import type { SlackStatusUpdate } from './replies.ts';
import { THREAD_TTL_MS } from './state-limits.ts';
import {
  emitSemanticActivityTelemetry,
  semanticTelemetryForStatus,
  type SemanticActivityQueueDisposition,
  type SemanticActivityTelemetrySink,
} from '../activity/telemetry.ts';
import { isSafeTypedActivityStatus } from '../activity/status.ts';

interface SlackStatusTurnRegistration {
  setStatus(update: SlackStatusUpdate): Promise<boolean>;
  drain(): Promise<void>;
  /** Fence narration and drop queued work before final delivery. */
  prepareFinal(): Promise<void>;
  close(): void;
  /** Fence new writes, clear now, and clear once more if an in-flight write lands late. */
  finish(clearStatus: (late: boolean) => Promise<void>): Promise<void>;
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
}

interface SlackStatusTurnOptions {
  /** Opaque identity for the logical turn that owns observed activity. */
  generation: string;
  /** Monotonic admitted-message generation used by canonical V3 turns. */
  sessionGeneration?: number;
  /** Slack thread/session key whose visible status is shared across Agent handoffs. */
  ownershipKey?: string;
  /** Deterministic clock for focused generation-history retention tests. */
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

const DEFAULT_OBSERVED_STATUS_MIN_INTERVAL_MS = 1_000;
const DEFAULT_STATUS_REFRESH_INTERVAL_MS = 90_000;
const STATUS_REFRESH_RETRY_MS = 15_000;

class ActiveSlackStatusTurn implements SlackStatusTurnRegistration {
  private active: QueuedStatusWrite | undefined;
  private pending: QueuedStatusWrite | undefined;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private lastObservedWriteStartedAt: number | undefined;
  private lastAppliedText: string | undefined;
  private closed = false;
  private finished = false;
  private terminalizing = false;
  private ownershipReady: boolean;

  constructor(
    private readonly registry: SlackStatusRegistry,
    private readonly instanceId: string,
    private readonly ownershipKey: string,
    private readonly generation: string,
    private readonly presenter: StatusPresenter,
    private readonly observedMinIntervalMs: number,
    private readonly refreshIntervalMs: number,
    private readonly telemetry: SemanticActivityTelemetrySink,
    private readonly sessionGeneration?: number,
    private acceptsWrites = true,
    ownershipBarrier?: Promise<void>,
    initialAppliedStatus?: SlackStatusUpdate,
    refreshInitialStatus = false,
  ) {
    this.ownershipReady = ownershipBarrier === undefined;
    if (ownershipBarrier) {
      void ownershipBarrier.finally(() => {
        this.ownershipReady = true;
        this.scheduleNext();
      });
    }
    if (initialAppliedStatus) {
      this.lastAppliedText = initialAppliedStatus.text;
      this.scheduleRefresh(
        initialAppliedStatus,
        refreshInitialStatus ? 0 : this.refreshIntervalMs,
        'validated',
      );
    }
  }

  setStatus(update: SlackStatusUpdate): Promise<boolean> {
    return this.enqueue(update, false, false);
  }

  setObservedStatus(update: SlackStatusUpdate): Promise<boolean> {
    return this.enqueue(update, true, false);
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
  }

  async prepareFinal(): Promise<void> {
    this.terminalizing = true;
    this.cancelRefresh();
    this.discardPending('terminal_dropped');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelRefresh();
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
    if (this.closed || !this.ownsVisibleWrites() || this.active || !this.pending) {
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
          this.lastAppliedText = queued.update.text;
          if (!this.pending || this.pending.update.text === queued.update.text) {
            this.scheduleRefresh(queued.update);
          }
        } else if (!this.pending && this.refreshRetryable()) {
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
    if (this.closed || this.terminalizing || !this.ownsVisibleWrites()) return;
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
      if (this.closed || this.terminalizing || !this.ownsVisibleWrites() || stale) {
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

  registerTurn(
    instanceId: string,
    presenter: StatusPresenter,
    options: SlackStatusTurnOptions,
  ): SlackStatusTurnRegistration {
    const now = options.now?.() ?? Date.now();
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
