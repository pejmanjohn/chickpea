import type { StateDb } from '../state/state-db.ts';

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
 * - `deferred`: a durable outbox owns the terminal; re-run after `retry_at`
 *   without holding later turns (the state store alarm's behaviour).
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

/** States that hold every later job of the thread until they settle. */
const ORDERED_STATES: ReadonlySet<string> = new Set(['admitted', 'running', 'yielded']);
/** Jobs the runner still has to run (or run again). */
export const OPEN_JOB_STATES: ReadonlySet<string> = new Set([...ORDERED_STATES, 'deferred']);
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
      else if (ORDERED_STATES.has(job.state)) break;
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
      if (ORDERED_STATES.has(String(row.state))) break;
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
      `UPDATE runner_jobs SET state = ?, retry_at = ?, settled_at = ?,
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
    return this.db.run(
      `DELETE FROM runner_jobs
       WHERE state NOT IN ${OPEN_STATES} AND terminal_sync IS NULL
         AND cleanup_at IS NULL AND active_clear = 0
         AND settled_at IS NOT NULL AND settled_at < ?`,
      now - SETTLED_RETENTION_MS,
    ).changes;
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
