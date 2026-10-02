import { deploymentTenancy } from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { Organization, SlackIdentityBinding } from '../identity/types.ts';

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

/**
 * What an installation's directory holds a principal to under installation
 * tenancy: the login the request was routed by, or none, in which case it
 * serves no principal at all.
 */
export interface HostedLoginFence {
  readonly login: HostedLogin | undefined;
}

const HOSTED_LOGIN = Symbol('chickpea.hosted-login');

/**
 * The installation env Core serves `login`'s request with. The login rides
 * in a frozen copy under a module-private symbol, like the installation
 * scope and the Better Auth backend, so no request payload can supply one;
 * the input is never changed.
 */
export function withHostedLogin<E extends PlatformEnv>(env: E, login: HostedLogin): E {
  const current = hostedLoginOf(env);
  if (current) {
    if (sameLogin(current, login)) return env;
    throw new Error('The env already carries another login.');
  }
  return Object.freeze({
    ...env,
    [HOSTED_LOGIN]: Object.freeze({
      betterAuthUserId: login.betterAuthUserId,
      slackTeamId: login.slackTeamId,
      slackUserId: login.slackUserId,
    }),
  });
}

export function hostedLoginOf(env: PlatformEnv | undefined): HostedLogin | undefined {
  return (env as { [HOSTED_LOGIN]?: HostedLogin } | undefined)?.[HOSTED_LOGIN];
}

/** Standalone: no fence. Installation tenancy: the request's login, if the host routed it by one. */
export function hostedLoginFence(env: PlatformEnv | undefined): HostedLoginFence | undefined {
  return deploymentTenancy(env) === 'installation' ? { login: hostedLoginOf(env) } : undefined;
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
