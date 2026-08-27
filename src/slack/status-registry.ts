import type { SlackStatusUpdate } from './replies.ts';
import { THREAD_TTL_MS } from './state-limits.ts';
import type { WebClientPresenter } from './web-client-presenter.ts';

export interface SlackStatusTurnRegistration {
  setStatus(update: SlackStatusUpdate): Promise<boolean>;
  drain(): Promise<void>;
  close(): void;
  /** Fence new writes, clear now, and clear once more if an in-flight write lands late. */
  finish(clearStatus: () => Promise<void>): Promise<void>;
}

type StatusPresenter = Pick<WebClientPresenter, 'setStatus'>;

export interface SlackStatusTurnOptions {
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
}

interface QueuedStatusWrite {
  update: SlackStatusUpdate;
  observed: boolean;
  result: Promise<boolean>;
  resolve(result: boolean): void;
}

const DEFAULT_OBSERVED_STATUS_MIN_INTERVAL_MS = 1_000;

class ActiveSlackStatusTurn implements SlackStatusTurnRegistration {
  private active: QueuedStatusWrite | undefined;
  private pending: QueuedStatusWrite | undefined;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private lastObservedWriteStartedAt: number | undefined;
  private lastAppliedText: string | undefined;
  private closed = false;
  private finished = false;
  private ownershipReady: boolean;

  constructor(
    private readonly instanceId: string,
    private readonly ownershipKey: string,
    private readonly generation: string,
    private readonly presenter: StatusPresenter,
    private readonly observedMinIntervalMs: number,
    private readonly sessionGeneration?: number,
    private acceptsWrites = true,
    ownershipBarrier?: Promise<void>,
  ) {
    this.ownershipReady = ownershipBarrier === undefined;
    if (ownershipBarrier) {
      void ownershipBarrier.finally(() => {
        this.ownershipReady = true;
        this.scheduleNext();
      });
    }
  }

  setStatus(update: SlackStatusUpdate): Promise<boolean> {
    return this.enqueue(update, false);
  }

  setObservedStatus(update: SlackStatusUpdate): Promise<boolean> {
    return this.enqueue(update, true);
  }

  belongsTo(generation: string): boolean {
    return this.generation === generation;
  }

  admittedGeneration(): number | undefined {
    return this.sessionGeneration;
  }

  fenceByNewerGeneration(): Promise<void> {
    this.acceptsWrites = false;
    this.discardPending();
    return this.active?.result.then(() => undefined) ?? Promise.resolve();
  }

  private enqueue(update: SlackStatusUpdate, observed: boolean): Promise<boolean> {
    if (this.closed || !this.ownsVisibleWrites()) {
      return Promise.resolve(false);
    }
    if (!this.active && !this.pending && this.lastAppliedText === update.text) {
      return Promise.resolve(true);
    }

    // If the newest fact matches the write already in flight, that in-flight
    // value is already the desired final state. Discard any older queued fact.
    if (this.active?.update.text === update.text) {
      this.discardPending();
      return this.active.result;
    }
    if (this.pending?.update.text === update.text) {
      return this.pending.result;
    }

    // One in-flight write plus one replaceable pending value is the complete
    // queue. Rapid distinct events resolve their superseded promises false and
    // never replay stale intermediate statuses after the useful newest fact.
    const deferred = Promise.withResolvers<boolean>();
    const queued: QueuedStatusWrite = {
      update,
      observed,
      result: deferred.promise,
      resolve: deferred.resolve,
    };
    if (this.pending) {
      this.pending.resolve(false);
    }
    this.pending = queued;

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
    this.discardPending();
    if (this.active) {
      await this.active.result;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.discardPending();
    // Two turns in the same Slack conversation share one registry key
    // (workspace:channel:thread — and ALL DM turns share workspace:dm-channel:dm),
    // so each key holds a SET of live turns. Closing removes only this turn;
    // an earlier turn finishing never drops a later, still-running turn.
    const turns = activeSlackStatusTurns.get(this.instanceId);
    if (turns) {
      turns.delete(this);
      if (turns.size === 0) {
        activeSlackStatusTurns.delete(this.instanceId);
      }
    }
    const owners = activeSlackStatusOwners.get(this.ownershipKey);
    if (owners) {
      owners.delete(this);
      if (owners.size === 0) activeSlackStatusOwners.delete(this.ownershipKey);
    }
  }

  async finish(clearStatus: () => Promise<void>): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const clearAuthority = this.ownsVisibleWrites();
    const activeResult = this.active?.result;
    this.close();
    const firstClear = this.clearIfUnowned(clearStatus, clearAuthority);
    if (activeResult) {
      void activeResult.finally(() => {
        return this.clearIfUnowned(clearStatus, clearAuthority);
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
      if (!this.ownsVisibleWrites()) this.discardPending();
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
      attempt = this.presenter.setStatus(queued.update);
    } catch {
      attempt = Promise.resolve(false);
    }
    void attempt
      .catch(() => false)
      .then((succeeded) => {
        if (succeeded) {
          this.lastAppliedText = queued.update.text;
        }
        if (this.active === queued) {
          this.active = undefined;
        }
        queued.resolve(succeeded);
        this.scheduleNext();
      });
  }

  private discardPending(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    if (this.pending) {
      this.pending.resolve(false);
      this.pending = undefined;
    }
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
      const latest = latestSlackStatusGenerations.get(this.ownershipKey);
      if (latest !== undefined && latest.generation > this.sessionGeneration) {
        return Promise.resolve();
      }
      const turns = activeSlackStatusOwners.get(this.ownershipKey);
      if (turns && [...turns].some((turn) =>
        turn.admittedGeneration() !== undefined &&
        turn.admittedGeneration()! >= this.sessionGeneration!
      )) return Promise.resolve();
      return this.clearBestEffort(clearStatus);
    }
    // A later turn owns the shared Slack thread status once registered.
    // Never let cleanup from this generation clear that newer turn.
    if ((activeSlackStatusTurns.get(this.instanceId)?.size ?? 0) > 0) {
      return Promise.resolve();
    }
    return this.clearBestEffort(clearStatus);
  }

  private ownsVisibleWrites(): boolean {
    if (this.closed || !this.acceptsWrites) return false;
    return this.sessionGeneration === undefined ||
      latestSlackStatusGenerations.get(this.ownershipKey)?.generation === this.sessionGeneration;
  }
}

interface SlackStatusGenerationHistory {
  generation: number;
  lastSeenAt: number;
}

const activeSlackStatusTurns = new Map<string, Set<ActiveSlackStatusTurn>>();
const activeSlackStatusOwners = new Map<string, Set<ActiveSlackStatusTurn>>();
const latestSlackStatusGenerations = new Map<string, SlackStatusGenerationHistory>();

function pruneInactiveSlackStatusGenerationHistory(now: number): void {
  for (const [ownershipKey, history] of latestSlackStatusGenerations) {
    if (now - history.lastSeenAt <= THREAD_TTL_MS) continue;
    if ((activeSlackStatusOwners.get(ownershipKey)?.size ?? 0) > 0) continue;
    latestSlackStatusGenerations.delete(ownershipKey);
  }
}

export function registerSlackStatusTurn(
  instanceId: string,
  presenter: StatusPresenter,
  options: SlackStatusTurnOptions,
): SlackStatusTurnRegistration {
  const now = options.now?.() ?? Date.now();
  pruneInactiveSlackStatusGenerationHistory(now);
  const turns = activeSlackStatusTurns.get(instanceId) ?? new Set<ActiveSlackStatusTurn>();
  const ownershipKey = options.ownershipKey ?? instanceId;
  const owners = activeSlackStatusOwners.get(ownershipKey) ?? new Set<ActiveSlackStatusTurn>();
  let acceptsWrites = true;
  let ownershipBarrier: Promise<void> | undefined;
  if (options.sessionGeneration !== undefined) {
    const latest = latestSlackStatusGenerations.get(ownershipKey);
    if (latest === undefined || options.sessionGeneration > latest.generation) {
      latestSlackStatusGenerations.set(ownershipKey, {
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
      latestSlackStatusGenerations.set(ownershipKey, { ...latest, lastSeenAt: now });
      // A persisted TurnJob retry re-registers the same admitted generation
      // after its prior in-memory owner closed. It may resume idempotent work
      // on the stored coordinate, but a concurrent duplicate stays silent.
      acceptsWrites = ![...owners].some((candidate) =>
        candidate.admittedGeneration() === options.sessionGeneration
      );
    } else {
      latestSlackStatusGenerations.set(ownershipKey, { ...latest, lastSeenAt: now });
      acceptsWrites = false;
    }
  }
  const turn = new ActiveSlackStatusTurn(
    instanceId,
    ownershipKey,
    options.generation,
    presenter,
    options.observedMinIntervalMs ?? DEFAULT_OBSERVED_STATUS_MIN_INTERVAL_MS,
    options.sessionGeneration,
    acceptsWrites,
    ownershipBarrier,
  );
  turns.add(turn);
  activeSlackStatusTurns.set(instanceId, turns);
  owners.add(turn);
  activeSlackStatusOwners.set(ownershipKey, owners);
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
 * the agent DO and the turn's alarm isolate never share this Map — see
 * relayObservedStatus).
 */
export function setObservedSlackStatus(
  instanceId: string,
  generation: string,
  update: SlackStatusUpdate,
): boolean {
  const turns = activeSlackStatusTurns.get(instanceId);
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
