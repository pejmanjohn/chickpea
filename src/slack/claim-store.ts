import { openStateDb, type NodeStateDb } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';

/**
 * Application-owned duplicate-admission store.
 *
 * `@flue/slack` deliberately does NOT dedupe Events API retries or the
 * app_mention + message fan-out (Slack delivers both for a single mention).
 * The channel claims each event before dispatch and releases on failure so a
 * Slack retry can re-drive the turn.
 *
 * All public store interfaces are async: the Node backend answers from local
 * SQLite (the awaits resolve immediately), while the Cloudflare backend calls
 * into a Durable Object over RPC. Consumers are written against the async
 * shape so the two backends are interchangeable.
 */
export interface SlackClaimStore {
  /** Resolves true if the key was newly claimed; false if it was already held. */
  claim(key: string): Promise<boolean>;
  /** Release a previously claimed key so a retry can re-claim it. */
  release(key: string): Promise<void>;
}

/**
 * Registry of thread keys this app has actively started (via a mention or DM).
 * It gates implicit thread replies: a reply whose thread was never started is
 * ignored (scenario S13).
 */
export interface SlackThreadRegistry {
  /** Mark a thread key as started so its later implicit replies are admitted. */
  start(key: string): Promise<void>;
  /** True if a mention/DM already started this thread. */
  has(key: string): Promise<boolean>;
}

/** The combined claims + thread-registry surface the Slack channel consumes. */
export interface SlackStateStore extends SlackClaimStore, SlackThreadRegistry {
  /** Node backend only (closes the SQLite handle); absent on RPC proxies. */
  close?(): void;
}

// Claims only need to outlive Slack's redelivery horizon (retries span about an
// hour); the TTL is what keeps the claims table from growing without bound.
// Exported so the turn-relay job table (turn-jobs.ts) purges on the SAME
// horizon: past it Slack no longer redelivers the originating event, so a
// leftover job row can no longer matter.
export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
// Joined threads stay continuable for much longer, but not forever — expiring
// them bounds the table and matches how stale a weeks-old thread really is. A
// thread's config snapshot is bounded to the same horizon (see snapshot-store):
// past it, an implicit reply is no longer admitted, so the snapshot is dead.
export const THREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Target-neutral claims + thread-registry logic over the StateDb
 * mini-interface: the single source of the tables, TTL purges, and the
 * INSERT OR IGNORE claim semantics. The Node backend runs it over
 * `node:sqlite`; the Cloudflare Durable Object runs the same class over
 * `ctx.storage.sql`. Methods are synchronous — both backends execute SQL
 * synchronously — and the async public interface wraps them.
 */
export class SlackStateLogic {
  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    // One statement per exec: DO SQLite rejects multi-statement strings.
    db.exec(
      'CREATE TABLE IF NOT EXISTS slack_claims (key TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL)',
    );
    db.exec(
      'CREATE TABLE IF NOT EXISTS slack_threads (key TEXT PRIMARY KEY, started_at INTEGER NOT NULL)',
    );
  }

  claim(key: string): boolean {
    this.purgeExpired();
    const inserted = this.db.run(
      'INSERT OR IGNORE INTO slack_claims (key, claimed_at) VALUES (?, ?)',
      key,
      this.now(),
    );
    return inserted.changes === 1;
  }

  release(key: string): void {
    this.db.run('DELETE FROM slack_claims WHERE key = ?', key);
  }

  start(key: string): void {
    this.db.run('INSERT OR REPLACE INTO slack_threads (key, started_at) VALUES (?, ?)', key, this.now());
  }

  has(key: string): boolean {
    const row = this.db.get(
      'SELECT started_at FROM slack_threads WHERE key = ? AND started_at >= ?',
      key,
      this.now() - THREAD_TTL_MS,
    );
    return row !== undefined;
  }

  private purgeExpired(): void {
    this.db.run('DELETE FROM slack_claims WHERE claimed_at < ?', this.now() - CLAIM_TTL_MS);
    this.db.run('DELETE FROM slack_threads WHERE started_at < ?', this.now() - THREAD_TTL_MS);
  }
}

/**
 * SQLite-backed claims + thread registry so dedupe and joined-thread admission
 * survive a process restart — the durability class `db.ts` already gives the
 * agent transcript. Lives in its OWN database file (not the Flue transcript
 * DB) so the app never contends with the runtime's connection. `:memory:`
 * yields a per-process store with the exact pre-durability semantics — the
 * parity suite and offline harnesses rely on that isolation.
 */
export class SqliteSlackStateStore implements SlackStateStore {
  private readonly db: NodeStateDb;
  private readonly logic: SlackStateLogic;

  constructor(path: string, now: () => number = Date.now) {
    this.db = openStateDb(path);
    this.logic = new SlackStateLogic(this.db, now);
  }

  async claim(key: string): Promise<boolean> {
    return this.logic.claim(key);
  }

  async release(key: string): Promise<void> {
    this.logic.release(key);
  }

  async start(key: string): Promise<void> {
    this.logic.start(key);
  }

  async has(key: string): Promise<boolean> {
    return this.logic.has(key);
  }

  close(): void {
    this.db.close();
  }
}
