/**
 * The only file a host imports from this module: the port it installs, the
 * ingress facts it needs before trusting a delivery, the lifecycle end of one
 * Agent app, the handoff that carries a verified delivery or an Owner into
 * Core, and the retirement of every Agent app when a tenant ends.
 */
import {
  deploymentTenancy,
  InstallationContextError,
} from '../../config/installation-scope.ts';
import type { PlatformEnv } from '../../config/state-backend.ts';
import { agentAppIngressFacts, endAgentSlackAppLive, retireAgentSlackAppsLive } from './live.ts';

export interface AgentSlackAppsHost {
  /** Slack Request URLs for one app; only the host holds the path-token key. Pure; throws on a malformed ID. */
  requestUrls(installationId: string, appId: string): { readonly events: string; readonly interactions: string };
  /** The one OAuth redirect URI every Agent app's manifest lists: the host's callback route. */
  readonly redirectUri: string;
  /** Where "Allow <Agent> in Slack" sends the Owner: the host's allow route. */
  allowUrl(agentId: string): string;
}

let installedHost: AgentSlackAppsHost | undefined;

/** The port's presence is the whole feature gate: without it nothing shows, serves or runs. */
export function configureAgentSlackApps(host: AgentSlackAppsHost | undefined): void {
  installedHost = host;
}

export function agentSlackAppsHost(): AgentSlackAppsHost | undefined {
  return installedHost;
}

/** What a host's ingress needs before it trusts a delivery. */
export interface AgentSlackAppIngress {
  readonly agentId: string;
  readonly teamId: string;
  readonly signingSecret: string;
}

/** Undefined when this installation has no Agent app with that ID (unknown, or deleted). Throws on a store outage or an unreadable envelope. */
export function agentSlackAppIngress(env: PlatformEnv, appId: string): Promise<AgentSlackAppIngress | undefined> {
  return agentAppIngressFacts(env, appId);
}

/** A verified app_uninstalled or tokens_revoked of one Agent app: ends only that Agent's app, never the installation. */
export function endAgentSlackApp(
  env: PlatformEnv,
  appId: string,
  payload: Record<string, unknown>,
): Promise<'ended' | 'ignored'> {
  return endAgentSlackAppLive(env, appId, payload);
}

export type AgentSlackAppHandoff =
  | { readonly kind: 'delivery'; readonly agentId: string; readonly appId: string; readonly signingSecret: string }
  | { readonly kind: 'owner'; readonly slackUserId: string };

const HANDOFF = Symbol('chickpea.agent-slack-app-handoff');
const SLACK_ID = /^[A-Z][A-Z0-9]{1,63}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A frozen env copy with the handoff under a module-private symbol, so no
 * payload or deployment variable can supply a signing secret or an Owner.
 * Throws outside installation tenancy, on a malformed handoff, or when one is
 * already attached; the input is never changed.
 */
export function withAgentSlackAppHandoff<E extends PlatformEnv>(env: E, handoff: AgentSlackAppHandoff): E {
  if (deploymentTenancy(env) !== 'installation') {
    throw new InstallationContextError(
      'installation_context_invalid',
      'Only a deployment serving many installations hands Core an Agent app.',
    );
  }
  if (!handoffIsWellFormed(handoff)) {
    throw new InstallationContextError('installation_context_invalid', 'The Agent app handoff is malformed.');
  }
  if (agentSlackAppHandoffOf(env)) {
    throw new InstallationContextError('installation_context_mismatch', 'The env already carries an Agent app handoff.');
  }
  return Object.freeze({ ...env, [HANDOFF]: Object.freeze({ ...handoff }) });
}

/** The handoff a host attached with withAgentSlackAppHandoff, if any. */
export function agentSlackAppHandoffOf(env: PlatformEnv | undefined): AgentSlackAppHandoff | undefined {
  return (env as { [HANDOFF]?: AgentSlackAppHandoff } | undefined)?.[HANDOFF];
}

function handoffIsWellFormed(handoff: AgentSlackAppHandoff): boolean {
  if (!handoff || typeof handoff !== 'object') return false;
  if (handoff.kind === 'owner') return typeof handoff.slackUserId === 'string' && SLACK_ID.test(handoff.slackUserId);
  if (handoff.kind !== 'delivery') return false;
  return typeof handoff.agentId === 'string' && AGENT_ID.test(handoff.agentId) &&
    typeof handoff.appId === 'string' && SLACK_ID.test(handoff.appId) &&
    typeof handoff.signingSecret === 'string' && handoff.signingSecret.trim().length > 0;
}

export interface AgentAppRetirement {
  readonly agentId: string;
  readonly outcome: 'removed' | 'uninstalled_left_definition' | 'left_for_owner';
}

/** Tenant end: uninstalls and deletes every Agent app of the env's installation. Never throws for one app. */
export function retireAgentSlackApps(env: PlatformEnv): Promise<readonly AgentAppRetirement[]> {
  return retireAgentSlackAppsLive(env);
}
