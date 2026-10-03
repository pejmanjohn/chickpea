import type { BetterAuthOptions } from 'better-auth';

import { validInstallationIdentityId } from '../config/installation-scope.ts';

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

/**
 * Rows removed by erasing one installation's Better Auth organization. A
 * former member whose login another organization still holds (the same
 * person in a reinstalled workspace) keeps it whole and is counted in
 * `usersKept`; the rest of that person's rows are counted with their login.
 */
export interface BetterAuthOrganizationErasure {
  organizations: number;
  members: number;
  invitations: number;
  users: number;
  usersKept: number;
  sessions: number;
  accounts: number;
  oauthAccessTokens: number;
  oauthRefreshTokens: number;
  oauthConsents: number;
  oauthClients: number;
}

/**
 * The erasure on SQLite (Node and D1), run in order in one transaction with
 * the organization's slug bound as `?1`: first a count of every row it
 * removes (D1 reports cascaded rows among a statement's changes, so the
 * counts are read, not taken from the deletes), then one statement per
 * step. A former member is erasable while no membership of another
 * organization holds their login; the login goes before the organization's
 * memberships, which are what identify its former members.
 */
const SQLITE_ORGANIZATION = '(SELECT id FROM organization WHERE slug = ?1)';
const SQLITE_ERASABLE_USERS = `SELECT m.userId FROM member AS m
  WHERE m.organizationId = ${SQLITE_ORGANIZATION}
    AND NOT EXISTS (SELECT 1 FROM member AS o WHERE o.userId = m.userId AND o.organizationId <> m.organizationId)`;
const SQLITE_ERASED_INVITATIONS = `organizationId = ${SQLITE_ORGANIZATION} OR inviterId IN (${SQLITE_ERASABLE_USERS})`;
const ofErasableUsers = (table: string) => `(SELECT count(*) FROM ${table} WHERE userId IN (${SQLITE_ERASABLE_USERS}))`;
export const SQLITE_ORGANIZATION_ERASURE = {
  count: `SELECT
    (SELECT count(*) FROM organization WHERE slug = ?1) AS organizations,
    (SELECT count(*) FROM member WHERE organizationId = ${SQLITE_ORGANIZATION}) AS members,
    (SELECT count(*) FROM invitation WHERE ${SQLITE_ERASED_INVITATIONS}) AS invitations,
    (SELECT count(*) FROM (${SQLITE_ERASABLE_USERS})) AS users,
    (SELECT count(DISTINCT userId) FROM member WHERE organizationId = ${SQLITE_ORGANIZATION}) AS formerMembers,
    ${ofErasableUsers('session')} AS sessions,
    ${ofErasableUsers('account')} AS accounts,
    ${ofErasableUsers('oauthAccessToken')} AS oauthAccessTokens,
    ${ofErasableUsers('oauthRefreshToken')} AS oauthRefreshTokens,
    ${ofErasableUsers('oauthConsent')} AS oauthConsents,
    ${ofErasableUsers('oauthClient')} AS oauthClients`,
  steps: [
    `DELETE FROM oauthAccessToken WHERE userId IN (${SQLITE_ERASABLE_USERS})`,
    `DELETE FROM oauthRefreshToken WHERE userId IN (${SQLITE_ERASABLE_USERS})`,
    `DELETE FROM oauthConsent WHERE userId IN (${SQLITE_ERASABLE_USERS})`,
    `DELETE FROM session WHERE userId IN (${SQLITE_ERASABLE_USERS})`,
    `DELETE FROM account WHERE userId IN (${SQLITE_ERASABLE_USERS})`,
    `DELETE FROM oauthClient WHERE userId IN (${SQLITE_ERASABLE_USERS})`,
    `DELETE FROM invitation WHERE ${SQLITE_ERASED_INVITATIONS}`,
    `DELETE FROM "user" WHERE id IN (${SQLITE_ERASABLE_USERS})`,
    `DELETE FROM member WHERE organizationId = ${SQLITE_ORGANIZATION}`,
    'DELETE FROM organization WHERE slug = ?1',
  ],
} as const;

/** The erasure's counts, from SQLite's count row. */
export function sqliteOrganizationErasure(counts: Record<string, unknown> | undefined): BetterAuthOrganizationErasure {
  const count = (field: string) => Number(counts?.[field] ?? 0);
  return {
    organizations: count('organizations'),
    members: count('members'),
    invitations: count('invitations'),
    users: count('users'),
    usersKept: count('formerMembers') - count('users'),
    sessions: count('sessions'),
    accounts: count('accounts'),
    oauthAccessTokens: count('oauthAccessTokens'),
    oauthRefreshTokens: count('oauthRefreshTokens'),
    oauthConsents: count('oauthConsents'),
    oauthClients: count('oauthClients'),
  };
}

/** A hosted installation's Better Auth organization slug (`chickpea-<organizationId>`). */
export function hostedBetterAuthOrganizationSlug(organizationId: string): string {
  return `chickpea-${validInstallationIdentityId(organizationId, 'organization')}`;
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
  /**
   * Better Auth reads a row with the rows it joins (a session with its user)
   * in one statement. Only PostgreSQL's backend sets it: each of its
   * statements is a network round trip. The SQLite backends read joined rows
   * one by one, as before.
   */
  readonly nativeJoins?: true;
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
  /**
   * Erase one installation's organization, by its unique slug, in one
   * transaction: its memberships and invitations, and each former member's
   * login (with its sessions, accounts, OAuth tokens, consents and the
   * clients it owns) that no other organization's membership still holds.
   * Safe to repeat.
   */
  eraseOrganization(slug: string): Promise<BetterAuthOrganizationErasure>;
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

/**
 * Ends the MCP OAuth grants and browser sessions of every member of one
 * Better Auth organization: an installation's, when Slack uninstalls it or
 * the host deletes it. Sessions name no organization, so each member's are
 * all ended; a member is one Slack account in that installation's workspace,
 * so no other workspace's people are touched. Safe to repeat: a retry after a
 * failure revokes what is left.
 */
export async function revokeOrganizationAccess(
  backend: BetterAuthAccessRevoker & Pick<BetterAuthDatabaseBackend, 'listMemberships'>,
  organizationId: string,
): Promise<{ members: number }> {
  const members = await backend.listMemberships(organizationId);
  for (const userId of new Set(members.map((member) => member.userId))) {
    await revokeBetterAuthUserAccess(backend, userId);
  }
  return { members: members.length };
}

/**
 * Erase a hosted installation's Better Auth rows, the step of an
 * installation's deletion after its objects are erased. The slug comes
 * from the host's own organization ID, so it is known after the
 * installation's state store is gone. Sessions and grants were already
 * ended by `revokeOrganizationAccess` when access was revoked; a person
 * whose login another installation's organization holds keeps it.
 */
export async function eraseInstallationBetterAuthOrganization(
  backend: Pick<BetterAuthDatabaseBackend, 'eraseOrganization'>,
  input: { organizationId: string },
): Promise<BetterAuthOrganizationErasure> {
  return backend.eraseOrganization(hostedBetterAuthOrganizationSlug(input.organizationId));
}
