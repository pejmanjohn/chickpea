/**
 * Mini SQL interface every app state store is written against, so the store
 * logic (SQL, migrations, seeding, TTL purges) exists ONCE and runs on both
 * targets: Node wraps `node:sqlite`'s DatabaseSync, the Cloudflare target wraps
 * a Durable Object's `ctx.storage.sql`. The shape mirrors Flue's own internal
 * SqlStorage trick (`{exec(q, ...b): {toArray()}}`) kept deliberately small:
 * everything here must be implementable over DO SQLite, which has NO prepared
 * statements and does NOT accept multi-statement exec strings.
 */

/** Bindable parameter values — the JSON-safe subset both backends accept. */
export type SqlParam = string | number | null;

export interface StateDb {
  /** Execute a single write statement with bindings; report affected rows. */
  run(sql: string, ...params: SqlParam[]): { changes: number };
  /** Execute a query with bindings and return the first row, if any. */
  get(sql: string, ...params: SqlParam[]): Record<string, unknown> | undefined;
  /** Execute a query with bindings and return every row. */
  all(sql: string, ...params: SqlParam[]): Record<string, unknown>[];
  /**
   * Execute ONE bare statement (DDL/PRAGMA). Callers must issue one statement
   * per call: DO SQLite rejects multi-statement strings, so joining DDL with
   * ';' would work on Node and break on Cloudflare.
   */
  exec(sql: string): void;
  /**
   * Run `fn` atomically. Node brackets it in BEGIN IMMEDIATE/COMMIT (ROLLBACK
   * on throw); the DO backend maps to `ctx.storage.transactionSync`. `fn` must
   * stay synchronous — DO transactions cannot span awaits.
   */
  transaction<T>(fn: () => T): T;
}

interface StateDbIntegrity {
  foreignKeysEnabled: boolean;
  foreignKeyViolationCount: number;
}

/**
 * Cross-target relational integrity probe. Node and Durable Object SQLite both
 * support these PRAGMAs; canonical stores call this on construction and release
 * verification calls it again after migration/fixture writes.
 */
export function inspectStateDbIntegrity(db: StateDb): StateDbIntegrity {
  return {
    foreignKeysEnabled: Number(db.get('PRAGMA foreign_keys')?.foreign_keys) === 1,
    foreignKeyViolationCount: db.all('PRAGMA foreign_key_check').length,
  };
}
