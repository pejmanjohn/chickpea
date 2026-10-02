import type { BetterAuthOptions } from 'better-auth';
import pg, { type Pool, type PoolConfig, type QueryResultRow } from 'pg';

import type {
  BetterAuthDatabaseBackend,
  BetterAuthMcpOAuthContinuationRecord,
  BetterAuthMembershipRecord,
  BetterAuthOAuthGrantRevocation,
  BetterAuthOrganizationErasure,
  BetterAuthOrganizationRecord,
  BetterAuthUserRecord,
} from './better-auth-backend.ts';
import {
  BETTER_AUTH_IDENTITY_AUTHORITY_SQL,
  mapBetterAuthMembership,
  mapBetterAuthOrganization,
  mapBetterAuthUser,
  parseBetterAuthDate,
} from './better-auth-backend.ts';

/** What Better Auth (through Kysely) and this backend need from a `pg.Pool`. */
export type PostgresBetterAuthPool = Pick<Pool, 'connect' | 'query' | 'end'>;

// Better Auth keys every PostgreSQL row by uuid; anything else names no row,
// and comparing it to a uuid column would raise 22P02 instead.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Better Auth on PostgreSQL, for a host serving many installations (through
 * Hyperdrive on Cloudflare). Every statement is a single autocommitted
 * statement on a connection checked out for it; Better Auth's own
 * transactions hold one checked-out connection each. Nothing sets session
 * state, so pooled connections carry nothing between tenants or requests.
 */
export class PostgresBetterAuthBackend implements BetterAuthDatabaseBackend {
  readonly database: NonNullable<BetterAuthOptions['database']>;

  constructor(readonly pool: PostgresBetterAuthPool) {
    // Better Auth recognizes a pool by its `connect` method and selects PostgreSQL.
    this.database = pool as unknown as NonNullable<BetterAuthOptions['database']>;
  }

  async hasIdentityAuthority(): Promise<boolean> {
    const [row] = await this.rows<{ present: boolean }>(BETTER_AUTH_IDENTITY_AUTHORITY_SQL);
    return Boolean(row?.present);
  }

  async absoluteExpiryForToken(token: string): Promise<Date | null> {
    const [row] = await this.rows<{ absoluteExpiresAt: Date | null }>(
      'SELECT "absoluteExpiresAt" FROM session WHERE token = $1 LIMIT 1',
      [token],
    );
    return parseBetterAuthDate(row?.absoluteExpiresAt);
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    if (!UUID.test(userId)) return 0;
    const result = await this.pool.query('DELETE FROM session WHERE "userId" = $1', [userId]);
    return result.rowCount ?? 0;
  }

  async revokeOAuthGrantsForUser(userId: string): Promise<BetterAuthOAuthGrantRevocation> {
    if (!UUID.test(userId)) return { consents: 0, accessTokens: 0, refreshTokens: 0 };
    // One statement, so the three deletes commit together in one round trip.
    const [row] = await this.rows<BetterAuthOAuthGrantRevocation>(
      `WITH access AS (DELETE FROM "oauthAccessToken" WHERE "userId" = $1 RETURNING 1),
            refresh AS (DELETE FROM "oauthRefreshToken" WHERE "userId" = $1 RETURNING 1),
            consent AS (DELETE FROM "oauthConsent" WHERE "userId" = $1 RETURNING 1)
       SELECT (SELECT count(*) FROM access)::int AS "accessTokens",
              (SELECT count(*) FROM refresh)::int AS "refreshTokens",
              (SELECT count(*) FROM consent)::int AS "consents"`,
      [userId],
    );
    return {
      consents: row?.consents ?? 0,
      accessTokens: row?.accessTokens ?? 0,
      refreshTokens: row?.refreshTokens ?? 0,
    };
  }

  async getUser(userId: string): Promise<BetterAuthUserRecord | null> {
    if (!UUID.test(userId)) return null;
    const [row] = await this.rows(
      'SELECT id, email, name, "createdAt", "updatedAt" FROM "user" WHERE id = $1 LIMIT 1',
      [userId],
    );
    return mapBetterAuthUser(row);
  }

  async findUserByEmail(email: string): Promise<BetterAuthUserRecord | null> {
    const [row] = await this.rows(
      `SELECT id, email, name, "createdAt", "updatedAt" FROM "user"
       WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    return mapBetterAuthUser(row);
  }

  async getOrganization(organizationId: string): Promise<BetterAuthOrganizationRecord | null> {
    if (!UUID.test(organizationId)) return null;
    const [row] = await this.rows(
      'SELECT id, name, "createdAt" FROM organization WHERE id = $1 LIMIT 1',
      [organizationId],
    );
    return mapBetterAuthOrganization(row);
  }

  async getMembership(membershipId: string): Promise<BetterAuthMembershipRecord | null> {
    if (!UUID.test(membershipId)) return null;
    const [row] = await this.rows(
      'SELECT id, "organizationId", "userId", role, "createdAt" FROM member WHERE id = $1 LIMIT 1',
      [membershipId],
    );
    return mapBetterAuthMembership(row);
  }

  async listMemberships(organizationId: string): Promise<BetterAuthMembershipRecord[]> {
    if (!UUID.test(organizationId)) return [];
    return (await this.rows(
      `SELECT m.id, m."organizationId", m."userId", m.role, m."createdAt",
              u.id AS "joinedUserId", u.email AS "joinedUserEmail",
              u.name AS "joinedUserName", u."createdAt" AS "joinedUserCreatedAt",
              u."updatedAt" AS "joinedUserUpdatedAt"
       FROM member AS m JOIN "user" AS u ON u.id = m."userId"
       WHERE m."organizationId" = $1 ORDER BY m."createdAt", m.id`,
      [organizationId],
    )).map(mapBetterAuthMembership).filter(isPresent);
  }

  async listMembershipsForUser(userId: string): Promise<BetterAuthMembershipRecord[]> {
    if (!UUID.test(userId)) return [];
    return (await this.rows(
      `SELECT id, "organizationId", "userId", role, "createdAt" FROM member
       WHERE "userId" = $1 ORDER BY "createdAt", id`,
      [userId],
    )).map(mapBetterAuthMembership).filter(isPresent);
  }

  async getMembershipForUser(
    userId: string,
    organizationId: string,
  ): Promise<BetterAuthMembershipRecord | null> {
    if (!UUID.test(userId) || !UUID.test(organizationId)) return null;
    const [row] = await this.rows(
      `SELECT id, "organizationId", "userId", role, "createdAt" FROM member
       WHERE "userId" = $1 AND "organizationId" = $2 LIMIT 1`,
      [userId, organizationId],
    );
    return mapBetterAuthMembership(row);
  }

  /**
   * One transaction on one checked-out connection. The organization row is
   * locked first, so two erasures of it serialize; its members' logins are
   * locked next, so a sign-in adding a membership elsewhere either commits
   * first (and the login is kept) or waits for the erasure.
   */
  async eraseOrganization(slug: string): Promise<BetterAuthOrganizationErasure> {
    const erasure: BetterAuthOrganizationErasure = {
      organizations: 0, members: 0, invitations: 0, users: 0, usersKept: 0, sessions: 0, accounts: 0,
      oauthAccessTokens: 0, oauthRefreshTokens: 0, oauthConsents: 0, oauthClients: 0,
    };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const [organization] = (await client.query<{ id: string }>(
        'SELECT id FROM organization WHERE slug = $1 FOR UPDATE', [slug],
      )).rows;
      if (organization) {
        const memberRows = (await client.query<{ userId: string }>(
          'SELECT "userId" FROM member WHERE "organizationId" = $1', [organization.id],
        )).rows;
        const formerMembers = [...new Set(memberRows.map((row) => row.userId))];
        await client.query('SELECT id FROM "user" WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [formerMembers]);
        const erasable = (await client.query<{ id: string }>(
          `SELECT u.id FROM "user" AS u WHERE u.id = ANY($1::uuid[])
             AND NOT EXISTS (SELECT 1 FROM member AS m WHERE m."userId" = u.id AND m."organizationId" <> $2)`,
          [formerMembers, organization.id],
        )).rows.map((row) => row.id);
        const removed = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rowCount ?? 0;
        erasure.organizations = 1;
        erasure.members = memberRows.length;
        erasure.oauthAccessTokens = await removed('DELETE FROM "oauthAccessToken" WHERE "userId" = ANY($1::uuid[])', [erasable]);
        erasure.oauthRefreshTokens = await removed('DELETE FROM "oauthRefreshToken" WHERE "userId" = ANY($1::uuid[])', [erasable]);
        erasure.oauthConsents = await removed('DELETE FROM "oauthConsent" WHERE "userId" = ANY($1::uuid[])', [erasable]);
        erasure.sessions = await removed('DELETE FROM session WHERE "userId" = ANY($1::uuid[])', [erasable]);
        erasure.accounts = await removed('DELETE FROM account WHERE "userId" = ANY($1::uuid[])', [erasable]);
        erasure.oauthClients = await removed('DELETE FROM "oauthClient" WHERE "userId" = ANY($1::uuid[])', [erasable]);
        erasure.invitations = await removed(
          'DELETE FROM invitation WHERE "organizationId" = $2 OR "inviterId" = ANY($1::uuid[])', [erasable, organization.id],
        );
        erasure.users = await removed('DELETE FROM "user" WHERE id = ANY($1::uuid[])', [erasable]);
        erasure.usersKept = formerMembers.length - erasure.users;
        await client.query('DELETE FROM member WHERE "organizationId" = $1', [organization.id]);
        await client.query('DELETE FROM organization WHERE id = $1', [organization.id]);
      }
      await client.query('COMMIT');
      return erasure;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async countMcpOAuthClients(): Promise<number> {
    const [row] = await this.rows<{ count: number }>(
      `SELECT count(*)::int AS count FROM "oauthClient"
       WHERE "tokenEndpointAuthMethod" = 'none' AND "userId" IS NULL`,
    );
    return row?.count ?? 0;
  }

  async pruneUnusedMcpOAuthClients(createdBefore: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM "oauthClient" AS c
       WHERE c."tokenEndpointAuthMethod" = 'none' AND c."userId" IS NULL
         AND c."createdAt" < $1::timestamptz
         AND NOT EXISTS (SELECT 1 FROM "oauthAccessToken" AS t WHERE t."clientId" = c."clientId")
         AND NOT EXISTS (SELECT 1 FROM "oauthRefreshToken" AS t WHERE t."clientId" = c."clientId")
         AND NOT EXISTS (SELECT 1 FROM "oauthConsent" AS t WHERE t."clientId" = c."clientId")`,
      [createdBefore],
    );
    return result.rowCount ?? 0;
  }

  async putMcpOAuthContinuation(record: BetterAuthMcpOAuthContinuationRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO chickpea_mcp_oauth_continuation
         (id_hash, authorization_path, expires_at, created_at)
       VALUES ($1, $2, $3, $4)`,
      [record.idHash, record.authorizationPath, record.expiresAt, record.createdAt],
    );
  }

  async consumeMcpOAuthContinuation(idHash: string, now: number): Promise<string | null> {
    // Deleting first makes the continuation single-use; an expired one is removed too.
    const [row] = await this.rows<{ authorization_path: string; expires_at: string }>(
      `DELETE FROM chickpea_mcp_oauth_continuation WHERE id_hash = $1
       RETURNING authorization_path, expires_at`,
      [idHash],
    );
    if (!row || Number(row.expires_at) <= now) return null;
    return row.authorization_path;
  }

  /** Ends the pool and every connection it opened. */
  close(): Promise<void> {
    return this.pool.end();
  }

  private async rows<T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }
}

/**
 * Opens a backend whose pool lives only as long as one request or command;
 * close it when that ends. A Worker cannot reuse a socket across requests,
 * and Hyperdrive keeps the long-lived pool. Workers allow six simultaneous
 * connections, so the default leaves room for outbound fetches. Keep `max`
 * at 2 or more: a Better Auth hook reads the absolute session expiry on a
 * second connection, which could wait forever if the only connection were
 * held by a transaction.
 */
export function openPostgresBetterAuthBackend(config: PoolConfig): PostgresBetterAuthBackend {
  const pool = new pg.Pool({
    max: 4,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    ...config,
  });
  // pg-pool removes a connection that fails while idle and opens a fresh one
  // on next use; without a listener its 'error' event would crash Node.
  pool.on('error', () => {});
  return new PostgresBetterAuthBackend(pool);
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
