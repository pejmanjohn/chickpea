import type { D1Database } from '@cloudflare/workers-types';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

const EXECUTE = Symbol('execute');

/**
 * The D1 binding surface Chickpea and Better Auth's D1 dialect use, over a
 * local SQLite database. Real workerd D1 stays covered by
 * better-auth-cloudflare.test.ts; this runs D1 SQL in-process.
 */
export function sqliteD1(database: DatabaseSync): D1Database {
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async first(column?: string) {
      const row = execute(database, sql, values).results[0] ?? null;
      return column && row ? row[column] ?? null : row;
    },
    async all() {
      return execute(database, sql, values);
    },
    async run() {
      return execute(database, sql, values);
    },
    [EXECUTE]: () => execute(database, sql, values),
  });
  return {
    prepare: (sql: string) => statement(sql),
    async batch(statements: Array<ReturnType<typeof statement>>) {
      database.exec('BEGIN IMMEDIATE;');
      try {
        const results = statements.map((entry) => entry[EXECUTE]());
        database.exec('COMMIT;');
        return results;
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    },
    // Never called; Better Auth recognizes a D1 binding by batch, exec and prepare.
    async exec(sql: string) {
      database.exec(sql);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database;
}

function execute(database: DatabaseSync, sql: string, values: unknown[]) {
  const prepared = database.prepare(sql);
  const parameters = values.map(d1Value);
  const returnsRows = prepared.columns().length > 0;
  const results = returnsRows
    ? prepared.all(...parameters) as Array<Record<string, unknown>>
    : [];
  const write = returnsRows ? undefined : prepared.run(...parameters);
  const changes = write
    ? Number(write.changes)
    : /^\s*(?:insert|update|delete|replace)\b/i.test(sql)
      ? Number((database.prepare('SELECT changes() AS changes').get() as { changes: number }).changes)
      : 0;
  return {
    success: true,
    results,
    meta: {
      changes,
      last_row_id: write ? Number(write.lastInsertRowid) : 0,
      changed_db: changes > 0,
      duration: 0,
      rows_read: results.length,
      rows_written: changes,
      size_after: 0,
    },
  };
}

// D1 stores booleans as integers and has no undefined.
function d1Value(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value as SQLInputValue;
}
