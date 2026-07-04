import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Application-owned duplicate-admission store.
 *
 * `@flue/slack` deliberately does NOT dedupe Events API retries or the
 * app_mention + message fan-out (Slack delivers both for a single mention).
 * The channel claims each event before dispatch and releases on failure so a
 * Slack retry can re-drive the turn.
 */
export interface SlackClaimStore {
  /** Returns true if the key was newly claimed; false if it was already held. */
  claim(key: string): boolean;
  /** Release a previously claimed key so a retry can re-claim it. */
  release(key: string): void;
}

/**
 * Registry of thread keys this app has actively started (via a mention or DM).
 * It gates implicit thread replies: a reply whose thread was never started is
 * ignored (scenario S13).
 */
export interface SlackThreadRegistry {
  /** Mark a thread key as started so its later implicit replies are admitted. */
  start(key: string): void;
  /** True if a mention/DM already started this thread. */
  has(key: string): boolean;
}

export class InMemoryClaimStore implements SlackClaimStore {
  private readonly claimed = new Set<string>();

  claim(key: string): boolean {
    if (this.claimed.has(key)) {
      return false;
    }
    this.claimed.add(key);
    return true;
  }

  release(key: string): void {
    this.claimed.delete(key);
  }
}

/** Process-local thread registry (the pre-durability semantics). */
export class ThreadSessionRegistry implements SlackThreadRegistry {
  private readonly known = new Set<string>();

  start(key: string): void {
    this.known.add(key);
  }

  has(key: string): boolean {
    return this.known.has(key);
  }
}

// Claims only need to outlive Slack's redelivery horizon (retries span about an
// hour); the TTL is what keeps the claims table from growing without bound.
const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
// Joined threads stay continuable for much longer, but not forever — expiring
// them bounds the table and matches how stale a weeks-old thread really is. A
// thread's config snapshot is bounded to the same horizon (see snapshot-store):
// past it, an implicit reply is no longer admitted, so the snapshot is dead.
export const THREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * SQLite-backed claims + thread registry so dedupe and joined-thread admission
 * survive a process restart — the durability class `db.ts` already gives the
 * agent transcript. Uses node:sqlite's synchronous API, which keeps the
 * SlackClaimStore contract sync (the store is consulted inline during event
 * admission). Lives in its OWN database file (not the Flue transcript DB) so
 * the app never contends with the runtime's connection. `:memory:` yields a
 * per-process store with the exact pre-durability semantics — the parity suite
 * and offline harnesses rely on that isolation.
 */
export class SqliteSlackStateStore implements SlackClaimStore, SlackThreadRegistry {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.db = openStateDb(path);
    this.now = now;
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS slack_claims (key TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS slack_threads (key TEXT PRIMARY KEY, started_at INTEGER NOT NULL);',
    );
  }

  claim(key: string): boolean {
    this.purgeExpired();
    const inserted = this.db
      .prepare('INSERT OR IGNORE INTO slack_claims (key, claimed_at) VALUES (?, ?)')
      .run(key, this.now());
    return inserted.changes === 1;
  }

  release(key: string): void {
    this.db.prepare('DELETE FROM slack_claims WHERE key = ?').run(key);
  }

  start(key: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO slack_threads (key, started_at) VALUES (?, ?)')
      .run(key, this.now());
  }

  has(key: string): boolean {
    const row = this.db
      .prepare('SELECT started_at FROM slack_threads WHERE key = ? AND started_at >= ?')
      .get(key, this.now() - THREAD_TTL_MS);
    return row !== undefined;
  }

  private purgeExpired(): void {
    this.db.prepare('DELETE FROM slack_claims WHERE claimed_at < ?').run(this.now() - CLAIM_TTL_MS);
    this.db.prepare('DELETE FROM slack_threads WHERE started_at < ?').run(this.now() - THREAD_TTL_MS);
  }
}

/**
 * Resolve the state-store path from the environment. Defaults alongside the
 * Flue transcript DB (`<FLUE_DB_PATH>.state`, i.e. `./tmp/flue.db.state`);
 * `SLACK_STATE_DB_PATH` overrides it. A `:memory:` transcript DB gets a
 * `:memory:` state store so ephemeral runs stay fully ephemeral.
 */
export function resolveStateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SLACK_STATE_DB_PATH;
  if (configured) return configured;
  const fluePath = env.FLUE_DB_PATH ?? './tmp/flue.db';
  return fluePath === ':memory:' ? ':memory:' : `${fluePath}.state`;
}

/**
 * Open an app-owned SQLite database: create the parent directory and enable WAL
 * for a file path; a `:memory:` path is left ephemeral. Shared by every app
 * state store (claims/threads, config, snapshots) so the open/mkdir/WAL sequence
 * lives in one place. Callers run their own `CREATE TABLE` on the returned handle.
 */
export function openStateDb(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  return db;
}
