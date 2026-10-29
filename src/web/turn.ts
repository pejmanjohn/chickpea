import { usePersistentState } from '@flue/runtime';

export const WEB_READS_PER_TURN = 6;
export const WEB_SEARCHES_PER_TURN = 4;

const WEB_TURN_STATE = 'web-turn';
/** Every link each read may return, and every result each search may return. */
const MAX_SOURCED_URLS = WEB_READS_PER_TURN * 50 + WEB_SEARCHES_PER_TURN * 5;

/**
 * One conversation's web use, kept in persistent state so a re-render or a
 * redriven turn sees the same budgets. Counts and sources belong to one turn;
 * `pageRead` outlives it.
 */
export interface WebTurnState {
  turnKey: string;
  reads: number;
  searches: number;
  /** URLs this turn's search results and pages returned; each may be read with its query string. */
  sourced: string[];
  /**
   * Web content entered the conversation: a page read, search results, or a
   * browser call. It stays in the model's context after the turn, so the
   * fact does too.
   */
  pageRead?: true;
}

export interface WebTurn {
  /** Takes one of the turn's page reads; false when none are left. */
  takeRead(): boolean;
  /** Takes one of the turn's searches; false when none are left. */
  takeSearch(): boolean;
  sourced(): readonly string[];
  addSourced(urls: readonly string[]): void;
  markPageRead(): void;
  pageRead(): boolean;
}

/** `turnKey` undefined continues the stored turn, for a render that answers no new message. */
export function createWebTurn(
  turnKey: string | undefined,
  persisted: WebTurnState,
  persist: (state: WebTurnState) => void = () => undefined,
): WebTurn {
  let current: WebTurnState = turnKey === undefined || persisted.turnKey === turnKey
    ? persisted
    : { turnKey, reads: 0, searches: 0, sourced: [], ...(persisted.pageRead ? { pageRead: true } : {}) };
  const update = (next: WebTurnState) => {
    current = next;
    persist(next);
  };
  return {
    takeRead() {
      if (current.reads >= WEB_READS_PER_TURN) return false;
      update({ ...current, reads: current.reads + 1 });
      return true;
    },
    takeSearch() {
      if (current.searches >= WEB_SEARCHES_PER_TURN) return false;
      update({ ...current, searches: current.searches + 1 });
      return true;
    },
    sourced: () => current.sourced,
    addSourced(urls) {
      const sourced = [...new Set([...current.sourced, ...urls])].slice(0, MAX_SOURCED_URLS);
      if (sourced.length !== current.sourced.length) update({ ...current, sourced });
    },
    markPageRead() {
      if (!current.pageRead) update({ ...current, pageRead: true });
    },
    pageRead: () => current.pageRead === true,
  };
}

/** The conversation's web turn, keyed by the turn it answers. */
export function useWebTurn(turnKey: string | undefined): WebTurn {
  const [state, persist] = usePersistentState<WebTurnState>(
    WEB_TURN_STATE,
    { turnKey: turnKey ?? '', reads: 0, searches: 0, sourced: [] },
  );
  return createWebTurn(turnKey, state, persist);
}
