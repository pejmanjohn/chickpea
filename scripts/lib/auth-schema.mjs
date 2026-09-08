import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const AUTH_SCHEMA_QUERY =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' " +
  "AND name NOT IN ('d1_migrations','_cf_KV') ORDER BY type,name";

export function normalizeAuthSchemaRows(rows) {
  if (!Array.isArray(rows)) throw new Error('AUTH_DB schema inspection returned no rows.');
  return rows.filter((row) => row?.name !== '_cf_KV').map((row) => {
    if (!row || typeof row.type !== 'string' || typeof row.name !== 'string' ||
        typeof row.tbl_name !== 'string' || typeof row.sql !== 'string') {
      throw new Error('AUTH_DB schema inspection returned an unreadable row.');
    }
    return {
      type: row.type,
      name: row.name,
      table: row.tbl_name,
      // Cloudflare D1 may serialize a table's outer parentheses as `( ... )`
      // while Node SQLite preserves the authored `(...)`. Both forms describe
      // the same schema, so normalize only that insignificant whitespace while
      // retaining every identifier, column, constraint, and index definition.
      sql: row.sql
        .replace(/\s+/g, ' ')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .trim()
        .toLowerCase(),
    };
  });
}

export function expectedAuthSchema(artifact) {
  const binding = (artifact.config.d1_databases ?? []).find(
    (candidate) => candidate.binding === 'AUTH_DB',
  );
  const migrationsDirectory = path.resolve(
    path.dirname(artifact.configPath),
    binding?.migrations_dir ?? '',
  );
  let migrationPaths;
  try {
    migrationPaths = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => path.join(migrationsDirectory, name));
    if (migrationPaths.length === 0) throw new Error('no SQL migrations found');
  } catch (error) {
    throw new Error(
      `Unable to read the reviewed Better Auth migration chain: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const database = new DatabaseSync(':memory:');
  try {
    for (const migrationPath of migrationPaths) {
      database.exec(readFileSync(migrationPath, 'utf8'));
    }
    return normalizeAuthSchemaRows(database.prepare(AUTH_SCHEMA_QUERY).all());
  } finally {
    database.close();
  }
}

