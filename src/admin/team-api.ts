import { randomBytes as nodeRandomBytes } from 'node:crypto';

import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import { AuthorizationError, requirePermission } from '../auth/permissions.ts';
import { digest } from '../auth/personal-token.ts';
import { requestPrincipal } from '../auth/service.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import { IdentityStateError } from '../identity/errors.ts';
import type {
  IdentityStore,
  Invitation,
  Membership,
  OrganizationRole,
} from '../identity/types.ts';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const opaqueId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,200}$/));
const inviteSchema = v.strictObject({
  email: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320)),
  role: v.picklist(['member', 'admin']),
});
const membershipPatchSchema = v.pipe(
  v.strictObject({
    role: v.optional(v.picklist(['owner', 'admin', 'member'])),
    status: v.optional(v.picklist(['active', 'suspended', 'removed'])),
  }),
  v.check((body) => body.role !== undefined || body.status !== undefined),
);

interface TeamAdminApiOptions {
  store: (c: Context) => IdentityStore;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

export function createTeamAdminApi(options: TeamAdminApiOptions): Hono {
  const app = new Hono();
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? ((length: number) => nodeRandomBytes(length));

  app.get('/account', async (c) => {
    const principal = requiredPrincipal(c, 'account.view');
    const identity = options.store(c);
    const [organization, user, membership] = await Promise.all([
      identity.getOrganization(),
      identity.getUser(principal.userId),
      identity.getMembershipForUser(principal.userId, principal.organizationId),
    ]);
    if (!organization || !user || !membership) return c.json({ error: 'account_unavailable' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json({
      organization: { id: organization.id, displayName: organization.displayName },
      account: {
        userId: user.id,
        email: user.primaryEmail,
        displayName: user.displayName,
        membershipId: membership.id,
        role: membership.role,
        status: membership.status,
      },
      slackHandoff: { label: 'Open Slack', href: 'slack://open' },
    });
  });

  app.get('/team', async (c) => {
    const principal = requiredPrincipal(c, 'team.manage');
    c.header('Cache-Control', 'no-store');
    return c.json(await teamSnapshot(options.store(c), principal));
  });

  app.post('/team/invitations', async (c) => {
    const principal = requiredPrincipal(c, 'team.manage');
    const parsed = v.safeParse(inviteSchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    const secret = Buffer.from(randomBytes(32)).toString('base64url');
    try {
      const identity = options.store(c);
      const origin = await canonicalInviteOrigin(identity);
      if (!origin) return c.json({ error: 'canonical_origin_required' }, 409);
      const invitation = await identity.createInvitation({
        organizationId: principal.organizationId,
        email: parsed.output.email,
        role: parsed.output.role,
        tokenHash: digest(secret),
        inviterMembershipId: principal.membershipId,
        expiresAt: now() + INVITATION_TTL_MS,
      });
      return c.json({
        invitation: safeInvitation(invitation),
        inviteLink: invitationLink(origin, invitation.id, secret),
      }, 201);
    } catch (error) {
      return teamError(c, error);
    }
  });

  app.post('/team/invitations/:invitationId/resend', async (c) => {
    const principal = requiredPrincipal(c, 'team.manage');
    const invitationId = parseId(c.req.param('invitationId'));
    if (!invitationId) return invalid(c);
    const secret = Buffer.from(randomBytes(32)).toString('base64url');
    try {
      const identity = options.store(c);
      const origin = await canonicalInviteOrigin(identity);
      if (!origin) return c.json({ error: 'canonical_origin_required' }, 409);
      const existing = (await identity.listInvitations()).find((row) => row.id === invitationId);
      if (!existing || existing.organizationId !== principal.organizationId) {
        return c.json({ error: 'invitation_unavailable' }, 404);
      }
      const invitation = await identity.resendInvitation({
        invitationId,
        tokenHash: digest(secret),
        expiresAt: now() + INVITATION_TTL_MS,
      });
      return c.json({
        invitation: safeInvitation(invitation),
        inviteLink: invitationLink(origin, invitation.id, secret),
      });
    } catch (error) {
      return teamError(c, error);
    }
  });

  app.delete('/team/invitations/:invitationId', async (c) => {
    const principal = requiredPrincipal(c, 'team.manage');
    const invitationId = parseId(c.req.param('invitationId'));
    if (!invitationId) return invalid(c);
    try {
      const existing = (await options.store(c).listInvitations()).find((row) => row.id === invitationId);
      if (!existing || existing.organizationId !== principal.organizationId) {
        return c.json({ error: 'invitation_unavailable' }, 404);
      }
      const invitation = await options.store(c).revokeInvitation(invitationId);
      return c.json({ invitation: safeInvitation(invitation) });
    } catch (error) {
      return teamError(c, error);
    }
  });

  app.patch('/team/memberships/:membershipId', async (c) => {
    const principal = requiredPrincipal(c, 'team.manage');
    const membershipId = parseId(c.req.param('membershipId'));
    const parsed = v.safeParse(membershipPatchSchema, await readJson(c));
    if (!membershipId || !parsed.success) return invalid(c);
    try {
      const target = (await options.store(c).listMemberships()).find((row) => row.id === membershipId);
      if (!target || target.organizationId !== principal.organizationId) {
        return c.json({ error: 'membership_unavailable' }, 404);
      }
      enforceMembershipGrant(principal, target, parsed.output.role, parsed.output.status);
      const membership = await options.store(c).updateMembership({
        membershipId,
        ...(parsed.output.role === undefined ? {} : { role: parsed.output.role }),
        ...(parsed.output.status === undefined ? {} : { status: parsed.output.status }),
        actorMembershipId: principal.membershipId,
      });
      return c.json({ membership });
    } catch (error) {
      return teamError(c, error);
    }
  });

  return app;
}

function requiredPrincipal(c: Context, permission: Parameters<typeof requirePermission>[1]): AuthPrincipal {
  const principal = requestPrincipal(c.req.raw);
  requirePermission(principal, permission);
  return principal!;
}

function enforceMembershipGrant(
  principal: AuthPrincipal,
  target: Membership,
  role: OrganizationRole | undefined,
  status: Membership['status'] | undefined,
): void {
  const changesOwner = role === 'owner' || target.role === 'owner' && role !== undefined;
  const controlsOwner = target.role === 'owner' && status !== undefined && status !== 'active';
  if (changesOwner || controlsOwner) requirePermission(principal, 'team.manage_owners');
}

async function teamSnapshot(
  store: IdentityStore,
  principal: AuthPrincipal,
) {
  const [organization, memberships, bindings, invitations] = await Promise.all([
    store.getOrganization(),
    store.listMemberships(),
    store.listExternalIdentities(),
    store.listInvitations(),
  ]);
  const users = (await Promise.all(
    memberships.map((membership) => store.getUser(membership.userId)),
  )).filter((user): user is NonNullable<typeof user> => Boolean(user));
  const usersById = new Map(users.map((user) => [user.id, user]));
  const bindingsByUser = new Map(bindings.map((binding) => [binding.userId, binding]));
  return {
    organization: organization ? { id: organization.id, displayName: organization.displayName } : null,
    viewer: {
      userId: principal.userId,
      membershipId: principal.membershipId,
      role: principal.role,
    },
    members: memberships.map((membership) => {
      const user = usersById.get(membership.userId);
      const binding = bindingsByUser.get(membership.userId);
      return {
        id: membership.id,
        userId: membership.userId,
        email: user?.primaryEmail ?? null,
        displayName: user?.displayName ?? null,
        role: membership.role,
        status: membership.status,
        externalIdentity: binding ? { provider: binding.provider, bound: true } : null,
      };
    }),
    invitations: invitations.map(safeInvitation),
  };
}

function safeInvitation(invitation: Invitation) {
  return {
    id: invitation.id,
    email: invitation.normalizedEmail,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
  };
}

function invitationLink(organizationOrigin: string, invitationId: string, secret: string): string {
  const credential = encodeURIComponent(`${invitationId}.${secret}`);
  return `${organizationOrigin}/join#invite=${credential}`;
}

async function canonicalInviteOrigin(store: IdentityStore): Promise<string | undefined> {
  const origin = (await store.getOrganization())?.canonicalAdminOrigin;
  if (!origin) return undefined;
  try {
    return new URL(origin).origin;
  } catch {
    return undefined;
  }
}

function parseId(value: string): string | undefined {
  const parsed = v.safeParse(opaqueId, value);
  return parsed.success ? parsed.output : undefined;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function invalid(c: Context) {
  return c.json({ error: 'invalid_request' }, 400);
}

function teamError(c: Context, error: unknown) {
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
