import type { StateDb } from '../state/state-db.ts';

/** One turn handed to a thread's runner. `payload` stays opaque here. */
export interface ThreadRunnerJob {
  id: string;
  threadKey: string;
  payload: unknown;
}

export interface ThreadRunnerStatus {
  /** Rows by state. Only `admitted` exists until an executor is enabled. */
  jobs: Record<string, number>;
  total: number;
}

/**
 * Durable job list of one `SlackThreadRunner` (one instance per Slack thread
 * key). Kept free of `cloudflare:workers` so the SQL runs on Node in tests.
 * No executor consumes these rows yet: a later release moves turn execution
 * here and extends this table's state machine.
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
  }

  /**
   * Persist a hand-off. A repeated hand-off of the same job id (the caller
   * retrying after an unknown outcome) keeps the first row and its state.
   */
  admit(job: ThreadRunnerJob, now: number): { admitted: boolean } {
    if (!job || typeof job.id !== 'string' || !job.id || typeof job.threadKey !== 'string' || !job.threadKey) {
      throw new Error('A thread runner job needs an id and a thread key.');
    }
    const payload = JSON.stringify(job.payload ?? null);
    const { changes } = this.db.run(
      `INSERT INTO runner_jobs (id, thread_key, job_json, state, admitted_at)
       VALUES (?, ?, ?, 'admitted', ?) ON CONFLICT(id) DO NOTHING`,
      job.id, job.threadKey, payload, now,
    );
    return { admitted: changes === 1 };
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
}
