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
 * it runs out the drain stops admitting and aborts every observation. A turn
 * that is only observing an already-dispatched reply yields: it stays pending
 * with its durable receipt, and the next alarm reattaches to it. That is the
 * same recovery the platform kill used to force, done cleanly and with time
 * left for the rest of the alarm to run.
 */

/**
 * Admission and observation stop here. Cloudflare ends an alarm at 15 minutes
 * of wall time; the remaining five cover unwinding the aborted observations
 * (relay drains, milestone writes), finishing turns that were already past
 * observation and delivering (file uploads included), and the alarm's tail
 * (ledger runs, cleanups, presentation repairs, schedule actions, receipts).
 */
export const ALARM_TURN_BUDGET_MS = 10 * 60_000;

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
  /** Jobs that may be starting at once (not yet only observing). */
  startConcurrency: number;
  /** Threads that may run at once, observing ones included. */
  maxActiveThreads: number;
  budgetMs: number;
  recheckMs: number;
  now?: () => number;
  /** Registers the drain's wake for in-object admission; returns its release. */
  onWake?: (wake: () => void) => () => void;
}

export interface AlarmTurnDrainResult {
  /** The budget ended with work still observing; the caller re-arms promptly. */
  budgetExhausted: boolean;
}

interface ThreadState<J> {
  queue: J[];
  running: boolean;
  stopped: boolean;
}

export async function drainAlarmTurnJobs<J>(
  options: AlarmTurnDrainOptions<J>,
): Promise<AlarmTurnDrainResult> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.budgetMs;
  const controller = new AbortController();
  const seen = new Set<string>();
  const threads = new Map<string, ThreadState<J>>();
  const ready: string[] = [];
  const running = new Set<Promise<void>>();
  const runningJobIds = new Set<string>();
  let ticking: Promise<void> | undefined;
  let freeSlots = Math.max(1, options.startConcurrency);
  let activeThreads = 0;
  let budgetExhausted = false;
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

  const admit = (jobs: readonly J[]) => {
    for (const job of jobs) {
      const id = options.jobId(job);
      if (seen.has(id)) continue;
      const key = options.threadKey(job);
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

  const runOne = async (key: string, thread: ThreadState<J>, job: J) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      freeSlots += 1;
      wake();
    };
    let keepGoing = false;
    const id = options.jobId(job);
    runningJobIds.add(id);
    try {
      keepGoing = await options.runJob(job, { signal: controller.signal, observing: release });
    } catch (error) {
      // Store unavailability: stop admitting, let every observation yield,
      // and surface the error once the in-flight turns have unwound.
      failure ??= { error };
      if (!controller.signal.aborted) controller.abort(error);
    } finally {
      runningJobIds.delete(id);
      release();
      thread.running = false;
      activeThreads -= 1;
      if (!keepGoing) thread.stopped = true;
      else if (thread.queue.length > 0) ready.push(key);
      wake();
    }
  };

  const startTick = () => {
    if (!options.tick || ticking || controller.signal.aborted) return;
    ticking = options.tick(runningJobIds).catch((error: unknown) => {
      failure ??= { error };
      if (!controller.signal.aborted) controller.abort(error);
    }).finally(() => {
      ticking = undefined;
    });
  };

  const pump = () => {
    while (!controller.signal.aborted && freeSlots > 0 &&
        activeThreads < options.maxActiveThreads && ready.length > 0) {
      const key = ready.shift()!;
      const thread = threads.get(key)!;
      const job = thread.queue.shift();
      if (!job || thread.running || thread.stopped) continue;
      thread.running = true;
      activeThreads += 1;
      freeSlots -= 1;
      const task = runOne(key, thread, job);
      running.add(task);
      void task.finally(() => running.delete(task));
    }
  };

  const release = options.onWake?.(wake);
  try {
    admit(options.initial);
    pump();
    while (running.size > 0) {
      if (!controller.signal.aborted && now() >= deadline) {
        budgetExhausted = true;
        controller.abort(new AlarmTurnBudgetYield());
      }
      if (controller.signal.aborted) {
        // Aborted observations yield promptly; turns already delivering finish.
        await Promise.all([...running]);
        break;
      }
      await sleepOrWake(Math.min(options.recheckMs, deadline - now()));
      if (now() >= deadline) continue;
      try {
        admit(await options.refresh());
      } catch (error) {
        failure ??= { error };
        controller.abort(error);
        continue;
      }
      pump();
      startTick();
    }
    // The alarm's own tail runs these drains next; never overlap it.
    await ticking;
  } finally {
    release?.();
  }
  if (failure) throw failure.error;
  return { budgetExhausted };
}
