import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PostgresBetterAuthPool } from './better-auth-postgres.ts';

const DEFAULT_MIGRATIONS = fileURLToPath(
  new URL('../../migrations/better-auth-postgres/', import.meta.url),
);
const LEDGER = 'chickpea_better_auth_migrations';
const AUTHORITY_TABLES = [
  'user', 'account', 'verification', 'session', 'organization', 'member', 'invitation',
];
// Serializes migration runs: the bytes of "chkpauth" as one 64-bit key.
const MIGRATION_LOCK_KEY = '7163093337748370536';

/**
 * Applies the reviewed PostgreSQL Better Auth migrations that are not yet in
 * the ledger, in order, in one transaction, and returns their names. An
 * operator command runs this against the database directly (not per request);
 * concurrent runs wait on a transaction-scoped advisory lock, and a changed
 * history or an unledgered existing schema is refused.
 */
export async function applyPostgresBetterAuthMigrations(
  pool: PostgresBetterAuthPool,
  migrationsDirectory = DEFAULT_MIGRATIONS,
): Promise<string[]> {
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(path.join(migrationsDirectory, name), 'utf8');
      return { name, sql, digest: createHash('sha256').update(sql).digest('hex') };
    });
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    // The schema new tables are created in (the first on search_path).
    const existing = new Set((await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [[LEDGER, ...AUTHORITY_TABLES]],
    )).rows.map((row) => row.table_name));
    if (!existing.has(LEDGER)) {
      if (existing.size) throw incompatiblePostgresSchema();
      await client.query(
        `CREATE TABLE ${LEDGER} (
          name text PRIMARY KEY,
          digest text NOT NULL,
          applied_at bigint NOT NULL
        )`,
      );
    }
    const applied = new Map((await client.query<{ name: string; digest: string }>(
      `SELECT name, digest FROM ${LEDGER}`,
    )).rows.map((row) => [row.name, row.digest]));
    for (const [name, digest] of applied) {
      if (migrations.find((migration) => migration.name === name)?.digest !== digest) {
        throw incompatiblePostgresSchema();
      }
    }
    const appliedNow: string[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO ${LEDGER} (name, digest, applied_at) VALUES ($1, $2, $3)`,
        [migration.name, migration.digest, Date.now()],
      );
      appliedNow.push(migration.name);
    }
    await client.query('COMMIT');
    return appliedNow;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { broken = true; });
    throw error;
  } finally {
    client.release(broken);
  }
}

function incompatiblePostgresSchema(): Error {
  return new Error(
    'The PostgreSQL auth database has an incompatible Better Auth migration history; ' +
      'use a fresh empty database.',
  );
}
