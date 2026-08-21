import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import { AuthorizationError, requirePermission, type Permission } from '../auth/permissions.ts';
import { invalidRequest as invalid, readJson } from './api-support.ts';
import { AuthRateLimitError, type AuthRateLimiter } from '../auth/rate-limit.ts';
import { requestAuthSourceKey } from '../auth/source-key.ts';
import { requestPrincipal } from '../auth/service.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import { IdentityStateError } from '../identity/errors.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { WorkspaceManagementService } from '../management/service.ts';
import { ManagementError, type ManagementActorContext } from '../management/types.ts';

const MAX_TEAM_BODY_BYTES = 2_048;
const opaqueId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,200}$/));
const membershipPatchSchema = v.pipe(
  v.strictObject({
    role: v.optional(v.picklist(['owner', 'admin', 'member'])),
    status: v.optional(v.picklist(['active', 'suspended', 'removed'])),
  }),
  v.check((body) => body.role !== undefined || body.status !== undefined),
);

interface TeamAdminApiOptions {
  store: (c: Context) => IdentityStore;
  revokeBetterAuthSessions?: (c: Context, betterAuthUserId: string) => Promise<number>;
  management?: (c: Context) => WorkspaceManagementService;
  rateLimiter?: (c: Context) => Promise<AuthRateLimiter | undefined>;
}

export function createTeamAdminApi(options: TeamAdminApiOptions): Hono {
  const app = new Hono();
  // requiredPrincipal() runs before each handler's own try/catch, so in legacy
  // token mode (no request principal) its AuthorizationError would otherwise
  // escape to Hono as an uncaught 500. Route every uncaught handler error
  // through the same teamError mapper the handlers use, so a missing principal
  // is a sanitized 403 and genuine faults stay 500.
  app.onError((error, c) => teamError(c, error));
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
      if (options.management) {
        const service = options.management(c);
        const proposed = await service.applyWorkspaceChanges({
          context: managementContext(principal),
          idempotencyKey: `admin:membership:update:${principal.correlationId}:${membershipId}`,
          operations: [{
            itemId: 'membership',
            kind: 'update_member',
            membershipId,
            ...(parsed.output.role === undefined ? {} : { role: parsed.output.role }),
            ...(parsed.output.status === undefined ? {} : { status: parsed.output.status }),
          }],
        });
        const proposalId = proposed.outcomes[0]?.proposalId;
        if (!proposalId) return managementFailure(c, proposed.outcomes[0]?.code);
        await service.confirmWorkspaceChange({
          context: managementContext(principal),
          proposalId,
        });
        const membership = await identity.getMembership(membershipId);
        if (!membership) return c.json({ error: 'membership_unavailable' }, 404);
        if (membership.role !== target.role || membership.status !== target.status) {
          if (binding.betterAuthUserId) {
            await options.revokeBetterAuthSessions?.(c, binding.betterAuthUserId);
          }
        }
        return c.json({ membership });
      }
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
      if (result.changed && binding.betterAuthUserId) {
        await options.revokeBetterAuthSessions?.(c, binding.betterAuthUserId);
      }
      return c.json({ membership: result.membership });
    } catch (error) {
      return teamError(c, error);
    }
  });

  return app;
}

function requiredPrincipal(c: Context, permission: Permission): AuthPrincipal {
  const principal = requestPrincipal(c.req.raw);
  requirePermission(principal, permission);
  return principal!;
}

function managementContext(principal: AuthPrincipal): ManagementActorContext {
  return {
    userId: principal.userId,
    membershipId: principal.membershipId,
    organizationId: principal.organizationId,
    origin: { kind: 'admin', sessionId: principal.correlationId },
  };
}

function managementFailure(c: Context, code?: string): Response {
  if (code === 'owner_required' || code === 'forbidden') {
    return c.json({ error: 'forbidden' }, 403);
  }
  return c.json({ error: code ?? 'management_unavailable' }, 409);
}

async function canonicalResolution(identity: IdentityStore, principal: AuthPrincipal) {
  const binding = (await identity.listExternalIdentities()).find((row) =>
    row.userId === principal.userId && row.membershipId === principal.membershipId);
  return binding
    ? identity.resolveSlackIdentity(binding.slackTeamId, binding.slackUserId, principal.organizationId)
    : undefined;
}

async function teamSnapshot(identity: IdentityStore, principal: AuthPrincipal) {
  const [organization, memberships, bindings] = await Promise.all([
    identity.getOrganization(), identity.listMemberships(), identity.listExternalIdentities(),
  ]);
  const users = await Promise.all(memberships.map((membership) => identity.getUser(membership.userId)));
  const usersById = new Map(users.filter(Boolean).map((user) => [user!.id, user!]));
  const bindingsByMembership = new Map(bindings.map((binding) => [binding.membershipId, binding]));
  return {
    organization: organization
      ? { id: organization.id, displayName: organization.displayName, slackTeamId: organization.slackTeamId }
      : null,
    viewer: { userId: principal.userId, membershipId: principal.membershipId, role: principal.role },
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
  };
}

function parseId(value: string): string | undefined {
  const parsed = v.safeParse(opaqueId, value);
  return parsed.success ? parsed.output : undefined;
}

function teamError(c: Context, error: unknown) {
  if (error instanceof AuthRateLimitError) {
    c.header('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))));
    return c.json({ error: 'rate_limited' }, 429);
  }
  if (error instanceof AuthorizationError) return c.json({ error: 'forbidden' }, 403);
  if (error instanceof ManagementError) return managementFailure(c, error.code);
  if (error instanceof IdentityStateError) {
    if (error.code === 'membership_missing') {
      return c.json({ error: 'resource_unavailable' }, 404);
    }
    if (['last_owner_required', 'external_identity_conflict'].includes(error.code)) {
      return c.json({ error: error.code }, 409);
    }
    return c.json({ error: 'invalid_request' }, 400);
  }
  console.error('[chickpea] team API failure:', error instanceof Error ? error.message : String(error));
  return c.json({ error: 'internal_error' }, 500);
}
