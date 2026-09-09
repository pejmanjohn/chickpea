import type { DurableObjectStorage } from 'cloudflare:workers';

import type { SqlParam, StateDb, StateSchemaMode } from './state-db.ts';

/**
 * StateDb over a Durable Object's synchronous SQL storage.
 *
 * `changes` is derived from `SELECT changes()` — NOT the cursor's
 * `rowsWritten`, which counts index writes too (a single INSERT into a table
 * with a PRIMARY KEY reports rowsWritten=2; measured on workerd 2026-07-06).
 * The store logic's write-once semantics (claims, snapshot putIfAbsent,
 * createAgent) depend on exact SQLite changes semantics, which changes()
 * returns (1/0) both standalone and inside transactionSync.
 *
 * `transaction` is the native `transactionSync`, which nests as savepoints:
 * an inner throw that the outer catches rolls back only the inner work
 * (measured on workerd 2026-09-09: outer 1, inner 2 throws, outer 3 keeps
 * 1 and 3). The schema install relies on the other direction of the same
 * rule: constructor transactions nest inside the install transaction, and an
 * uncaught throw anywhere discards the whole install and its marker.
 */
export class DoSqlStateDb implements StateDb {
  constructor(
    private readonly storage: DurableObjectStorage,
    readonly schema: StateSchemaMode = 'install',
  ) {}

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    // Drain the write cursor before reading changes(): cursors execute
    // incrementally, and changes() must observe the completed statement.
    this.storage.sql.exec(sql, ...params).toArray();
    const row = this.storage.sql.exec('SELECT changes() AS changes').one();
    return { changes: Number(row.changes) };
  }

  get(sql: string, ...params: SqlParam[]): Record<string, unknown> | undefined {
    return this.storage.sql.exec(sql, ...params).toArray()[0];
  }

  all(sql: string, ...params: SqlParam[]): Record<string, unknown>[] {
    return this.storage.sql.exec(sql, ...params).toArray();
  }

  exec(sql: string): void {
    // Single statements only (the StateDb contract) — DO SQLite rejects
    // multi-statement strings, which is exactly why the contract exists.
    this.storage.sql.exec(sql).toArray();
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}
