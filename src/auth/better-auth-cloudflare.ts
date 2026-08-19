import type { D1Database } from '@cloudflare/workers-types';

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

export interface CloudflareBetterAuthEnv {
  AUTH_DB: D1Database;
  CHICKPEA_AUTH_SECRET?: string;
  CHICKPEA_RECOVERY_TOKEN?: string;
}

export class D1BetterAuthBackend implements BetterAuthDatabaseBackend {
  constructor(readonly database: D1Database) {}

  async hasIdentityAuthority(): Promise<boolean> {
    const row = await this.database.prepare(BETTER_AUTH_IDENTITY_AUTHORITY_SQL)
      .first<{ present: number }>();
    return Boolean(row?.present);
  }

  async absoluteExpiryForToken(token: string): Promise<Date | null> {
    const row = await this.database.prepare(
      'SELECT absoluteExpiresAt FROM session WHERE token = ? LIMIT 1',
    ).bind(token).first<{ absoluteExpiresAt: number | string | null }>();
    if (row?.absoluteExpiresAt === null || row?.absoluteExpiresAt === undefined) return null;
    const value = typeof row.absoluteExpiresAt === 'number'
      ? row.absoluteExpiresAt
      : Number(row.absoluteExpiresAt);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    const result = await this.database.prepare('DELETE FROM session WHERE userId = ?').bind(userId).run();
    return Number(result.meta.changes ?? 0);
  }

  async getUser(userId: string): Promise<BetterAuthUserRecord | null> {
    return mapBetterAuthUser(await this.database.prepare(
      'SELECT id, email, name, createdAt, updatedAt FROM "user" WHERE id = ? LIMIT 1',
    ).bind(userId).first());
  }

  async findUserByEmail(email: string): Promise<BetterAuthUserRecord | null> {
    return mapBetterAuthUser(await this.database.prepare(
      'SELECT id, email, name, createdAt, updatedAt FROM "user" WHERE lower(email) = lower(?) LIMIT 1',
    ).bind(email).first());
  }

  async getOrganization(organizationId: string): Promise<BetterAuthOrganizationRecord | null> {
    return mapBetterAuthOrganization(await this.database.prepare(
      'SELECT id, name, createdAt FROM organization WHERE id = ? LIMIT 1',
    ).bind(organizationId).first());
  }

  async getMembership(membershipId: string): Promise<BetterAuthMembershipRecord | null> {
    return mapBetterAuthMembership(await this.database.prepare(
      'SELECT id, organizationId, userId, role, createdAt FROM member WHERE id = ? LIMIT 1',
    ).bind(membershipId).first());
  }

  async listMemberships(organizationId: string): Promise<BetterAuthMembershipRecord[]> {
    const result = await this.database.prepare(
      `SELECT m.id, m.organizationId, m.userId, m.role, m.createdAt,
              u.id AS joinedUserId, u.email AS joinedUserEmail,
              u.name AS joinedUserName, u.createdAt AS joinedUserCreatedAt,
              u.updatedAt AS joinedUserUpdatedAt
       FROM member AS m JOIN "user" AS u ON u.id = m.userId
       WHERE m.organizationId = ? ORDER BY m.createdAt, m.id`,
    ).bind(organizationId).all();
    return result.results.map(mapBetterAuthMembership).filter(isPresent);
  }

  async listMembershipsForUser(userId: string): Promise<BetterAuthMembershipRecord[]> {
    const result = await this.database.prepare(
      'SELECT id, organizationId, userId, role, createdAt FROM member WHERE userId = ? ORDER BY createdAt, id',
    ).bind(userId).all();
    return result.results.map(mapBetterAuthMembership).filter(isPresent);
  }

  async getMembershipForUser(
    userId: string,
    organizationId: string,
  ): Promise<BetterAuthMembershipRecord | null> {
    return mapBetterAuthMembership(await this.database.prepare(
      `SELECT id, organizationId, userId, role, createdAt FROM member
       WHERE userId = ? AND organizationId = ? LIMIT 1`,
    ).bind(userId, organizationId).first());
  }

  async countMcpOAuthClients(): Promise<number> {
    const row = await this.database.prepare(
      `SELECT count(*) AS count FROM oauthClient
       WHERE tokenEndpointAuthMethod = 'none' AND userId IS NULL`,
    ).first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async pruneUnusedMcpOAuthClients(createdBefore: string): Promise<number> {
    const result = await this.database.prepare(
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
    ).bind(createdBefore).run();
    return Number(result.meta.changes ?? 0);
  }

  async putMcpOAuthContinuation(record: BetterAuthMcpOAuthContinuationRecord): Promise<void> {
    await this.database.prepare(
      `INSERT INTO chickpea_mcp_oauth_continuation
         (id_hash, authorization_path, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(record.idHash, record.authorizationPath, record.expiresAt, record.createdAt).run();
  }

  async consumeMcpOAuthContinuation(idHash: string, now: number): Promise<string | null> {
    const row = await this.database.prepare(
      `DELETE FROM chickpea_mcp_oauth_continuation
       WHERE id_hash = ? AND expires_at > ?
       RETURNING authorization_path`,
    ).bind(idHash, now).first<{ authorization_path: string }>();
    if (row?.authorization_path) return row.authorization_path;
    await this.database.prepare(
      'DELETE FROM chickpea_mcp_oauth_continuation WHERE id_hash = ? AND expires_at <= ?',
    ).bind(idHash, now).run();
    return null;
  }
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
