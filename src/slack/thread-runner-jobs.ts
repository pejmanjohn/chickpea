import type { CodingTaskStopReport } from '../sandbox/coding-task-stop.ts';
import type { StateDb } from '../state/state-db.ts';
import type { SlackRunFacts } from './status-registry.ts';
import type { TurnStopNotice } from './turn-job-types.ts';

/** One turn handed to a thread's runner. `payload` stays opaque here. */
export interface ThreadRunnerJob {
  id: string;
  threadKey: string;
  payload: unknown;
}

export interface ThreadRunnerStatus {
  /** Rows by state. */
  jobs: Record<string, number>;
  total: number;
}

/**
 * Local state of one job in its runner. The state store's turn row stays the
 * record of truth for the turn; these states only order and drive execution.
 *
 * - `admitted`: waiting to run (after `retry_at` when set).
 * - `running`: an alarm started it; after an eviction the next alarm
 *   reattaches through the turn row's durable checkpoints.
 * - `yielded`: observation stopped at the alarm budget; reattach next alarm.
 * - `deferred`: a durable outbox owns the terminal (an Agent welcome). The
 *   turn ran to the end; after `retry_at` the runner only reads the turn row,
 *   which the state store settles when it delivers or fails the outbox,
 *   backing off between reads. It never holds later turns.
 * - `done`, `error`, `recovery_required`: settled.
 * - `released`: the state store took the row back before it ran here.
 */
export type ThreadRunnerJobState =
  | 'admitted'
  | 'running'
  | 'yielded'
  | 'deferred'
  | 'done'
  | 'error'
  | 'recovery_required'
  | 'released';

export interface ThreadRunnerJobRecord {
  id: string;
  threadKey: string;
  payload: unknown;
  state: ThreadRunnerJobState;
  retryAt?: number;
  /** A settled outcome the state store has not yet recorded. */
  terminalSync?: 'done' | 'error';
}

/**
 * A stop this runner took for one of its turns (KTD2), kept in its own table
 * because a stop can reach the runner before the turn's hand-off does.
 *
 * - `abort`: `owed` until Flue's `abort()` of the turn's coordinator instance
 *   is confirmed (`done`); `none` when there is nothing to abort (the turn
 *   never dispatched here, or its submission had already settled).
 * - `cascade`: the coding-worker stop that follows the host abort (KTD4):
 *   `owed` until its first report is saved (`done`), `none` when the turn
 *   could not have started a coding job.
 */
export interface ThreadRunnerStopMarker {
  turnJobId: string;
  /** The latest notice, its dispatch coordinates merged across deliveries. */
  notice?: TurnStopNotice;
  abort: 'owed' | 'done' | 'none';
  abortAttempts: number;
  /** The Flue submission known when the confirmed abort was requested. */
  abortedSubmissionId?: string;
  cascade: 'owed' | 'done' | 'none';
  /** The first coding stop report; a later cascade never replaces it. */
  codingReport?: CodingTaskStopReport;
  receivedAt: number;
}

export type ThreadRunnerStopPatch = Partial<Pick<
  ThreadRunnerStopMarker,
  'abort' | 'abortAttempts' | 'abortedSubmissionId' | 'cascade'
>>;

/** States that hold every later job of the thread until they settle. */
export const ORDERED_JOB_STATES: ReadonlySet<string> = new Set(['admitted', 'running', 'yielded']);
/** Jobs the runner still has to run (or run again). */
export const OPEN_JOB_STATES: ReadonlySet<string> = new Set([...ORDERED_JOB_STATES, 'deferred']);
const OPEN_STATES = "('admitted', 'running', 'yielded', 'deferred')";
/** A job settled here as recovery or released can be handed over again. */
const REVIVABLE_STATES = "('recovery_required', 'released')";
const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Durable job list of one `SlackThreadRunner` (one instance per Slack thread
 * key), in admission order. Kept free of `cloudflare:workers` so the SQL runs
 * on Node in tests.
 */
export class ThreadRunnerJobStore {
  constructor(private readonly db: StateDb) {
    db.exec(`CREATE TABLE IF NOT EXISTS runner_jobs (
      id TEXT PRIMARY KEY,
      thread_key TEXT NOT NULL,
      job_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'admitted',
      admitted_at INTEGER NOT NULL
    )`);
    const columns = db.all('PRAGMA table_info(runner_jobs)');
    if (!columns.some((column) => column.name === 'retry_at')) {
      db.exec('ALTER TABLE runner_jobs ADD COLUMN retry_at INTEGER');
    }
    if (!columns.some((column) => column.name === 'terminal_sync')) {
      db.exec('ALTER TABLE runner_jobs ADD COLUMN terminal_sync TEXT');
    }
    if (!columns.some((column) => column.name === 'settled_at')) {
      db.exec('ALTER TABLE runner_jobs ADD COLUMN settled_at INTEGER');
    }
    // Follow-ups of a settled turn the runner still owes: checking (and
    // retrying) its Slack interaction cleanup, and clearing its active-work flag.
    if (!columns.some((column) => column.name === 'cleanup_at')) {
      db.exec('ALTER TABLE runner_jobs ADD COLUMN cleanup_at INTEGER');
    }
    if (!columns.some((column) => column.name === 'cleanup_attempts')) {
      db.exec('ALTER TABLE runner_jobs ADD COLUMN cleanup_attempts INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some((column) => column.name === 'active_clear')) {
      db.exec('ALTER TABLE runner_jobs ADD COLUMN active_clear INTEGER NOT NULL DEFAULT 0');
    }
    // Reads of a deferred turn's row that found it still pending (the backoff).
    if (!columns.some((column) => column.name === 'deferred_checks')) {
      db.exec('ALTER TABLE runner_jobs ADD COLUMN deferred_checks INTEGER NOT NULL DEFAULT 0');
    }
    // The run facts of the job's turn (SlackRunFacts), which a check-in reads
    // after an eviction: its start, its fixed-copy step, its last progress and
    // the workspace milestones already counted.
    for (const [name, type] of [
      ['run_started_at', 'INTEGER'],
      ['run_step', 'TEXT'],
      ['run_progress_at', 'INTEGER'],
      ['run_milestones', 'INTEGER'],
    ] as const) {
      if (!columns.some((column) => column.name === name)) {
        db.exec(`ALTER TABLE runner_jobs ADD COLUMN ${name} ${type}`);
      }
    }
    // Stops this runner took (ThreadRunnerStopMarker). An older release never
    // reads the table, so a rollback only leaves it unused.
    db.exec(`CREATE TABLE IF NOT EXISTS runner_stops (
      id TEXT PRIMARY KEY,
      notice_json TEXT,
      abort_state TEXT NOT NULL DEFAULT 'none',
      abort_attempts INTEGER NOT NULL DEFAULT 0,
      aborted_submission TEXT,
      cascade_state TEXT NOT NULL DEFAULT 'none',
      coding_report TEXT,
      ending_outcome TEXT,
      ending_count INTEGER,
      ending_reported INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER NOT NULL
    )`);
  }

  /**
   * Persist a hand-off. A repeated hand-off of the same job id (the caller
   * retrying after an unknown outcome) keeps the first row and its state,
   * unless the state store has handed a job it took back over again.
   */
  admit(job: ThreadRunnerJob, now: number): { admitted: boolean } {
    if (!job || typeof job.id !== 'string' || !job.id || typeof job.threadKey !== 'string' || !job.threadKey) {
      throw new Error('A thread runner job needs an id and a thread key.');
    }
    const payload = JSON.stringify(job.payload ?? null);
    const { changes } = this.db.run(
      `INSERT INTO runner_jobs (id, thread_key, job_json, state, admitted_at)
       VALUES (?, ?, ?, 'admitted', ?)
       ON CONFLICT(id) DO UPDATE SET
         state = 'admitted', job_json = excluded.job_json, retry_at = NULL, settled_at = NULL
       WHERE runner_jobs.state IN ${REVIVABLE_STATES}`,
      job.id, job.threadKey, payload, now,
    );
    return { admitted: changes === 1 };
  }

  get(id: string): ThreadRunnerJobRecord | undefined {
    const row = this.db.get(
      'SELECT id, thread_key, job_json, state, retry_at, terminal_sync FROM runner_jobs WHERE id = ?',
      id,
    );
    return row ? decodeJob(row) : undefined;
  }

  /**
   * Jobs that may run now, in thread order, up to the first job that must
   * run first but is not yet due (a retained turn waiting for its retry). A
   * deferred job waits for its retry without holding the ones after it.
   */
  runnable(now: number, limit = 16): ThreadRunnerJobRecord[] {
    const jobs: ThreadRunnerJobRecord[] = [];
    for (const row of this.db.all(
      `SELECT id, thread_key, job_json, state, retry_at, terminal_sync FROM runner_jobs
       WHERE state IN ${OPEN_STATES} ORDER BY admitted_at, rowid LIMIT 64`,
    )) {
      const job = decodeJob(row);
      const due = job.retryAt === undefined || job.retryAt <= now;
      if (due) jobs.push(job);
      else if (ORDERED_JOB_STATES.has(job.state)) break;
      if (jobs.length >= limit) break;
    }
    return jobs;
  }

  /** When the next open job falls due; `now` when one is due already. */
  nextDueAt(now: number): number | undefined {
    let due: number | undefined;
    for (const row of this.db.all(
      `SELECT state, retry_at FROM runner_jobs WHERE state IN ${OPEN_STATES}
       ORDER BY admitted_at, rowid LIMIT 64`,
    )) {
      const at = row.retry_at === null || row.retry_at === undefined ? now : Number(row.retry_at);
      due = Math.min(due ?? at, at);
      // Jobs after the first ordered one wait for it (see runnable()).
      if (ORDERED_JOB_STATES.has(String(row.state))) break;
    }
    return due === undefined ? undefined : Math.max(now, due);
  }

  markRunning(id: string): void {
    this.db.run(
      "UPDATE runner_jobs SET state = 'running', retry_at = NULL WHERE id = ?",
      id,
    );
  }

  /** Record where a run left the job (see ThreadRunnerJobState). */
  settle(id: string, state: ThreadRunnerJobState, now: number, retryAt?: number): void {
    const settled = !OPEN_JOB_STATES.has(state);
    // A delivered or failed turn may still owe Slack interaction cleanup.
    const checkCleanup = state === 'done' || state === 'error';
    this.db.run(
      `UPDATE runner_jobs SET state = ?, retry_at = ?, settled_at = ?, deferred_checks = 0,
         cleanup_at = CASE WHEN ? THEN COALESCE(cleanup_at, ?) ELSE cleanup_at END
       WHERE id = ?`,
      state,
      retryAt ?? null,
      settled ? now : null,
      checkCleanup ? 1 : 0,
      now,
      id,
    );
  }

  /**
   * A deferred job's turn row was still pending: read it again after
   * `delayMs(checks)`, where `checks` counts the reads that found it pending
   * (this one included). Returns when.
   */
  recheckDeferred(id: string, now: number, delayMs: (checks: number) => number): number {
    const row = this.db.get('SELECT deferred_checks FROM runner_jobs WHERE id = ?', id);
    const checks = Number(row?.deferred_checks ?? 0) + 1;
    const retryAt = now + delayMs(checks);
    this.db.run(
      "UPDATE runner_jobs SET state = 'deferred', retry_at = ?, deferred_checks = ? WHERE id = ?",
      retryAt,
      checks,
      id,
    );
    return retryAt;
  }

  /** Settled jobs whose Slack interaction cleanup is due for a check or retry. */
  dueCleanups(now: number, limit = 16): Array<ThreadRunnerJobRecord & { cleanupAttempts: number }> {
    return this.db.all(
      `SELECT id, thread_key, job_json, state, retry_at, terminal_sync, cleanup_attempts
       FROM runner_jobs
       WHERE cleanup_at IS NOT NULL AND cleanup_at <= ? AND terminal_sync IS NULL
       ORDER BY admitted_at, rowid LIMIT ?`,
      now,
      limit,
    ).map((row) => ({ ...decodeJob(row), cleanupAttempts: Number(row.cleanup_attempts) }));
  }

  /** Check the cleanup again at `at`, or stop owing it (`undefined`). */
  scheduleCleanup(id: string, at: number | undefined, attempts: number): void {
    this.db.run(
      'UPDATE runner_jobs SET cleanup_at = ?, cleanup_attempts = ? WHERE id = ?',
      at ?? null,
      attempts,
      id,
    );
  }

  /** The turn's active-work flag must still be cleared in the state store. */
  owesActiveClear(id: string, owed: boolean): void {
    this.db.run('UPDATE runner_jobs SET active_clear = ? WHERE id = ?', owed ? 1 : 0, id);
  }

  pendingActiveClears(limit = 16): ThreadRunnerJobRecord[] {
    return this.db.all(
      `SELECT id, thread_key, job_json, state, retry_at, terminal_sync FROM runner_jobs
       WHERE active_clear = 1 ORDER BY admitted_at, rowid LIMIT ?`,
      limit,
    ).map(decodeJob);
  }

  /** When the next Slack interaction cleanup check falls due (see dueCleanups). */
  nextCleanupAt(): number | undefined {
    const row = this.db.get(
      'SELECT MIN(cleanup_at) AS due FROM runner_jobs WHERE terminal_sync IS NULL',
    );
    return row?.due === null || row?.due === undefined ? undefined : Number(row.due);
  }

  /**
   * The turn reached its terminal here: settle it locally before the state
   * store records it, so a failed recording never lets the turn run again.
   */
  settleTerminal(id: string, outcome: 'done' | 'error', now: number): void {
    this.db.run(
      `UPDATE runner_jobs SET state = ?, terminal_sync = ?, retry_at = NULL, settled_at = ?,
         cleanup_at = COALESCE(cleanup_at, ?)
       WHERE id = ?`,
      outcome,
      outcome,
      now,
      now,
      id,
    );
  }

  terminalSynced(id: string): void {
    this.db.run('UPDATE runner_jobs SET terminal_sync = NULL WHERE id = ?', id);
  }

  unsyncedTerminals(limit = 16): ThreadRunnerJobRecord[] {
    return this.db.all(
      `SELECT id, thread_key, job_json, state, retry_at, terminal_sync FROM runner_jobs
       WHERE terminal_sync IS NOT NULL ORDER BY admitted_at, rowid LIMIT ?`,
      limit,
    ).map(decodeJob);
  }

  /** Forget settled jobs after a week; open or unsynced ones are kept. */
  purge(now: number): number {
    const changes = this.db.run(
      `DELETE FROM runner_jobs
       WHERE state NOT IN ${OPEN_STATES} AND terminal_sync IS NULL
         AND cleanup_at IS NULL AND active_clear = 0
         AND settled_at IS NOT NULL AND settled_at < ?`,
      now - SETTLED_RETENTION_MS,
    ).changes;
    // A stop is forgotten after its turn: nothing owed, its job gone.
    this.db.run(
      `DELETE FROM runner_stops
       WHERE received_at < ? AND abort_state != 'owed' AND cascade_state != 'owed'
         AND (ending_outcome IS NULL OR ending_reported = 1)
         AND NOT EXISTS (SELECT 1 FROM runner_jobs WHERE runner_jobs.id = runner_stops.id)`,
      now - SETTLED_RETENTION_MS,
    );
    return changes;
  }

  status(): ThreadRunnerStatus {
    const rows = this.db.all('SELECT state, COUNT(*) AS n FROM runner_jobs GROUP BY state');
    const jobs: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.n);
      jobs[String(row.state)] = count;
      total += count;
    }
    return { jobs, total };
  }

  /** The saved run facts of a job's turn, if its status turn saved any here. */
  runFacts(id: string): SlackRunFacts | undefined {
    const row = this.db.get(
      `SELECT run_started_at, run_step, run_progress_at, run_milestones
       FROM runner_jobs WHERE id = ?`,
      id,
    );
    if (!row || row.run_started_at === null || row.run_started_at === undefined ||
        row.run_progress_at === null || row.run_progress_at === undefined) return undefined;
    return {
      startedAt: Number(row.run_started_at),
      ...(typeof row.run_step === 'string' ? { step: row.run_step } : {}),
      progressAt: Number(row.run_progress_at),
      milestones: Number(row.run_milestones ?? 0),
    };
  }

  /** Save a job's run facts; a job this runner does not hold keeps none. */
  saveRunFacts(id: string, facts: SlackRunFacts): void {
    this.db.run(
      `UPDATE runner_jobs SET run_started_at = ?, run_step = ?, run_progress_at = ?,
         run_milestones = ?
       WHERE id = ?`,
      facts.startedAt,
      facts.step ?? null,
      facts.progressAt,
      facts.milestones,
      id,
    );
  }

  /** A job was running when this object's previous instance stopped. */
  hasRunning(): boolean {
    return this.db.get("SELECT 1 AS running FROM runner_jobs WHERE state = 'running' LIMIT 1") !== undefined;
  }

  /** Jobs not yet settled. */
  openCount(): number {
    return Number(this.db.get(
      `SELECT COUNT(*) AS n FROM runner_jobs WHERE state IN ${OPEN_STATES}`,
    )?.n ?? 0);
  }

  /** An admitted or yielded job waiting for its retry runs at the next alarm instead. */
  makeDue(id: string): void {
    this.db.run(
      "UPDATE runner_jobs SET retry_at = NULL WHERE id = ? AND state IN ('admitted', 'yielded')",
      id,
    );
  }

  // ── stops this runner took (ThreadRunnerStopMarker) ─────────────────────

  /**
   * Record a stop, or merge a redelivered one into the first: the first
   * decision stands, and a later notice only adds dispatch coordinates, and
   * the settlement, the earlier one lacked. Returns the stored marker.
   */
  recordStop(
    notice: TurnStopNotice,
    initial: Pick<ThreadRunnerStopMarker, 'abort' | 'cascade'>,
    now: number,
  ): ThreadRunnerStopMarker {
    const existing = this.stopMarker(notice.turnJobId);
    const merged: TurnStopNotice = existing?.notice
      ? {
          ...existing.notice,
          attempts: notice.attempts,
          ...(existing.notice.instanceId ? {} : notice.instanceId ? { instanceId: notice.instanceId } : {}),
          ...(existing.notice.uid ? {} : notice.uid ? { uid: notice.uid } : {}),
          ...(notice.submissionId ? { submissionId: notice.submissionId } : {}),
          ...(existing.notice.settled ? {} : notice.settled ? { settled: notice.settled } : {}),
        }
      : notice;
    this.db.run(
      `INSERT INTO runner_stops (id, notice_json, abort_state, cascade_state, received_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET notice_json = excluded.notice_json`,
      notice.turnJobId,
      JSON.stringify(merged),
      initial.abort,
      initial.cascade,
      now,
    );
    return this.stopMarker(notice.turnJobId)!;
  }

  stopMarker(id: string): ThreadRunnerStopMarker | undefined {
    const row = this.db.get(
      `SELECT id, notice_json, abort_state, abort_attempts, aborted_submission, cascade_state,
         coding_report, received_at
       FROM runner_stops WHERE id = ?`,
      id,
    );
    return row ? decodeStop(row) : undefined;
  }

  updateStop(id: string, patch: ThreadRunnerStopPatch): void {
    const current = this.stopMarker(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db.run(
      `UPDATE runner_stops SET abort_state = ?, abort_attempts = ?, aborted_submission = ?,
         cascade_state = ?
       WHERE id = ?`,
      next.abort,
      next.abortAttempts,
      next.abortedSubmissionId ?? null,
      next.cascade,
      id,
    );
  }

  /** Save a stop's coding report; the first one stands. Returns the stored report. */
  saveCodingStopReport(id: string, report: CodingTaskStopReport): CodingTaskStopReport | undefined {
    this.db.run(
      `UPDATE runner_stops SET coding_report = COALESCE(coding_report, ?), cascade_state = 'done'
       WHERE id = ?`,
      JSON.stringify(report),
      id,
    );
    return this.stopMarker(id)?.codingReport;
  }

  /** Stops that still owe their abort or their coding cascade, oldest first. */
  owedStops(limit = 16): ThreadRunnerStopMarker[] {
    return this.db.all(
      `SELECT id, notice_json, abort_state, abort_attempts, aborted_submission, cascade_state,
         coding_report, received_at
       FROM runner_stops WHERE abort_state = 'owed' OR cascade_state = 'owed'
       ORDER BY received_at, rowid LIMIT ?`,
      limit,
    ).map(decodeStop);
  }

  hasOwedStops(): boolean {
    return this.db.get(
      "SELECT 1 AS owed FROM runner_stops WHERE abort_state = 'owed' OR cascade_state = 'owed' LIMIT 1",
    ) !== undefined;
  }

  /**
   * A stopped turn's ending, once per turn (a replayed ending is not counted
   * again), for the alarm record's dropped-turn count. True the first time.
   */
  recordStopEnding(id: string, outcome: 'dropped' | 'released', count: number, now: number): boolean {
    this.db.run(
      `INSERT INTO runner_stops (id, received_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`,
      id,
      now,
    );
    return this.db.run(
      `UPDATE runner_stops SET ending_outcome = ?, ending_count = ?
       WHERE id = ? AND ending_outcome IS NULL`,
      outcome,
      Math.max(0, Math.trunc(count)),
      id,
    ).changes === 1;
  }

  /** Turns dropped by stop endings not yet reported in an alarm record; marks them reported. */
  takeUnreportedDrops(): number {
    const dropped = Number(this.db.get(
      `SELECT COALESCE(SUM(ending_count), 0) AS n FROM runner_stops
       WHERE ending_outcome = 'dropped' AND ending_reported = 0`,
    )?.n ?? 0);
    this.db.run(
      'UPDATE runner_stops SET ending_reported = 1 WHERE ending_outcome IS NOT NULL AND ending_reported = 0',
    );
    return dropped;
  }
}

function decodeStop(row: Record<string, unknown>): ThreadRunnerStopMarker {
  const state = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? value as T : fallback;
  return {
    turnJobId: String(row.id),
    ...(typeof row.notice_json === 'string'
      ? { notice: JSON.parse(row.notice_json) as TurnStopNotice }
      : {}),
    abort: state(row.abort_state, ['owed', 'done', 'none'] as const, 'none'),
    abortAttempts: Number(row.abort_attempts ?? 0),
    ...(typeof row.aborted_submission === 'string'
      ? { abortedSubmissionId: row.aborted_submission }
      : {}),
    cascade: state(row.cascade_state, ['owed', 'done', 'none'] as const, 'none'),
    ...(typeof row.coding_report === 'string'
      ? { codingReport: JSON.parse(row.coding_report) as CodingTaskStopReport }
      : {}),
    receivedAt: Number(row.received_at),
  };
}

function decodeJob(row: Record<string, unknown>): ThreadRunnerJobRecord {
  return {
    id: String(row.id),
    threadKey: String(row.thread_key),
    payload: JSON.parse(String(row.job_json)),
    state: String(row.state) as ThreadRunnerJobState,
    ...(row.retry_at === null || row.retry_at === undefined ? {} : { retryAt: Number(row.retry_at) }),
    ...(row.terminal_sync === 'done' || row.terminal_sync === 'error'
      ? { terminalSync: row.terminal_sync }
      : {}),
  };
}
