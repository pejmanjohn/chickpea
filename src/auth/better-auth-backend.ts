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

/** One MCP client a person signed in with, read from their consents and tokens; never a token value. */
export interface BetterAuthMcpOAuthClient {
  clientId: string;
  /** The name the client registered with. */
  name: string | null;
  connectedAt: Date;
  /** When it last received a token: at sign-in, then each renewal. */
  lastTokenAt: Date | null;
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

const SQLITE_PENDING_MCP_CLIENTS = `pending AS (
  SELECT c.clientId, c.createdAt FROM oauthClient AS c
  WHERE (c.tokenEndpointAuthMethod = 'none' OR c.clientDiscoveryId IS NOT NULL) AND c.userId IS NULL
    AND NOT EXISTS (SELECT 1 FROM oauthConsent AS t WHERE t.clientId = c.clientId)
    AND NOT EXISTS (SELECT 1 FROM oauthAccessToken AS t WHERE t.clientId = c.clientId)
    AND NOT EXISTS (SELECT 1 FROM oauthRefreshToken AS t WHERE t.clientId = c.clientId)
)`;
export const SQLITE_PENDING_MCP_CLIENT_PRUNE = {
  delete: `WITH ${SQLITE_PENDING_MCP_CLIENTS}
DELETE FROM oauthClient WHERE clientId IN (
  SELECT clientId FROM pending
  WHERE createdAt < ?1
     OR (createdAt < ?2 AND clientId NOT IN (
       SELECT clientId FROM pending ORDER BY createdAt DESC, clientId DESC LIMIT ?3
     ))
)`,
  count: `WITH ${SQLITE_PENDING_MCP_CLIENTS} SELECT count(*) AS count FROM pending`,
} as const;

/** One person's consents and tokens, a row each, with the client they belong to; bind the user ID as ?1. */
export const SQLITE_MCP_OAUTH_CLIENT_GRANTS = `SELECT g.clientId AS clientId, c.name AS name, g.kind AS kind, g.createdAt AS createdAt
FROM (
  SELECT clientId, 'consent' AS kind, createdAt FROM oauthConsent WHERE userId = ?1
  UNION ALL SELECT clientId, 'token' AS kind, createdAt FROM oauthRefreshToken WHERE userId = ?1
  UNION ALL SELECT clientId, 'token' AS kind, createdAt FROM oauthAccessToken WHERE userId = ?1
) AS g JOIN oauthClient AS c ON c.clientId = g.clientId`;

/**
 * One entry per client: connected at its first consent (or first token when
 * none survives), last given a token at its newest one. Most recent first.
 */
export function mcpOAuthClientsFromGrants(rows: readonly unknown[]): BetterAuthMcpOAuthClient[] {
  const clients = new Map<string, { name: string | null; consents: Date[]; tokens: Date[] }>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { clientId, name, kind, createdAt } = row as Record<string, unknown>;
    const at = parseBetterAuthDate(createdAt);
    if (typeof clientId !== 'string' || !at) continue;
    const client = clients.get(clientId) ??
      { name: typeof name === 'string' ? name : null, consents: [], tokens: [] };
    (kind === 'consent' ? client.consents : client.tokens).push(at);
    clients.set(clientId, client);
  }
  const earliest = (dates: Date[]) => dates.reduce((a, b) => a <= b ? a : b);
  const latest = (dates: Date[]) => dates.reduce((a, b) => a >= b ? a : b);
  return [...clients].map(([clientId, { name, consents, tokens }]) => ({
    clientId,
    name,
    connectedAt: earliest(consents.length ? consents : tokens),
    lastTokenAt: tokens.length ? latest(tokens) : null,
  })).sort((left, right) =>
    (right.lastTokenAt ?? right.connectedAt).getTime() - (left.lastTokenAt ?? left.connectedAt).getTime());
}

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

export interface PendingMcpOAuthClientPrune {
  expiredBefore: Date;
  evictableBefore: Date;
  keep: number;
}

/** A per-source limit on new MCP clients: a response refusing the request, or undefined. */
export type McpRegistrationThrottle = (request: Request) => Promise<Response | undefined>;

/** How many MCP clients no one has consented to may wait, and for how long. */
export interface McpRegistrationPolicy {
  maxPendingClients: number;
  pendingClientRetentionMs: number;
  consentWindowMs: number;
  now: () => number;
}

export const DEFAULT_MCP_REGISTRATION_POLICY: McpRegistrationPolicy = {
  maxPendingClients: 1_000,
  pendingClientRetentionMs: 30 * 24 * 60 * 60_000,
  // Outlasts the 10-minute sign-in continuation and authorization code, and
  // holds a full cap no longer than the durable limiter's 15-minute window.
  consentWindowMs: 15 * 60_000,
  now: () => Date.now(),
};

/**
 * Prunes the pending MCP clients `policy` lets go, then answers whether one
 * more may be stored: a dynamic registration, or the first sign-in of a client
 * known by its metadata document.
 */
export async function admitPendingMcpOAuthClient(
  backend: Pick<BetterAuthDatabaseBackend, 'prunePendingMcpOAuthClients'>,
  policy: McpRegistrationPolicy,
): Promise<boolean> {
  const at = policy.now();
  const pending = await backend.prunePendingMcpOAuthClients({
    expiredBefore: new Date(at - policy.pendingClientRetentionMs),
    evictableBefore: new Date(at - policy.consentWindowMs),
    keep: Math.max(0, policy.maxPendingClients - 1),
  });
  return pending < policy.maxPendingClients;
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
  /** The MCP clients one canonical user holds a consent or token for. */
  listOAuthClientsForUser(userId: string): Promise<BetterAuthMcpOAuthClient[]>;
  /**
   * Remove one user's consent and tokens for one client together. The client's
   * registration and anyone else's grants stay; an access token already issued
   * as a JWT works until it expires.
   */
  revokeOAuthClientForUser(userId: string, clientId: string): Promise<BetterAuthOAuthGrantRevocation>;
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
  /**
   * Deletes the ownerless MCP clients that no one has consented to, public
   * registrations and every client known by its metadata document alike:
   * every one registered before `expiredBefore`, then the oldest registered
   * before `evictableBefore` until `keep` remain. A client with a consent or
   * token is in use and stays. Answers how many such clients remain. The cap
   * is approximate under a concurrent burst: overlapping callers each count
   * before the others register, so more than `keep` can briefly remain, and
   * refusal applies once a caller sees the count at the cap.
   */
  prunePendingMcpOAuthClients(prune: PendingMcpOAuthClientPrune): Promise<number>;
  putMcpOAuthContinuation(record: BetterAuthMcpOAuthContinuationRecord): Promise<void>;
  consumeMcpOAuthContinuation(idHash: string, now: number): Promise<string | null>;
}

export type BetterAuthAccessRevoker =
  Pick<BetterAuthDatabaseBackend, 'deleteSessionsForUser' | 'revokeOAuthGrantsForUser'>;

export type BetterAuthMcpOAuthClients =
  Pick<BetterAuthDatabaseBackend, 'listOAuthClientsForUser' | 'revokeOAuthClientForUser'>;

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
