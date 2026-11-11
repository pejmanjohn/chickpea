import { RESIDENCY_HOLD_VARIABLE, ResidencyHold, type HoldTimers } from '../../src/state/residency-hold.ts';

/**
 * A configured hold window. It differs from the state store's 10-minute
 * keep-warm tick window, so a test tells the setting from that constant.
 */
export const HOLD_MS = 12 * 60_000;
/** A deployment's env that sets HOLD_MS. */
export const HOLD_ENV: Readonly<Record<string, string>> = Object.freeze({ [RESIDENCY_HOLD_VARIABLE]: String(HOLD_MS) });

/**
 * Timers on a test's clock. Nothing fires until `fireDue`, so no test waits
 * on a hold, and `pending` lists the deadlines that keep an object in memory.
 */
export class ScriptedTimers implements HoldTimers {
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private nextId = 1;

  constructor(readonly now: () => number) {}

  set(callback: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now() + ms, callback });
    return id;
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
