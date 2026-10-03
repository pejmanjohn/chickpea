import { deploymentTenancy, installationScopeOf } from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { BetterAuthPrincipalRecord, Organization, SlackIdentityBinding } from '../identity/types.ts';
import type { BetterAuthMembershipRecord } from './better-auth-backend.ts';

/**
 * The login a host serving many installations found a request's
 * installation from: a Better Auth user and the one Slack account it signs
 * in with. A login is one Slack account `(team, user)`, so its workspace, and
 * through the host's registry its installation, comes from the credential
 * itself; no organization ID, header or URL a client sends takes part.
 */
export interface HostedLogin {
  readonly betterAuthUserId: string;
  readonly slackTeamId: string;
  readonly slackUserId: string;
}

/** The browser session hosted routing read, and refreshed when due, for one request. */
export interface HostedSessionRead {
  readonly id: string;
  readonly betterAuthUserId: string;
  /** The request's Cookie header: the read serves only a request presenting the same one. */
  readonly cookie: string;
  /** Set-Cookie values from refreshing it, for the response that authenticates with it. */
  readonly setCookies: readonly string[];
}

/**
 * What hosted routing read for its login while it found the request's
 * installation, so the installation's authenticator and directory do not
 * read it again. Only Core's routing attaches it (withHostedLogin), and it
 * serves only the env of the installation it was read from.
 */
export interface HostedRouteReads {
  /** The browser session; none for an MCP access token. */
  readonly session?: HostedSessionRead;
  /** What the installation stored for the login (resolveBetterAuthPrincipal), whose binding routing checked. */
  readonly principal: BetterAuthPrincipalRecord;
  /** Every Better Auth membership of the login's user, when the host read them with its accounts. */
  readonly memberships?: readonly BetterAuthMembershipRecord[];
}

/**
 * What an installation's directory holds a principal to under installation
 * tenancy: the login the request was routed by, or none, in which case it
 * serves no principal at all; and what routing already read for that login.
 */
export interface HostedLoginFence {
  readonly login: HostedLogin | undefined;
  readonly routed?: HostedRouteReads;
}

const HOSTED_LOGIN = Symbol('chickpea.hosted-login');
const HOSTED_ROUTE_READS = Symbol('chickpea.hosted-route-reads');

interface CarriedReads {
  readonly installationId: string;
  readonly reads: HostedRouteReads;
}

/**
 * The installation env Core serves `login`'s request with. The login, and
 * what routing read for it, ride in a frozen copy under module-private
 * symbols, like the installation scope and the Better Auth backend, so no
 * request payload can supply them; the input is never changed.
 */
export function withHostedLogin<E extends PlatformEnv>(env: E, login: HostedLogin, reads?: HostedRouteReads): E {
  const current = hostedLoginOf(env);
  if (current) {
    if (!sameLogin(current, login)) throw new Error('The env already carries another login.');
    if (reads) throw new Error('Routing attaches its reads together with the login.');
    return env;
  }
  const installationId = installationScopeOf(env)?.installationId;
  if (reads && !installationId) throw new Error('Routing reads ride only on an installation\'s env.');
  return Object.freeze({
    ...env,
    [HOSTED_LOGIN]: Object.freeze({
      betterAuthUserId: login.betterAuthUserId,
      slackTeamId: login.slackTeamId,
      slackUserId: login.slackUserId,
    }),
    ...(reads && installationId
      ? { [HOSTED_ROUTE_READS]: Object.freeze({ installationId, reads: Object.freeze({ ...reads }) }) satisfies CarriedReads }
      : {}),
  });
}

export function hostedLoginOf(env: PlatformEnv | undefined): HostedLogin | undefined {
  return (env as { [HOSTED_LOGIN]?: HostedLogin } | undefined)?.[HOSTED_LOGIN];
}

/**
 * Standalone: no fence. Installation tenancy: the request's login, if the
 * host routed it by one, and what routing read for it on this same
 * installation.
 */
export function hostedLoginFence(env: PlatformEnv | undefined): HostedLoginFence | undefined {
  if (deploymentTenancy(env) !== 'installation') return undefined;
  const login = hostedLoginOf(env);
  const carried = (env as { [HOSTED_ROUTE_READS]?: CarriedReads } | undefined)?.[HOSTED_ROUTE_READS];
  return login && carried && carried.installationId === installationScopeOf(env)?.installationId
    ? { login, routed: carried.reads }
    : { login };
}

/**
 * Whether what an installation stored when this person signed in (their
 * Slack binding and, when given, the installation's organization) agrees
 * with the login's own Slack account. Any disagreement fails closed.
 */
export function hostedLoginAgrees(
  login: HostedLogin,
  binding: Pick<SlackIdentityBinding, 'betterAuthUserId' | 'slackTeamId' | 'slackUserId'>,
  organization?: Pick<Organization, 'slackTeamId'>,
): boolean {
  return binding.betterAuthUserId === login.betterAuthUserId &&
    binding.slackTeamId === login.slackTeamId &&
    binding.slackUserId === login.slackUserId &&
    (organization === undefined || organization.slackTeamId === login.slackTeamId);
}

function sameLogin(a: HostedLogin, b: HostedLogin): boolean {
  return a.betterAuthUserId === b.betterAuthUserId && a.slackTeamId === b.slackTeamId &&
    a.slackUserId === b.slackUserId;
}
