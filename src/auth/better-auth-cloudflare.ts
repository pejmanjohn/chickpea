import { createHash } from 'node:crypto';
import type { D1Database } from '@cloudflare/workers-types';

import type {
  BetterAuthDatabaseBackend,
  BetterAuthMembershipRecord,
  BetterAuthOrganizationRecord,
  BetterAuthUserRecord,
} from './better-auth-backend.ts';
import {
  mapBetterAuthMembership,
  mapBetterAuthOrganization,
  mapBetterAuthUser,
} from './better-auth-backend.ts';
import { DUMMY_PASSWORD_RECORD, verifierShard, type PasswordPrimitive } from './password.ts';

export interface AuthGuardRpc {
  hashPassword(password: string): Promise<string>;
  verifyPassword(input: { hash: string; password: string }): Promise<boolean>;
  allow(bucket: string, limit: number, windowMs: number): Promise<boolean>;
}

interface AuthGuardNamespace {
  getByName(name: string): AuthGuardRpc;
}

export interface CloudflareBetterAuthEnv {
  AUTH_DB: D1Database;
  AUTH_GUARD: AuthGuardNamespace;
  CHICKPEA_AUTH_SECRET?: string;
  CHICKPEA_RECOVERY_TOKEN?: string;
}

export class D1BetterAuthBackend implements BetterAuthDatabaseBackend {
  constructor(readonly database: D1Database) {}

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

  async hasPasswordCredential(email: string): Promise<boolean> {
    const row = await this.database.prepare(
      `SELECT 1 AS present
       FROM "user" AS u
       JOIN account AS a ON a.userId = u.id
       WHERE lower(u.email) = lower(?)
         AND a.providerId = 'credential'
         AND a.password IS NOT NULL
       LIMIT 1`,
    ).bind(email).first<{ present: number }>();
    return Boolean(row?.present);
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

export function cloudflarePasswordPrimitive(
  env: CloudflareBetterAuthEnv,
  shardKey: string,
): PasswordPrimitive {
  return {
    hash: (password) => authGuard(env, 'kdf-hash', shardKey).hashPassword(password),
    verify: (input) => authGuard(
      env,
      'kdf-verify',
      input.hash === DUMMY_PASSWORD_RECORD
        ? shardKey
        : verifierShard(input.hash) ?? shardKey,
    ).verifyPassword(input),
  };
}

export async function cloudflareLoginSourceAllowed(
  env: CloudflareBetterAuthEnv,
  source: string,
): Promise<boolean> {
  return authGuard(env, 'source-rate', source).allow('sign-in', 50, 10_000);
}

export async function cloudflareLoginIdentityAllowed(
  env: CloudflareBetterAuthEnv,
  email: string,
): Promise<boolean> {
  return authGuard(env, 'identity-rate', email).allow('sign-in', 5, 10_000);
}

function authGuard(
  env: CloudflareBetterAuthEnv,
  purpose: string,
  shardKey: string,
) {
  return env.AUTH_GUARD.getByName(`${purpose}:${stableDigest(shardKey)}`);
}

function stableDigest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
