import {
  RESIDENCY_HOLD_VARIABLE,
  ResidencyHold,
  STORE_RESIDENCY_HOLD_VARIABLE,
  type HoldTimers,
} from '../../src/state/residency-hold.ts';

/**
 * A configured hold window. It differs from the state store's 10-minute
 * keep-warm tick window, so a test tells the setting from that constant.
 */
export const HOLD_MS = 12 * 60_000;
/** A deployment's env that sets HOLD_MS. */
export const HOLD_ENV: Readonly<Record<string, string>> = Object.freeze({ [RESIDENCY_HOLD_VARIABLE]: String(HOLD_MS) });

/** A store window longer than the 15 minutes one pending timer blocks eviction. */
export const STORE_HOLD_MS = 60 * 60_000;
/** A deployment's env that holds the store for STORE_HOLD_MS and a thread's objects for HOLD_MS. */
export const STORE_HOLD_ENV: Readonly<Record<string, string>> = Object.freeze({
  ...HOLD_ENV,
  [STORE_RESIDENCY_HOLD_VARIABLE]: String(STORE_HOLD_MS),
});

/** How long Cloudflare lets one pending timer block eviction, from when it was set. */
const PENDING_TIMER_EVICTION_CAP_MS = 15 * 60_000;

/**
 * Timers on a test's clock. Nothing fires until `fireDue`, so no test waits
 * on a hold, and `pending` lists the deadlines that keep an object in memory.
 */
export class ScriptedTimers implements HoldTimers {
  private readonly timers = new Map<number, { at: number; setAt: number; callback: () => void }>();
  private nextId = 1;

  constructor(readonly now: () => number) {}

  set(callback: () => void, ms: number): number {
    const id = this.nextId++;
    const setAt = this.now();
    this.timers.set(id, { at: setAt + ms, setAt, callback });
    return id;
  }

  /** Whether a pending timer blocks eviction now, under the platform's cap on each one. */
  blocksEviction(): boolean {
    const now = this.now();
    return [...this.timers.values()].some(({ setAt }) => now - setAt < PENDING_TIMER_EVICTION_CAP_MS);
  }

  clear(timer: unknown): void {
    this.timers.delete(timer as number);
  }

  pending(): number[] {
    return [...this.timers.values()].map(({ at }) => at);
  }

  fireDue(): void {
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.now()) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

/** ResidencyHold on `timers`, for production code that builds its own hold from its env. */
export function holdOn(timers: ScriptedTimers): typeof ResidencyHold {
  return class extends ResidencyHold {
    constructor(windowMs: number | undefined) {
      super(windowMs, timers);
    }
  };
}
