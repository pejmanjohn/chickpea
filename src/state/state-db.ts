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

/**
 * Schema lifecycle a handle carries into store constructors. `install` (the
 * default) runs DDL, migrations, probes and seeds exactly as today. `attach`
 * asserts that this exact code version already installed the schema on this
 * storage, so constructors must issue no schema work at all: Durable Objects
 * SQLite meters every row a statement reads and constructors run on every
 * cold start. See `schema-lifecycle.ts` for who may assert `attach`.
 */
export type StateSchemaMode = 'install' | 'attach';

export interface StateDb {
  /** Absent means `install`. Only a verified installation marker sets `attach`. */
  readonly schema?: StateSchemaMode;
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

/** Store constructors gate their one schema block on this. */
export function schemaInstallRequired(db: StateDb): boolean {
  return db.schema !== 'attach';
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
