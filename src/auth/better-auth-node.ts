import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolveStateDbPath } from '../state/node-state-db.ts';
import type { BetterAuthDatabaseBackend } from './better-auth-backend.ts';

interface CachedBackend {
  path: string;
  backend: NodeBetterAuthBackend;
}

let cached: CachedBackend | undefined;

export class NodeBetterAuthBackend implements BetterAuthDatabaseBackend {
  readonly database: DatabaseSync;

  constructor(
    readonly path: string,
    migrationsDirectory = pathDefaultMigrations(),
  ) {
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.database.exec('PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') this.database.exec('PRAGMA journal_mode = WAL;');
    applyBetterAuthMigrations(this.database, migrationsDirectory);
  }

  async absoluteExpiryForToken(token: string): Promise<Date | null> {
    const row = this.database.prepare(
      'SELECT absoluteExpiresAt FROM session WHERE token = ? LIMIT 1',
    ).get(token) as { absoluteExpiresAt?: number | string | null } | undefined;
    return parseStoredDate(row?.absoluteExpiresAt);
  }

  async hasPasswordCredential(email: string): Promise<boolean> {
    const row = this.database.prepare(
      `SELECT 1 AS present
       FROM "user" AS u
       JOIN account AS a ON a.userId = u.id
       WHERE lower(u.email) = lower(?)
         AND a.providerId = 'credential'
         AND a.password IS NOT NULL
       LIMIT 1`,
    ).get(email);
    return Boolean(row);
  }

  close(): void {
    this.database.close();
  }
}

export function getNodeBetterAuthBackend(
  env: NodeJS.ProcessEnv = process.env,
): NodeBetterAuthBackend {
  const authPath = resolveBetterAuthDbPath(env);
  if (cached?.path === authPath) return cached.backend;
  cached?.backend.close();
  cached = { path: authPath, backend: new NodeBetterAuthBackend(authPath) };
  return cached.backend;
}

export function resolveBetterAuthDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CHICKPEA_AUTH_DB_PATH) return env.CHICKPEA_AUTH_DB_PATH;
  const statePath = resolveStateDbPath(env);
  return statePath === ':memory:' ? ':memory:' : `${statePath}.auth`;
}

export function applyBetterAuthMigrations(
  database: DatabaseSync,
  migrationsDirectory = pathDefaultMigrations(),
): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS chickpea_better_auth_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  );
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const name of migrations) {
    const applied = database.prepare(
      'SELECT 1 AS applied FROM chickpea_better_auth_migrations WHERE name = ?',
    ).get(name);
    if (applied) continue;
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.exec(readFileSync(path.join(migrationsDirectory, name), 'utf8'));
      database.prepare(
        'INSERT INTO chickpea_better_auth_migrations (name, applied_at) VALUES (?, ?)',
      ).run(name, Date.now());
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }
}

function pathDefaultMigrations(): string {
  return path.resolve(process.cwd(), 'migrations/better-auth');
}

function parseStoredDate(value: number | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  const date = new Date(Number.isFinite(numeric) ? numeric : value);
  return Number.isNaN(date.getTime()) ? null : date;
}
