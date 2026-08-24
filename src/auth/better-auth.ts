import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { createLocalAccountIssuer } from 'better-auth/db';
import { getOrgAdapter, jwt, organization } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';

import type { BetterAuthDatabaseBackend } from './better-auth-backend.ts';
import {
  MCP_WORKSPACE_SCOPE,
  mcpResourceForOrigin,
} from './mcp-oauth.ts';

export const BETTER_AUTH_BASE_PATH = '/api/auth';
export const SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1_000;
export const SESSION_REFRESH_SECONDS = 24 * 60 * 60;
export const BETTER_AUTH_SLACK_PROVIDER_ID = 'slack';
export const BETTER_AUTH_PRIVATE_SESSION_PATH = '/chickpea-private/issue-session';

export interface BetterAuthAdmissionOperation {
  operationId: string;
  status: string;
  chickpeaRole: string;
  slackTeamId: string;
  slackUserId: string;
  betterAuthUserId: string;
  betterAuthOrganizationId: string;
  betterAuthMembershipId: string;
}

export interface BetterAuthPrivateSeam {
  resolveAdmissionOperation(operationId: string): Promise<BetterAuthAdmissionOperation | null>;
}

export interface ReconcileSlackIdentityInput {
  slackTeamId: string;
  slackUserId: string;
  displayName: string;
  organization: {
    id?: string;
    name: string;
    slug: string;
  };
  /** A server-recorded resumable Better Auth user ID, never a browser subject. */
  expectedUserId?: string;
}

export interface ReconciledSlackIdentity {
  providerId: typeof BETTER_AUTH_SLACK_PROVIDER_ID;
  accountId: string;
  userId: string;
  organizationId: string;
  membershipId: string;
  membershipRole: 'member';
}

export class BetterAuthIdentityConflictError extends Error {
  constructor(message = 'The Slack identity conflicts with existing Better Auth authority.') {
    super(message);
    this.name = 'BetterAuthIdentityConflictError';
  }
}

export interface CreateBetterAuthInput {
  backend: BetterAuthDatabaseBackend;
  baseURL: string;
  secret: string;
  privateSeam?: BetterAuthPrivateSeam;
}

export function createBetterAuth(input: CreateBetterAuthInput) {
  const baseURL = requireSupportedOrigin(input.baseURL);
  const internalMarker = Object.freeze({});
  const normalizedInput = { ...input, baseURL };
  const auth = betterAuth(createOptions(normalizedInput, internalMarker));

  return Object.assign(auth, {
    chickpea: {
      reconcileSlackIdentity: (identity: ReconcileSlackIdentityInput) =>
        reconcileSlackIdentity(auth, identity),
      issueSession: async (operationId: string, request?: Request): Promise<Response> => {
        const api = auth.api as unknown as {
          issueChickpeaSession(input: {
            asResponse: true;
            body: { internalMarker: object; operationId: string };
            headers?: Headers;
          }): Promise<Response>;
        };
        return api.issueChickpeaSession({
          asResponse: true,
          body: { internalMarker, operationId },
          ...(request ? { headers: request.headers } : {}),
        });
      },
    },
  });
}

/** The production options are also the source of the pinned fresh-schema generator. */
export function createBetterAuthOptions(input: CreateBetterAuthInput): BetterAuthOptions {
  const baseURL = requireSupportedOrigin(input.baseURL);
  return createOptions({ ...input, baseURL }, Object.freeze({}));
}

function createOptions(
  input: CreateBetterAuthInput & { baseURL: string },
  internalMarker: object,
): BetterAuthOptions {
  const secureCookies = new URL(input.baseURL).protocol === 'https:';
  return {
    appName: 'Chickpea',
    baseURL: input.baseURL,
    basePath: BETTER_AUTH_BASE_PATH,
    secret: input.secret,
    trustedOrigins: [input.baseURL],
    database: input.backend.database,
    emailAndPassword: {
      enabled: false,
      disableSignUp: true,
    },
    account: {
      accountLinking: {
        enabled: false,
        disableImplicitLinking: true,
        trustedProviders: [],
      },
    },
    session: {
      additionalFields: {
        absoluteExpiresAt: {
          defaultValue: () => new Date(Date.now() + SESSION_ABSOLUTE_MS),
          input: false,
          required: true,
          returned: true,
          type: 'date',
        },
      },
      cookieCache: { enabled: false },
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
    },
    databaseHooks: {
      session: {
        update: {
          async before(data: Record<string, unknown>, context: unknown) {
            if (!(data.expiresAt instanceof Date)) return;
            const session = (context as {
              context?: { session?: { session?: { token?: string } } };
            } | null)?.context?.session?.session;
            if (!session?.token) return;
            const absolute = await input.backend.absoluteExpiryForToken(session.token);
            if (absolute && data.expiresAt > absolute) {
              return { data: { ...data, expiresAt: absolute } };
            }
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/get-session') return;
        const session = ctx.context.session?.session as
          | { token: string; absoluteExpiresAt?: Date | string | number }
          | undefined;
        if (!session?.token) return;
        const fromSession = session.absoluteExpiresAt instanceof Date
          ? session.absoluteExpiresAt
          : null;
        const absolute = fromSession ?? await input.backend.absoluteExpiryForToken(session.token);
        if (absolute && absolute.getTime() <= Date.now()) {
          await ctx.context.internalAdapter.deleteSession(session.token);
          return ctx.json(null);
        }
      }),
    },
    rateLimit: { enabled: false },
    advanced: {
      database: { generateId: 'uuid' },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] },
      useSecureCookies: secureCookies,
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        cancelPendingInvitationsOnReInvite: true,
        invitationExpiresIn: 7 * 24 * 60 * 60,
        async sendInvitationEmail() {},
      }),
      jwt({
        jwks: {
          keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' },
          rotationInterval: 30 * 24 * 60 * 60,
          gracePeriod: 30 * 24 * 60 * 60,
        },
      }),
      mcp({
        resource: mcpResourceForOrigin(input.baseURL),
        loginPage: '/auth/mcp/login',
        consentPage: '/auth/mcp/consent',
        scopes: [MCP_WORKSPACE_SCOPE],
        grantTypes: ['authorization_code', 'refresh_token'],
        accessTokenExpiresIn: 15 * 60,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        codeExpiresIn: 10 * 60,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: [MCP_WORKSPACE_SCOPE],
        clientRegistrationAllowedScopes: [],
        clientRegistrationRequirePKCE: true,
      }) as unknown as BetterAuthPlugin,
      createPrivateSessionPlugin(input.privateSeam, internalMarker),
    ],
    telemetry: { enabled: false },
  };
}

function createPrivateSessionPlugin(
  seam: BetterAuthPrivateSeam | undefined,
  internalMarker: object,
): BetterAuthPlugin {
  return {
    id: 'chickpea-private-session',
    endpoints: {
      issueChickpeaSession: createAuthEndpoint(
        BETTER_AUTH_PRIVATE_SESSION_PATH,
        { method: 'POST' },
        async (ctx) => {
          const body = ctx.body as Record<string, unknown> | undefined;
          if (body?.internalMarker !== internalMarker ||
              typeof body.operationId !== 'string' || !seam) {
            throw ctx.error('FORBIDDEN', { message: 'Active Chickpea authority is required.' });
          }

          const admission = await seam.resolveAdmissionOperation(body.operationId);
          if (!isActiveAdmission(admission, body.operationId)) {
            throw ctx.error('FORBIDDEN', { message: 'Active Chickpea authority is required.' });
          }

          const account = await ctx.context.internalAdapter.findAccountByKey({
            issuer: createLocalAccountIssuer(BETTER_AUTH_SLACK_PROVIDER_ID),
            accountId: slackAccountId(admission.slackTeamId, admission.slackUserId),
          });
          const user = await ctx.context.internalAdapter.findUserById(admission.betterAuthUserId);
          const member = await getOrgAdapter(ctx.context).findMemberByOrgId({
            userId: admission.betterAuthUserId,
            organizationId: admission.betterAuthOrganizationId,
          });
          if (!account || account.userId !== admission.betterAuthUserId || !user || !member ||
              member.id !== admission.betterAuthMembershipId || member.role !== 'member') {
            throw ctx.error('FORBIDDEN', { message: 'Active Chickpea authority is required.' });
          }

          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({
            ok: true,
            operationId: admission.operationId,
            organizationId: admission.betterAuthOrganizationId,
            membershipId: admission.betterAuthMembershipId,
          });
        },
      ),
    },
  };
}

async function reconcileSlackIdentity(
  auth: ReturnType<typeof betterAuth>,
  input: ReconcileSlackIdentityInput,
): Promise<ReconciledSlackIdentity> {
  const accountId = slackAccountId(input.slackTeamId, input.slackUserId);
  const issuer = createLocalAccountIssuer(BETTER_AUTH_SLACK_PROVIDER_ID);
  const context = await auth.$context;
  let account = await context.internalAdapter.findAccountByKey({ issuer, accountId });
  let user = account
    ? await context.internalAdapter.findUserById(account.userId)
    : null;

  if (account) {
    if (!user || (input.expectedUserId && input.expectedUserId !== account.userId)) {
      throw new BetterAuthIdentityConflictError();
    }
  } else {
    if (input.expectedUserId) {
      user = await context.internalAdapter.findUserById(input.expectedUserId);
      if (!user) throw new BetterAuthIdentityConflictError();
      const linkedSlackAccount = (await context.internalAdapter.findAccounts(user.id)).find(
        (candidate) => candidate.providerId === BETTER_AUTH_SLACK_PROVIDER_ID,
      );
      if (linkedSlackAccount) throw new BetterAuthIdentityConflictError();
    } else {
      user = await context.internalAdapter.createUser({
        email: opaqueIdentityEmail(),
        emailVerified: false,
        name: input.displayName,
      }, { method: 'chickpea-slack-oidc' });
    }

    try {
      account = await context.internalAdapter.createAccount({
        accountId,
        issuer,
        providerId: BETTER_AUTH_SLACK_PROVIDER_ID,
        userId: user.id,
      });
    } catch (error) {
      const winner = await context.internalAdapter.findAccountByKey({ issuer, accountId });
      if (!input.expectedUserId) await context.internalAdapter.deleteUser(user.id).catch(() => {});
      if (!winner) throw error;
      if (input.expectedUserId && winner.userId !== input.expectedUserId) {
        throw new BetterAuthIdentityConflictError();
      }
      account = winner;
      user = await context.internalAdapter.findUserById(winner.userId);
      if (!user) throw new BetterAuthIdentityConflictError();
    }
  }

  const orgAdapter = getOrgAdapter(
    context as unknown as Parameters<typeof getOrgAdapter>[0],
  );
  let organizationRecord = await orgAdapter.findOrganizationBySlug(input.organization.slug);
  if (organizationRecord && input.organization.id && organizationRecord.id !== input.organization.id) {
    throw new BetterAuthIdentityConflictError('The Better Auth organization slug is already bound.');
  }
  organizationRecord ??= await orgAdapter.createOrganization({
    organization: {
      ...(input.organization.id ? { id: input.organization.id } : {}),
      createdAt: new Date(),
      name: input.organization.name,
      slug: input.organization.slug,
    },
  });

  let membership = await orgAdapter.findMemberByOrgId({
    userId: user.id,
    organizationId: organizationRecord.id,
  });
  if (membership && membership.role !== 'member') {
    throw new BetterAuthIdentityConflictError('Better Auth membership role must remain member.');
  }
  if (!membership) {
    let createError: unknown;
    try {
      await orgAdapter.createMember({
        organizationId: organizationRecord.id,
        role: 'member',
        userId: user.id,
      });
    } catch (error) {
      createError = error;
    }
    membership = await orgAdapter.findMemberByOrgId({
      userId: user.id,
      organizationId: organizationRecord.id,
    });
    if (!membership) throw createError ?? new Error('Better Auth membership was not created.');
  }
  if (membership.role !== 'member') {
    throw new BetterAuthIdentityConflictError('Better Auth membership role must remain member.');
  }

  return {
    providerId: BETTER_AUTH_SLACK_PROVIDER_ID,
    accountId,
    userId: user.id,
    organizationId: organizationRecord.id,
    membershipId: membership.id,
    membershipRole: 'member',
  };
}

function isActiveAdmission(
  value: BetterAuthAdmissionOperation | null,
  operationId: string,
): value is BetterAuthAdmissionOperation {
  return Boolean(value && value.operationId === operationId && value.status === 'active' &&
    (value.chickpeaRole === 'owner' || value.chickpeaRole === 'admin' || value.chickpeaRole === 'member'));
}

export function slackAccountId(teamId: string, userId: string): string {
  if (!/^[A-Za-z0-9]+$/.test(teamId) || !/^[A-Za-z0-9]+$/.test(userId)) {
    throw new Error('Canonical Slack team and user IDs are required.');
  }
  return `slack:${teamId}:${userId}`;
}

function opaqueIdentityEmail(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const local = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${local}@identity.invalid`;
}

export function requireSupportedOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopback = url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !loopback) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('invalid');
    return url.origin;
  } catch {
    throw new Error('A canonical HTTPS origin is required for Better Auth.');
  }
}
