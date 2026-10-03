import { APIError } from 'better-auth/api';
import { Hono } from 'hono';

import { InstallationContextError, requireInstallationScope } from '../config/installation-scope.ts';
import { getIdentityStore, type PlatformEnv } from '../config/state-backend.ts';
import type { BetterAuthPrincipalRecord, IdentityStore } from '../identity/types.ts';
import {
  BETTER_AUTH_SLACK_PROVIDER_ID,
  createBetterAuthSessionReader,
  requireSupportedOrigin,
} from './better-auth.ts';
import type { BetterAuthMembershipRecord } from './better-auth-backend.ts';
import { hostBetterAuthBackend, type BetterAuthEnvironment } from './better-auth-environment.ts';
import { BetterAuthDirectory } from './better-auth-principal.ts';
import { createBetterAuthPublicHandler, type BetterAuthPublicHandlerInput } from './better-auth-routes.ts';
import { betterAuthPublicRoutes } from './better-auth-runtime.ts';
import { setCookieValues } from './cookies.ts';
import {
  hostedLoginAgrees,
  withHostedLogin,
  type HostedLogin,
  type HostedRouteReads,
  type HostedSessionRead,
} from './hosted-login.ts';
import {
  betterAuthJwks,
  mcpAccessForbidden,
  mcpAuthorizationChallenge,
  mcpBearerToken,
  mountMcpOAuthBrowserRoutes,
  verifyMcpAccessToken,
} from './mcp-oauth-routes.ts';

/** A host's Better Auth and registry for one request. */
export interface HostedRouting<E extends PlatformEnv> {
  /** Better Auth on the host's request database, at the hosted origin. */
  environment: BetterAuthEnvironment;
  /**
   * The env serving the active installation of `login`'s Slack workspace:
   * scoped to it, with `environment.backend` attached
   * (resolveInstallationEnv over the host's registry). An unknown or
   * inactive installation throws InstallationContextError.
   */
  installationEnv(login: HostedLogin): Promise<E>;
  /**
   * Optional: a Better Auth user's Slack accounts and memberships, read by
   * the host in place of Better Auth's account read and the directory's
   * membership read. A host that reads them in the same statement as the
   * registry entry of the workspace the one Slack account names answers
   * `installationEnv` for that login from it, without reading again.
   */
  readLogin?(betterAuthUserId: string): Promise<HostedLoginRead>;
  /** The installation's identity store; by default its TagStateStore. */
  identity?: (env: E) => IdentityStore;
  /**
   * Client registration limits for the whole deployment, which every
   * installation shares: set `maxClients` (default 1,000 public clients not
   * used for 30 days) explicitly. Core's per-source window lives in a handler
   * that here serves one request, so it never trips; the host throttles
   * registration per source before calling.
   */
  mcpRegistrationPolicy?: BetterAuthPublicHandlerInput['mcpRegistrationPolicy'];
}

/** What `HostedRouting.readLogin` answers from Better Auth's tables for one user. */
export interface HostedLoginRead {
  /** The account ID (`slack:TEAM:USER`) of each of the user's accounts with the Slack provider. */
  readonly slackAccountIds: readonly string[];
  /** Every membership the user holds, in any organization. */
  readonly memberships: readonly BetterAuthMembershipRecord[];
}

/**
 * Where a request goes. `unauthenticated`: no valid credential, so a browser
 * signs in again. `refused`: the credential's installation is not active, or
 * what it stored disagrees with the credential; nothing names it. Both carry
 * Core's MCP answer for /mcp.
 */
export type HostedRoute<E extends PlatformEnv> =
  | { kind: 'installation'; env: E; login: HostedLogin }
  | { kind: 'unauthenticated'; response?: Response }
  | { kind: 'refused'; response?: Response };

const MCP_PATH = '/mcp';
const SLACK_ACCOUNT = /^slack:([A-Za-z0-9]+):([A-Za-z0-9]+)$/;
const SHARED_PATHS = new Set([
  '/api/auth',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server/api/auth',
  '/auth/mcp/login',
  '/auth/mcp/consent',
]);

/** Whether serveHostedSharedAuth answers `pathname`, whatever the method. */
export function isHostedSharedAuthPath(pathname: string): boolean {
  return SHARED_PATHS.has(pathname) || pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/auth/mcp/resume/');
}

/**
 * Answers a request that belongs to no installation (Better Auth is shared:
 * one origin, secret and database), or returns undefined for the host to
 * route; every token it issues waits for the user's installation to admit
 * them. Run it before routeHostedRequest. Throttle client
 * registration (`POST /api/auth/oauth2/register`) per source before it: no
 * installation's limiter applies here (see `mcpRegistrationPolicy`).
 */
export async function serveHostedSharedAuth<E extends PlatformEnv>(
  request: Request,
  routing: HostedRouting<E>,
): Promise<Response | undefined> {
  if (!isHostedSharedAuthPath(new URL(request.url).pathname)) return undefined;
  const logins = hostedLogins(routing.environment, routing.readLogin);
  const handler = createBetterAuthPublicHandler({
    ...routing.environment,
    mayIssueTokens: (betterAuthUserId) => mayIssueHostedTokens(routing, logins, betterAuthUserId),
    ...(routing.mcpRegistrationPolicy ? { mcpRegistrationPolicy: routing.mcpRegistrationPolicy } : {}),
  });
  const app = new Hono();
  app.route('/', betterAuthPublicRoutes((c) => handler(c.req.raw)));
  mountMcpOAuthBrowserRoutes(app, async () => routing.environment);
  return app.fetch(request);
}

/**
 * The installation a request belongs to, found from its credential alone
 * (its login, then the host's registry); its stored binding for the login
 * must agree. No organization ID, header or URL the client sends takes
 * part. Core's app then serves the returned env, whose directory serves a
 * principal only for that login. The env also carries what routing read:
 * the browser session (refreshed here when due, its cookies set by the
 * response that authenticates with it) and the installation's stored
 * principal, so Core's authenticator reads neither again. A response that
 * authenticates nobody (an Admin image, an OAuth callback) leaves a refresh's
 * cookies out; the browser's cookie then lapses at its earlier expiry unless
 * a later refresh, due a day on, reaches it.
 */
export async function routeHostedRequest<E extends PlatformEnv>(
  request: Request,
  routing: HostedRouting<E>,
): Promise<HostedRoute<E>> {
  const mcp = new URL(request.url).pathname === MCP_PATH;
  const presented = await presentedLogin(request, hostedLogins(routing.environment, routing.readLogin), { refresh: true });
  if (!presented) {
    return mcp
      ? {
          kind: 'unauthenticated',
          response: mcpAuthorizationChallenge(routing.environment.baseURL, mcpBearerToken(request) !== undefined),
        }
      : { kind: 'unauthenticated' };
  }
  const { login } = presented;
  const routed = await installationFor(routing, login);
  if (routed) {
    const reads: HostedRouteReads = {
      principal: routed.principal,
      ...(presented.session ? { session: presented.session } : {}),
      ...(presented.memberships ? { memberships: presented.memberships } : {}),
    };
    return { kind: 'installation', env: withHostedLogin(routed.env, login, reads), login };
  }
  return mcp ? { kind: 'refused', response: mcpAccessForbidden() } : { kind: 'refused' };
}

/**
 * The login a request presents before any installation serves it: the
 * Better Auth user of its browser session, or for /mcp of its MCP access
 * token, and that user's one Slack account. Undefined for a missing,
 * expired or invalid credential, or a user without exactly one Slack account.
 * It only reads: the session is not refreshed.
 */
export async function resolveHostedLogin(
  request: Request,
  environment: BetterAuthEnvironment,
): Promise<HostedLogin | undefined> {
  return (await presentedLogin(request, hostedLogins(environment), { refresh: false }))?.login;
}

async function presentedLogin(
  request: Request,
  logins: HostedLogins,
  options: { refresh: boolean },
): Promise<PresentedLogin | undefined> {
  if (new URL(request.url).pathname !== MCP_PATH) return logins.fromSession(request, options);
  const token = mcpBearerToken(request);
  return token ? logins.fromAccessToken(token) : undefined;
}

/** A login, and what reading it found on the way. */
interface PresentedLogin {
  login: HostedLogin;
  session?: HostedSessionRead;
  memberships?: readonly BetterAuthMembershipRecord[];
}

type HostedLogins = ReturnType<typeof hostedLogins>;

/**
 * Login lookups on the host's Better Auth, built on first use. This is
 * Better Auth before any installation, so it issues nothing: unlike
 * installationBetterAuth it has no installation's admission to issue for,
 * and it only reads (createBetterAuthSessionReader).
 */
function hostedLogins(environment: BetterAuthEnvironment, readLogin?: HostedRouting<PlatformEnv>['readLogin']) {
  let auth: ReturnType<typeof createBetterAuthSessionReader> | undefined;
  const betterAuth = () => auth ??= createBetterAuthSessionReader(environment);
  const forUser = async (betterAuthUserId: string): Promise<PresentedLogin | undefined> => {
    const read: Pick<HostedLoginRead, 'slackAccountIds'> & Partial<HostedLoginRead> = readLogin
      ? await readLogin(betterAuthUserId)
      : {
          slackAccountIds: (await (await betterAuth().$context).internalAdapter.findAccounts(betterAuthUserId))
            .filter((account) => account.providerId === BETTER_AUTH_SLACK_PROVIDER_ID)
            .map((account) => account.accountId),
        };
    // One login is one Slack account; Better Auth refuses linking a second.
    const match = read.slackAccountIds.length === 1 ? SLACK_ACCOUNT.exec(read.slackAccountIds[0]!) : null;
    if (!match) return undefined;
    return {
      login: { betterAuthUserId, slackTeamId: match[1]!, slackUserId: match[2]! },
      ...(read.memberships ? { memberships: read.memberships } : {}),
    };
  };
  return {
    forUser,
    /**
     * The session's login. With `refresh`, the one read of this request's
     * session also extends it when due, as Admin's authentication did.
     */
    async fromSession(request: Request, { refresh }: { refresh: boolean }): Promise<PresentedLogin | undefined> {
      const cookie = request.headers.get('cookie');
      if (!cookie) return undefined;
      // Chickpea's hook ends a session past its absolute expiry in this read.
      let result: { headers?: Headers; response?: { session?: { id?: unknown }; user?: { id?: unknown } } | null };
      try {
        result = await betterAuth().api.getSession({
          headers: request.headers,
          returnHeaders: true,
          ...(refresh ? {} : { query: { disableRefresh: true } }),
        }) as unknown as typeof result;
      } catch (error) {
        // Better Auth refused the session, as when it was deleted while being
        // refreshed. It wraps any other failure (the database's) as a server
        // error, which is not a sign-out.
        if (error instanceof APIError && error.status === 'UNAUTHORIZED') return undefined;
        throw error;
      }
      const betterAuthUserId = result.response?.user?.id;
      const sessionId = result.response?.session?.id;
      if (typeof betterAuthUserId !== 'string' || typeof sessionId !== 'string') return undefined;
      const presented = await forUser(betterAuthUserId);
      return presented && {
        ...presented,
        session: {
          id: sessionId,
          betterAuthUserId,
          cookie,
          setCookies: result.headers ? setCookieValues(result.headers) : [],
        },
      };
    },
    async fromAccessToken(token: string): Promise<PresentedLogin | undefined> {
      const claims = await verifyMcpAccessToken(token, {
        baseURL: environment.baseURL,
        getJwks: () => betterAuthJwks(betterAuth()),
      });
      return typeof claims?.sub === 'string' && claims.sub ? forUser(claims.sub) : undefined;
    },
  };
}

/**
 * The env serving `login`'s installation and what that installation stored
 * for the login; or undefined when no active installation serves its
 * workspace, or when the installation's stored binding for this Better Auth
 * user disagrees with the login's Slack account.
 */
async function installationFor<E extends PlatformEnv>(
  routing: HostedRouting<E>,
  login: HostedLogin,
): Promise<{ env: E; principal: BetterAuthPrincipalRecord } | undefined> {
  let env: E;
  try {
    env = await routing.installationEnv(login);
  } catch (error) {
    if (error instanceof InstallationContextError) return undefined;
    throw error;
  }
  if (!requireInstallationScope(env)) {
    throw new InstallationContextError('installation_context_missing', 'A host serves an installation with an env scoped to it.');
  }
  if (hostBetterAuthBackend(env) !== routing.environment.backend) {
    throw new Error('The installation env must carry the request\'s Better Auth backend.');
  }
  const principal = await identityOf(routing, env).resolveBetterAuthPrincipal(login.betterAuthUserId);
  if (!principal || !hostedLoginAgrees(login, principal.binding)) return undefined;
  return { env, principal };
}

/**
 * Whether Better Auth may issue MCP tokens to this user now: from a code or
 * a refresh token alike, only while their installation is active and they
 * hold an active membership there, decided as the MCP resource decides it.
 */
async function mayIssueHostedTokens<E extends PlatformEnv>(
  routing: HostedRouting<E>,
  logins: HostedLogins,
  betterAuthUserId: string,
): Promise<boolean> {
  const presented = await logins.forUser(betterAuthUserId);
  const routed = presented ? await installationFor(routing, presented.login) : undefined;
  if (!presented || !routed) return false;
  const identity = identityOf(routing, routed.env);
  const control = await identity.getAuthControl();
  const origin = requireSupportedOrigin(routing.environment.baseURL);
  if (control?.authMode !== 'slack_active' || control.healthGate !== 'normal' ||
      !control.betterAuthOrganizationId || control.canonicalAdminOrigin !== origin) return false;
  const resolution = await new BetterAuthDirectory({
    backend: routing.environment.backend,
    access: identity,
    organizationId: control.betterAuthOrganizationId,
    canonicalAdminOrigin: origin,
    hostedLogin: {
      login: presented.login,
      routed: { principal: routed.principal, ...(presented.memberships ? { memberships: presented.memberships } : {}) },
    },
  }).resolveBetterAuthUser(betterAuthUserId);
  return resolution?.membership.status === 'active';
}

function identityOf<E extends PlatformEnv>(routing: HostedRouting<E>, env: E): IdentityStore {
  return routing.identity ? routing.identity(env) : getIdentityStore(env);
}
