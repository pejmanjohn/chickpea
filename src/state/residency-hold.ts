/**
 * How long a conversation keeps its Durable Objects in memory: the state
 * store after a person's last admitted turn, and a thread's runner and Agent
 * object after the last turn they served. At most 15 minutes, the longest one
 * pending timer holds an object (see ResidencyHold).
 */
export const KEEP_WARM_WINDOW_MS = 10 * 60_000;

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
 * Keeps a Durable Object in memory until a deadline. Cloudflare hibernates an
 * idle object after 10 seconds unless it has a pending timer; a scheduled
 * alarm does not stop that. So the hold is one pending timer, moved only
 * later. Whether the timer also blocks eviction depends on the Worker's
 * compatibility date:
 * - From 2026-10-01, or with the `durable_object_io_tasks_prevent_eviction`
 *   flag, it does, until it fires or 15 minutes after it was set.
 * - Before that date and without the flag, as in wrangler.jsonc today, an
 *   object that cannot hibernate is still evicted after 70 to 140 seconds
 *   with no request or alarm. The state store's keep-warm tick is such an
 *   alarm. A thread's runner and Agent object have none, so their hold ends
 *   there.
 * Once the timer fires, the object hibernates on the platform's ordinary
 * rules. The object pays duration charges while held.
 */
export class ResidencyHold {
  private timer: unknown;
  private until = 0;

  constructor(private readonly timers: HoldTimers = platformTimers) {}

  /** Hold until `at`. A deadline already past, or no later than the current one, changes nothing. */
  extendTo(at: number): void {
    const now = this.timers.now();
    if (at <= now || at <= this.until) return;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.until = at;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
    }, at - now);
  }
}
