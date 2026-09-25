import {
  emitThreadRunnerAlarm,
  type RuntimeLatencySink,
  type ThreadRunnerAlarmRecord,
} from '../observability/runtime-latency.ts';
import {
  ALARM_ADMISSION_RECHECK_MS,
  ALARM_TURN_BUDGET_MS,
  ALARM_TURN_HARD_CAP_MS,
  ALARM_YIELD_REARM_MS,
  drainAlarmTurnJobs,
  type AlarmTurnJobControl,
} from './alarm-turn-drain.ts';
import type { SlackPresentationStatePort } from './agent-view-presentation.ts';
import { localSlackPresentationStatePort } from './presentation-state-port.ts';
import type {
  SlackRunPresentation,
  SlackRunPresentationStoreLogic,
} from './run-presentations.ts';
import {
  OPEN_JOB_STATES,
  type ThreadRunnerJobRecord,
  type ThreadRunnerJobStore,
} from './thread-runner-jobs.ts';
import type { TurnExecutionPorts } from './turn-executor.ts';
import type { PendingTurnJob, RunnerTurnJobView } from './turn-jobs.ts';

/**
 * The turn execution loop of one SlackThreadRunner alarm, free of
 * `cloudflare:workers` so it runs against fakes on Node.
 *
 * The runner is the only executor for its thread: jobs run strictly in
 * admission order through the shared `executeTurnJob`. Each alarm observes
 * for at most the alarm budget (10 minutes), then aborts observation exactly
 * as the state store's alarm does; the turn yields with its durable receipt
 * and the next alarm (a second later) reattaches. A yield is never an
 * attempt. A backstop alarm is armed whenever a job starts, so a runner that
 * is evicted mid-turn resumes from the turn row's checkpoints instead of
 * dispatching again. The alarm never throws: a failure (the state store
 * unreachable, say) is logged and retried with a bounded backoff, so a
 * thread recovers without waiting for a new message.
 */

/** Wake again this soon while a job is running, so eviction is recovered. */
export const THREAD_RUNNER_BACKSTOP_MS = 30_000;
/** A retained (not yet settled) turn is retried after this delay at least. */
export const THREAD_RUNNER_RETRY_MS = 2_000;
/** Retry an unrecorded terminal outcome or active-work clear at this interval. */
export const THREAD_RUNNER_SYNC_RETRY_MS = 30_000;
/** After a failed alarm: 2 s, doubling, at most a minute. */
export const THREAD_RUNNER_FAILURE_BACKOFF_MS = 2_000;
export const THREAD_RUNNER_FAILURE_BACKOFF_MAX_MS = 60_000;
/** Slack interaction cleanup checks: 30 s, doubling to 15 minutes, 8 tries. */
export const THREAD_RUNNER_CLEANUP_BACKOFF_MS = 30_000;
const THREAD_RUNNER_CLEANUP_BACKOFF_MAX_MS = 15 * 60_000;
export const THREAD_RUNNER_CLEANUP_ATTEMPTS = 8;

/** The state store's turn rows as a runner reaches them (over RPC in production). */
export interface ThreadRunnerTurnRows {
  view(id: string): Promise<RunnerTurnJobView>;
  markDelivered(id: string): Promise<void>;
  markError(id: string): Promise<void>;
}

export interface ThreadRunnerLoopDeps {
  jobs: ThreadRunnerJobStore;
  turns: ThreadRunnerTurnRows;
  /** `executeTurnJob` with this runner's ports. */
  execute(
    job: PendingTurnJob,
    control: AlarmTurnJobControl,
    onRetry: (afterMs?: number) => void,
    threadKey: string,
  ): Promise<boolean>;
  /** Called once a job settles or stops, e.g. to publish its presentation. */
  afterJob?(job: PendingTurnJob): Promise<void>;
  /** This runner's own presentation repairs; returns when to retry. */
  repair?(): Promise<{ nextRetryAt?: number }>;
  /** Retry a settled turn's Slack interaction cleanup (reactions, checklists). */
  repairInteraction?(job: PendingTurnJob): Promise<void>;
  /** Clear a settled turn's active-work flag in the state store. */
  clearActiveWork(threadKey: string, jobId: string): Promise<void>;
  /** Keep a wake armed no later than `at` (the backstop while a job runs). */
  armBackstop(at: number): Promise<void>;
  /** Jobs an earlier alarm of this isolate left running at its hard cap. */
  carried: Map<string, Promise<void>>;
  /** Consecutive failed alarms of this isolate (drives the backoff). */
  failures: { count: number };
  /** Registers the drain's wake for admissions; returns its release. */
  onWake?: (wake: () => void) => () => void;
  now?: () => number;
  budgetMs?: number;
  hardCapMs?: number;
  recheckMs?: number;
  sink?: RuntimeLatencySink;
}

export interface ThreadRunnerAlarmResult {
  record: ThreadRunnerAlarmRecord;
  /** When the runner's next alarm should fire; none when it is idle. */
  nextAlarmAt?: number;
}

const THREAD = 'thread';
const TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export async function runThreadRunnerAlarm(
  deps: ThreadRunnerLoopDeps,
): Promise<ThreadRunnerAlarmResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const record: ThreadRunnerAlarmRecord = {
    jobs: deps.jobs.openCount(),
    ran: 0,
    yielded: false,
    carried: 0,
    durationMs: 0,
    outcome: 'idle',
  };
  try {
    await followUps(deps, now);
    const budgetMs = deps.budgetMs ?? ALARM_TURN_BUDGET_MS;
    let stopped = false;
    // One drain runs the jobs listed when it starts (and any admitted while
    // a job runs); list again after it until the thread stops or the budget
    // ends, so a backlog never waits for another alarm.
    while (!stopped && !record.yielded && deps.carried.size === 0 && now() < startedAt + budgetMs) {
      const initial = deps.jobs.runnable(now());
      if (initial.length === 0) break;
      record.outcome = 'drained';
      const drain = await drainAlarmTurnJobs<ThreadRunnerJobRecord>({
        initial,
        jobId: (job) => job.id,
        threadKey: () => THREAD,
        runJob: async (job, control) => {
          record.ran += 1;
          const keepGoing = await runOne(deps, job, control, now);
          if (!keepGoing) stopped = true;
          return keepGoing;
        },
        refresh: async () => deps.jobs.runnable(now()),
        carried: {
          threadKeys: () => new Set(deps.carried.size > 0 ? [THREAD] : []),
          jobIds: () => new Set(deps.carried.keys()),
        },
        startConcurrency: 1,
        maxActiveThreads: 1,
        startedAt,
        budgetMs,
        hardCapMs: deps.hardCapMs ?? ALARM_TURN_HARD_CAP_MS,
        recheckMs: deps.recheckMs ?? ALARM_ADMISSION_RECHECK_MS,
        now,
        ...(deps.onWake ? { onWake: deps.onWake } : {}),
      });
      record.yielded = drain.budgetExhausted;
      record.carried += drain.carried.length;
      for (const carried of drain.carried) {
        deps.carried.set(carried.id, carried.settled);
        void carried.settled.finally(() => deps.carried.delete(carried.id));
      }
    }
    await followUps(deps, now);
    const repairs = deps.repair ? await deps.repair() : {};
    deps.jobs.purge(now());
    deps.failures.count = 0;
    const at = now();
    const syncOwed = deps.jobs.unsyncedTerminals(1).length > 0 ||
      deps.jobs.pendingActiveClears(1).length > 0;
    const wakes = [
      // A turn still running here past the cap: look again at the backstop.
      deps.carried.size > 0 ? at + THREAD_RUNNER_BACKSTOP_MS : deps.jobs.nextDueAt(at),
      syncOwed ? at + THREAD_RUNNER_SYNC_RETRY_MS : undefined,
      deps.jobs.nextCleanupAt(),
      repairs.nextRetryAt,
    ].filter((value): value is number => value !== undefined);
    return {
      record,
      ...(wakes.length > 0 ? { nextAlarmAt: Math.max(at, Math.min(...wakes)) } : {}),
    };
  } catch (error) {
    // Never throw: the platform's alarm retries give up after a few minutes,
    // which would strand this thread until its next message. Jobs keep their
    // state; the next alarm reads the turn row again and reattaches.
    record.outcome = 'threw';
    record.reason = error instanceof Error && TOKEN.test(error.name) ? error.name : 'unknown';
    deps.failures.count += 1;
    const backoff = Math.min(
      THREAD_RUNNER_FAILURE_BACKOFF_MS * 2 ** (deps.failures.count - 1),
      THREAD_RUNNER_FAILURE_BACKOFF_MAX_MS,
    );
    return { record, nextAlarmAt: now() + backoff };
  } finally {
    record.durationMs = now() - startedAt;
    emitThreadRunnerAlarm(record, deps.sink);
  }
}

async function runOne(
  deps: ThreadRunnerLoopDeps,
  local: ThreadRunnerJobRecord,
  control: AlarmTurnJobControl,
  now: () => number,
): Promise<boolean> {
  const current = deps.jobs.get(local.id);
  if (!current || !OPEN_JOB_STATES.has(current.state)) {
    return true;
  }
  // The state store's row is authoritative: a settled or reclaimed turn never
  // runs here, and a dispatched one reattaches through its checkpoints.
  const view = await deps.turns.view(local.id);
  if (view.status !== 'pending' || !view.job) {
    settleFromView(deps, local.id, view, now);
    return true;
  }
  if (view.executor !== 'runner') {
    deps.jobs.settle(local.id, 'released', now());
    return true;
  }
  deps.jobs.markRunning(local.id);
  await deps.armBackstop(now() + THREAD_RUNNER_BACKSTOP_MS);
  let retryAfterMs: number | undefined;
  let retry = false;
  let settled: boolean;
  try {
    settled = await deps.execute(view.job, control, (afterMs) => {
      retry = true;
      if (afterMs !== undefined) retryAfterMs = Math.max(retryAfterMs ?? 0, afterMs);
    }, local.threadKey);
  } finally {
    await deps.afterJob?.(view.job).catch(() => undefined);
  }
  const after = deps.jobs.get(local.id);
  // The terminal was recorded locally first (see the runner's turn port).
  if (after && (after.state === 'done' || after.state === 'error')) return true;
  const row = await deps.turns.view(local.id);
  if (row.status !== 'pending') {
    settleFromView(deps, local.id, row, now);
    return true;
  }
  if (control.signal.aborted && !retry) {
    // The alarm budget ended observation on purpose; the next alarm, a
    // second from now, reattaches.
    deps.jobs.settle(local.id, 'yielded', now(), now() + ALARM_YIELD_REARM_MS);
    return false;
  }
  if (settled) {
    // A durable outbox owns the terminal. Like the state store's alarm, check
    // it again shortly without holding the thread's next turn.
    deps.jobs.settle(local.id, 'deferred', now(), now() + THREAD_RUNNER_RETRY_MS);
    return true;
  }
  deps.jobs.settle(
    local.id,
    'admitted',
    now(),
    now() + Math.max(THREAD_RUNNER_RETRY_MS, retryAfterMs ?? 0),
  );
  return false;
}

function settleFromView(
  deps: ThreadRunnerLoopDeps,
  id: string,
  view: RunnerTurnJobView,
  now: () => number,
): void {
  if (view.status === 'recovery_required') {
    deps.jobs.settle(id, 'recovery_required', now());
    return;
  }
  deps.jobs.settle(id, view.status === 'done' ? 'done' : 'error', now());
}

/**
 * What a settled turn still owes, each retried until it succeeds: record its
 * outcome in the state store, clear its active-work flag, and finish its
 * Slack interaction cleanup. The runner keeps these for its own turns; the
 * state store never takes them over.
 */
async function followUps(deps: ThreadRunnerLoopDeps, now: () => number): Promise<void> {
  for (const job of deps.jobs.unsyncedTerminals()) {
    try {
      if (job.terminalSync === 'done') await deps.turns.markDelivered(job.id);
      else await deps.turns.markError(job.id);
      deps.jobs.terminalSynced(job.id);
    } catch {
      console.warn('[chickpea] thread runner could not record a settled turn yet');
      return;
    }
  }
  for (const job of deps.jobs.pendingActiveClears()) {
    try {
      await deps.clearActiveWork(job.threadKey, job.id);
      deps.jobs.owesActiveClear(job.id, false);
    } catch {
      return;
    }
  }
  for (const job of deps.jobs.dueCleanups(now())) {
    let view: RunnerTurnJobView;
    try {
      view = await deps.turns.view(job.id);
    } catch {
      return;
    }
    if (!view.cleanupPending || !view.job || !deps.repairInteraction) {
      deps.jobs.scheduleCleanup(job.id, undefined, 0);
      continue;
    }
    if (job.cleanupAttempts >= THREAD_RUNNER_CLEANUP_ATTEMPTS) {
      console.warn('[chickpea] thread runner gave up a Slack interaction cleanup');
      deps.jobs.scheduleCleanup(job.id, undefined, job.cleanupAttempts);
      continue;
    }
    try {
      await deps.repairInteraction(view.job);
    } catch {
      console.warn('[chickpea] thread runner Slack interaction cleanup will retry');
    }
    const attempts = job.cleanupAttempts + 1;
    deps.jobs.scheduleCleanup(job.id, now() + Math.min(
      THREAD_RUNNER_CLEANUP_BACKOFF_MS * 2 ** (attempts - 1),
      THREAD_RUNNER_CLEANUP_BACKOFF_MAX_MS,
    ), attempts);
  }
}

/**
 * The runner's Slack state port: a failure to clear a turn's active-work flag
 * never fails the turn (its final may already be posted); the runner owes the
 * clear and retries it.
 */
export function runnerSlackPort(
  remote: TurnExecutionPorts['slack'],
  jobs: ThreadRunnerJobStore,
): TurnExecutionPorts['slack'] {
  return {
    setActiveWork: async (key, generation, active) => {
      try {
        await remote.setActiveWork(key, generation, active);
        if (!active) jobs.owesActiveClear(generation, false);
      } catch (error) {
        if (active) throw error;
        jobs.owesActiveClear(generation, true);
      }
    },
    markCodingActiveWork: (...args) => remote.markCodingActiveWork(...args),
    release: (...args) => remote.release(...args),
  };
}

/**
 * The runner's turn-row port: the state store's, except that a terminal
 * outcome is settled in the runner's own storage before the state store
 * records it. The Slack final is already posted when `markDelivered` runs; if
 * the state store cannot be reached then, the turn still never runs again,
 * and the runner records the outcome on a later alarm.
 */
export function runnerTurnJobsPort<P extends TurnExecutionPorts['turnJobs']>(
  remote: P,
  jobs: ThreadRunnerJobStore,
  now: () => number = Date.now,
): TurnExecutionPorts['turnJobs'] {
  const settle = async (id: string, outcome: 'done' | 'error') => {
    jobs.settleTerminal(id, outcome, now());
    try {
      if (outcome === 'done') await remote.markDelivered(id);
      else await remote.markError(id);
      jobs.terminalSynced(id);
    } catch {
      console.warn('[chickpea] thread runner will record a settled turn later');
    }
  };
  return {
    recordAttempt: (...args) => remote.recordAttempt(...args),
    markRecoveryRequired: (...args) => remote.markRecoveryRequired(...args),
    prepareFlueDispatch: (...args) => remote.prepareFlueDispatch(...args),
    reconcileFlueExistingInstance: (...args) => remote.reconcileFlueExistingInstance(...args),
    recordFlueReceipt: (...args) => remote.recordFlueReceipt(...args),
    recordFlueSettlement: (...args) => remote.recordFlueSettlement(...args),
    recordPullRequest: (...args) => remote.recordPullRequest(...args),
    freezeRuntimePlan: (...args) => remote.freezeRuntimePlan(...args),
    getBoundRuntimePlan: (...args) => remote.getBoundRuntimePlan(...args),
    recordUsagePersistence: (...args) => remote.recordUsagePersistence(...args),
    recordInteractionIntent: (...args) => remote.recordInteractionIntent(...args),
    recordSlackInteractionProgress: (...args) => remote.recordSlackInteractionProgress(...args),
    markDelivered: (id) => settle(id, 'done'),
    markError: (id) => settle(id, 'error'),
  };
}

/**
 * The runner's presentation state: its own SQLite copy is authoritative for
 * every write, per stream chunk included. What other readers of the shared
 * state store need (Admin views, the thread's session-generation fence) is
 * published back when the presentation's lifecycle changes, a few times per
 * turn, and once more when the job stops (`publish`).
 */
export function runnerPresentationState(input: {
  local: SlackRunPresentationStoreLogic;
  remote: Pick<SlackPresentationStatePort, 'matchFlueObservation' | 'getLatestThreadSessionGeneration'>;
  putRemote(presentation: SlackRunPresentation): Promise<unknown>;
}): { state: SlackPresentationStatePort; publish(runId: string | undefined): Promise<void> } {
  const published = new Map<string, string>();
  const publish = async (presentation: SlackRunPresentation, force = false) => {
    const fingerprint = lifecycleFingerprint(presentation);
    if (!force && published.get(presentation.runId) === fingerprint) return;
    try {
      await input.putRemote(presentation);
      published.set(presentation.runId, fingerprint);
      if (published.size > 64) published.delete(published.keys().next().value!);
    } catch {
      // Readers see the earlier copy until the next lifecycle change or job end.
      console.warn('[chickpea] thread runner presentation publish failed');
    }
  };
  const base = localSlackPresentationStatePort({
    presentations: input.local,
    matchFlueObservation: (instanceId, submissionId) =>
      input.remote.matchFlueObservation(instanceId, submissionId),
  });
  return {
    state: {
      ...base,
      // The shared store sees every presentation of this Slack thread,
      // including ones other executors own; generations never change.
      getLatestThreadSessionGeneration: async (root) => {
        const [local, remote] = await Promise.all([
          input.local.getLatestThreadSessionGeneration(root),
          input.remote.getLatestThreadSessionGeneration(root),
        ]);
        if (local === undefined) return remote;
        return remote === undefined ? local : Math.max(local, remote);
      },
      transitionRunPresentation: async (transition) => {
        const result = input.local.transition(transition);
        if (result.outcome === 'applied') await publish(result.presentation);
        return result;
      },
    },
    publish: async (runId) => {
      const presentation = runId ? input.local.get(runId) : undefined;
      if (presentation) await publish(presentation, false);
    },
  };
}

function lifecycleFingerprint(presentation: SlackRunPresentation): string {
  const v3 = presentation.schemaVersion === 3 ? presentation : undefined;
  return JSON.stringify([
    presentation.stream.state,
    presentation.stream.messageTs ?? null,
    presentation.repairRequired,
    v3?.lifecyclePhase,
    v3?.activityProjection,
    v3?.agentSession,
    v3?.terminalDelivery,
    v3?.cleanup,
    v3?.continuations?.state,
  ]);
}
