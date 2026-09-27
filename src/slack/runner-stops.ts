import type { CodingTaskStopReport } from '../sandbox/coding-task-stop.ts';
import type { SlackThreadAgentTarget } from './flue-dispatch.ts';
import {
  ORDERED_JOB_STATES,
  type ThreadRunnerJobStore,
  type ThreadRunnerStopMarker,
} from './thread-runner-jobs.ts';
import {
  THREAD_RUNNER_HEARTBEAT_MS,
  THREAD_RUNNER_SYNC_RETRY_MS,
  type ThreadRunnerTurnRows,
} from './thread-runner-loop.ts';
import type { FlueSettlementCheckpointV1, TurnStopNotice } from './turn-job-types.ts';
import type { RunnerTurnJobView } from './turn-jobs.ts';

/**
 * A thread runner's stops (KTD2-KTD4): free of `cloudflare:workers` so it
 * runs against fakes on Node, like thread-runner-loop.ts, which owns the
 * turn-execution loop this stop machinery is attached to (a runner's
 * ThreadRunnerLoopDeps.stops) and is the alarm executor's own StopAbortFence
 * caller. Kept in its own module because it is self-contained: nothing here
 * reaches into the alarm loop beyond the shared job store and constants.
 */

/** A failed stop abort is tried again 2.5 s later, doubling to every 30 s. */
export const THREAD_RUNNER_STOP_ABORT_BACKOFF_MAX_MS = 30_000;
/**
 * A stop's Flue abort request unanswered this long counts as a failed
 * attempt: it stays owed and is repeated while its turn is unsettled. The
 * thread's next turn waits for a request in flight no longer than this.
 */
export const THREAD_RUNNER_STOP_ABORT_TIMEOUT_MS = 5_000;
/** The runner's `stop` RPC waits this long at most for its abort's answer. */
export const THREAD_RUNNER_STOP_RECEIVE_WAIT_MS = 2_000;
/**
 * The state store's outbox waits this long at most for a runner's `stop`
 * RPC, which answers within THREAD_RUNNER_STOP_RECEIVE_WAIT_MS when the
 * runner is well: one that has not answered counts as not acknowledged, and
 * the stop is offered again after the outbox's backoff.
 */
export const STOP_NOTICE_DELIVERY_TIMEOUT_MS = 5_000;

/**
 * Runner states whose turn may still hold the thread's unsettled Flue
 * submission: the states that hold the thread's later jobs. A runner runs
 * its thread strictly in order, so while its stopped turn is in one of them
 * no later turn of the thread has been dispatched into the coordinator
 * instance they share.
 */
const STOPPABLE_STATES = ORDERED_JOB_STATES;

/** A runner turn's Flue checkpoints, as the runner's turn port records them. */
export interface RunnerTurnObserver {
  noteReceipt(id: string, submissionId: string): void;
  noteSettlement(id: string, outcome: FlueSettlementCheckpointV1['outcome']): void;
}

/** What a runner's stops reach outside the runner's own storage. */
export interface RunnerStopDeps {
  jobs: ThreadRunnerJobStore;
  /** Flue `abort()` of the stopped turn's coordinator instance (abortSlackThreadAgent). */
  abortHost(target: SlackThreadAgentTarget): Promise<void>;
  /**
   * Stop and confirm the coding workers the host turn's task records name
   * (stopCodingTasks, KTD4); up to about 14 s. Absent where no coding
   * workspace can exist (no Sandbox binding): a stop then owes no cascade.
   */
  stopCodingTasks?(notice: TurnStopNotice): Promise<CodingTaskStopReport>;
  now?: () => number;
  /** Focused seams: THREAD_RUNNER_STOP_ABORT_TIMEOUT_MS and THREAD_RUNNER_STOP_RECEIVE_WAIT_MS. */
  abortTimeoutMs?: number;
  receiveWaitMs?: number;
}

/**
 * A thread runner's stops (KTD2, KTD4). The state store's stop outbox calls
 * `receive` (the runner's `stop` RPC); everything slow runs in the runner's
 * alarm, which the RPC makes due, never in the RPC's own request.
 *
 * - The host abort: Flue `abort()` of the coordinator instance named by the
 *   stopped turn's persisted dispatch envelope, requested only while that
 *   turn may still hold the thread's unsettled submission (STOPPABLE_STATES,
 *   and no settlement recorded here or carried by the notice). `abort()`
 *   stops whatever the instance runs when the request lands, and later turns
 *   of the thread share it, so a stop redelivered after its turn settled is
 *   acknowledged without one, and no turn starts while a request is out
 *   (`abortsSettled`). A request unanswered after
 *   THREAD_RUNNER_STOP_ABORT_TIMEOUT_MS counts as failed, so that wait is
 *   bounded; its request was sent at least that long before the next
 *   turn's dispatch to the same instance, which almost always takes it
 *   first, and a wedged coordinator cannot hold the thread forever. An
 *   answered request whose turn settled meanwhile is recorded moot, never
 *   done. The turn's live observation is left running: it reads the
 *   `aborted` settlement through its normal path, so a stop never becomes a
 *   yield. A failed abort stays owed and the running job's heartbeat (or the
 *   next alarm) repeats it.
 * - The coding cascade: once the host abort is confirmed (or the turn read
 *   its `aborted` settlement), the coding workers are stopped and confirmed
 *   from the host turn's task records. The first report is kept for the
 *   stop note (`codingReport`); a redelivered stop never runs it again. A
 *   turn that settled on its own before any abort took effect (R22) owes
 *   neither.
 */
export class RunnerStops implements RunnerTurnObserver {
  private readonly aborting = new Map<string, Promise<void>>();
  private readonly cascades = new Map<string, Promise<CodingTaskStopReport | undefined>>();
  /** The receipt each turn recorded through this instance (lost with it). */
  private readonly receipts = new Map<string, string>();
  /** Turns whose Flue settlement this instance recorded: never aborted. */
  private readonly settled = new Set<string>();
  /** When a failed abort may be tried again from a heartbeat. */
  private readonly retryAbortAt = new Map<string, number>();

  constructor(private readonly deps: RunnerStopDeps) {}

  /**
   * The runner's `stop` RPC. Persists the stop first; `acknowledged` is true
   * once the runner owns everything the stop still needs. It stays false
   * while the stopped turn's submission is not yet known (a dispatch in
   * flight could land after the abort), so the outbox brings the stop back
   * with the receipt and the abort is repeated then. `wake`: the alarm should
   * run now (the stopped path, or owed stop work). The RPC waits for its
   * abort's answer THREAD_RUNNER_STOP_RECEIVE_WAIT_MS at most: a slower one
   * goes on in this object, where the alarm (made due by the RPC) and the
   * thread's next turn wait for it.
   */
  async receive(notice: TurnStopNotice): Promise<{ acknowledged: boolean; wake: boolean }> {
    if (!validStopNotice(notice)) {
      console.warn('[chickpea] thread runner refused a malformed stop notice');
      return { acknowledged: false, wake: false };
    }
    const { jobs } = this.deps;
    const id = notice.turnJobId;
    // A notice of a settled submission is not live even where this instance
    // lost what it noted (an eviction between the settlement and the terminal).
    const live = notice.settled === undefined && this.stoppable(id);
    const dispatched = notice.instanceId !== undefined;
    const marker = jobs.recordStop(notice, {
      abort: live && dispatched ? 'owed' : 'none',
      cascade: live && dispatched && this.deps.stopCodingTasks ? 'owed' : 'none',
    }, this.now());
    if (!live) {
      // Settled here (a redelivery, or a run that finished first), settled
      // as the state store recorded it, or never handed here: nothing of it
      // is running, and later turns may share the instance. A stop taken
      // before the settlement takes it as its turn would have noted it. A
      // stop that never dispatched is kept from dispatching by its row's
      // stop record alone.
      if (notice.settled !== undefined) this.noteSettlement(id, notice.settled);
      else if (marker.abort === 'owed') this.lapse(marker);
      return { acknowledged: true, wake: jobs.hasOwedStops() };
    }
    // Waiting for a retry: its stopped path runs at the next alarm instead.
    jobs.makeDue(id);
    const known = marker.notice?.submissionId ?? this.receipts.get(id);
    if (marker.abort === 'done' && dispatched &&
        (known === undefined || known !== marker.abortedSubmissionId)) {
      // The confirmed abort was requested before this submission was known.
      jobs.updateStop(id, { abort: 'owed' });
    }
    await boundedStopCall(
      this.tryAbort(id),
      this.deps.receiveWaitMs ?? THREAD_RUNNER_STOP_RECEIVE_WAIT_MS,
    ).catch(() => undefined);
    return { acknowledged: !dispatched || known !== undefined, wake: true };
  }

  noteReceipt(id: string, submissionId: string): void {
    this.receipts.set(id, submissionId);
    if (this.receipts.size > 64) this.receipts.delete(this.receipts.keys().next().value!);
    try {
      const marker = this.deps.jobs.stopMarker(id);
      if (!marker?.notice?.instanceId || marker.abort === 'none' ||
          marker.abortedSubmissionId === submissionId) return;
      // The stop reached this turn while its dispatch was in flight: the
      // abort may have preceded the submission, so it is repeated now.
      this.deps.jobs.updateStop(id, { abort: 'owed' });
      void this.tryAbort(id);
    } catch {
      console.warn('[chickpea] thread runner stop follow-up will retry');
    }
  }

  noteSettlement(id: string, outcome: FlueSettlementCheckpointV1['outcome']): void {
    this.settled.add(id);
    if (this.settled.size > 64) this.settled.delete(this.settled.values().next().value!);
    this.receipts.delete(id);
    try {
      const marker = this.deps.jobs.stopMarker(id);
      if (!marker) return;
      if (outcome === 'aborted') {
        // The abort took effect, whether or not its request was confirmed.
        if (marker.abort === 'owed') this.deps.jobs.updateStop(id, { abort: 'done' });
        return;
      }
      // The run settled on its own before the abort took effect (R22; an
      // abort that loses the race settles as completed): the stop stopped
      // nothing, so no coding job is stopped for it either.
      this.deps.jobs.updateStop(id, {
        ...(marker.abort === 'owed' ? { abort: 'none' as const } : {}),
        ...(marker.cascade === 'owed' && !this.cascades.has(id) ? { cascade: 'none' as const } : {}),
      });
    } catch {
      console.warn('[chickpea] thread runner could not note a stopped settlement');
    }
  }

  /**
   * From a running job's heartbeat (and once it returns): repeat an owed
   * abort when its backoff allows, or start the coding cascade a confirmed
   * abort allows. Never throws; the work it starts is awaited by `drain`.
   */
  heartbeat(id: string): void {
    try {
      const marker = this.deps.jobs.stopMarker(id);
      if (marker?.abort === 'owed' && this.stoppable(id, marker)) {
        if ((this.retryAbortAt.get(id) ?? 0) <= this.now()) void this.tryAbort(id);
        return;
      }
      this.advance(id);
    } catch {
      console.warn('[chickpea] thread runner stop follow-up will retry');
    }
  }

  /** At each alarm's start and end: every stop's owed abort (once, whatever its backoff), then its cascade. */
  async followUp(): Promise<void> {
    let owed: ThreadRunnerStopMarker[];
    try {
      owed = this.deps.jobs.owedStops();
    } catch {
      return;
    }
    for (const marker of owed) {
      if (marker.abort === 'owed') await this.tryAbort(marker.turnJobId);
      try {
        this.advance(marker.turnJobId);
      } catch {
        console.warn('[chickpea] thread runner stop follow-up will retry');
      }
    }
  }

  /**
   * The coding-worker confirmation of a stopped turn (KTD4), for its stop
   * note (KTD3): the first report, running the cascade now if it is still
   * owed. Call it once the turn read its `aborted` settlement: the host can
   * then start no new coding job, so an abort this runner could not confirm
   * has taken effect after all. Undefined when the stop owes no cascade (the
   * turn never dispatched, or no coding workspace can exist) or the cascade
   * failed (it is retried by a later alarm; the note says the coding work may
   * still be winding down).
   */
  async codingReport(id: string): Promise<CodingTaskStopReport | undefined> {
    const marker = this.deps.jobs.stopMarker(id);
    if (!marker) return undefined;
    if (marker.codingReport) return marker.codingReport;
    if (marker.cascade !== 'owed') return undefined;
    if (marker.abort === 'owed') this.deps.jobs.updateStop(id, { abort: 'done' });
    return this.cascade(id);
  }

  /**
   * Resolves once no abort request is in flight. Before a turn starts: an
   * abort stops whatever the thread's coordinator instance runs when it
   * lands. Bounded, since each request is (THREAD_RUNNER_STOP_ABORT_TIMEOUT_MS).
   */
  async abortsSettled(): Promise<void> {
    while (this.aborting.size > 0) await Promise.allSettled([...this.aborting.values()]);
  }

  /** Wait for every abort and cascade in flight (the alarm ends only after them). */
  async drain(): Promise<void> {
    while (this.aborting.size > 0 || this.cascades.size > 0) {
      await Promise.allSettled([...this.aborting.values(), ...this.cascades.values()]);
    }
  }

  /** A stop that still owes work brings the alarm back; its turn's own wake is usually sooner. */
  nextRetryAt(at: number): number | undefined {
    try {
      return this.deps.jobs.hasOwedStops() ? at + THREAD_RUNNER_SYNC_RETRY_MS : undefined;
    } catch {
      return undefined;
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** An owed abort whose turn no longer runs here lapses; a confirmed one starts its cascade. */
  private advance(id: string): void {
    const marker = this.deps.jobs.stopMarker(id);
    if (!marker) return;
    if (marker.abort === 'owed') {
      if (!this.stoppable(id, marker)) this.lapse(marker);
      return;
    }
    if (marker.abort === 'done' && marker.cascade === 'owed') void this.cascade(id);
  }

  /**
   * The stopped turn settled (or was never here) before any abort was
   * confirmed: nothing is left to stop, so neither the abort nor a cascade
   * not yet started is owed any more. A confirmed abort keeps its cascade.
   */
  private lapse(marker: ThreadRunnerStopMarker): void {
    const id = marker.turnJobId;
    this.deps.jobs.updateStop(id, {
      ...(marker.abort === 'owed' ? { abort: 'none' as const } : {}),
      ...(marker.abort !== 'done' && marker.cascade === 'owed' && !this.cascades.has(id)
        ? { cascade: 'none' as const }
        : {}),
    });
  }

  private stoppable(id: string, marker = this.deps.jobs.stopMarker(id)): boolean {
    const job = this.deps.jobs.get(id);
    return job !== undefined && STOPPABLE_STATES.has(job.state) && !this.settled.has(id) &&
      marker?.notice?.settled === undefined;
  }

  /**
   * One abort request at a time per turn, bounded by
   * THREAD_RUNNER_STOP_ABORT_TIMEOUT_MS; a failure stays owed. Never rejects.
   * The stoppable check and the entry in `aborting` happen in one step, so a
   * turn started after it waits for the request (see `abortsSettled`).
   */
  private tryAbort(id: string): Promise<void> {
    const inFlight = this.aborting.get(id);
    if (inFlight) return inFlight;
    const run = (async () => {
      const { jobs } = this.deps;
      const marker = jobs.stopMarker(id);
      if (marker?.abort !== 'owed') return;
      const target = marker.notice;
      if (!target?.instanceId || !this.stoppable(id, marker)) {
        this.lapse(marker);
        return;
      }
      const covering = target.submissionId ?? this.receipts.get(id);
      const attempts = marker.abortAttempts + 1;
      try {
        await boundedStopCall(this.deps.abortHost({
          instanceId: target.instanceId,
          ...(target.uid ? { uid: target.uid } : {}),
        }), this.deps.abortTimeoutMs ?? THREAD_RUNNER_STOP_ABORT_TIMEOUT_MS);
      } catch {
        jobs.updateStop(id, { abortAttempts: attempts });
        this.retryAbortAt.set(id, this.now() + Math.min(
          THREAD_RUNNER_HEARTBEAT_MS * 2 ** Math.min(attempts - 1, 8),
          THREAD_RUNNER_STOP_ABORT_BACKOFF_MAX_MS,
        ));
        console.warn('[chickpea] thread runner stop abort will retry', { attempts });
        return;
      }
      this.retryAbortAt.delete(id);
      // Read the stop again: its turn may have settled while the request was
      // out. One that finished on its own (R22) makes the abort moot: it
      // stopped nothing, so it owes no coding cascade either.
      const after = jobs.stopMarker(id);
      if (!after) return;
      if (after.abort === 'none' || (after.abort === 'owed' && !this.stoppable(id, after))) {
        jobs.updateStop(id, { abortAttempts: attempts });
        if (after.abort === 'owed') this.lapse(after);
        return;
      }
      jobs.updateStop(id, {
        abort: 'done',
        abortAttempts: attempts,
        ...(covering ? { abortedSubmissionId: covering } : {}),
      });
    })().catch(() => {
      console.warn('[chickpea] thread runner stop abort will retry');
    }).finally(() => {
      this.aborting.delete(id);
    });
    this.aborting.set(id, run);
    return run;
  }

  /** One cascade at a time per turn; its first report is kept. Never rejects. */
  private cascade(id: string): Promise<CodingTaskStopReport | undefined> {
    const inFlight = this.cascades.get(id);
    if (inFlight) return inFlight;
    const { jobs } = this.deps;
    const marker = jobs.stopMarker(id);
    if (!marker || marker.cascade !== 'owed') return Promise.resolve(marker?.codingReport);
    const stopCodingTasks = this.deps.stopCodingTasks;
    if (!marker.notice || !stopCodingTasks) {
      jobs.updateStop(id, { cascade: 'none' });
      return Promise.resolve(undefined);
    }
    const notice = marker.notice;
    const run = (async () => {
      try {
        return jobs.saveCodingStopReport(id, await stopCodingTasks(notice));
      } catch {
        console.warn('[chickpea] thread runner coding stop will retry');
        return undefined;
      }
    })().finally(() => {
      this.cascades.delete(id);
    });
    this.cascades.set(id, run);
    return run;
  }
}

const SETTLEMENT_OUTCOMES: ReadonlySet<string> = new Set(['completed', 'failed', 'aborted']);

function validStopNotice(notice: TurnStopNotice | undefined): notice is TurnStopNotice {
  const bounded = (value: unknown, max: number) =>
    typeof value === 'string' && value.length > 0 && value.length <= max;
  const optional = (value: unknown, max: number) => value === undefined || bounded(value, max);
  return notice !== null && typeof notice === 'object' &&
    bounded(notice.turnJobId, 256) && bounded(notice.runnerKey, 512) &&
    notice.record?.role === 'stopped' &&
    optional(notice.instanceId, 512) && optional(notice.uid, 512) && optional(notice.submissionId, 512) &&
    (notice.settled === undefined || SETTLEMENT_OUTCOMES.has(notice.settled));
}

/**
 * A stop for a turn the state store's own alarm executes (the emergency
 * `SLACK_TAG_TURN_EXECUTOR=alarm` fallback), decided from its row: the
 * coordinator is aborted in-process while the row's Flue submission is
 * unsettled, and the alarm's live observation reads the `aborted`
 * settlement. The alarm runs a thread's turns in order, so a pending row's
 * instance holds no later turn of the thread; the caller runs this inside
 * its StopAbortFence, so none starts while the abort is out. True
 * (acknowledged) once the abort covers a recorded submission or nothing is
 * left to abort: `reread`, the row read again after the abort, shows a
 * submission that settled meanwhile (the abort was moot). A dispatch whose
 * receipt was not recorded before the abort keeps the notice owed, so the
 * abort is repeated for the submission that may have landed after it, and
 * a failed abort rejects (the outbox retries). This executor runs no coding
 * cascade: the stopped coordinator's own `workspace_task` stops its worker
 * best-effort.
 */
export async function receiveAlarmExecutorStop(
  view: RunnerTurnJobView,
  abortHost: (target: SlackThreadAgentTarget) => Promise<void>,
  reread?: () => RunnerTurnJobView | Promise<RunnerTurnJobView>,
): Promise<boolean> {
  // A runner took the row over: the next delivery goes to it.
  if (view.executor === 'runner') return false;
  const job = view.status === 'pending' ? view.job : undefined;
  // Settled: its submission is over, and the instance may hold later turns.
  if (!job || job.flueSettlement) return true;
  // Never dispatched: its stop record alone keeps it from dispatching.
  const envelope = job.dispatchEnvelope;
  if (!envelope) return true;
  const uid = job.dispatchReceipt?.uid ?? envelope.uid;
  await abortHost({ instanceId: envelope.instanceId, ...(uid ? { uid } : {}) });
  if (reread) {
    const after = await reread();
    const current = after.status === 'pending' ? after.job : undefined;
    if (!current || current.flueSettlement) return true;
  }
  return job.dispatchReceipt !== undefined;
}

/**
 * Stop aborts in flight, per thread, on an executor that runs many threads
 * (the state store's alarm executor, the Node relay). Flue's `abort()` stops
 * whatever the thread's coordinator instance runs when the request lands, so
 * a turn of the thread never starts while one is out: the executor awaits
 * `clear(threadKey)` before each turn. `run` registers the stop's work
 * (reading the row, then aborting) before it starts, so a row read as
 * unsettled always has its abort fenced. The work is bounded by
 * THREAD_RUNNER_STOP_ABORT_TIMEOUT_MS: one unanswered that long rejects (the
 * outbox repeats it while the row is unsettled) and holds the thread no
 * longer, as a thread runner's stops do (see RunnerStops).
 */
export class StopAbortFence {
  private readonly inFlight = new Map<string, Set<Promise<void>>>();

  constructor(private readonly timeoutMs = THREAD_RUNNER_STOP_ABORT_TIMEOUT_MS) {}

  run<T>(threadKey: string, work: () => Promise<T>): Promise<T> {
    const bounded = boundedStopCall(Promise.resolve().then(work), this.timeoutMs);
    const settled = bounded.then(() => undefined, () => undefined);
    let entries = this.inFlight.get(threadKey);
    if (!entries) {
      entries = new Set();
      this.inFlight.set(threadKey, entries);
    }
    const current = entries;
    current.add(settled);
    void settled.then(() => {
      current.delete(settled);
      if (current.size === 0 && this.inFlight.get(threadKey) === current) this.inFlight.delete(threadKey);
    });
    return bounded;
  }

  /** Resolves once no stop abort of the thread is in flight. */
  async clear(threadKey: string): Promise<void> {
    for (let entries = this.inFlight.get(threadKey); entries && entries.size > 0;
      entries = this.inFlight.get(threadKey)) {
      await Promise.all([...entries]);
    }
  }
}

/** `call`, or a rejection once `ms` pass without an answer (the call itself goes on). */
export async function boundedStopCall<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The stop call was not answered in time.')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a stop of a runner turn is recorded, read just before its answer
 * is marked delivered (R22): the stop this runner took, else the state
 * store's row. A stop whose notice has not reached the runner yet (its
 * outbox backoff, an older runner during a rollout) is recorded there only,
 * and marking the turn delivered would release it without a word to the
 * person who pressed it.
 */
export async function runnerStopRecorded(
  jobs: Pick<ThreadRunnerJobStore, 'stopMarker'>,
  turns: Pick<ThreadRunnerTurnRows, 'view'>,
  id: string,
): Promise<boolean> {
  if (jobs.stopMarker(id)?.notice?.record.role === 'stopped') return true;
  return (await turns.view(id)).job?.stop?.role === 'stopped';
}
