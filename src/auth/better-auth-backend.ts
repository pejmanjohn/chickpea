import type { BetterAuthOptions } from 'better-auth';

export const BETTER_AUTH_IDENTITY_AUTHORITY_SQL = `SELECT (
  EXISTS(SELECT 1 FROM "user") OR
  EXISTS(SELECT 1 FROM account) OR
  EXISTS(SELECT 1 FROM organization) OR
  EXISTS(SELECT 1 FROM member) OR
  EXISTS(SELECT 1 FROM session)
) AS present`;

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

export interface BetterAuthMcpOAuthContinuationRecord {
  idHash: string;
  authorizationPath: string;
  expiresAt: number;
  createdAt: number;
}

/** Rows removed by revoking one user's MCP OAuth grants. */
export interface BetterAuthOAuthGrantRevocation {
  consents: number;
  accessTokens: number;
  refreshTokens: number;
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
  return parseBetterAuthDate(value)?.getTime() ?? 0;
}

/** SQLite stores Better Auth dates as ISO text (or epoch numbers); PostgreSQL returns a Date. */
export function parseBetterAuthDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  const date = new Date(Number.isFinite(numeric) ? numeric : String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface BetterAuthDatabaseBackend {
  database: NonNullable<BetterAuthOptions['database']>;
  /** True when Better Auth contains any identity, credential, membership, or session authority. */
  hasIdentityAuthority(): Promise<boolean>;
  absoluteExpiryForToken(token: string): Promise<Date | null>;
  /** Revoke every Better Auth browser session for one canonical user. */
  deleteSessionsForUser(userId: string): Promise<number>;
  /**
   * Remove one canonical user's MCP OAuth consents and access and refresh
   * tokens together, so their stored grants end with their membership. An
   * authorization code issued earlier can still be exchanged; its tokens are
   * refused at the MCP resource, which checks membership on every request.
   */
  revokeOAuthGrantsForUser(userId: string): Promise<BetterAuthOAuthGrantRevocation>;
  getUser(userId: string): Promise<BetterAuthUserRecord | null>;
  findUserByEmail(email: string): Promise<BetterAuthUserRecord | null>;
  getOrganization(organizationId: string): Promise<BetterAuthOrganizationRecord | null>;
  getMembership(membershipId: string): Promise<BetterAuthMembershipRecord | null>;
  listMemberships(organizationId: string): Promise<BetterAuthMembershipRecord[]>;
  listMembershipsForUser(userId: string): Promise<BetterAuthMembershipRecord[]>;
  getMembershipForUser(
    userId: string,
    organizationId: string,
  ): Promise<BetterAuthMembershipRecord | null>;
  countMcpOAuthClients(): Promise<number>;
  pruneUnusedMcpOAuthClients(createdBefore: string): Promise<number>;
  putMcpOAuthContinuation(record: BetterAuthMcpOAuthContinuationRecord): Promise<void>;
  consumeMcpOAuthContinuation(idHash: string, now: number): Promise<string | null>;
}

export type BetterAuthAccessRevoker =
  Pick<BetterAuthDatabaseBackend, 'deleteSessionsForUser' | 'revokeOAuthGrantsForUser'>;

/**
 * Ends one user's MCP OAuth grants and browser sessions when their membership
 * is suspended or removed. Grants go first: a retry after a failure finds the
 * membership unchanged and would not revoke again.
 */
export async function revokeBetterAuthUserAccess(
  backend: BetterAuthAccessRevoker,
  userId: string,
): Promise<void> {
  await backend.revokeOAuthGrantsForUser(userId);
  await backend.deleteSessionsForUser(userId);
}
