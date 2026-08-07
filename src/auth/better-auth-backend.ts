import type { BetterAuthOptions } from 'better-auth';

export interface BetterAuthUserRecord {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface BetterAuthOrganizationRecord {
  id: string;
  name: string;
  createdAt: number;
}

export interface BetterAuthMembershipRecord {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: number;
  user?: BetterAuthUserRecord;
}

export function mapBetterAuthUser(row: unknown): BetterAuthUserRecord | null {
  if (!row) return null;
  const value = row as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.email !== 'string' ||
      typeof value.name !== 'string') return null;
  return {
    id: value.id,
    email: value.email,
    name: value.name,
    createdAt: betterAuthEpoch(value.createdAt),
    updatedAt: betterAuthEpoch(value.updatedAt),
  };
}

export function mapBetterAuthOrganization(row: unknown): BetterAuthOrganizationRecord | null {
  if (!row) return null;
  const value = row as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.name !== 'string') return null;
  return { id: value.id, name: value.name, createdAt: betterAuthEpoch(value.createdAt) };
}

export function mapBetterAuthMembership(row: unknown): BetterAuthMembershipRecord | null {
  if (!row) return null;
  const value = row as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.organizationId !== 'string' ||
      typeof value.userId !== 'string' || typeof value.role !== 'string') return null;
  const joinedUser = mapBetterAuthUser({
    id: value.joinedUserId,
    email: value.joinedUserEmail,
    name: value.joinedUserName,
    createdAt: value.joinedUserCreatedAt,
    updatedAt: value.joinedUserUpdatedAt,
  });
  return {
    id: value.id,
    organizationId: value.organizationId,
    userId: value.userId,
    role: value.role,
    createdAt: betterAuthEpoch(value.createdAt),
    ...(joinedUser ? { user: joinedUser } : {}),
  };
}

function betterAuthEpoch(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined) return 0;
  const numeric = typeof value === 'number' ? value : Number(value);
  const date = new Date(Number.isFinite(numeric) ? numeric : String(value));
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export interface BetterAuthDatabaseBackend {
  database: NonNullable<BetterAuthOptions['database']>;
  absoluteExpiryForToken(token: string): Promise<Date | null>;
  hasPasswordCredential(email: string): Promise<boolean>;
  getUser(userId: string): Promise<BetterAuthUserRecord | null>;
  findUserByEmail(email: string): Promise<BetterAuthUserRecord | null>;
  getOrganization(organizationId: string): Promise<BetterAuthOrganizationRecord | null>;
  getMembership(membershipId: string): Promise<BetterAuthMembershipRecord | null>;
  listMemberships(organizationId: string): Promise<BetterAuthMembershipRecord[]>;
  getMembershipForUser(
    userId: string,
    organizationId: string,
  ): Promise<BetterAuthMembershipRecord | null>;
}
