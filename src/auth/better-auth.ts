import type { betterAuth, BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import type { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import type { setSessionCookie } from 'better-auth/cookies';
import type { getOrgAdapter, jwt, organization } from 'better-auth/plugins';
import type { mcp } from '@better-auth/mcp';

import { onDemand } from '../runtime/on-demand.ts';
import {
  admitPendingMcpOAuthClient,
  DEFAULT_MCP_REGISTRATION_POLICY,
  type BetterAuthDatabaseBackend,
  type McpRegistrationPolicy,
  type McpRegistrationThrottle,
} from './better-auth-backend.ts';
import type { clientMetadataDiscovery, ClientMetadataFetch } from './mcp-client-metadata.ts';
import {
  MCP_OAUTH_SCOPES,
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
  /**
   * Asked before MCP tokens are issued to a user from a code or a refresh
   * token: false refuses with `invalid_grant`, leaving the refresh token
   * unrotated (a refused code is spent). A host serving many installations
   * answers from the user's installation, so a grant outlives neither its
   * membership nor an active installation. Not asked when the provider
   * replays a rotation within its 30-second reuse window: that returns the
   * tokens already issued, which the MCP resource and the next refresh
   * still check.
   */
  mayIssueTokens?: (betterAuthUserId: string) => Promise<boolean>;
  /** Bounds both dynamic registrations and clients first seen by their metadata document. */
  mcpRegistrationPolicy?: Partial<McpRegistrationPolicy>;
  /**
   * The per-source limit on new MCP clients: a response refusing this
   * request, or undefined to let it through. A dynamic registration, the
   * first sign-in of a client known by its metadata document, and every
   * later lookup of one no one has consented to pass it; any other stored
   * client never does. Without one only the pending bound applies.
   */
  throttleRegistration?: McpRegistrationThrottle;
  /**
   * Signs in a client by its accepted client ID metadata document. Off
   * unless serveHostedSharedAuth turns it on: a self-hosted deployment
   * registers every client dynamically.
   */
  clientMetadataDocuments?: boolean;
  /** Fetches client metadata documents; the guarded public-HTTPS transport by default. */
  fetchClientMetadataResource?: ClientMetadataFetch;
}

/** Better Auth's public client read, which the `mcp()` plugin cast hides from `auth.api`'s type. */
export interface PublicOAuthClientApi {
  getOAuthClientPublic(input: { query: { client_id: string }; headers: Headers }):
    Promise<{ client_name?: unknown } | null | undefined>;
}

interface BetterAuthModules {
  betterAuth: typeof betterAuth;
  APIError: typeof APIError;
  createAuthEndpoint: typeof createAuthEndpoint;
  createAuthMiddleware: typeof createAuthMiddleware;
  setSessionCookie: typeof setSessionCookie;
  getOrgAdapter: typeof getOrgAdapter;
  jwt: typeof jwt;
  organization: typeof organization;
  mcp: typeof mcp;
  clientMetadataDiscovery: typeof clientMetadataDiscovery;
}

/**
 * Better Auth, its plugins and the client metadata discovery (about 1 MiB
 * built), loaded by the first sign-in, session read or MCP request in an
 * isolate and never at Worker startup: a Slack turn needs none of it. The
 * factories below await it, so a caller cannot skip the load.
 */
const betterAuthModules = onDemand<BetterAuthModules>('Better Auth', async () => {
  const [core, api, cookies, plugins, mcpPlugin, clientMetadata] = await Promise.all([
    import('better-auth'),
    import('better-auth/api'),
    import('better-auth/cookies'),
    import('better-auth/plugins'),
    import('@better-auth/mcp'),
    import('./mcp-client-metadata.ts'),
  ]);
  return {
    betterAuth: core.betterAuth,
    APIError: api.APIError,
    createAuthEndpoint: api.createAuthEndpoint,
    createAuthMiddleware: api.createAuthMiddleware,
    setSessionCookie: cookies.setSessionCookie,
    getOrgAdapter: plugins.getOrgAdapter,
    jwt: plugins.jwt,
    organization: plugins.organization,
    mcp: mcpPlugin.mcp,
    clientMetadataDiscovery: clientMetadata.clientMetadataDiscovery,
  };
});

export async function createBetterAuth(input: CreateBetterAuthInput) {
  const baseURL = requireSupportedOrigin(input.baseURL);
  const internalMarker = Object.freeze({});
  const normalizedInput = { ...input, baseURL };
  const modules = await betterAuthModules.load();
  const auth = modules.betterAuth(createOptions(normalizedInput, internalMarker, modules));

  return Object.assign(auth, {
    chickpea: {
      reconcileSlackIdentity: (identity: ReconcileSlackIdentityInput) =>
        reconcileSlackIdentity(auth, identity, modules),
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

/**
 * Better Auth that only reads a request's session, a user's accounts and the
 * JWKS, as hosted routing does before an installation serves the request:
 * the same session settings and hooks, and keys of the same kind, with no
 * other plugin. Hosted routing builds one per request, and initializing the
 * MCP plugin costs a database read (its resource seed) each time. Its
 * get-session signs no JWT into a response header: Chickpea reads none, and
 * signing one costs another read. It also omits the oauth-provider's
 * databaseHooks.session.delete (back-channel logout), which Chickpea does not offer.
 */
export async function createBetterAuthSessionReader(input: Pick<CreateBetterAuthInput, 'backend' | 'baseURL' | 'secret'>) {
  const baseURL = requireSupportedOrigin(input.baseURL);
  const modules = await betterAuthModules.load();
  return modules.betterAuth({
    ...createOptions({ ...input, baseURL }, Object.freeze({}), modules),
    plugins: [modules.jwt({ ...JWT_OPTIONS, disableSettingJwtHeader: true })],
  });
}

/** Better Auth with Chickpea's seam, as createBetterAuth resolves it. */
export type ChickpeaBetterAuth = Awaited<ReturnType<typeof createBetterAuth>>;
/** The session-only Better Auth createBetterAuthSessionReader resolves. */
export type BetterAuthSessionReader = Awaited<ReturnType<typeof createBetterAuthSessionReader>>;

/** The production options are also the source of the pinned fresh-schema generator. */
export async function createBetterAuthOptions(input: CreateBetterAuthInput): Promise<BetterAuthOptions> {
  const baseURL = requireSupportedOrigin(input.baseURL);
  return createOptions({ ...input, baseURL }, Object.freeze({}), await betterAuthModules.load());
}

/**
 * Better Auth 1.7.0 to 1.7.2 keyed an account by `issuer`; 1.7.3 returned to
 * `providerId` and stopped writing it. Chickpea's databases keep the column,
 * NOT NULL under a unique index, so Chickpea writes the value 1.7.1 wrote for
 * its one provider, and an older release still reads every row.
 */
const ACCOUNT_ISSUER_FIELD = {
  type: 'string',
  required: true,
  input: false,
  defaultValue: `local:${BETTER_AUTH_SLACK_PROVIDER_ID}`,
} as const;

const JWT_OPTIONS = {
  jwks: {
    keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' },
    rotationInterval: 30 * 24 * 60 * 60,
    gracePeriod: 30 * 24 * 60 * 60,
  },
} as const satisfies Parameters<typeof jwt>[0];

function createOptions(
  input: CreateBetterAuthInput & { baseURL: string },
  internalMarker: object,
  modules: BetterAuthModules,
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
      additionalFields: { issuer: ACCOUNT_ISSUER_FIELD },
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
      after: modules.createAuthMiddleware(async (ctx) => {
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
      database: {
        generateId: 'uuid',
        ...(input.backend.nativeJoins ? { joins: true } : {}),
        // Chickpea builds Better Auth per request, and the check reads every
        // table's shape again each time. Reviewed migrations own the schema.
        validateSchema: false,
      },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] },
      useSecureCookies: secureCookies,
    },
    plugins: [
      modules.organization({
        allowUserToCreateOrganization: false,
        cancelPendingInvitationsOnReInvite: true,
        invitationExpiresIn: 7 * 24 * 60 * 60,
        async sendInvitationEmail() {},
      }),
      modules.jwt(JWT_OPTIONS),
      modules.mcp({
        resource: mcpResourceForOrigin(input.baseURL),
        loginPage: '/auth/mcp/login',
        consentPage: '/auth/mcp/consent',
        // offline_access enables renewable client sessions. The MCP plugin keeps
        // this authorization-server scope out of protected-resource metadata.
        scopes: [...MCP_OAUTH_SCOPES],
        grantTypes: ['authorization_code', 'refresh_token'],
        accessTokenExpiresIn: 15 * 60,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        codeExpiresIn: 10 * 60,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: [...MCP_OAUTH_SCOPES],
        clientRegistrationAllowedScopes: [],
        clientRegistrationRequirePKCE: true,
        ...(input.clientMetadataDocuments === true ? {
          extensions: [{
            clientDiscovery: modules.clientMetadataDiscovery(input.fetchClientMetadataResource, {
              throttle: input.throttleRegistration,
              admitPending: () =>
                admitPendingMcpOAuthClient(input.backend, { ...DEFAULT_MCP_REGISTRATION_POLICY, ...input.mcpRegistrationPolicy }),
            }, input.baseURL),
          }],
        } : {}),
        ...(input.mayIssueTokens ? { customTokenResponseFields: tokenIssuanceGate(input.mayIssueTokens, modules.APIError) } : {}),
      }) as unknown as BetterAuthPlugin,
      createPrivateSessionPlugin(input.privateSeam, internalMarker, modules),
    ],
    telemetry: { enabled: false },
  };
}

/**
 * The provider calls this before it creates any token row for a code or
 * refresh grant (after spending the code), so throwing refuses the grant
 * and leaves a presented refresh token unrotated.
 */
function tokenIssuanceGate(
  mayIssueTokens: (betterAuthUserId: string) => Promise<boolean>,
  APIError: BetterAuthModules['APIError'],
) {
  return async ({ user }: { user?: { id?: unknown } | null }): Promise<Record<string, unknown>> => {
    if (typeof user?.id !== 'string' || !(await mayIssueTokens(user.id))) {
      throw new APIError('BAD_REQUEST', {
        error: 'invalid_grant',
        error_description: 'Current Chickpea access does not permit this grant.',
      });
    }
    return {};
  };
}

function createPrivateSessionPlugin(
  seam: BetterAuthPrivateSeam | undefined,
  internalMarker: object,
  modules: BetterAuthModules,
): BetterAuthPlugin {
  return {
    id: 'chickpea-private-session',
    endpoints: {
      issueChickpeaSession: modules.createAuthEndpoint(
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
            providerId: BETTER_AUTH_SLACK_PROVIDER_ID,
            accountId: slackAccountId(admission.slackTeamId, admission.slackUserId),
          });
          const user = await ctx.context.internalAdapter.findUserById(admission.betterAuthUserId);
          const member = await modules.getOrgAdapter(ctx.context).findMemberByOrgId({
            userId: admission.betterAuthUserId,
            organizationId: admission.betterAuthOrganizationId,
          });
          if (!account || account.userId !== admission.betterAuthUserId || !user || !member ||
              member.id !== admission.betterAuthMembershipId || member.role !== 'member') {
            throw ctx.error('FORBIDDEN', { message: 'Active Chickpea authority is required.' });
          }

          const session = await ctx.context.internalAdapter.createSession(user.id);
          await modules.setSessionCookie(ctx, { session, user });
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
  modules: BetterAuthModules,
): Promise<ReconciledSlackIdentity> {
  const accountId = slackAccountId(input.slackTeamId, input.slackUserId);
  const accountKey = { providerId: BETTER_AUTH_SLACK_PROVIDER_ID, accountId };
  const context = await auth.$context;
  let account = await context.internalAdapter.findAccountByKey(accountKey);
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
      account = await context.internalAdapter.createAccount({ ...accountKey, userId: user.id });
    } catch (error) {
      const winner = await context.internalAdapter.findAccountByKey(accountKey);
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

  const orgAdapter = modules.getOrgAdapter(
    context as unknown as Parameters<BetterAuthModules['getOrgAdapter']>[0],
  );
  let organizationRecord = await orgAdapter.findOrganizationBySlug(input.organization.slug);
  if (!organizationRecord) {
    try {
      organizationRecord = await orgAdapter.createOrganization({
        organization: {
          ...(input.organization.id ? { id: input.organization.id } : {}),
          createdAt: new Date(),
          name: input.organization.name,
          slug: input.organization.slug,
        },
      });
    } catch (error) {
      // A concurrent first sign-in may have created it; the slug is unique.
      organizationRecord = await orgAdapter.findOrganizationBySlug(input.organization.slug);
      if (!organizationRecord) throw error;
    }
  }
  if (input.organization.id && organizationRecord.id !== input.organization.id) {
    throw new BetterAuthIdentityConflictError('The Better Auth organization slug is already bound.');
  }

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
