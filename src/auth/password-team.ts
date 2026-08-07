import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { IdentityStore, Membership, OrganizationRole } from '../identity/types.ts';
import { digest } from './personal-token.ts';
import { assertPasswordPolicy } from './password-policy.ts';
import type { BetterAuthEnvironment } from './better-auth-environment.ts';
import { createBetterAuth } from './better-auth.ts';
import { setCookieValues } from './cookies.ts';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const RESET_TTL_MS = 30 * 60 * 1_000;

export type PasswordLifecycleErrorCode =
  | 'unavailable'
  | 'conflict'
  | 'existing_account'
  | 'already_enrolled'
  | 'suspended';

export class PasswordLifecycleError extends Error {
  constructor(readonly code: PasswordLifecycleErrorCode) {
    super(code);
    this.name = 'PasswordLifecycleError';
  }
}

export interface PasswordInvitationSummary {
  id: string;
  email: string;
  role: 'admin' | 'member';
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

interface BetterAuthInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date | string | number;
  createdAt: Date | string | number;
}

interface OrganizationApi {
  createInvitation(input: {
    body: { email: string; role: string; organizationId: string; resend?: boolean };
    headers: Headers;
  }): Promise<BetterAuthInvitation>;
  listInvitations(input: {
    query: { organizationId: string };
    headers: Headers;
  }): Promise<BetterAuthInvitation[]>;
  cancelInvitation(input: {
    body: { invitationId: string };
    headers: Headers;
  }): Promise<unknown>;
  acceptInvitation(input: {
    body: { invitationId: string };
    headers: Headers;
  }): Promise<{ member?: { id: string; userId: string; organizationId: string; role: string } }>;
  updateMemberRole(input: {
    body: { memberId: string; role: string; organizationId: string };
    headers: Headers;
  }): Promise<unknown>;
  removeMember(input: {
    body: { memberIdOrEmail: string; organizationId: string };
    headers: Headers;
  }): Promise<unknown>;
  getSession(input: { headers: Headers }): Promise<{
    user?: { id?: string; email?: string };
    session?: { id?: string };
  } | null>;
}

export class PasswordTeamLifecycleService {
  private readonly auth: ReturnType<typeof createBetterAuth>;
  private readonly api: OrganizationApi;

  constructor(
    private readonly control: IdentityStore,
    private readonly environment: BetterAuthEnvironment,
    private readonly organizationId: string,
    private readonly now: () => number = Date.now,
    private readonly random: (length: number) => Uint8Array = (length) => randomBytes(length),
  ) {
    this.auth = createBetterAuth({ ...environment, allowSignUp: true, autoSignInAfterSignUp: false });
    this.api = this.auth.api as unknown as OrganizationApi;
  }

  async listInvitations(headers: Headers): Promise<PasswordInvitationSummary[]> {
    const [invitations, operations] = await Promise.all([
      this.api.listInvitations({ query: { organizationId: this.organizationId }, headers }),
      this.control.listAuthOperations('invitation_enrollment', this.organizationId),
    ]);
    const byInvitation = new Map(invitations.map((invitation) => [invitation.id, invitation]));
    return operations
      .filter((operation) => operation.betterAuthInvitationId && byInvitation.has(operation.betterAuthInvitationId))
      .map((operation) => invitationSummary(
        operation,
        byInvitation.get(operation.betterAuthInvitationId!)!,
        this.now(),
      ));
  }

  async createInvitation(input: {
    email: string;
    role: 'admin' | 'member';
    headers: Headers;
  }): Promise<{ invitation: PasswordInvitationSummary; inviteLink: string }> {
    const email = normalizeEmail(input.email);
    const existing = await this.environment.backend.findUserByEmail(email);
    if (existing && await this.environment.backend.getMembershipForUser(existing.id, this.organizationId)) {
      throw new PasswordLifecycleError('already_enrolled');
    }
    const priorOperations = await this.control.listAuthOperations(
      'invitation_enrollment',
      this.organizationId,
    );
    if (priorOperations.some((operation) =>
      operation.status === 'pending' &&
      operation.expiresAt > this.now() &&
      operation.expectedNormalizedEmail === email)) {
      throw new PasswordLifecycleError('conflict');
    }
    const secret = Buffer.from(this.random(32)).toString('base64url');
    const expiresAt = this.now() + INVITATION_TTL_MS;
    const operation = await this.control.createAuthOperation({
      kind: 'invitation_enrollment',
      organizationId: this.organizationId,
      expectedEmail: email,
      capabilityHash: digest(secret),
      expiresAt,
    });
    try {
      const invitation = await this.api.createInvitation({
        body: { email, role: input.role, organizationId: this.organizationId },
        headers: input.headers,
      });
      const ready = await this.control.advanceAuthOperation({
        operationId: operation.id,
        capabilityHash: digest(secret),
        step: 1,
        betterAuthOrganizationId: this.organizationId,
        betterAuthInvitationId: invitation.id,
      });
      return {
        invitation: invitationSummary(ready, invitation, this.now()),
        inviteLink: capabilityLink(this.environment.baseURL, '/join', 'invite', ready.id, secret),
      };
    } catch (error) {
      await this.control.revokeAuthOperation(operation.id).catch(() => undefined);
      throw error;
    }
  }

  async rotateInvitation(input: {
    operationId: string;
    headers: Headers;
  }): Promise<{ invitation: PasswordInvitationSummary; inviteLink: string }> {
    const current = await this.requiredOperation(input.operationId, 'invitation_enrollment');
    if (!current.betterAuthInvitationId) throw new PasswordLifecycleError('unavailable');
    const listed = await this.api.listInvitations({
      query: { organizationId: this.organizationId },
      headers: input.headers,
    });
    const prior = listed.find((invitation) => invitation.id === current.betterAuthInvitationId);
    if (!prior || prior.status !== 'pending' || !isInvitationRole(prior.role)) {
      throw new PasswordLifecycleError('unavailable');
    }
    const secret = Buffer.from(this.random(32)).toString('base64url');
    const expiresAt = this.now() + INVITATION_TTL_MS;
    const replacement = await this.control.createAuthOperation({
      kind: 'invitation_enrollment',
      organizationId: this.organizationId,
      expectedEmail: current.expectedNormalizedEmail,
      capabilityHash: digest(secret),
      expiresAt,
    });
    try {
      const invitation = await this.api.createInvitation({
        body: {
          email: current.expectedNormalizedEmail,
          role: prior.role,
          organizationId: this.organizationId,
          resend: true,
        },
        headers: input.headers,
      });
      const ready = await this.control.advanceAuthOperation({
        operationId: replacement.id,
        capabilityHash: digest(secret),
        step: 1,
        betterAuthOrganizationId: this.organizationId,
        betterAuthInvitationId: invitation.id,
      });
      await this.control.revokeAuthOperation(current.id);
      return {
        invitation: invitationSummary(ready, invitation, this.now()),
        inviteLink: capabilityLink(this.environment.baseURL, '/join', 'invite', ready.id, secret),
      };
    } catch (error) {
      await this.control.revokeAuthOperation(replacement.id).catch(() => undefined);
      throw error;
    }
  }

  async revokeInvitation(operationId: string, headers: Headers): Promise<PasswordInvitationSummary> {
    const operation = await this.requiredOperation(operationId, 'invitation_enrollment');
    if (!operation.betterAuthInvitationId) throw new PasswordLifecycleError('unavailable');
    const invitations = await this.api.listInvitations({
      query: { organizationId: this.organizationId },
      headers,
    });
    const invitation = invitations.find((entry) => entry.id === operation.betterAuthInvitationId);
    if (!invitation) throw new PasswordLifecycleError('unavailable');
    if (invitation.status === 'pending') {
      await this.api.cancelInvitation({ body: { invitationId: invitation.id }, headers });
    }
    const revoked = await this.control.revokeAuthOperation(operation.id);
    return invitationSummary(revoked, { ...invitation, status: 'canceled' }, this.now());
  }

  async updateMembership(input: {
    membership: Membership;
    role?: OrganizationRole;
    status?: Membership['status'];
    actorMembershipId: string;
    headers: Headers;
  }): Promise<Membership> {
    if (input.membership.organizationId !== this.organizationId) {
      throw new PasswordLifecycleError('unavailable');
    }
    const removesActiveOwner = input.membership.role === 'owner' &&
      input.membership.status === 'active' && (
      input.role !== undefined && input.role !== 'owner' ||
      input.status === 'suspended' ||
      input.status === 'removed'
    );
    const ownerMembershipIds = removesActiveOwner
      ? await this.activeOwnerMembershipIds(input.membership.id)
      : undefined;
    const requiresReservation = removesActiveOwner &&
      (input.status === 'removed' || input.role !== undefined && input.role !== 'owner');
    let reservation: Awaited<ReturnType<IdentityStore['setMembershipAccessOverlay']>> | undefined;
    if (requiresReservation && ownerMembershipIds) {
      const current = await this.control.getMembershipAccessOverlay(input.membership.id);
      reservation = await this.control.setMembershipAccessOverlay({
        membershipId: input.membership.id,
        organizationId: this.organizationId,
        accessStatus: 'suspended',
        expectedVersion: current?.membershipVersion ?? 0,
        actorMembershipId: input.actorMembershipId,
        ownerMembershipIds,
      });
    }
    let externalMutationCommitted = false;
    try {
      if (input.role !== undefined && input.role !== input.membership.role) {
        await this.api.updateMemberRole({
          body: {
            memberId: input.membership.id,
            role: input.role,
            organizationId: this.organizationId,
          },
          headers: input.headers,
        });
        externalMutationCommitted = true;
      }
      if (input.status === 'removed') {
        await this.api.removeMember({
          body: { memberIdOrEmail: input.membership.id, organizationId: this.organizationId },
          headers: input.headers,
        });
        externalMutationCommitted = true;
        await this.revokeTargetAuthority(input.membership.userId);
        return { ...input.membership, role: input.role ?? input.membership.role, status: 'removed' };
      }
      if (input.status === 'active' || input.status === 'suspended') {
        const current = await this.control.getMembershipAccessOverlay(input.membership.id);
        await this.control.setMembershipAccessOverlay({
          membershipId: input.membership.id,
          organizationId: this.organizationId,
          accessStatus: input.status,
          expectedVersion: current?.membershipVersion ?? 0,
          actorMembershipId: input.actorMembershipId,
          ...(input.membership.role === 'owner' && input.status === 'suspended' && ownerMembershipIds
            ? { ownerMembershipIds }
            : {}),
        });
        if (input.status === 'suspended') await this.revokeTargetAuthority(input.membership.userId);
      } else if (reservation) {
        await this.releaseOwnerReservation(reservation, input.actorMembershipId);
      }
    } catch (error) {
      if (reservation && !externalMutationCommitted) {
        await this.releaseOwnerReservation(reservation, input.actorMembershipId).catch(() => undefined);
      }
      throw error;
    }
    return {
      ...input.membership,
      role: input.role ?? input.membership.role,
      status: input.status ?? input.membership.status,
    };
  }

  private async releaseOwnerReservation(
    reservation: Awaited<ReturnType<IdentityStore['setMembershipAccessOverlay']>>,
    actorMembershipId: string,
  ): Promise<void> {
    await this.control.setMembershipAccessOverlay({
      membershipId: reservation.membershipId,
      organizationId: reservation.organizationId,
      accessStatus: 'active',
      expectedVersion: reservation.membershipVersion,
      actorMembershipId,
    });
  }

  async createAdministrativeReset(input: {
    membership: Membership;
  }): Promise<{ resetLink: string; expiresAt: number }> {
    const user = await this.environment.backend.getUser(input.membership.userId);
    if (!user || input.membership.organizationId !== this.organizationId) {
      throw new PasswordLifecycleError('unavailable');
    }
    const prior = await this.control.listAuthOperations('administrative_reset', this.organizationId);
    await Promise.all(prior
      .filter((operation) => operation.status === 'pending' && operation.betterAuthUserId === user.id)
      .map((operation) => this.control.revokeAuthOperation(operation.id)));
    const secret = Buffer.from(this.random(32)).toString('base64url');
    const expiresAt = this.now() + RESET_TTL_MS;
    let operation = await this.control.createAuthOperation({
      kind: 'administrative_reset',
      organizationId: this.organizationId,
      expectedEmail: user.email,
      capabilityHash: digest(secret),
      expiresAt,
    });
    operation = await this.control.advanceAuthOperation({
      operationId: operation.id,
      capabilityHash: digest(secret),
      step: 1,
      betterAuthUserId: user.id,
      betterAuthOrganizationId: this.organizationId,
      betterAuthMembershipId: input.membership.id,
    });
    return {
      resetLink: capabilityLink(this.environment.baseURL, '/reset', 'reset', operation.id, secret),
      expiresAt,
    };
  }

  private async requiredOperation(
    operationId: string,
    kind: 'invitation_enrollment' | 'administrative_reset',
  ) {
    const operation = await this.control.getAuthOperation(operationId);
    if (!operation || operation.kind !== kind || operation.organizationId !== this.organizationId ||
        operation.status !== 'pending' || operation.expiresAt <= this.now()) {
      throw new PasswordLifecycleError('unavailable');
    }
    return operation;
  }

  private async revokeTargetAuthority(userId: string): Promise<void> {
    const context = await this.auth.$context;
    await context.internalAdapter.deleteUserSessions(userId);
    const tokens = (await this.control.exportSummary()).personalTokens
      .filter((token) => token.userId === userId && token.status === 'active');
    await Promise.all(tokens.map((token) => this.control.revokePersonalToken(token.id)));
  }

  private async activeOwnerMembershipIds(targetMembershipId: string): Promise<string[]> {
    const memberships = await this.environment.backend.listMemberships(this.organizationId);
    const ownerMembershipIds = memberships
      .filter((membership) => membership.role === 'owner')
      .map((membership) => membership.id);
    for (const membership of memberships) {
      if (membership.id === targetMembershipId || membership.role !== 'owner') continue;
      const overlay = await this.control.getMembershipAccessOverlay(membership.id);
      if (overlay?.accessStatus !== 'suspended') return ownerMembershipIds;
    }
    throw new PasswordLifecycleError('conflict');
  }
}

export class PasswordEnrollmentService {
  private readonly auth: ReturnType<typeof createBetterAuth>;
  private readonly api: OrganizationApi;

  constructor(
    private readonly control: IdentityStore,
    private readonly environment: BetterAuthEnvironment,
    private readonly organizationId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.auth = createBetterAuth({ ...environment, allowSignUp: true, autoSignInAfterSignUp: false });
    this.api = this.auth.api as unknown as OrganizationApi;
  }

  async inspectInvitation(input: { operationId: string; secret: string; headers: Headers }) {
    const operation = await this.capabilityOperation(
      input.operationId,
      input.secret,
      'invitation_enrollment',
    );
    if (operation.step < 1 || !operation.betterAuthInvitationId) {
      throw new PasswordLifecycleError('unavailable');
    }
    const user = await this.environment.backend.findUserByEmail(operation.expectedNormalizedEmail);
    const session = await this.sessionUser(input.headers);
    if (session && session.email !== operation.expectedNormalizedEmail) {
      throw new PasswordLifecycleError('conflict');
    }
    const membership = user
      ? await this.environment.backend.getMembershipForUser(user.id, this.organizationId)
      : null;
    if (membership) throw new PasswordLifecycleError('already_enrolled');
    const partial = Boolean(user && (
      operation.betterAuthUserId === user.id || user.createdAt >= operation.createdAt
    ));
    return {
      email: operation.expectedNormalizedEmail,
      expiresAt: operation.expiresAt,
      accountState: !user || partial
        ? 'new'
        : session?.id === user.id ? 'authenticated' : 'existing',
    } as const;
  }

  async completeInvitation(input: {
    operationId: string;
    secret: string;
    displayName?: string;
    password?: string;
    headers: Headers;
  }): Promise<{ headers?: Headers; userId: string; membershipId: string }> {
    let operation = await this.capabilityOperation(
      input.operationId,
      input.secret,
      'invitation_enrollment',
    );
    if (operation.step < 1 || !operation.betterAuthInvitationId) {
      throw new PasswordLifecycleError('unavailable');
    }
    const invitationId = operation.betterAuthInvitationId;
    const email = operation.expectedNormalizedEmail;
    const organization = await this.environment.backend.getOrganization(this.organizationId);
    if (!organization) throw new PasswordLifecycleError('unavailable');
    let user = await this.environment.backend.findUserByEmail(email);
    const session = await this.sessionUser(input.headers);
    if (session && session.email !== email) throw new PasswordLifecycleError('conflict');
    let sessionHeaders: Headers | undefined;
    if (!user) {
      const displayName = boundedDisplayName(input.displayName);
      if (!input.password) throw new PasswordLifecycleError('unavailable');
      assertPasswordPolicy(input.password, { email, organizationName: organization.name });
      const signup = await this.auth.api.signUpEmail({
        body: { email, name: displayName, password: input.password },
      });
      user = await this.environment.backend.getUser(signup.user.id);
      if (!user) throw new PasswordLifecycleError('unavailable');
    }
    if (operation.betterAuthUserId && operation.betterAuthUserId !== user.id) {
      throw new PasswordLifecycleError('conflict');
    }
    const resumablePartial = operation.betterAuthUserId === user.id ||
      (!operation.betterAuthUserId && user.createdAt >= operation.createdAt);
    if (operation.step === 1) {
      operation = await this.control.advanceAuthOperation({
        operationId: operation.id,
        capabilityHash: digest(input.secret),
        step: 2,
        betterAuthUserId: user.id,
      });
    }

    let acceptanceHeaders = input.headers;
    if (!session) {
      if (!resumablePartial) {
        throw new PasswordLifecycleError('existing_account');
      }
      if (!input.password) throw new PasswordLifecycleError('existing_account');
      const login = await this.auth.api.signInEmail({
        body: { email, password: input.password },
        returnHeaders: true,
      });
      sessionHeaders = login.headers;
      acceptanceHeaders = cookieRequestHeaders(login.headers);
    } else if (session.id !== user.id) {
      throw new PasswordLifecycleError('conflict');
    }

    let membership = await this.environment.backend.getMembershipForUser(user.id, this.organizationId);
    if (!membership) {
      const accepted = await this.api.acceptInvitation({
        body: { invitationId },
        headers: acceptanceHeaders,
      });
      membership = accepted.member
        ? await this.environment.backend.getMembership(accepted.member.id)
        : await this.environment.backend.getMembershipForUser(user.id, this.organizationId);
    }
    if (!membership || membership.userId !== user.id ||
        membership.organizationId !== this.organizationId ||
        !isInvitationRole(membership.role)) throw new PasswordLifecycleError('unavailable');
    if (operation.step === 2) {
      operation = await this.control.advanceAuthOperation({
        operationId: operation.id,
        capabilityHash: digest(input.secret),
        step: 3,
        betterAuthMembershipId: membership.id,
      });
    }
    await this.control.consumeAuthOperation({
      operationId: operation.id,
      capabilityHash: digest(input.secret),
      expectedStep: 3,
    });
    return { ...(sessionHeaders ? { headers: sessionHeaders } : {}), userId: user.id, membershipId: membership.id };
  }

  async inspectReset(input: { operationId: string; secret: string; headers: Headers }) {
    const operation = await this.capabilityOperation(
      input.operationId,
      input.secret,
      'administrative_reset',
    );
    if (operation.step !== 1 || !operation.betterAuthUserId || !operation.betterAuthMembershipId) {
      throw new PasswordLifecycleError('unavailable');
    }
    const session = await this.sessionUser(input.headers);
    if (session && session.id !== operation.betterAuthUserId) {
      throw new PasswordLifecycleError('conflict');
    }
    return { email: operation.expectedNormalizedEmail, expiresAt: operation.expiresAt };
  }

  async completeReset(input: {
    operationId: string;
    secret: string;
    newPassword: string;
    headers: Headers;
  }): Promise<void> {
    const operation = await this.capabilityOperation(
      input.operationId,
      input.secret,
      'administrative_reset',
    );
    if (operation.step !== 1 || !operation.betterAuthUserId || !operation.betterAuthMembershipId) {
      throw new PasswordLifecycleError('unavailable');
    }
    const session = await this.sessionUser(input.headers);
    if (session && session.id !== operation.betterAuthUserId) {
      throw new PasswordLifecycleError('conflict');
    }
    const organization = await this.environment.backend.getOrganization(this.organizationId);
    assertPasswordPolicy(input.newPassword, {
      email: operation.expectedNormalizedEmail,
      ...(organization ? { organizationName: organization.name } : {}),
    });
    const context = await this.auth.$context;
    const account = (await context.internalAdapter.findAccounts(operation.betterAuthUserId)).find(
      (candidate) => candidate.providerId === 'credential' && candidate.password,
    );
    if (!account) throw new PasswordLifecycleError('unavailable');
    const verifier = await this.environment.password.hash(input.newPassword);
    await context.internalAdapter.updateAccount(account.id, { password: verifier });
    await context.internalAdapter.deleteUserSessions(operation.betterAuthUserId);
    await this.control.consumeAuthOperation({
      operationId: operation.id,
      capabilityHash: digest(input.secret),
      expectedStep: 1,
    });
    const tokens = (await this.control.exportSummary()).personalTokens
      .filter((token) => token.userId === operation.betterAuthUserId && token.status === 'active');
    await Promise.all(tokens.map((token) => this.control.revokePersonalToken(token.id)));
  }

  private async capabilityOperation(
    operationId: string,
    secret: string,
    kind: 'invitation_enrollment' | 'administrative_reset',
  ) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(operationId) ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
      throw new PasswordLifecycleError('unavailable');
    }
    const operation = await this.control.getAuthOperation(operationId);
    if (!operation || operation.kind !== kind || operation.organizationId !== this.organizationId ||
        operation.status !== 'pending' || operation.expiresAt <= this.now() ||
        !hashEquals(operation.capabilityHash, digest(secret))) {
      throw new PasswordLifecycleError('unavailable');
    }
    return operation;
  }

  private async sessionUser(headers: Headers): Promise<{ id: string; email: string } | undefined> {
    const session = await this.api.getSession({ headers });
    const id = session?.user?.id;
    const email = session?.user?.email;
    return typeof id === 'string' && typeof email === 'string'
      ? { id, email: normalizeEmail(email) }
      : undefined;
  }
}

function invitationSummary(
  operation: {
    id: string;
    status: string;
    expiresAt: number;
    createdAt: number;
    updatedAt: number;
    expectedNormalizedEmail: string;
  },
  invitation: BetterAuthInvitation,
  now: number,
): PasswordInvitationSummary {
  if (!isInvitationRole(invitation.role)) throw new PasswordLifecycleError('unavailable');
  const status = operation.status === 'consumed'
    ? 'accepted'
    : operation.status === 'revoked'
      ? 'revoked'
      : operation.status === 'expired' || operation.expiresAt <= now || invitation.status === 'expired'
        ? 'expired'
        : invitation.status === 'accepted'
          ? 'accepted'
          : invitation.status === 'canceled' || invitation.status === 'cancelled'
            ? 'revoked'
            : 'pending';
  return {
    id: operation.id,
    email: operation.expectedNormalizedEmail,
    role: invitation.role,
    status,
    expiresAt: operation.expiresAt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

function capabilityLink(
  origin: string,
  path: '/join' | '/reset',
  parameter: 'invite' | 'reset',
  operationId: string,
  secret: string,
): string {
  return `${origin}${path}#${parameter}=${encodeURIComponent(`${operationId}.${secret}`)}`;
}

function cookieRequestHeaders(responseHeaders: Headers): Headers {
  const headers = new Headers();
  const cookies = setCookieValues(responseHeaders);
  headers.set('cookie', cookies.map((cookie) => cookie.split(';', 1)[0]).join('; '));
  return headers;
}

function normalizeEmail(value: string): string {
  const email = value.trim().normalize('NFKC').toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new PasswordLifecycleError('unavailable');
  }
  return email;
}

function boundedDisplayName(value: string | undefined): string {
  const displayName = value?.trim().normalize('NFKC') ?? '';
  if (!displayName || [...displayName].length > 128) {
    throw new PasswordLifecycleError('unavailable');
  }
  return displayName;
}

function isInvitationRole(value: string): value is 'admin' | 'member' {
  return value === 'admin' || value === 'member';
}

function hashEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
