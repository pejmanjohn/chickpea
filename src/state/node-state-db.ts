import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { SqlParam, StateDb } from './state-db.ts';

/**
 * Node backend for the StateDb mini-interface, over `node:sqlite`'s
 * synchronous API. Statements are prepared per call rather than cached: every
 * store call is a handful of statements against a local file, and skipping the
 * cache keeps this adapter shaped exactly like the Durable Object one (which
 * has no prepared statements at all).
 */
export class NodeStateDb implements StateDb {
  constructor(private readonly db: DatabaseSync) {}

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  get(sql: string, ...params: SqlParam[]): Record<string, unknown> | undefined {
    return this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  }

  all(sql: string, ...params: SqlParam[]): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...params) as Record<string, unknown>[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    // BEGIN IMMEDIATE (not deferred): take the write lock up front so a
    // concurrent writer on another connection fails fast here instead of
    // deadlocking mid-transaction (the pre-refactor seedOnce semantics).
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Resolve the state-store path from the environment. Defaults alongside the
 * Flue transcript DB (`<TAG_DB_PATH>.state`, i.e. `./tmp/flue.db.state`);
 * `SLACK_STATE_DB_PATH` overrides it. A `:memory:` transcript DB gets a
 * `:memory:` state store so ephemeral runs stay fully ephemeral.
 */
export function resolveStateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SLACK_STATE_DB_PATH;
  if (configured) return configured;
  const fluePath = env.TAG_DB_PATH ?? './tmp/flue.db';
  return fluePath === ':memory:' ? ':memory:' : `${fluePath}.state`;
}

/**
 * Open an app-owned SQLite database: create the parent directory and enable WAL
 * for a file path; a `:memory:` path is left ephemeral. Shared by every app
 * state store (claims/threads, config, snapshots, settings) so the
 * open/mkdir/WAL sequence lives in one place. Callers run their own
 * `CREATE TABLE` statements through the returned StateDb.
 */
export function openStateDb(path: string): NodeStateDb {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  // The canonical Work ledger depends on relational ownership constraints.
  // Keep this explicit even though current Node 24 builds enable it by
  // default, and wait briefly for another process applying an app migration.
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  return new NodeStateDb(db);
}
