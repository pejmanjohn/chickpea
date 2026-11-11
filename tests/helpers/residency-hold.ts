import { ResidencyHold, type HoldTimers } from '../../src/state/residency-hold.ts';

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

/** A hold for a probe that does not look at it. */
export function unobservedHold(): ResidencyHold {
  return new ResidencyHold(new ScriptedTimers(Date.now));
}
