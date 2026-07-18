import type { SlackStatusUpdate } from './replies.ts';
import type { WebClientPresenter } from './web-client-presenter.ts';

export interface SlackStatusTurnRegistration {
  setStatus(update: SlackStatusUpdate): Promise<boolean>;
  drain(): Promise<void>;
  close(): void;
}

type StatusPresenter = Pick<WebClientPresenter, 'setStatus'>;

class ActiveSlackStatusTurn implements SlackStatusTurnRegistration {
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;

  constructor(
    private readonly instanceId: string,
    private readonly presenter: StatusPresenter,
  ) {}

  setStatus(update: SlackStatusUpdate): Promise<boolean> {
    if (this.closed) {
      return Promise.resolve(false);
    }
    const attempt = this.presenter.setStatus(update).catch(() => false);
    this.pending.add(attempt);
    void attempt.finally(() => this.pending.delete(attempt));
    return attempt;
  }

  // Called only after the agent turn has resolved, so no further tool_start
  // events can fire — a single settle over the in-flight status writes is enough.
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  close(): void {
    this.closed = true;
    // Identity-guarded: two turns in the same Slack thread share one registry
    // key (workspace:channel:thread), and a later turn's registration overwrites
    // an earlier one. Only evict the map entry if it still points at THIS turn,
    // so an earlier turn finishing never removes a later, still-running turn's
    // registration (which would silently drop its tool statuses).
    if (activeSlackStatusTurns.get(this.instanceId) === this) {
      activeSlackStatusTurns.delete(this.instanceId);
    }
  }
}

const activeSlackStatusTurns = new Map<string, ActiveSlackStatusTurn>();

export function registerSlackStatusTurn(
  instanceId: string,
  presenter: StatusPresenter,
): SlackStatusTurnRegistration {
  const turn = new ActiveSlackStatusTurn(instanceId, presenter);
  activeSlackStatusTurns.set(instanceId, turn);
  return turn;
}

/**
 * Route an observed tool status to the live turn registered in THIS isolate.
 * Returns false on a miss so the caller can decide to relay cross-isolate
 * (on Cloudflare the agent DO and the turn's alarm isolate never share this
 * Map — see relayObservedToolStatus).
 */
export function setObservedSlackStatus(
  instanceId: string,
  update: SlackStatusUpdate,
): boolean {
  const turn = activeSlackStatusTurns.get(instanceId);
  if (!turn) {
    return false;
  }
  void turn.setStatus(update);
  return true;
}
