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
 * idle object after 10 seconds unless it has a pending timer, and evicts it
 * only once that timer fires or 15 minutes after it was set; a scheduled
 * alarm blocks neither. So the hold is one pending timer, moved only later.
 * Once it fires, the object hibernates on the platform's ordinary rules. The
 * object pays duration charges while held.
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
