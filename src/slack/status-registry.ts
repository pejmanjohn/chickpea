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
}

const activeSlackStatusTurns = new Map<string, Set<ActiveSlackStatusTurn>>();

export function registerSlackStatusTurn(
  instanceId: string,
  presenter: StatusPresenter,
): SlackStatusTurnRegistration {
  const turn = new ActiveSlackStatusTurn(instanceId, presenter);
  const turns = activeSlackStatusTurns.get(instanceId) ?? new Set<ActiveSlackStatusTurn>();
  turns.add(turn);
  activeSlackStatusTurns.set(instanceId, turns);
  return turn;
}

/**
 * Route an observed tool status to every live turn registered under the key in
 * THIS isolate. Broadcast, not last-writer-wins: Flue's tool events carry only
 * the conversation key, so with two concurrent turns in one conversation we
 * cannot tell whose tool fired — sending to both keeps the status on the RIGHT
 * thread (plus a transient extra on the other), where routing to only the
 * newest registration put it exclusively on the WRONG thread for DMs.
 * Returns false on a miss so the caller can relay cross-isolate (on Cloudflare
 * the agent DO and the turn's alarm isolate never share this Map — see
 * relayObservedToolStatus).
 */
export function setObservedSlackStatus(
  instanceId: string,
  update: SlackStatusUpdate,
): boolean {
  const turns = activeSlackStatusTurns.get(instanceId);
  if (!turns || turns.size === 0) {
    return false;
  }
  for (const turn of turns) {
    void turn.setStatus(update);
  }
  return true;
}
