import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolveStateDbPath } from '../state/node-state-db.ts';
import type {
  BetterAuthDatabaseBackend,
  BetterAuthMcpOAuthContinuationRecord,
  BetterAuthMembershipRecord,
  BetterAuthOrganizationRecord,
  BetterAuthUserRecord,
} from './better-auth-backend.ts';
import {
  BETTER_AUTH_IDENTITY_AUTHORITY_SQL,
  mapBetterAuthMembership,
  mapBetterAuthOrganization,
  mapBetterAuthUser,
} from './better-auth-backend.ts';

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

  async hasIdentityAuthority(): Promise<boolean> {
    const row = this.database.prepare(BETTER_AUTH_IDENTITY_AUTHORITY_SQL)
      .get() as { present?: number } | undefined;
    return Boolean(row?.present);
  }

  async absoluteExpiryForToken(token: string): Promise<Date | null> {
    const row = this.database.prepare(
      'SELECT absoluteExpiresAt FROM session WHERE token = ? LIMIT 1',
    ).get(token) as { absoluteExpiresAt?: number | string | null } | undefined;
    return parseStoredDate(row?.absoluteExpiresAt);
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    return Number(this.database.prepare('DELETE FROM session WHERE userId = ?').run(userId).changes);
  }

  async getUser(userId: string): Promise<BetterAuthUserRecord | null> {
    return mapBetterAuthUser(this.database.prepare(
      'SELECT id, email, name, createdAt, updatedAt FROM "user" WHERE id = ? LIMIT 1',
    ).get(userId));
  }

  async findUserByEmail(email: string): Promise<BetterAuthUserRecord | null> {
    return mapBetterAuthUser(this.database.prepare(
      'SELECT id, email, name, createdAt, updatedAt FROM "user" WHERE lower(email) = lower(?) LIMIT 1',
    ).get(email));
  }

  async getOrganization(organizationId: string): Promise<BetterAuthOrganizationRecord | null> {
    return mapBetterAuthOrganization(this.database.prepare(
      'SELECT id, name, createdAt FROM organization WHERE id = ? LIMIT 1',
    ).get(organizationId));
  }

  async getMembership(membershipId: string): Promise<BetterAuthMembershipRecord | null> {
    return mapBetterAuthMembership(this.database.prepare(
      'SELECT id, organizationId, userId, role, createdAt FROM member WHERE id = ? LIMIT 1',
    ).get(membershipId));
  }

  async listMemberships(organizationId: string): Promise<BetterAuthMembershipRecord[]> {
    return this.database.prepare(
      `SELECT m.id, m.organizationId, m.userId, m.role, m.createdAt,
              u.id AS joinedUserId, u.email AS joinedUserEmail,
              u.name AS joinedUserName, u.createdAt AS joinedUserCreatedAt,
              u.updatedAt AS joinedUserUpdatedAt
       FROM member AS m JOIN "user" AS u ON u.id = m.userId
       WHERE m.organizationId = ? ORDER BY m.createdAt, m.id`,
    ).all(organizationId).map(mapBetterAuthMembership).filter(isPresent);
  }

  async listMembershipsForUser(userId: string): Promise<BetterAuthMembershipRecord[]> {
    return this.database.prepare(
      'SELECT id, organizationId, userId, role, createdAt FROM member WHERE userId = ? ORDER BY createdAt, id',
    ).all(userId).map(mapBetterAuthMembership).filter(isPresent);
  }

  async getMembershipForUser(
    userId: string,
    organizationId: string,
  ): Promise<BetterAuthMembershipRecord | null> {
    return mapBetterAuthMembership(this.database.prepare(
      `SELECT id, organizationId, userId, role, createdAt FROM member
       WHERE userId = ? AND organizationId = ? LIMIT 1`,
    ).get(userId, organizationId));
  }

  async countMcpOAuthClients(): Promise<number> {
    const row = this.database.prepare(
      `SELECT count(*) AS count FROM oauthClient
       WHERE tokenEndpointAuthMethod = 'none' AND userId IS NULL`,
    ).get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  async pruneUnusedMcpOAuthClients(createdBefore: string): Promise<number> {
    const result = this.database.prepare(
      `DELETE FROM oauthClient
       WHERE tokenEndpointAuthMethod = 'none' AND userId IS NULL
         AND createdAt < ?
         AND NOT EXISTS (
           SELECT 1 FROM oauthAccessToken WHERE oauthAccessToken.clientId = oauthClient.clientId
         )
         AND NOT EXISTS (
           SELECT 1 FROM oauthRefreshToken WHERE oauthRefreshToken.clientId = oauthClient.clientId
         )
         AND NOT EXISTS (
           SELECT 1 FROM oauthConsent WHERE oauthConsent.clientId = oauthClient.clientId
         )`,
    ).run(createdBefore);
    return Number(result.changes);
  }

  async putMcpOAuthContinuation(record: BetterAuthMcpOAuthContinuationRecord): Promise<void> {
    this.database.prepare(
      `INSERT INTO chickpea_mcp_oauth_continuation
         (id_hash, authorization_path, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(record.idHash, record.authorizationPath, record.expiresAt, record.createdAt);
  }

  async consumeMcpOAuthContinuation(idHash: string, now: number): Promise<string | null> {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.database.prepare(
        `SELECT authorization_path, expires_at
         FROM chickpea_mcp_oauth_continuation WHERE id_hash = ? LIMIT 1`,
      ).get(idHash) as { authorization_path?: string; expires_at?: number } | undefined;
      this.database.prepare(
        'DELETE FROM chickpea_mcp_oauth_continuation WHERE id_hash = ?',
      ).run(idHash);
      this.database.exec('COMMIT;');
      if (!row || typeof row.authorization_path !== 'string' ||
          typeof row.expires_at !== 'number' || row.expires_at <= now) return null;
      return row.authorization_path;
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
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

function resolveBetterAuthDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CHICKPEA_AUTH_DB_PATH) return env.CHICKPEA_AUTH_DB_PATH;
  const statePath = resolveStateDbPath(env);
  return statePath === ':memory:' ? ':memory:' : `${statePath}.auth`;
}

export function applyBetterAuthMigrations(
  database: DatabaseSync,
  migrationsDirectory = pathDefaultMigrations(),
): void {
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(path.join(migrationsDirectory, name), 'utf8');
      return { name, sql, digest: createHash('sha256').update(sql).digest('hex') };
    });
  const ledgerExists = Boolean(database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'chickpea_better_auth_migrations'",
  ).get());
  if (ledgerExists) {
    const columns = database.prepare('PRAGMA table_info(chickpea_better_auth_migrations)').all()
      .map((row) => String((row as { name?: unknown }).name));
    if (!columns.includes('digest')) throw incompatibleBetterAuthSchema();
    const applied = database.prepare(
      'SELECT name, digest FROM chickpea_better_auth_migrations ORDER BY name',
    ).all() as Array<{ name: string; digest: string }>;
    if (applied.some((entry) =>
      migrations.find((migration) => migration.name === entry.name)?.digest !== entry.digest)) {
      throw incompatibleBetterAuthSchema();
    }
  } else {
    const existingAuthorityTable = database.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name IN ('user','account','verification','session','organization','member','invitation')
       LIMIT 1`,
    ).get();
    if (existingAuthorityTable) throw incompatibleBetterAuthSchema();
    database.exec(
      `CREATE TABLE chickpea_better_auth_migrations (
        name TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`,
    );
  }
  for (const migration of migrations) {
    const applied = database.prepare(
      'SELECT digest FROM chickpea_better_auth_migrations WHERE name = ?',
    ).get(migration.name) as { digest?: string } | undefined;
    if (applied) {
      if (applied.digest !== migration.digest) throw incompatibleBetterAuthSchema();
      continue;
    }
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.exec(migration.sql);
      database.prepare(
        'INSERT INTO chickpea_better_auth_migrations (name, digest, applied_at) VALUES (?, ?, ?)',
      ).run(migration.name, migration.digest, Date.now());
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }
}

function incompatibleBetterAuthSchema(): Error {
  return new Error(
    'AUTH_DB contains an incompatible Better Auth 0001; use a fresh empty database.',
  );
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

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
