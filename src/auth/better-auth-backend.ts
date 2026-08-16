import type { BetterAuthOptions } from 'better-auth';

export const BETTER_AUTH_IDENTITY_AUTHORITY_SQL = `SELECT (
  EXISTS(SELECT 1 FROM "user") OR
  EXISTS(SELECT 1 FROM account) OR
  EXISTS(SELECT 1 FROM organization) OR
  EXISTS(SELECT 1 FROM member) OR
  EXISTS(SELECT 1 FROM session)
) AS present`;

export const BETTER_AUTH_OWNER_SETUP_AUTHORITY_SQL = `SELECT CASE WHEN
  (
    ? = 1 AND
    NOT EXISTS(SELECT 1 FROM "user") AND
    NOT EXISTS(SELECT 1 FROM account) AND
    NOT EXISTS(SELECT 1 FROM organization) AND
    NOT EXISTS(SELECT 1 FROM member) AND
    NOT EXISTS(SELECT 1 FROM session) AND
    NOT EXISTS(SELECT 1 FROM invitation) AND
    NOT EXISTS(SELECT 1 FROM verification)
  ) OR (
    ? BETWEEN 0 AND 2 AND
    (SELECT COUNT(*) FROM "user") = 1 AND
    EXISTS(
      SELECT 1 FROM "user" AS u
      WHERE lower(u.email) = lower(?)
        AND (? IS NULL OR u.id = ?)
        AND CASE
          WHEN typeof(u.createdAt) IN ('integer', 'real') THEN CAST(u.createdAt AS INTEGER)
          ELSE CAST(unixepoch(u.createdAt, 'subsec') * 1000 AS INTEGER)
        END >= ?
    ) AND
    (SELECT COUNT(*) FROM account) = 1 AND
    EXISTS(
      SELECT 1 FROM account AS a
      JOIN "user" AS u ON u.id = a.userId
      WHERE a.providerId = 'credential'
        AND a.accountId = u.id
        AND a.password IS NOT NULL
        AND a.accessToken IS NULL
        AND a.refreshToken IS NULL
        AND a.idToken IS NULL
        AND a.scope IS NULL
    ) AND
    NOT EXISTS(SELECT 1 FROM invitation) AND
    NOT EXISTS(SELECT 1 FROM verification) AND
    NOT EXISTS(
      SELECT 1 FROM session AS s
      WHERE s.userId <> (SELECT id FROM "user" LIMIT 1)
    ) AND
    (? = 1 OR NOT EXISTS(SELECT 1 FROM session)) AND
    (
      (? = 0 AND
        NOT EXISTS(SELECT 1 FROM organization) AND
        NOT EXISTS(SELECT 1 FROM member)
      ) OR
      (? = 1 AND (
        (
          NOT EXISTS(SELECT 1 FROM organization) AND
          NOT EXISTS(SELECT 1 FROM member)
        ) OR (
          (SELECT COUNT(*) FROM organization) = 1 AND
          (SELECT COUNT(*) FROM member) = 1 AND
          EXISTS(
            SELECT 1 FROM member AS m
            JOIN organization AS o ON o.id = m.organizationId
            JOIN "user" AS u ON u.id = m.userId
            WHERE m.role = 'owner'
              AND o.name = 'Chickpea'
              AND o.slug = 'chickpea'
          )
        )
      )) OR
      (? = 2 AND
        (SELECT COUNT(*) FROM organization) = 1 AND
        (SELECT COUNT(*) FROM member) = 1 AND
        EXISTS(
          SELECT 1 FROM member AS m
          JOIN organization AS o ON o.id = m.organizationId
          JOIN "user" AS u ON u.id = m.userId
          WHERE (? IS NULL OR o.id = ?)
            AND (? IS NULL OR m.id = ?)
            AND m.role = 'owner'
            AND o.name = 'Chickpea'
            AND o.slug = 'chickpea'
        )
      )
    )
  ) THEN 1 ELSE 0 END AS matches`;

export interface BetterAuthOwnerSetupAuthorityExpectation {
  expectedEmail: string;
  operationCreatedAt: number;
  step: 0 | 1 | 2;
  betterAuthUserId: string | null;
  betterAuthOrganizationId: string | null;
  betterAuthMembershipId: string | null;
}

export function betterAuthOwnerSetupAuthorityBindings(
  input: BetterAuthOwnerSetupAuthorityExpectation,
): Array<string | number | null> {
  const emptyAllowed = input.step === 0 && input.betterAuthUserId === null &&
    input.betterAuthOrganizationId === null && input.betterAuthMembershipId === null;
  return [
    emptyAllowed ? 1 : 0,
    input.step,
    input.expectedEmail,
    input.betterAuthUserId,
    input.betterAuthUserId,
    input.operationCreatedAt,
    input.step === 2 ? 1 : 0,
    input.step,
    input.step,
    input.step,
    input.betterAuthOrganizationId,
    input.betterAuthOrganizationId,
    input.betterAuthMembershipId,
    input.betterAuthMembershipId,
  ];
}

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
  /** True when Better Auth contains any identity, credential, membership, or session authority. */
  hasIdentityAuthority(): Promise<boolean>;
  /** Proves the entire Better Auth authority is exactly one staged owner-setup operation. */
  matchesOwnerSetupAuthority(input: BetterAuthOwnerSetupAuthorityExpectation): Promise<boolean>;
  absoluteExpiryForToken(token: string): Promise<Date | null>;
  /** Revoke every Better Auth browser session for one canonical user. */
  deleteSessionsForUser(userId: string): Promise<number>;
  hasPasswordCredential(email: string): Promise<boolean>;
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
}
