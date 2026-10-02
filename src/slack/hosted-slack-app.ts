import {
  deploymentTenancy,
  InstallationContextError,
} from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import {
  HOSTED_SLACK_INSTALLATION_ID,
  WORKSPACE_SLACK_INSTALLATION_ID,
} from '../config/types.ts';

/**
 * The Slack app of a host serving many installations, and the rules that tie
 * one of its deliveries to one installation.
 *
 * A standalone deployment owns its Slack app: the app's signing secret and
 * the bot token live together in its own encrypted bundle. A deployment with
 * installation tenancy runs one app for every installation. The host verifies
 * each delivery with that app's signing secret, finds the installation from
 * the verified body, and hands Core the app with the installation's env; the
 * installation's store holds only its bot token.
 */
export interface HostedSlackApp {
  readonly appId: string;
  readonly signingSecret: string;
}

const HOSTED_SLACK_APP = Symbol('chickpea.hosted-slack-app');
const SLACK_ID = /^[A-Z][A-Z0-9]{1,63}$/;

/**
 * The installation env Core serves a hosted Slack delivery with. The app
 * rides in a frozen copy under a module-private symbol, like the installation
 * scope and the Better Auth backend, so no payload or deployment variable can
 * supply a signing secret; the input is never changed.
 */
export function withHostedSlackApp<E extends PlatformEnv>(env: E, app: HostedSlackApp): E {
  if (deploymentTenancy(env) !== 'installation') {
    throw new InstallationContextError(
      'installation_context_invalid',
      'Only a deployment serving many installations runs a hosted Slack app.',
    );
  }
  if (!SLACK_ID.test(app.appId) || typeof app.signingSecret !== 'string' || !app.signingSecret.trim()) {
    throw new InstallationContextError('installation_context_invalid', 'The hosted Slack app is malformed.');
  }
  const current = hostedSlackAppOf(env);
  if (current) {
    if (current.appId === app.appId && current.signingSecret === app.signingSecret) return env;
    throw new InstallationContextError(
      'installation_context_mismatch',
      'The env already carries another hosted Slack app.',
    );
  }
  return Object.freeze({
    ...env,
    [HOSTED_SLACK_APP]: Object.freeze({ appId: app.appId, signingSecret: app.signingSecret }),
  });
}

/** The app a host attached with withHostedSlackApp, if any. */
export function hostedSlackAppOf(env: PlatformEnv | undefined): HostedSlackApp | undefined {
  return (env as { [HOSTED_SLACK_APP]?: HostedSlackApp } | undefined)?.[HOSTED_SLACK_APP];
}

/**
 * Where this deployment keeps the Slack bot it acts as: the installation's own
 * bot-only bundle under installation tenancy, the customer-owned app's bundle
 * on standalone. Every runtime Slack read asks this rather than defaulting.
 */
export function slackInstallationCredentialId(
  env: PlatformEnv | undefined,
): typeof HOSTED_SLACK_INSTALLATION_ID | typeof WORKSPACE_SLACK_INSTALLATION_ID {
  return deploymentTenancy(env) === 'installation'
    ? HOSTED_SLACK_INSTALLATION_ID
    : WORKSPACE_SLACK_INSTALLATION_ID;
}

/**
 * Refuses a read of the other mode's slot, so a call site that still names
 * the standalone slot under installation tenancy fails loudly instead of
 * finding nothing. A caller that passes no env names its store explicitly
 * (the hosted sign-in port does) and is not checked.
 */
export function assertSlackInstallationCredentialId(
  identityId: string,
  env: PlatformEnv | undefined,
): void {
  if (!env) return;
  if (identityId !== HOSTED_SLACK_INSTALLATION_ID && identityId !== WORKSPACE_SLACK_INSTALLATION_ID) return;
  if (identityId !== slackInstallationCredentialId(env)) {
    throw new InstallationContextError(
      'installation_context_mismatch',
      identityId === WORKSPACE_SLACK_INSTALLATION_ID
        ? 'A deployment serving many installations has no standalone Slack credentials.'
        : 'A standalone deployment has no hosted Slack credentials.',
    );
  }
}

export type HostedSlackDropReason =
  | 'malformed'
  | 'enterprise'
  | 'context_mismatch'
  | 'shared_without_authorization'
  | 'foreign_team';

/** The installation a verified delivery belongs to, or why it belongs to none. */
export type HostedSlackDeliveryRoute =
  | { readonly route: 'installation'; readonly teamId: string }
  | { readonly route: 'drop'; readonly reason: HostedSlackDropReason };

/**
 * The installation a verified Events API delivery is for. Read it only from a
 * body whose signature was verified. The receiving workspace comes from
 * Slack's authorization (one installation that can see the event), never
 * from `team_id` alone, and must agree with `context_team_id`. Without an
 * authorization an event in a channel shared between organizations is
 * refused. An event that happened in another workspace than the receiving one
 * is dropped too: Core keys every record, claim and budget on `team_id`, so
 * acting on it would mix workspaces. Org-wide installs are never served.
 */
export function hostedSlackEventRoute(payload: unknown): HostedSlackDeliveryRoute {
  const body = asRecord(payload);
  const teamId = slackId(body?.team_id);
  if (!body || !teamId) return drop('malformed');
  const authorizations = body.authorizations ?? [];
  if (!Array.isArray(authorizations)) return drop('malformed');
  let receiving: string | undefined;
  if (authorizations.length > 0) {
    const authorization = asRecord(authorizations[0]);
    if (!authorization) return drop('malformed');
    if (authorization.is_enterprise_install === true) return drop('enterprise');
    receiving = slackId(authorization.team_id);
    if (!receiving) return drop('malformed');
  } else {
    if (body.is_ext_shared_channel === true) return drop('shared_without_authorization');
    receiving = teamId;
  }
  if (body.context_team_id !== undefined && body.context_team_id !== null &&
      body.context_team_id !== receiving) return drop('context_mismatch');
  if (teamId !== receiving) return drop('foreign_team');
  return { route: 'installation', teamId: receiving };
}

/**
 * The installation a verified interaction is for. Interactions carry no
 * authorization, so the signed `team.id` decides; a click on a card of
 * another installation finds no surface there and is refused by Core.
 */
export function hostedSlackInteractionRoute(payload: unknown): HostedSlackDeliveryRoute {
  const body = asRecord(payload);
  if (!body) return drop('malformed');
  if (body.is_enterprise_install === true) return drop('enterprise');
  const teamId = slackId(asRecord(body.team)?.id);
  return teamId ? { route: 'installation', teamId } : drop('malformed');
}

/**
 * What a verified `app_uninstalled` or `tokens_revoked` means for the
 * installation it reached: undefined for any other event. An event older than
 * the installation is about an earlier installation of the workspace and is
 * `stale`; Slack's `event_time` has whole seconds, so the installation's own
 * second still counts as current. Revoking people's user tokens (Sign in with
 * Slack issues them) never ends an installation: only its bot's token does.
 */
export function hostedSlackLifecycleOutcome(
  payload: unknown,
  installation: { readonly installedAt: number; readonly botUserId?: string | null | undefined },
): 'end' | 'stale' | 'user_tokens_only' | undefined {
  const body = asRecord(payload);
  const event = asRecord(body?.event);
  if (event?.type !== 'app_uninstalled' && event?.type !== 'tokens_revoked') return undefined;
  const eventTime = body?.event_time;
  if (typeof eventTime === 'number' && Number.isFinite(eventTime) &&
      eventTime < Math.floor(installation.installedAt / 1_000)) return 'stale';
  if (event.type === 'app_uninstalled') return 'end';
  const bots = asRecord(event.tokens)?.bot;
  const revoked = Array.isArray(bots) ? bots.filter((id): id is string => typeof id === 'string') : [];
  const endsBot = installation.botUserId
    ? revoked.includes(installation.botUserId)
    : revoked.length > 0;
  return endsBot ? 'end' : 'user_tokens_only';
}

function drop(reason: HostedSlackDropReason): HostedSlackDeliveryRoute {
  return { route: 'drop', reason };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function slackId(value: unknown): string | undefined {
  return typeof value === 'string' && SLACK_ID.test(value) ? value : undefined;
}
