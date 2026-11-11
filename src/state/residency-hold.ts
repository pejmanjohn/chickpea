/**
 * The Cloudflare deployment variable that turns the residency hold on: how
 * long, in milliseconds, a conversation keeps its Durable Objects in memory.
 * That is the state store after a person's turn is admitted and after it
 * ends, and a thread's runner and Agent object after the last turn they
 * served. Unset, empty or 0, nothing is held.
 */
export const RESIDENCY_HOLD_VARIABLE = 'CHICKPEA_RESIDENCY_HOLD_MS';

/** The longest one pending timer holds an object (see ResidencyHold). */
export const MAX_RESIDENCY_HOLD_MS = 15 * 60_000;

/**
 * The hold window a RESIDENCY_HOLD_VARIABLE value sets; undefined for none.
 * Throws for anything but a whole number of milliseconds up to
 * MAX_RESIDENCY_HOLD_MS. The guarded deploy refuses such a value with it.
 */
export function parseResidencyHoldMs(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const digits = typeof value === 'number' ? String(value) : value;
  if (typeof digits !== 'string' || !/^[0-9]+$/.test(digits) || Number(digits) > MAX_RESIDENCY_HOLD_MS) {
    throw new Error(
      `${RESIDENCY_HOLD_VARIABLE} must be a whole number of milliseconds up to ${MAX_RESIDENCY_HOLD_MS}, or 0 or unset for no hold.`,
    );
  }
  return Number(digits) || undefined;
}

/**
 * The hold window this Worker's env sets. A value the deploy would refuse
 * holds nothing: an object that cannot read its setting behaves as before
 * the setting existed, rather than failing the turn that reads it.
 */
export function residencyHoldMs(env: Record<string, unknown> | undefined): number | undefined {
  try {
    return parseResidencyHoldMs(env?.[RESIDENCY_HOLD_VARIABLE]);
  } catch {
    return undefined;
  }
}

/** The clock and timer a hold runs on. */
export interface HoldTimers {
  now(): number;
  set(callback: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

const platformTimers: HoldTimers = {
  now: () => Date.now(),
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (timer) => clearTimeout(timer as Parameters<typeof clearTimeout>[0]),
};

/**
 * Keeps a Durable Object in memory for a window after a turn. Cloudflare
 * hibernates an idle object after 10 seconds unless it has a pending timer;
 * a scheduled alarm does not stop that. So the hold is one pending timer,
 * moved only later. Whether the timer also blocks eviction depends on the
 * Worker's compatibility date:
 * - From 2026-10-01, or with the `durable_object_io_tasks_prevent_eviction`
 *   flag, it does, until it fires or 15 minutes after it was set.
 * - Before that date and without the flag, as in wrangler.jsonc today, an
 *   object that cannot hibernate is still evicted after 70 to 140 seconds
 *   with no request or alarm. The state store's keep-warm tick is such an
 *   alarm. A thread's runner and Agent object have none, so their hold ends
 *   there.
 * Once the timer fires, the object hibernates on the platform's ordinary
 * rules. The object pays duration charges while held. Without a window
 * (RESIDENCY_HOLD_VARIABLE unset) it holds nothing.
 */
export class ResidencyHold {
  private readonly windowMs: number | undefined;
  private readonly timers: HoldTimers;
  private timer: unknown;
  private until = 0;

  constructor(windowMs: number | undefined, timers: HoldTimers = platformTimers) {
    this.windowMs = windowMs;
    this.timers = timers;
  }

  /** Whether this deployment holds objects at all. */
  get active(): boolean {
    return this.windowMs !== undefined;
  }

  /** Hold until the window after `from`. A deadline already past, or no later than the current one, changes nothing. */
  holdFrom(from: number): void {
    if (this.windowMs === undefined) return;
    const at = from + this.windowMs;
    const now = this.timers.now();
    if (at <= now || at <= this.until) return;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.until = at;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
    }, at - now);
  }
}
