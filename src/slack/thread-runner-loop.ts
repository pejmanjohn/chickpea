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
import { isSandboxDisconnect } from '../sandbox/reconnect.ts';
import { StateStoreUnavailable } from './flue-dispatch.ts';
import type { RunnerTurnBegin } from './thread-runner-rpc.ts';
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

/**
 * While a job runs, a wake stays armed this far ahead (refreshed every
 * THREAD_RUNNER_HEARTBEAT_MS), so an instance replaced mid-turn (a code
 * update, eviction) resumes within seconds.
 */
export const THREAD_RUNNER_BACKSTOP_MS = 5_000;
export const THREAD_RUNNER_HEARTBEAT_MS = 2_500;
/** A retained (not yet settled) turn is retried after this delay at least. */
export const THREAD_RUNNER_RETRY_MS = 2_000;
/** Retry an unrecorded terminal outcome or active-work clear at this interval. */
export const THREAD_RUNNER_SYNC_RETRY_MS = 30_000;
/** After a failed alarm: 2 s, doubling, at most a minute. */
export const THREAD_RUNNER_FAILURE_BACKOFF_MS = 2_000;
export const THREAD_RUNNER_FAILURE_BACKOFF_MAX_MS = 60_000;
/**
 * After the state store was unreachable (it is being replaced, usually for a
 * few seconds on a code update): 1 s, doubling, at most 8 s.
 */
const THREAD_RUNNER_STORE_BACKOFF_MS = 1_000;
const THREAD_RUNNER_STORE_BACKOFF_MAX_MS = 8_000;
/** Slack interaction cleanup checks: 30 s, doubling to 15 minutes, 8 tries. */
export const THREAD_RUNNER_CLEANUP_BACKOFF_MS = 30_000;
const THREAD_RUNNER_CLEANUP_BACKOFF_MAX_MS = 15 * 60_000;
export const THREAD_RUNNER_CLEANUP_ATTEMPTS = 8;

/** The state store's turn rows as a runner reaches them (over RPC in production). */
export interface ThreadRunnerTurnRows {
  view(id: string): Promise<RunnerTurnJobView>;
  /** `view` plus the turn's installation reads, in one round trip. */
  begin(id: string): Promise<RunnerTurnBegin>;
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
    onRetry: (afterMs?: number, reason?: 'state_store_unavailable') => void,
    threadKey: string,
    start: RunnerTurnBegin,
  ): Promise<boolean>;
  /** Called once a job settles or stops, e.g. to publish its presentation. */
  afterJob?(job: PendingTurnJob): Promise<void>;
  /** This runner's own presentation repairs; returns when to retry. */
  repair?(): Promise<{ nextRetryAt?: number }>;
  /** Retry a settled turn's Slack interaction cleanup (its acknowledgment reaction). */
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
  heartbeatMs?: number;
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
    // A follow-up that could not reach the state store counts as a failed
    // alarm: the runner backs off instead of waking again at once.
    let followUpsFailed = !(await followUps(deps, now));
    // A turn could not reach the state store: the runner backs off too.
    const outage = { storeUnavailable: false };
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
          const keepGoing = await runOne(deps, job, control, now, outage);
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
    followUpsFailed = !(await followUps(deps, now)) || followUpsFailed;
    const repairs = deps.repair ? await deps.repair() : {};
    deps.jobs.purge(now());
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
    if (outage.storeUnavailable) {
      // runOne already counted this failure and set the job's retry.
      record.reason = 'state_store_unavailable';
      return { record, ...(wakes.length > 0 ? { nextAlarmAt: Math.max(at, Math.min(...wakes)) } : {}) };
    }
    if (followUpsFailed) {
      record.reason = 'follow_up_failed';
      return { record, nextAlarmAt: at + failureBackoff(deps) };
    }
    deps.failures.count = 0;
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
    return { record, nextAlarmAt: now() + failureBackoff(deps, isSandboxDisconnect(error)) };
  } finally {
    record.durationMs = now() - startedAt;
    emitThreadRunnerAlarm(record, deps.sink);
  }
}

/**
 * 2 s after the first failed alarm, doubling, at most a minute; 1 s to 8 s
 * when the state store could not be reached (a replacement in progress).
 */
function failureBackoff(deps: ThreadRunnerLoopDeps, storeUnreachable = false): number {
  deps.failures.count += 1;
  const [base, max] = storeUnreachable
    ? [THREAD_RUNNER_STORE_BACKOFF_MS, THREAD_RUNNER_STORE_BACKOFF_MAX_MS]
    : [THREAD_RUNNER_FAILURE_BACKOFF_MS, THREAD_RUNNER_FAILURE_BACKOFF_MAX_MS];
  return Math.min(base * 2 ** (deps.failures.count - 1), max);
}

async function runOne(
  deps: ThreadRunnerLoopDeps,
  local: ThreadRunnerJobRecord,
  control: AlarmTurnJobControl,
  now: () => number,
  outage: { storeUnavailable: boolean },
): Promise<boolean> {
  const current = deps.jobs.get(local.id);
  if (!current || !OPEN_JOB_STATES.has(current.state)) {
    return true;
  }
  // The state store's row is authoritative: a settled or reclaimed turn never
  // runs here, and a dispatched one reattaches through its checkpoints. One
  // round trip also brings what the turn's installation context reads.
  const [start] = await Promise.all([
    deps.turns.begin(local.id),
    deps.armBackstop(now() + THREAD_RUNNER_BACKSTOP_MS),
  ]);
  const view = start.view;
  if (view.status !== 'pending' || !view.job) {
    settleFromView(deps, local.id, view, now);
    return true;
  }
  if (view.executor !== 'runner') {
    deps.jobs.settle(local.id, 'released', now());
    return true;
  }
  deps.jobs.markRunning(local.id);
  let retryAfterMs: number | undefined;
  let retry = false;
  let storeUnavailable = false;
  let settled: boolean;
  // Keep a wake a few seconds ahead for as long as the job runs.
  const heartbeat = setInterval(() => {
    void deps.armBackstop(now() + THREAD_RUNNER_BACKSTOP_MS).catch(() => undefined);
  }, deps.heartbeatMs ?? THREAD_RUNNER_HEARTBEAT_MS);
  try {
    settled = await deps.execute(view.job, control, (afterMs, reason) => {
      retry = true;
      if (reason === 'state_store_unavailable') storeUnavailable = true;
      if (afterMs !== undefined) retryAfterMs = Math.max(retryAfterMs ?? 0, afterMs);
    }, local.threadKey, start);
  } finally {
    clearInterval(heartbeat);
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
  if (storeUnavailable) {
    // 1 s after the first outage, doubling to 8 s.
    outage.storeUnavailable = true;
    deps.jobs.settle(local.id, 'admitted', now(), now() + failureBackoff(deps, true));
    return false;
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
 * state store never takes them over. False when the state store could not be
 * reached (a Slack cleanup failure has its own backoff and is not counted).
 */
async function followUps(deps: ThreadRunnerLoopDeps, now: () => number): Promise<boolean> {
  for (const job of deps.jobs.unsyncedTerminals()) {
    try {
      if (job.terminalSync === 'done') await deps.turns.markDelivered(job.id);
      else await deps.turns.markError(job.id);
      deps.jobs.terminalSynced(job.id);
    } catch {
      console.warn('[chickpea] thread runner could not record a settled turn yet');
      return false;
    }
  }
  for (const job of deps.jobs.pendingActiveClears()) {
    try {
      await deps.clearActiveWork(job.threadKey, job.id);
      deps.jobs.owesActiveClear(job.id, false);
    } catch {
      return false;
    }
  }
  for (const job of deps.jobs.dueCleanups(now())) {
    let view: RunnerTurnJobView;
    try {
      view = await deps.turns.view(job.id);
    } catch {
      return false;
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
  return true;
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
        if (active) throw unavailable(error);
        jobs.owesActiveClear(generation, true);
      }
    },
    markCodingActiveWork: (...args) => storeCall(() => remote.markCodingActiveWork(...args)),
    isCodingActiveWork: (...args) => storeCall(() => remote.isCodingActiveWork(...args)),
    release: (...args) => storeCall(() => remote.release(...args)),
  };
}

/**
 * A state-store call from inside a turn. A store that stays unreachable
 * (it is being replaced) becomes {@link StateStoreUnavailable}: a retryable
 * failure the turn body passes through untouched, so it never posts a
 * failure notice for it, and the executor keeps the turn for its next attempt.
 */
async function storeCall<T>(call: () => T | Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw unavailable(error);
  }
}

function unavailable(error: unknown): unknown {
  return error instanceof Error && error.name === 'StateStoreDisconnectedError'
    ? new StateStoreUnavailable()
    : error;
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
    recordAttempt: (...args) => storeCall(() => remote.recordAttempt(...args)),
    markRecoveryRequired: (...args) => storeCall(() => remote.markRecoveryRequired(...args)),
    prepareFlueDispatch: (...args) => storeCall(() => remote.prepareFlueDispatch(...args)),
    reconcileFlueExistingInstance: (...args) =>
      storeCall(() => remote.reconcileFlueExistingInstance(...args)),
    recordFlueReceipt: (...args) => storeCall(() => remote.recordFlueReceipt(...args)),
    recordFlueSettlement: (...args) => storeCall(() => remote.recordFlueSettlement(...args)),
    recordPullRequest: (...args) => storeCall(() => remote.recordPullRequest(...args)),
    freezeRuntimePlan: (...args) => storeCall(() => remote.freezeRuntimePlan(...args)),
    getBoundRuntimePlan: (...args) => storeCall(() => remote.getBoundRuntimePlan(...args)),
    recordUsagePersistence: (...args) => storeCall(() => remote.recordUsagePersistence(...args)),
    recordInteractionIntent: (...args) => storeCall(() => remote.recordInteractionIntent(...args)),
    recordSlackInteractionProgress: (...args) =>
      storeCall(() => remote.recordSlackInteractionProgress(...args)),
    markDelivered: (id) => settle(id, 'done'),
    markError: (id) => settle(id, 'error'),
  };
}

/** Presentation copies are published at most this often, trailing the latest. */
export const RUNNER_PRESENTATION_PUBLISH_INTERVAL_MS = 3_000;
/** The thread's latest session generation is read from the state store at most this often. */
export const RUNNER_GENERATION_CACHE_MS = 15_000;

/**
 * The runner's presentation state: its own SQLite copy is authoritative for
 * every write, per stream chunk and activity change included. What readers of
 * the shared state store need (Admin views, the thread's session-generation
 * fence) is published back on lifecycle changes only (stream start and end,
 * terminal delivery, session and cleanup settlement), at most one publish per
 * interval with the latest copy trailing, and once more when the job stops
 * (`publish`). The state store's generation for the thread is cached briefly,
 * so activity changes make no state-store calls.
 */
export function runnerPresentationState(input: {
  local: SlackRunPresentationStoreLogic;
  remote: Pick<SlackPresentationStatePort, 'matchFlueObservation' | 'getLatestThreadSessionGeneration'>;
  putRemote(presentation: SlackRunPresentation): Promise<unknown>;
  now?: () => number;
  publishIntervalMs?: number;
  generationCacheMs?: number;
}): { state: SlackPresentationStatePort; publish(runId: string | undefined): Promise<void> } {
  const now = input.now ?? Date.now;
  const interval = input.publishIntervalMs ?? RUNNER_PRESENTATION_PUBLISH_INTERVAL_MS;
  const published = new Map<string, string>();
  const trailing = new Map<string, ReturnType<typeof setTimeout>>();
  let lastPublishAt = Number.NEGATIVE_INFINITY;
  const put = async (runId: string, always = false) => {
    const presentation = input.local.get(runId);
    if (!presentation) return;
    const fingerprint = lifecycleFingerprint(presentation);
    if (!always && published.get(runId) === fingerprint) return;
    lastPublishAt = now();
    try {
      await input.putRemote(presentation);
      published.set(runId, fingerprint);
      if (published.size > 64) published.delete(published.keys().next().value!);
    } catch {
      // Readers see the earlier copy until the next lifecycle change or job end.
      console.warn('[chickpea] thread runner presentation publish failed');
    }
  };
  const lifecycleChanged = async (presentation: SlackRunPresentation) => {
    const runId = presentation.runId;
    if (published.get(runId) === lifecycleFingerprint(presentation) || trailing.has(runId)) return;
    const wait = lastPublishAt + interval - now();
    if (wait <= 0) {
      await put(runId);
      return;
    }
    trailing.set(runId, setTimeout(() => {
      trailing.delete(runId);
      void put(runId);
    }, wait));
  };
  const generations = new Map<string, { value: number | undefined; at: number }>();
  const base = localSlackPresentationStatePort({
    presentations: input.local,
    matchFlueObservation: (instanceId, submissionId) =>
      storeCall(() => input.remote.matchFlueObservation(instanceId, submissionId)),
  });
  return {
    state: {
      ...base,
      // The shared store sees every presentation of this Slack thread,
      // including ones other executors own; generations never change, and a
      // newer one appears only with a new message, so a brief cache is safe.
      getLatestThreadSessionGeneration: async (root) => {
        const key = `${root.workspaceId}:${root.channelId}:${root.threadTs}`;
        let cached = generations.get(key);
        if (!cached || now() - cached.at >= (input.generationCacheMs ?? RUNNER_GENERATION_CACHE_MS)) {
          cached = {
            value: await storeCall(() => input.remote.getLatestThreadSessionGeneration(root)),
            at: now(),
          };
          generations.set(key, cached);
        }
        const local = input.local.getLatestThreadSessionGeneration(root);
        if (local === undefined) return cached.value;
        return cached.value === undefined ? local : Math.max(local, cached.value);
      },
      transitionRunPresentation: async (transition) => {
        if (!published.has(transition.runId)) {
          // The state store's copy matched this one when this alarm began
          // (hand-off or an earlier publish); the job-end publish corrects it.
          const before = input.local.get(transition.runId);
          if (before) published.set(transition.runId, lifecycleFingerprint(before));
        }
        const result = input.local.transition(transition);
        if (result.outcome === 'applied') await lifecycleChanged(result.presentation);
        return result;
      },
    },
    publish: async (runId) => {
      if (!runId) return;
      const timer = trailing.get(runId);
      if (timer !== undefined) {
        clearTimeout(timer);
        trailing.delete(runId);
      }
      // Always, once per job: version-gated, so an unchanged copy is a no-op.
      await put(runId, true);
    },
  };
}

/** What readers of the state store's copy look at; activity changes are not in it. */
function lifecycleFingerprint(presentation: SlackRunPresentation): string {
  const v3 = presentation.schemaVersion === 3 ? presentation : undefined;
  const terminal = v3?.terminalDelivery as { state?: string; operation?: { certainty?: string } } | undefined;
  const cleanup = v3?.cleanup as { state?: string; operation?: { certainty?: string } } | undefined;
  return JSON.stringify([
    presentation.stream.state,
    presentation.stream.messageTs ?? null,
    // repairRequired follows each activity receipt; the state store's repair
    // sweep skips runner-owned turns, so it is published with the rest only.
    v3?.lifecyclePhase,
    v3?.agentSession.desired,
    v3?.agentSession.acknowledged,
    terminal?.state,
    terminal?.operation?.certainty,
    cleanup?.state,
    cleanup?.operation?.certainty,
    v3?.continuations?.state,
  ]);
}

/**
 * One runner loop at a time, whether the alarm or an admission started it.
 * A request that arrives while a loop runs joins it; the loop then runs once
 * more, since work may have arrived after its last listing, unless it yielded
 * at its budget or left a job carried: a second loop in the same invocation
 * would get a fresh observation budget and head for the platform's 15-minute
 * alarm limit, so the re-armed alarm (a second out) reattaches instead.
 * Never throws.
 */
export function runnerLoopScheduler(input: {
  runOnce(): Promise<ThreadRunnerAlarmResult>;
  arm(nextAlarmAt: number | undefined): Promise<void>;
  now?: () => number;
}): () => Promise<void> {
  const now = input.now ?? Date.now;
  let running: Promise<void> | undefined;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      // Publish `running` before the loop starts, so a call from inside it joins.
      await Promise.resolve();
      let repeat: boolean;
      do {
        again = false;
        let result: ThreadRunnerAlarmResult | undefined;
        try {
          result = await input.runOnce();
        } catch {
          // Setup failed before the loop could run: try again soon.
          console.warn('[chickpea] thread runner alarm could not start');
        }
        try {
          await input.arm(result ? result.nextAlarmAt : now() + THREAD_RUNNER_FAILURE_BACKOFF_MAX_MS);
        } catch {
          // The instance is being replaced; its successor resumes the job.
        }
        repeat = again && result !== undefined && !result.record.yielded && result.record.carried === 0;
      } while (repeat);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
}
