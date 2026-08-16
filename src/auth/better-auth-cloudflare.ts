import type { D1Database } from '@cloudflare/workers-types';

import type {
  BetterAuthDatabaseBackend,
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
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
