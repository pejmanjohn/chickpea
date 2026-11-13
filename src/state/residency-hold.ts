/**
 * The Cloudflare deployment variable that turns the residency hold on: how
 * long, in milliseconds, a conversation keeps its Durable Objects in memory.
 * That is the state store after a person's turn is admitted and after it
 * ends, unless STORE_RESIDENCY_HOLD_VARIABLE sets the store's own window, and
 * a thread's runner and Agent object after the last turn they served. Unset,
 * empty or 0, nothing is held.
 */
export const RESIDENCY_HOLD_VARIABLE = 'CHICKPEA_RESIDENCY_HOLD_MS';

/**
 * The longest window RESIDENCY_HOLD_VARIABLE sets. It holds a runner and an
 * Agent object for every thread a person talked in, so it stays short.
 */
export const MAX_RESIDENCY_HOLD_MS = 15 * 60_000;

/**
 * The deployment variable that sets the state store's own window, in
 * milliseconds after a person's turn is admitted and after it ends. There is
 * one store per installation, so it can hold longer than a thread's objects.
 * Unset or empty, the store takes RESIDENCY_HOLD_VARIABLE's window; 0, it
 * holds nothing whatever that window is.
 */
export const STORE_RESIDENCY_HOLD_VARIABLE = 'CHICKPEA_STORE_RESIDENCY_HOLD_MS';

/** The longest window STORE_RESIDENCY_HOLD_VARIABLE sets. */
export const MAX_STORE_RESIDENCY_HOLD_MS = 60 * 60_000;

/**
 * Cloudflare lets one pending timer block eviction for 15 minutes from when it
 * was set. A hold's timer waits at most a minute less, so it fires, and sets
 * the next, while it still holds the object.
 */
const HOLD_TIMER_MS = 14 * 60_000;

function parseWindowMs(value: unknown, variable: string, max: number, unset: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const digits = typeof value === 'number' ? String(value) : value;
  if (typeof digits !== 'string' || !/^[0-9]+$/.test(digits) || Number(digits) > max) {
    throw new Error(`${variable} must be a whole number of milliseconds up to ${max}, ${unset}.`);
  }
  return Number(digits);
}

/**
 * The hold window a RESIDENCY_HOLD_VARIABLE value sets; undefined for none.
 * Throws for anything but a whole number of milliseconds up to
 * MAX_RESIDENCY_HOLD_MS. The guarded deploy refuses such a value with it.
 */
export function parseResidencyHoldMs(value: unknown): number | undefined {
  return parseWindowMs(value, RESIDENCY_HOLD_VARIABLE, MAX_RESIDENCY_HOLD_MS, 'or 0 or unset for no hold') || undefined;
}

/**
 * The window a STORE_RESIDENCY_HOLD_VARIABLE value sets: undefined when it is
 * unset or empty, so the store takes the conversation's window, and 0 for no
 * hold. Throws for anything but a whole number of milliseconds up to
 * MAX_STORE_RESIDENCY_HOLD_MS. The guarded deploy refuses such a value with it.
 */
export function parseStoreResidencyHoldMs(value: unknown): number | undefined {
  return parseWindowMs(
    value,
    STORE_RESIDENCY_HOLD_VARIABLE,
    MAX_STORE_RESIDENCY_HOLD_MS,
    `0 for no hold, or unset for ${RESIDENCY_HOLD_VARIABLE}'s window`,
  );
}

/**
 * The hold window this Worker's env sets for a thread's runner and Agent
 * object. A value the deploy would refuse holds nothing: an object that
 * cannot read its setting behaves as before the setting existed, rather than
 * failing the turn that reads it.
 */
export function residencyHoldMs(env: Record<string, unknown> | undefined): number | undefined {
  try {
    return parseResidencyHoldMs(env?.[RESIDENCY_HOLD_VARIABLE]);
  } catch {
    return undefined;
  }
}

/**
 * The state store's hold window in this Worker's env. A store value the
 * deploy would refuse counts as unset, as before the setting existed.
 */
export function storeResidencyHoldMs(env: Record<string, unknown> | undefined): number | undefined {
  let window: number | undefined;
  try {
    window = parseStoreResidencyHoldMs(env?.[STORE_RESIDENCY_HOLD_VARIABLE]);
  } catch {
    window = undefined;
  }
  return window === undefined ? residencyHoldMs(env) : window || undefined;
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
 * Why a hold moved its deadline later: a person's turn was admitted, or it
 * ended, or the state store's alarm or its first call on a new instance found
 * a person's window still open.
 */
export type HoldReason = 'admission' | 'turn_end' | 'alarm' | 'first_call';

/**
 * One change of a hold: a deadline moved later (`reason`), a timer of a run
 * set the next (`chain`), or the last timer fired (`expired`).
 */
export interface ResidencyHoldChange {
  reason: HoldReason | 'chain' | 'expired' | undefined;
  windowMs: number | undefined;
  /** When the hold lets the object go, in epoch milliseconds. */
  holdEndsAt: number;
  holdLeftMs: number;
  /** The timer this change set; absent on `expired`. */
  timerMs?: number;
  /** A deadline moved while a timer was pending. */
  renewed?: boolean;
}

export interface ResidencyHoldOptions {
  timers?: HoldTimers;
  /** Told each change of the hold; the state store logs them. */
  report?: (change: ResidencyHoldChange) => void;
}

/**
 * Keeps a Durable Object in memory for a window after a turn. Cloudflare
 * hibernates an idle object after 10 seconds unless it has a pending timer;
 * a scheduled alarm does not stop that. So the hold is one pending timer at a
 * time, moved only later. Whether the timer also blocks eviction depends on
 * the Worker's compatibility date:
 * - From 2026-10-01, or with the `durable_object_io_tasks_prevent_eviction`
 *   flag, it does, until it fires or 15 minutes after it was set. A window
 *   longer than HOLD_TIMER_MS is a run of timers, each set as the one before
 *   fires.
 * - Before that date and without the flag, as in wrangler.jsonc today, an
 *   object that cannot hibernate is still evicted after 70 to 140 seconds
 *   with no request or alarm. The state store's keep-warm tick is such an
 *   alarm. A thread's runner and Agent object have none, so their hold ends
 *   there.
 * Once the last timer fires, the object hibernates on the platform's
 * ordinary rules. The platform can also close a held object while its timer
 * is pending (staging, 2026-11-13), so a hold makes cold starts rarer but
 * cannot rule them out. The object pays duration charges while held. Without
 * a window it holds nothing.
 */
export class ResidencyHold {
  private readonly windowMs: number | undefined;
  private readonly timers: HoldTimers;
  private readonly report: ((change: ResidencyHoldChange) => void) | undefined;
  private timer: unknown;
  private until = 0;

  constructor(windowMs: number | undefined, options: ResidencyHoldOptions = {}) {
    this.windowMs = windowMs;
    this.timers = options.timers ?? platformTimers;
    this.report = options.report;
  }

  /** Whether this deployment holds objects at all. */
  get active(): boolean {
    return this.windowMs !== undefined;
  }

  /**
   * Hold until the window after `from`. A deadline already past, or no later
   * than the current one, changes nothing. `reason` names the change it
   * reports.
   */
  holdFrom(from: number, reason?: HoldReason): void {
    if (this.windowMs === undefined) return;
    const at = from + this.windowMs;
    const now = this.timers.now();
    if (at <= now || at <= this.until) return;
    const renewed = this.timer !== undefined;
    this.until = at;
    this.tell(reason, now, { timerMs: this.arm(now), renewed });
  }

  /** Sets the one pending timer, at most HOLD_TIMER_MS ahead; returns its delay. */
  private arm(now: number): number {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    const timerMs = Math.min(this.until - now, HOLD_TIMER_MS);
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      const firedAt = this.timers.now();
      if (firedAt < this.until) this.tell('chain', firedAt, { timerMs: this.arm(firedAt) });
      else this.tell('expired', firedAt);
    }, timerMs);
    return timerMs;
  }

  private tell(
    reason: ResidencyHoldChange['reason'],
    now: number,
    rest: Pick<ResidencyHoldChange, 'timerMs' | 'renewed'> = {},
  ): void {
    this.report?.({
      reason,
      windowMs: this.windowMs,
      holdEndsAt: this.until,
      holdLeftMs: Math.max(0, this.until - now),
      ...rest,
    });
  }
}
