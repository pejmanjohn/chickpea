import { createHash } from 'node:crypto';
import type { D1Database } from '@cloudflare/workers-types';

import type { BetterAuthDatabaseBackend } from './better-auth-backend.ts';
import type { PasswordPrimitive } from './password.ts';

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
  CHICKPEA_RECOVERY_TOKEN: string;
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
}

export function cloudflarePasswordPrimitive(
  env: CloudflareBetterAuthEnv,
  shardKey: string,
): PasswordPrimitive {
  return {
    hash: (password) => authGuard(env, 'kdf-hash', shardKey).hashPassword(password),
    verify: (input) => authGuard(env, 'kdf-verify', input.hash).verifyPassword(input),
  };
}

export async function cloudflareLoginAllowed(
  env: CloudflareBetterAuthEnv,
  source: string,
  email: string,
): Promise<boolean> {
  const [sourceAllowed, identityAllowed] = await Promise.all([
    authGuard(env, 'source-rate', source).allow('sign-in', 50, 10_000),
    authGuard(env, 'identity-rate', email).allow('sign-in', 5, 10_000),
  ]);
  return sourceAllowed && identityAllowed;
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
