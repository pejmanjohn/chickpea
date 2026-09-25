import { CHICKPEA_SUBMISSION_DURABILITY } from '../agents/submission-durability.ts';

/**
 * Turn scheduling for one Cloudflare TagStateStore alarm invocation.
 *
 * A Durable Object runs one alarm at a time, and an alarm it arms while one
 * is running cannot fire until that one returns. A delegated coding task can
 * keep a single turn observing for an hour, so an alarm that listed its work
 * once and then waited for every turn would hold every newly delivered Slack
 * message until Cloudflare killed it at the 15-minute alarm wall-time limit.
 *
 * This drain instead keeps admitting while it waits: it re-reads the gateway
 * inbox and pending turn jobs whenever admission wakes it (and at a short
 * fallback interval), starting new work alongside turns that are already
 * observing. Ordering inside one conversation is kept: a thread's next job
 * never starts while its previous one is still running, and a job that asks to
 * stop its thread ends that thread for the rest of the alarm.
 *
 * The whole invocation also has a budget well under the platform limit. When
 * it runs out the drain aborts every observation. A turn that is only
 * observing an already-dispatched reply yields: it stays pending with its
 * durable receipt, and the next alarm reattaches to it. That is the same
 * recovery the platform kill used to force, done cleanly. Admission continues
 * while the cut work unwinds, and a hard cap returns the alarm well before the
 * platform limit even if some work ignores the abort.
 */

/**
 * Observation of turns started in this alarm yields here, counted from the
 * alarm's start. Cloudflare ends an alarm at 15 minutes of wall time.
 */
export const ALARM_TURN_BUDGET_MS = 10 * 60_000;

/**
 * The drain returns by this point whatever still runs. Between the budget and
 * the cap it keeps admitting new messages while aborted observations unwind
 * and deliveries in flight finish; anything still running at the cap (a large
 * upload, a slow container start) is carried: it keeps running in this
 * isolate, and its thread stays closed until it settles. The last three
 * minutes are the alarm's tail (ledger runs, cleanups, repairs, schedule
 * actions, receipts).
 */
export const ALARM_TURN_HARD_CAP_MS = 12 * 60_000;

/**
 * Fallback re-check of the inbox and pending jobs while turns run. Admission
 * inside this Durable Object wakes the drain at once; this interval only
 * bounds the delay for work that arrives any other way. It matches the relay
 * retry backoff, so an inbox item that failed transiently is not retried any
 * faster than before.
 */
export const ALARM_ADMISSION_RECHECK_MS = 2_000;

/**
 * Yields are free only while the submission can still be running. Flue ends a
 * coordinator submission within its durability timeout; past that plus this
 * margin, a reply that still has not settled is treated like any other failed
 * reattachment, so it cannot hold its thread and active work forever.
 */
export const ALARM_YIELD_BACKSTOP_MS =
  (CHICKPEA_SUBMISSION_DURABILITY.timeoutMs ?? 60 * 60_000) + 30 * 60_000;

/** Whether yields for a submission accepted at `acceptedAt` still cost nothing. */
export function alarmYieldIsFree(acceptedAt: string | undefined, now: number): boolean {
  const accepted = acceptedAt === undefined ? Number.NaN : Date.parse(acceptedAt);
  // An unreadable receipt time cannot prove the submission outlived its budget.
  return !Number.isFinite(accepted) || now - accepted <= ALARM_YIELD_BACKSTOP_MS;
}

/**
 * Pending jobs listed per conversation on each refresh. A thread runs one job
 * at a time, so a few are enough to keep it moving inside one alarm, and a
 * long queue in one thread never hides another conversation.
 */
export const ALARM_PENDING_PER_THREAD = 4;

/** Re-arm delay after a budget yield: prompt, but not the error backoff. */
export const ALARM_YIELD_REARM_MS = 1_000;

export class AlarmTurnBudgetYield extends Error {
  constructor() {
    super('The alarm turn budget ended; observation yields for reattachment.');
    this.name = 'AlarmTurnBudgetYield';
  }
}

export interface AlarmTurnJobControl {
  /** Aborted when the alarm stops observing; the observed turn then yields. */
  signal: AbortSignal;
  /** The job is now only observing a dispatched reply; frees its start slot. */
  observing(): void;
}

/** Jobs a previous alarm left running in this isolate (see `carried`). */
export interface AlarmCarriedTurns {
  threadKeys(): ReadonlySet<string>;
  jobIds(): ReadonlySet<string>;
}

export interface AlarmTurnDrainOptions<J> {
  initial: readonly J[];
  jobId(job: J): string;
  threadKey(job: J): string;
  /** Run one job. `false` stops its thread for the rest of this alarm. */
  runJob(job: J, control: AlarmTurnJobControl): Promise<boolean>;
  /** Admit newly delivered work, then list the pending jobs. */
  refresh(): Promise<readonly J[]>;
  /**
   * The alarm's other due work (receipts, schedule actions, repairs), run on
   * each wake and re-check while turns observe so it never waits for the
   * budget. Never overlaps itself; it receives the ids of jobs running now so
   * it can leave their records to them.
   */
  tick?(runningJobIds: ReadonlySet<string>): Promise<void>;
  /**
   * Jobs an earlier alarm returned without, still running in this isolate.
   * Their threads are not started again until they finish, so a delivery in
   * flight is never run twice.
   */
  carried?: AlarmCarriedTurns;
  /** Jobs that may be starting at once (not yet only observing). */
  startConcurrency: number;
  /** Threads that may run at once, observing ones included. */
  maxActiveThreads: number;
  /** When the alarm invocation began; budgets count from here. */
  startedAt?: number;
  /** Observation of jobs started before this point yields. */
  budgetMs: number;
  /** The drain returns by this point, leaving unfinished jobs carried. */
  hardCapMs: number;
  recheckMs: number;
  now?: () => number;
  /** Registers the drain's wake for in-object admission; returns its release. */
  onWake?: (wake: () => void) => () => void;
}

export interface AlarmTurnDrainResult {
  /** The budget ended with work still observing; the caller re-arms promptly. */
  budgetExhausted: boolean;
  /**
   * Jobs still running at the hard cap (a delivery or setup that does not
   * react to the abort). The caller keeps their threads closed until each
   * settles; their own outcome writes stay authoritative.
   */
  carried: Array<{ id: string; threadKey: string; settled: Promise<void> }>;
}

interface ThreadState<J> {
  queue: J[];
  running: boolean;
  stopped: boolean;
}

interface RunningJob {
  id: string;
  threadKey: string;
  /** Started before the budget ended (its observation yields at the budget). */
  early: boolean;
  settled: Promise<void>;
}

export async function drainAlarmTurnJobs<J>(
  options: AlarmTurnDrainOptions<J>,
): Promise<AlarmTurnDrainResult> {
  const now = options.now ?? Date.now;
  const startedAt = options.startedAt ?? now();
  const budgetAt = startedAt + options.budgetMs;
  const hardCapAt = startedAt + Math.max(options.budgetMs, options.hardCapMs);
  // Jobs started before the budget observe under `early`; jobs admitted while
  // the alarm waits for work that ignores the abort observe under `late`.
  const early = new AbortController();
  const late = new AbortController();
  const seen = new Set<string>();
  const threads = new Map<string, ThreadState<J>>();
  const ready: string[] = [];
  const running = new Map<string, RunningJob>();
  let ticking: Promise<void> | undefined;
  let refreshing: Promise<void> | undefined;
  let freeSlots = Math.max(1, options.startConcurrency);
  let activeThreads = 0;
  let budgetExhausted = false;
  let admissionOpen = true;
  let failure: { error: unknown } | undefined;

  let wakePending = false;
  let wakeWaiter: (() => void) | undefined;
  const wake = () => {
    const waiter = wakeWaiter;
    wakeWaiter = undefined;
    if (waiter) waiter();
    else wakePending = true;
  };
  const sleepOrWake = (milliseconds: number) => new Promise<void>((resolve) => {
    if (wakePending) {
      wakePending = false;
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      wakeWaiter = undefined;
      resolve();
    }, Math.max(0, milliseconds));
    wakeWaiter = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  /** Resolves with the promise, or at `at`, whichever comes first. */
  const settleBy = async (promise: Promise<unknown> | undefined, at: number) => {
    if (!promise) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      promise.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, at - now())); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  };

  const fail = (error: unknown) => {
    failure ??= { error };
    admissionOpen = false;
    if (!early.signal.aborted) early.abort(error);
    if (!late.signal.aborted) late.abort(error);
  };

  const admit = (jobs: readonly J[]) => {
    if (!admissionOpen) return;
    const carriedThreads = options.carried?.threadKeys();
    for (const job of jobs) {
      const id = options.jobId(job);
      if (seen.has(id)) continue;
      const key = options.threadKey(job);
      // A thread whose job an earlier alarm left running waits for it.
      if (carriedThreads?.has(key)) continue;
      let thread = threads.get(key);
      // A thread whose job asked to stop keeps its later jobs for a later alarm.
      if (thread?.stopped) continue;
      if (!thread) {
        thread = { queue: [], running: false, stopped: false };
        threads.set(key, thread);
      }
      thread.queue.push(job);
      seen.add(id);
      if (!thread.running && !ready.includes(key)) ready.push(key);
    }
  };

  const runOne = async (key: string, thread: ThreadState<J>, job: J, id: string, signal: AbortSignal) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      freeSlots += 1;
      wake();
    };
    let keepGoing = false;
    try {
      keepGoing = await options.runJob(job, { signal, observing: release });
    } catch (error) {
      // Store unavailability: stop admitting, let every observation yield,
      // and surface the error once the in-flight turns have unwound.
      fail(error);
    } finally {
      running.delete(id);
      release();
      thread.running = false;
      activeThreads -= 1;
      if (!keepGoing) thread.stopped = true;
      else if (thread.queue.length > 0) ready.push(key);
      pump();
      wake();
    }
  };

  function pump(): void {
    while (admissionOpen && freeSlots > 0 &&
        activeThreads < options.maxActiveThreads && ready.length > 0) {
      const key = ready.shift()!;
      const thread = threads.get(key)!;
      const job = thread.queue.shift();
      if (!job || thread.running || thread.stopped) continue;
      thread.running = true;
      activeThreads += 1;
      freeSlots -= 1;
      const id = options.jobId(job);
      const isEarly = !budgetExhausted;
      const entry: RunningJob = { id, threadKey: key, early: isEarly, settled: Promise.resolve() };
      running.set(id, entry);
      entry.settled = runOne(key, thread, job, id, isEarly ? early.signal : late.signal);
    }
  }

  let refreshAgain = false;
  const startRefresh = () => {
    if (!admissionOpen) return;
    if (refreshing) {
      // Work may have arrived after the running refresh read the inbox.
      refreshAgain = true;
      return;
    }
    // Refresh runs beside the loop: a slow inbox item never holds back the
    // budget checks, and every finished job still starts its successor.
    refreshing = options.refresh().then(
      (jobs) => { admit(jobs); pump(); },
      (error: unknown) => fail(error),
    ).finally(() => {
      refreshing = undefined;
      if (refreshAgain) {
        refreshAgain = false;
        startRefresh();
      }
      // With nothing running, the loop only waits for this refresh; let it
      // see the jobs this refresh started (or leave) without a full re-check.
      if (running.size === 0) wake();
    });
  };

  const startTick = () => {
    if (!options.tick || ticking || !admissionOpen) return;
    const exclude = new Set([...running.keys(), ...(options.carried?.jobIds() ?? [])]);
    ticking = options.tick(exclude).catch((error: unknown) => fail(error)).finally(() => {
      ticking = undefined;
    });
  };

  const release = options.onWake?.(wake);
  let cappedOut = false;
  try {
    admit(options.initial);
    pump();
    // A refresh in flight can still admit and start jobs, so the drain never
    // returns while one runs: every started job is awaited or carried.
    while (running.size > 0 || refreshing) {
      const at = now();
      if (!budgetExhausted && at >= budgetAt) {
        budgetExhausted = true;
        early.abort(new AlarmTurnBudgetYield());
      }
      if (budgetExhausted && admissionOpen &&
          ![...running.values()].some((job) => job.early)) {
        // Everything the budget cut has unwound. Work admitted meanwhile
        // yields now, and the next alarm (armed in a second) reattaches it.
        admissionOpen = false;
        late.abort(new AlarmTurnBudgetYield());
      }
      if (at >= hardCapAt) {
        // Whatever still runs ignores the abort (a delivery or setup in
        // flight). Return without it rather than meet the platform kill.
        admissionOpen = false;
        if (!late.signal.aborted) late.abort(new AlarmTurnBudgetYield());
        cappedOut = true;
        break;
      }
      const nextAt = budgetExhausted ? hardCapAt : budgetAt;
      await sleepOrWake(Math.min(options.recheckMs, nextAt - now()));
      if (admissionOpen && running.size > 0) {
        startRefresh();
        pump();
        startTick();
      }
    }
    // Nothing may start once the loop has decided to return: a job a late
    // refresh admitted now would be neither awaited nor carried.
    admissionOpen = false;
    // The alarm's own tail runs these drains next; never overlap it. Neither
    // may hold the alarm past its cap.
    await settleBy(ticking, hardCapAt);
    await settleBy(refreshing, hardCapAt);
  } finally {
    release?.();
  }
  if (failure) throw failure.error;
  return {
    budgetExhausted,
    carried: cappedOut
      ? [...running.values()].map(({ id, threadKey, settled }) => ({ id, threadKey, settled }))
      : [],
  };
}
