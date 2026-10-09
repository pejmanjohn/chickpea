/** The service over an installation's live stores, main bot and public URL. */
import type { EncryptedCredentialStore } from '../../config/settings-store.ts';
import type { PlatformEnv } from '../../config/state-backend.ts';
import { resolveStores } from '../../config/state-backend.ts';
import { resolveSlackPublicUrl } from '../credentials.ts';
import { slackInstallationCredentialId } from '../hosted-slack-app.ts';
import { resolveSlackInstallationCredentials } from '../installation-credentials.ts';
import {
  SlackInstallationUnavailableError,
  type SlackInstallationExecutionContext,
  type SlackInstallationExecutionResolver,
} from '../installation-execution.ts';
import { createDirectSlackTransport } from '../transport/direct.ts';
import { createSlackWebClient } from '../web-client.ts';
import { agentSlackAppsHost, type AgentSlackAppIngress, type AgentSlackAppsHost } from './host.ts';
import { agentAppIsLive, agentAppRecord } from './lifecycle.ts';
import { readAppSecrets, type SecretDeps } from './secrets.ts';
import { AgentSlackApps } from './service.ts';
import { createAgentAppSlackApi } from './slack-api.ts';
import { loadCredentialKeyring } from '../credential-keyring.ts';

function realm(env: PlatformEnv | undefined): SettingsRealm {
  const settings = resolveStores(env).settings;
  if (!('getEncryptedCredentialRevision' in settings)) throw new Error('The settings store has no encrypted realm.');
  return settings as SettingsRealm;
}

type SettingsRealm = ReturnType<typeof resolveStores>['settings'] & EncryptedCredentialStore;

function secretDeps(env: PlatformEnv | undefined): SecretDeps {
  return { credentials: realm(env), keyring: loadCredentialKeyring(env), slack: createAgentAppSlackApi() };
}

export interface AgentAppBotCredentials {
  agentId: string;
  appId: string;
  botToken: string;
  botUserId: string;
  displayName: string;
}

export type AgentAppExecutionLookup =
  | { kind: 'live'; bot: AgentAppBotCredentials }
  /** A user-group Agent, or no Agent: the installation's own bot answers. */
  | { kind: 'not_app' }
  /** An Agent with an app that is not live or whose token cannot be read: nothing answers as Chickpea for it. */
  | { kind: 'unavailable' };

export async function agentAppExecutionBot(env: PlatformEnv | undefined, agentId: string): Promise<AgentAppExecutionLookup> {
  const agent = await resolveStores(env).config.getAgent(agentId).catch(() => undefined);
  const presence = agent?.slackPresence;
  if (!agent || presence?.kind !== 'agent_app') return { kind: 'not_app' };
  if (!agentAppIsLive(presence)) return { kind: 'unavailable' };
  const appId = presence.app.app.appId;
  const stored = await readAppSecrets(secretDeps(env), appId).catch(() => undefined);
  if (!stored?.secrets.botToken) return { kind: 'unavailable' };
  return {
    kind: 'live',
    bot: { agentId, appId, botToken: stored.secrets.botToken, botUserId: presence.app.botUserId, displayName: agent.name },
  };
}

/** The live app's own bot for a delivery; undefined when the app is not active, is another app, or has no token. */
export async function agentAppBotCredentials(
  env: PlatformEnv | undefined,
  agentId: string,
  appId: string,
): Promise<AgentAppBotCredentials | undefined> {
  const lookup = await agentAppExecutionBot(env, agentId);
  return lookup.kind === 'live' && lookup.bot.appId === appId ? lookup.bot : undefined;
}

/**
 * A turn resolver that answers as the Agent's own bot whenever the Agent has
 * a live app, and as the installation's bot otherwise. Without the port it
 * is the base resolver and never reads the realm. A broken app throws, so a
 * reply is never posted as Chickpea on that Agent's behalf.
 */
export function withAgentAppExecution(
  base: SlackInstallationExecutionResolver,
  env: PlatformEnv | undefined,
): SlackInstallationExecutionResolver {
  const contexts = new Map<string, Promise<SlackInstallationExecutionContext>>();
  return (workspaceId, agentId) => {
    if (!agentId || !agentSlackAppsHost()) return base(workspaceId);
    const key = `${workspaceId}\u0000${agentId}`;
    let context = contexts.get(key);
    if (!context) {
      context = agentAppExecutionBot(env, agentId).then((lookup): Promise<SlackInstallationExecutionContext> | SlackInstallationExecutionContext => {
        if (lookup.kind === 'not_app') return base(workspaceId);
        if (lookup.kind === 'unavailable') {
          throw new SlackInstallationUnavailableError(workspaceId, 'agent_app_unavailable', { retryable: false });
        }
        const { bot } = lookup;
        return {
          workspaceId,
          transportMode: 'direct',
          sharedAppReads: false,
          botToken: bot.botToken,
          botUserId: bot.botUserId,
          displayName: bot.displayName,
          client: createSlackWebClient(bot.botToken),
        };
      });
      contexts.set(key, context);
      context.catch(() => contexts.delete(key));
    }
    return context;
  };
}

/** What a host needs before it trusts a delivery for this app; undefined for an unknown or deleted app. */
export async function agentAppIngressFacts(env: PlatformEnv, appId: string): Promise<AgentSlackAppIngress | undefined> {
  const stores = resolveStores(env);
  const agent = (await stores.config.listAgents()).find((candidate) =>
    candidate.slackPresence?.kind === 'agent_app' && agentAppRecord(candidate.slackPresence.app)?.appId === appId
  );
  if (!agent) return undefined;
  const stored = await readAppSecrets(secretDeps(env), appId);
  if (!stored) return undefined;
  const workspace = (await stores.config.listWorkspaceInstallations())[0];
  const teamId = workspace?.teamId ?? workspace?.workspaceId;
  if (!teamId) return undefined;
  return { agentId: agent.id, teamId, signingSecret: stored.secrets.signingSecret };
}

/** A verified lifecycle event of one Agent app: ends that app only, never the installation. */
export async function endAgentSlackAppLive(
  env: PlatformEnv,
  appId: string,
  payload: Record<string, unknown>,
): Promise<'ended' | 'ignored'> {
  const host = agentSlackAppsHost();
  if (!host) return 'ignored';
  return (await liveAgentSlackApps(env, host)).end(appId, payload);
}

export async function liveAgentSlackApps(env: PlatformEnv | undefined, host: AgentSlackAppsHost): Promise<AgentSlackApps> {
  const stores = resolveStores(env);
  const settings = realm(env);
  const credentials = await resolveSlackInstallationCredentials(slackInstallationCredentialId(env), env);
  return new AgentSlackApps({
    env,
    stores: { config: stores.config, settings },
    host,
    transport: createDirectSlackTransport(credentials.botToken ?? '', credentials.userGroupToken),
    publicOrigin: () => resolveSlackPublicUrl(env, stores.settings, stores.identity),
  });
}
