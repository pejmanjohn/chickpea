import { randomBytes as nodeRandomBytes } from 'node:crypto';

import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import { AuthorizationError, requirePermission, type Permission } from '../auth/permissions.ts';
import { invalidRequest as invalid, readJson } from './api-support.ts';
import { digest } from '../auth/personal-token.ts';
import { AuthRateLimitError, type AuthRateLimiter } from '../auth/rate-limit.ts';
import { requestAuthSourceKey } from '../auth/source-key.ts';
import { requestPrincipal } from '../auth/service.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import { IdentityStateError } from '../identity/errors.ts';
import type { IdentityStore, Invitation } from '../identity/types.ts';
import {
  slackDirectoryUserInfo,
  slackDirectoryUsersList,
  type SlackDirectoryMember,
  type SlackDirectoryUserInfoResult,
  type SlackDirectoryUsersPage,
} from '../slack/credentials.ts';
import type { ResolvedSlackIdentityCredentials } from '../slack/identity-credentials.ts';
import { classifySlackUserForAdmission } from '../slack/user-classification.ts';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_TEAM_BODY_BYTES = 2_048;
const slackIdSchema = v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9]{1,63}$/));
const opaqueId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,200}$/));
const inviteSchema = v.strictObject({ slackUserId: slackIdSchema });
const membershipPatchSchema = v.pipe(
  v.strictObject({
    role: v.optional(v.picklist(['owner', 'admin'])),
    status: v.optional(v.picklist(['active', 'suspended', 'removed'])),
  }),
  v.check((body) => body.role !== undefined || body.status !== undefined),
);

interface TeamAdminApiOptions {
  store: (c: Context) => IdentityStore;
  resolveCredentials?: (c: Context) => Promise<ResolvedSlackIdentityCredentials>;
  usersList?: (
    botToken: string,
    options?: { cursor?: string; limit?: number; timeoutMs?: number },
  ) => Promise<SlackDirectoryUsersPage>;
  usersInfo?: (botToken: string, userId: string) => Promise<SlackDirectoryUserInfoResult>;
  revokeBetterAuthSessions?: (c: Context, betterAuthUserId: string) => Promise<number>;
  rateLimiter?: (c: Context) => Promise<AuthRateLimiter | undefined>;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

export function createTeamAdminApi(options: TeamAdminApiOptions): Hono {
  const app = new Hono();
  // requiredPrincipal() runs before each handler's own try/catch, so in legacy
  // token mode (no request principal) its AuthorizationError would otherwise
  // escape to Hono as an uncaught 500. Route every uncaught handler error
  // through the same teamError mapper the handlers use, so a missing principal
  // is a sanitized 403 and genuine faults stay 500.
  app.onError((error, c) => teamError(c, error));
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? ((length: number) => nodeRandomBytes(length));
  const usersList = options.usersList ?? slackDirectoryUsersList;
  const usersInfo = options.usersInfo ?? slackDirectoryUserInfo;

  app.use('*', async (c, next) => {
    const limiter = await options.rateLimiter?.(c);
    if (!limiter) return next();
    const source = requestAuthSourceKey(c.req.raw);
    const operation = `${c.req.method}:${c.req.path}:${c.req.query('cursor') ?? ''}`.slice(0, 768);
    await Promise.all([
      limiter.assertAllowed('team_api_source', source),
      limiter.assertAllowed('team_api_operation', operation),
      limiter.assertAllowed('team_api_deployment', 'deployment'),
    ]);
    try {
      await next();
      const record = c.res.status >= 400 ? limiter.recordFailure.bind(limiter) : limiter.recordSuccess.bind(limiter);
      await Promise.all([
        record('team_api_source', source),
        record('team_api_operation', operation),
        record('team_api_deployment', 'deployment'),
      ]);
    } catch (error) {
      await Promise.all([
        limiter.recordFailure('team_api_source', source),
        limiter.recordFailure('team_api_operation', operation),
        limiter.recordFailure('team_api_deployment', 'deployment'),
      ]);
      throw error;
    }
  });

  app.get('/account', async (c) => {
    const principal = requiredPrincipal(c, 'account.view');
    const [organization, resolution] = await Promise.all([
      options.store(c).getOrganization(),
      canonicalResolution(options.store(c), principal),
    ]);
    if (!organization || !resolution) return c.json({ error: 'account_unavailable' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json({
      organization: { id: organization.id, displayName: organization.displayName },
      account: {
        userId: resolution.user.id,
        displayName: resolution.user.displayName,
        membershipId: resolution.membership.id,
        role: resolution.membership.role,
        status: resolution.membership.status,
        slackTeamId: resolution.binding.slackTeamId,
        slackUserId: resolution.binding.slackUserId,
      },
      slackHandoff: { label: 'Open Slack', href: 'slack://open' },
    });
  });

  app.get('/team', async (c) => {
    const principal = requiredPrincipal(c, 'team.view');
    c.header('Cache-Control', 'no-store');
    return c.json(await teamSnapshot(options.store(c), principal));
  });

  app.get('/team/directory', async (c) => {
    requiredPrincipal(c, 'team.view');
    const cursor = c.req.query('cursor');
    if (cursor !== undefined && (cursor.length > 512 || /[\r\n]/.test(cursor))) return invalid(c);
    const context = await directoryContext(options, c);
    if ('response' in context) return context.response;
    let page: SlackDirectoryUsersPage;
    try {
      page = await usersList(context.botToken, {
        ...(cursor ? { cursor } : {}), limit: 200, timeoutMs: 10_000,
      });
    } catch {
      return slackDirectoryFailure(c, undefined);
    }
    if (!page.ok) return slackDirectoryFailure(c, page.retryAfterMs);
    const unavailableIds = await unavailableSlackUserIds(options.store(c));
    const members = page.members
      .filter((member) => eligibleMember(member, context.teamId, context.botUserId))
      .filter((member) => !unavailableIds.has(member.id))
      .map(safeDirectoryMember);
    c.header('Cache-Control', 'no-store');
    return c.json({ members, nextCursor: page.nextCursor ?? null });
  });

  app.get('/team/directory/:slackUserId', async (c) => {
    requiredPrincipal(c, 'team.view');
    const parsed = v.safeParse(slackIdSchema, c.req.param('slackUserId'));
    if (!parsed.success) return invalid(c);
    const context = await directoryContext(options, c);
    if ('response' in context) return context.response;
    let result: SlackDirectoryUserInfoResult;
    try {
      result = await usersInfo(context.botToken, parsed.output);
    } catch {
      return slackDirectoryFailure(c, undefined);
    }
    if (!result.ok) return slackDirectoryFailure(c, result.retryAfterMs);
    if (!result.member || !eligibleMember(result.member, context.teamId, context.botUserId)) {
      return c.json({ error: 'member_unavailable' }, 404);
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ member: safeDirectoryMember(result.member) });
  });

  app.post('/team/invitations', async (c) => {
    const principal = requiredPrincipal(c, 'team.invite');
    const parsed = v.safeParse(inviteSchema, await readJson(c, MAX_TEAM_BODY_BYTES));
    if (!parsed.success) return invalid(c);
    try {
      const context = await directoryContext(options, c);
      if ('response' in context) return context.response;
      let lookup: SlackDirectoryUserInfoResult;
      try {
        lookup = await usersInfo(context.botToken, parsed.output.slackUserId);
      } catch {
        return slackDirectoryFailure(c, undefined);
      }
      if (!lookup.ok) return slackDirectoryFailure(c, lookup.retryAfterMs);
      if (!lookup.member || !eligibleMember(lookup.member, context.teamId, context.botUserId)) {
        return c.json({ error: 'member_unavailable' }, 404);
      }
      const identity = options.store(c);
      const existing = (await identity.listInvitations()).find((invitation) =>
        invitation.status === 'pending' && invitation.slackTeamId === context.teamId &&
        invitation.slackUserId === lookup.member!.id);
      if (existing) return c.json({ invitation: safeInvitation(existing), inviteLink: null });
      const secret = Buffer.from(randomBytes(32)).toString('base64url');
      const invitation = await identity.createInvitation({
        organizationId: principal.organizationId,
        slackTeamId: context.teamId,
        slackUserId: lookup.member.id,
        displayName: lookup.member.displayName,
        role: 'admin',
        locatorHash: digest(secret),
        inviterMembershipId: principal.membershipId,
        expiresAt: now() + INVITATION_TTL_MS,
      });
      await identity.recordAuthAudit({
        event: 'authorization', outcome: 'success', action: 'team.invitation.create',
        correlationId: principal.correlationId, authenticatorKind: principal.authenticatorKind,
        userId: principal.userId, membershipId: principal.membershipId,
        reasonCode: 'slack_identity_verified',
      });
      return c.json({
        invitation: safeInvitation(invitation),
        inviteLink: `${await canonicalOrigin(c, identity)}/auth/slack/invite#invite=${encodeURIComponent(secret)}`,
      }, 201);
    } catch (error) {
      return teamError(c, error);
    }
  });

  app.delete('/team/invitations/:invitationId', async (c) => {
    const principal = requiredPrincipal(c, 'team.invite');
    const invitationId = parseId(c.req.param('invitationId'));
    if (!invitationId) return invalid(c);
    try {
      const identity = options.store(c);
      const existing = (await identity.listInvitations()).find((row) => row.id === invitationId);
      if (!existing || existing.organizationId !== principal.organizationId) {
        return c.json({ error: 'invitation_unavailable' }, 404);
      }
      const invitation = await identity.revokeInvitation(invitationId);
      await identity.recordAuthAudit({
        event: 'authorization', outcome: 'success', action: 'team.invitation.revoke',
        correlationId: principal.correlationId, authenticatorKind: principal.authenticatorKind,
        userId: principal.userId, membershipId: principal.membershipId,
        reasonCode: 'owner_revoked_invitation',
      });
      return c.json({ invitation: safeInvitation(invitation) });
    } catch (error) {
      return teamError(c, error);
    }
  });

  app.patch('/team/memberships/:membershipId', async (c) => {
    const principal = requiredPrincipal(c, 'team.manage_members');
    const membershipId = parseId(c.req.param('membershipId'));
    const parsed = v.safeParse(membershipPatchSchema, await readJson(c, MAX_TEAM_BODY_BYTES));
    if (!membershipId || !parsed.success) return invalid(c);
    try {
      if (parsed.output.role === 'owner') requirePermission(principal, 'team.manage_owners');
      const identity = options.store(c);
      const target = await identity.getMembership(membershipId);
      if (!target || target.organizationId !== principal.organizationId) {
        return c.json({ error: 'membership_unavailable' }, 404);
      }
      const binding = (await identity.listExternalIdentities()).find((row) => row.membershipId === target.id);
      if (!binding) return c.json({ error: 'membership_unavailable' }, 404);
      const result = await identity.updateMembershipAuthority({
        membershipId,
        ...(parsed.output.role === undefined ? {} : { role: parsed.output.role }),
        ...(parsed.output.status === undefined ? {} : { status: parsed.output.status }),
        actorMembershipId: principal.membershipId,
        authenticationSurface: 'better_auth',
        correlationId: principal.correlationId,
        reasonCode: parsed.output.role === 'owner'
          ? 'owner_promoted_member'
          : parsed.output.status === 'removed'
            ? 'owner_removed_member'
            : parsed.output.status === 'suspended'
              ? 'owner_suspended_member'
              : 'owner_updated_member',
        slackTeamId: binding.slackTeamId,
        slackUserId: binding.slackUserId,
      });
      if (result.changed) await options.revokeBetterAuthSessions?.(c, binding.betterAuthUserId);
      return c.json({ membership: result.membership });
    } catch (error) {
      return teamError(c, error);
    }
  });

  app.onError((error, c) => teamError(c, error));

  return app;
}

function requiredPrincipal(c: Context, permission: Permission): AuthPrincipal {
  const principal = requestPrincipal(c.req.raw);
  requirePermission(principal, permission);
  return principal!;
}

async function canonicalResolution(identity: IdentityStore, principal: AuthPrincipal) {
  const binding = (await identity.listExternalIdentities()).find((row) =>
    row.userId === principal.userId && row.membershipId === principal.membershipId);
  return binding
    ? identity.resolveSlackIdentity(binding.slackTeamId, binding.slackUserId, principal.organizationId)
    : undefined;
}

async function teamSnapshot(identity: IdentityStore, principal: AuthPrincipal) {
  const [organization, memberships, bindings, invitations] = await Promise.all([
    identity.getOrganization(), identity.listMemberships(), identity.listExternalIdentities(),
    identity.listInvitations(),
  ]);
  const users = await Promise.all(memberships.map((membership) => identity.getUser(membership.userId)));
  const usersById = new Map(users.filter(Boolean).map((user) => [user!.id, user!]));
  const bindingsByMembership = new Map(bindings.map((binding) => [binding.membershipId, binding]));
  const activeOwners = memberships.filter((membership) =>
    membership.role === 'owner' && membership.status === 'active').length;
  return {
    organization: organization
      ? { id: organization.id, displayName: organization.displayName, slackTeamId: organization.slackTeamId }
      : null,
    viewer: { userId: principal.userId, membershipId: principal.membershipId, role: principal.role },
    soleOwnerWarning: activeOwners === 1,
    members: memberships.map((membership) => {
      const binding = bindingsByMembership.get(membership.id);
      const user = usersById.get(membership.userId);
      return {
        id: membership.id, userId: membership.userId,
        displayName: user?.displayName ?? null,
        slackTeamId: binding?.slackTeamId ?? null,
        slackUserId: binding?.slackUserId ?? null,
        role: membership.role, status: membership.status,
      };
    }),
    invitations: invitations.filter((invitation) => invitation.status === 'pending').map(safeInvitation),
  };
}

async function directoryContext(options: TeamAdminApiOptions, c: Context): Promise<
  { teamId: string; botToken: string; botUserId: string } | { response: Response }
> {
  let organization;
  let credentials;
  try {
    [organization, credentials] = await Promise.all([
      options.store(c).getOrganization(), options.resolveCredentials?.(c),
    ]);
  } catch {
    return { response: Response.json({ error: 'slack_directory_unavailable' }, { status: 503 }) };
  }
  if (!organization?.slackTeamId || !credentials?.botToken || !credentials.botUserId) {
    return { response: Response.json({ error: 'slack_directory_unavailable' }, { status: 409 }) };
  }
  return { teamId: organization.slackTeamId, botToken: credentials.botToken, botUserId: credentials.botUserId };
}

async function unavailableSlackUserIds(identity: IdentityStore): Promise<Set<string>> {
  const [bindings, memberships, invitations] = await Promise.all([
    identity.listExternalIdentities(), identity.listMemberships(), identity.listInvitations(),
  ]);
  const membershipStatus = new Map(memberships.map((membership) => [membership.id, membership.status]));
  return new Set([
    ...bindings
      .filter((binding) => membershipStatus.get(binding.membershipId) !== 'removed')
      .map((binding) => binding.slackUserId),
    ...invitations.filter((invitation) => invitation.status === 'pending').map((invitation) => invitation.slackUserId),
  ]);
}

function eligibleMember(member: SlackDirectoryMember, teamId: string, botUserId: string): boolean {
  return classifySlackUserForAdmission(member, teamId, botUserId) === 'eligible_human';
}

function safeDirectoryMember(member: SlackDirectoryMember) {
  return {
    slackUserId: member.id,
    displayName: member.displayName,
    realName: member.realName,
    handle: member.handle,
    avatarUrl: safeAvatarUrl(member.avatarUrl),
  };
}

function safeAvatarUrl(value: string | undefined): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeInvitation(invitation: Invitation) {
  return {
    id: invitation.id,
    slackTeamId: invitation.slackTeamId,
    slackUserId: invitation.slackUserId,
    displayName: invitation.displayName,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
  };
}

function parseId(value: string): string | undefined {
  const parsed = v.safeParse(opaqueId, value);
  return parsed.success ? parsed.output : undefined;
}

async function canonicalOrigin(c: Context, identity: IdentityStore): Promise<string> {
  const organization = await identity.getOrganization();
  const configured = organization?.canonicalAdminOrigin;
  return configured && new URL(configured).protocol === 'https:'
    ? configured
    : new URL(c.req.url).origin;
}

function slackDirectoryFailure(c: Context, retryAfterMs: number | undefined) {
  if (retryAfterMs !== undefined) {
    c.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
    return c.json({ error: 'slack_rate_limited' }, 429);
  }
  return c.json({ error: 'slack_directory_unavailable' }, 502);
}

function teamError(c: Context, error: unknown) {
  if (error instanceof AuthRateLimitError) {
    c.header('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))));
    return c.json({ error: 'rate_limited' }, 429);
  }
  if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
  if (error instanceof IdentityStateError) {
    if (['invitation_missing', 'membership_missing'].includes(error.code)) {
      return c.json({ error: 'resource_unavailable' }, 404);
    }
    if (['last_owner_required', 'invitation_not_pending', 'external_identity_conflict'].includes(error.code)) {
      return c.json({ error: error.code }, 409);
    }
    if (error.code === 'inviter_not_authorized') return c.json({ error: 'forbidden' }, 403);
    return c.json({ error: 'invalid_request' }, 400);
  }
  console.error('[chickpea] team API failure:', error instanceof Error ? error.message : String(error));
  return c.json({ error: 'internal_error' }, 500);
}
