import type { TurnJob } from '../config/state-rpc.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import type { StateDb } from '../state/state-db.ts';
import { CLAIM_TTL_MS } from './claim-store.ts';
import type { NormalizedSlackTurn } from './types.ts';

/**
 * Durable queue of Slack turns for the Cloudflare turn-relay (see state-rpc.ts
 * TurnJob for why the relay exists). The events handler enqueues a job and arms
 * the state DO's alarm; the alarm drains pending jobs and runs each turn with
 * the DO's 15-minute wall-time budget instead of the events invocation's ~30s
 * `waitUntil` horizon.
 *
 * This is target-neutral StateDb logic (like the claim/snapshot/settings logic)
 * so it is unit-testable on the node lane, even though only the Cloudflare
 * Durable Object ever enqueues or drains (node runs turns inline — no relay).
 *
 * Delivery guarantees:
 *   - Idempotent enqueue (INSERT OR IGNORE on the message claim key), so the
 *     app_mention + message fan-out for one mention enqueues at most once.
 *   - A `delivered` tombstone excludes a completed job from any later alarm
 *     scan (`WHERE delivered = 0`), the guard against a redundant re-delivery.
 *   - A bounded attempt counter caps retries; the alarm posts the sanitized
 *     provider-failure final and releases the claims on the terminal attempt.
 *   - Rows purge on the claim TTL horizon (past it a Slack redelivery can no
 *     longer arrive, so the tombstone is dead weight — the same horizon the
 *     claims table uses).
 */

/** Attempts (inclusive) the alarm makes to deliver a turn before giving up. */
export const MAX_TURN_ATTEMPTS = 2;

// Job rows live no longer than the claim TTL: past it Slack no longer
// redelivers the originating event, so neither the idempotency key nor the
// delivered tombstone can still matter.
export const TURN_JOB_TTL_MS = CLAIM_TTL_MS;

/** A pending job the alarm should run, decoded from its row. */
export interface PendingTurnJob {
  id: string;
  evtKey: string;
  msgKey: string;
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  /** Deliveries already attempted (0 before the alarm has ever run it). */
  attempts: number;
}

interface TurnJobRow {
  id: string;
  evt_key: string;
  msg_key: string;
  turn_json: string;
  assignment_json: string;
  attempts: number;
}

export class TurnJobStoreLogic {
  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS turn_jobs (
        id TEXT PRIMARY KEY,
        evt_key TEXT NOT NULL,
        msg_key TEXT NOT NULL,
        turn_json TEXT NOT NULL,
        assignment_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        delivered INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        enqueued_at INTEGER NOT NULL
      )`,
    );
  }

  /**
   * Persist a job write-once by id. Returns true when newly enqueued, false
   * when the id already existed (a duplicate enqueue — ignored). The caller
   * arms the alarm regardless: re-arming for an already-queued job is harmless.
   */
  enqueue(job: TurnJob): boolean {
    this.purgeExpired();
    const inserted = this.db.run(
      `INSERT OR IGNORE INTO turn_jobs (
        id, evt_key, msg_key, turn_json, assignment_json, attempts, delivered, status, enqueued_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, 'pending', ?)`,
      job.id,
      job.evtKey,
      job.msgKey,
      JSON.stringify(job.turn),
      JSON.stringify(job.assignment),
      this.now(),
    );
    return inserted.changes === 1;
  }

  /** Undelivered jobs in enqueue order — the alarm's work list. */
  listPending(): PendingTurnJob[] {
    const rows = this.db.all(
      `SELECT id, evt_key, msg_key, turn_json, assignment_json, attempts
       FROM turn_jobs WHERE delivered = 0 ORDER BY enqueued_at`,
    ) as unknown as TurnJobRow[];
    return rows.map((row) => ({
      id: row.id,
      evtKey: row.evt_key,
      msgKey: row.msg_key,
      turn: JSON.parse(row.turn_json) as NormalizedSlackTurn,
      assignment: JSON.parse(row.assignment_json) as ResolvedAssignment,
      attempts: Number(row.attempts),
    }));
  }

  /** Record that an attempt is being made (before running the turn). */
  recordAttempt(id: string, attempts: number): void {
    this.db.run('UPDATE turn_jobs SET attempts = ? WHERE id = ?', attempts, id);
  }

  /** Tombstone a delivered job so no later scan re-delivers it. */
  markDelivered(id: string): void {
    this.db.run("UPDATE turn_jobs SET delivered = 1, status = 'done' WHERE id = ?", id);
  }

  /** Tombstone a job that exhausted its attempts (terminal failure). */
  markError(id: string): void {
    this.db.run("UPDATE turn_jobs SET delivered = 1, status = 'error' WHERE id = ?", id);
  }

  private purgeExpired(): void {
    this.db.run('DELETE FROM turn_jobs WHERE enqueued_at < ?', this.now() - TURN_JOB_TTL_MS);
  }
}
