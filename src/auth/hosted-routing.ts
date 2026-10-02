import { Hono } from 'hono';
import type { JWK } from 'jose';

import { InstallationContextError, requireInstallationScope } from '../config/installation-scope.ts';
import { getIdentityStore, type PlatformEnv } from '../config/state-backend.ts';
import type { IdentityStore } from '../identity/types.ts';
import { BETTER_AUTH_SLACK_PROVIDER_ID, createBetterAuth, requireSupportedOrigin } from './better-auth.ts';
import { hostBetterAuthBackend, type BetterAuthEnvironment } from './better-auth-environment.ts';
import { BetterAuthDirectory } from './better-auth-principal.ts';
import { createBetterAuthPublicHandler } from './better-auth-routes.ts';
import { betterAuthPublicRoutes } from './better-auth-runtime.ts';
import { hostedLoginAgrees, withHostedLogin, type HostedLogin } from './hosted-login.ts';
import {
  mcpAccessForbidden,
  mcpAuthorizationChallenge,
  mcpBearerToken,
  mountMcpOAuthBrowserRoutes,
  verifyMcpAccessToken,
} from './mcp-oauth-routes.ts';

// How a host serving many installations hands Core its requests. All of
// Better Auth is shared: one origin, one secret, one database (PostgreSQL).
//
// 1. serveHostedSharedAuth answers what belongs to no installation (OAuth
//    discovery, JWKS, client registration, authorize, consent, token and
//    refresh, revoke, sign-out, the MCP sign-in continuation and consent
//    pages). Every token it issues is first checked against the user's
//    installation.
// 2. routeHostedRequest finds the installation of everything else from its
//    credential alone: the browser session (for /mcp, the MCP access token)
//    names a Better Auth user, the user's one Slack account names a
//    workspace, and the host's registry names that workspace's active
//    installation. The installation's stored binding must agree.
// 3. Core's application serves the request with the env that returns. The
//    installation's directory serves a principal only for that login.

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
  /** The installation's identity store; by default its TagStateStore. */
  identity?: (env: E) => IdentityStore;
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
 * Answers a request that belongs to no installation, or returns undefined
 * for the host to route. Run it before routeHostedRequest. The host's own
 * throttle should precede client registration (`POST /api/auth/oauth2/register`):
 * Core's per-installation limiter has no installation here.
 */
export async function serveHostedSharedAuth<E extends PlatformEnv>(
  request: Request,
  routing: HostedRouting<E>,
): Promise<Response | undefined> {
  if (!isHostedSharedAuthPath(new URL(request.url).pathname)) return undefined;
  const logins = hostedLogins(routing.environment);
  const handler = createBetterAuthPublicHandler({
    ...routing.environment,
    mayIssueTokens: (betterAuthUserId) => mayIssueHostedTokens(routing, logins, betterAuthUserId),
  });
  const app = new Hono();
  app.route('/', betterAuthPublicRoutes((c) => handler(c.req.raw)));
  mountMcpOAuthBrowserRoutes(app, async () => routing.environment);
  return app.fetch(request);
}

/**
 * The installation a request belongs to, found from its credential: the
 * browser session, or for /mcp the MCP access token. No organization ID,
 * header or URL the client sends takes part.
 */
export async function routeHostedRequest<E extends PlatformEnv>(
  request: Request,
  routing: HostedRouting<E>,
): Promise<HostedRoute<E>> {
  const logins = hostedLogins(routing.environment);
  if (new URL(request.url).pathname === MCP_PATH) {
    const token = mcpBearerToken(request);
    const login = token ? await logins.fromAccessToken(token) : undefined;
    if (!login) {
      return {
        kind: 'unauthenticated',
        response: mcpAuthorizationChallenge(routing.environment.baseURL, token !== undefined),
      };
    }
    const env = await installationFor(routing, login);
    return env ? { kind: 'installation', env, login } : { kind: 'refused', response: mcpAccessForbidden() };
  }
  const login = await logins.fromSession(request);
  if (!login) return { kind: 'unauthenticated' };
  const env = await installationFor(routing, login);
  return env ? { kind: 'installation', env, login } : { kind: 'refused' };
}

/**
 * The login a request presents before any installation serves it: the
 * Better Auth user of its browser session, or for /mcp of its MCP access
 * token, and that user's one Slack account. Undefined for a missing,
 * expired or invalid credential, or a user without exactly one Slack account.
 */
export async function resolveHostedLogin(
  request: Request,
  environment: BetterAuthEnvironment,
): Promise<HostedLogin | undefined> {
  const logins = hostedLogins(environment);
  if (new URL(request.url).pathname !== MCP_PATH) return logins.fromSession(request);
  const token = mcpBearerToken(request);
  return token ? logins.fromAccessToken(token) : undefined;
}

type HostedLogins = ReturnType<typeof hostedLogins>;

/**
 * Login lookups on the host's Better Auth, built on first use. This is
 * Better Auth before any installation, so it issues nothing: unlike
 * installationBetterAuth it has no installation's admission to issue for.
 */
function hostedLogins(environment: BetterAuthEnvironment) {
  let auth: ReturnType<typeof createBetterAuth> | undefined;
  const betterAuth = () => auth ??= createBetterAuth(environment);
  const forUser = async (betterAuthUserId: string): Promise<HostedLogin | undefined> => {
    const context = await betterAuth().$context;
    const accounts = (await context.internalAdapter.findAccounts(betterAuthUserId))
      .filter((account) => account.providerId === BETTER_AUTH_SLACK_PROVIDER_ID);
    // One login is one Slack account; Better Auth refuses linking a second.
    const match = accounts.length === 1 ? SLACK_ACCOUNT.exec(accounts[0]!.accountId) : null;
    return match ? { betterAuthUserId, slackTeamId: match[1]!, slackUserId: match[2]! } : undefined;
  };
  return {
    forUser,
    async fromSession(request: Request): Promise<HostedLogin | undefined> {
      if (!request.headers.get('cookie')) return undefined;
      // Read only: the installation's own authenticator refreshes the session
      // (and Chickpea's hook still ends one past its absolute expiry here).
      const result = await betterAuth().api.getSession({
        headers: request.headers,
        query: { disableRefresh: true },
      }) as { user?: { id?: unknown } } | null;
      const betterAuthUserId = result?.user?.id;
      return typeof betterAuthUserId === 'string' ? forUser(betterAuthUserId) : undefined;
    },
    async fromAccessToken(token: string): Promise<HostedLogin | undefined> {
      const claims = await verifyMcpAccessToken(token, {
        baseURL: environment.baseURL,
        getJwks: async () => {
          const api = betterAuth().api as unknown as { getJwks(): Promise<{ keys?: JWK[] }> };
          const result = await api.getJwks();
          return { keys: Array.isArray(result.keys) ? result.keys : [] };
        },
      });
      return typeof claims?.sub === 'string' && claims.sub ? forUser(claims.sub) : undefined;
    },
  };
}

/**
 * The env Core serves `login`'s installation with, carrying the login; or
 * undefined when no active installation serves its workspace, or when the
 * installation's stored binding for this Better Auth user disagrees with
 * the login's Slack account.
 */
async function installationFor<E extends PlatformEnv>(
  routing: HostedRouting<E>,
  login: HostedLogin,
): Promise<E | undefined> {
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
  const stored = await identityOf(routing, env).resolveBetterAuthIdentity(login.betterAuthUserId);
  if (!stored || !hostedLoginAgrees(login, stored.binding)) return undefined;
  return withHostedLogin(env, login);
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
  const login = await logins.forUser(betterAuthUserId);
  const env = login ? await installationFor(routing, login) : undefined;
  if (!login || !env) return false;
  const identity = identityOf(routing, env);
  const control = await identity.getAuthControl();
  const origin = requireSupportedOrigin(routing.environment.baseURL);
  if (control?.authMode !== 'slack_active' || control.healthGate !== 'normal' ||
      !control.betterAuthOrganizationId || control.canonicalAdminOrigin !== origin) return false;
  const resolution = await new BetterAuthDirectory({
    backend: routing.environment.backend,
    access: identity,
    organizationId: control.betterAuthOrganizationId,
    canonicalAdminOrigin: origin,
    hostedLogin: { login },
  }).resolveBetterAuthUser(betterAuthUserId);
  return resolution?.membership.status === 'active';
}

function identityOf<E extends PlatformEnv>(routing: HostedRouting<E>, env: E): IdentityStore {
  return routing.identity ? routing.identity(env) : getIdentityStore(env);
}
