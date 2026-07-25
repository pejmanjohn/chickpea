import type { SlackStatusUpdate } from './replies.ts';
import type { WebClientPresenter } from './web-client-presenter.ts';

export interface SlackStatusTurnRegistration {
  setStatus(update: SlackStatusUpdate): Promise<boolean>;
  drain(): Promise<void>;
  close(): void;
}

type StatusPresenter = Pick<WebClientPresenter, 'setStatus'>;

export interface SlackStatusTurnOptions {
  /** Opaque identity for the logical turn that owns observed activity. */
  generation: string;
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

  constructor(
    private readonly instanceId: string,
    private readonly generation: string,
    private readonly presenter: StatusPresenter,
    private readonly observedMinIntervalMs: number,
  ) {}

  setStatus(update: SlackStatusUpdate): Promise<boolean> {
    return this.enqueue(update, false);
  }

  setObservedStatus(update: SlackStatusUpdate): Promise<boolean> {
    return this.enqueue(update, true);
  }

  belongsTo(generation: string): boolean {
    return this.generation === generation;
  }

  private enqueue(update: SlackStatusUpdate, observed: boolean): Promise<boolean> {
    if (this.closed) {
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
  }

  private scheduleNext(): void {
    if (this.closed || this.active || this.pendingTimer || !this.pending) {
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
    if (this.closed || this.active || !this.pending) {
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
}

const activeSlackStatusTurns = new Map<string, Set<ActiveSlackStatusTurn>>();

export function registerSlackStatusTurn(
  instanceId: string,
  presenter: StatusPresenter,
  options: SlackStatusTurnOptions,
): SlackStatusTurnRegistration {
  const turn = new ActiveSlackStatusTurn(
    instanceId,
    options.generation,
    presenter,
    options.observedMinIntervalMs ?? DEFAULT_OBSERVED_STATUS_MIN_INTERVAL_MS,
  );
  const turns = activeSlackStatusTurns.get(instanceId) ?? new Set<ActiveSlackStatusTurn>();
  turns.add(turn);
  activeSlackStatusTurns.set(instanceId, turns);
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
