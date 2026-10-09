/** The service over an installation's live stores, main bot and public URL. */
import type { EncryptedCredentialStore } from '../../config/settings-store.ts';
import type { PlatformEnv } from '../../config/state-backend.ts';
import { resolveStores } from '../../config/state-backend.ts';
import { resolveSlackPublicUrl } from '../credentials.ts';
import { slackInstallationCredentialId } from '../hosted-slack-app.ts';
import { resolveSlackInstallationCredentials } from '../installation-credentials.ts';
import { createDirectSlackTransport } from '../transport/direct.ts';
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
}

/** The live app's own bot for a delivery; undefined when the app is not active, is another app, or has no token. */
export async function agentAppBotCredentials(
  env: PlatformEnv | undefined,
  agentId: string,
  appId: string,
): Promise<AgentAppBotCredentials | undefined> {
  const agent = await resolveStores(env).config.getAgent(agentId).catch(() => undefined);
  const presence = agent?.slackPresence;
  if (!agentAppIsLive(presence) || presence.app.app.appId !== appId) return undefined;
  const stored = await readAppSecrets(secretDeps(env), appId).catch(() => undefined);
  if (!stored?.secrets.botToken) return undefined;
  return { agentId, appId, botToken: stored.secrets.botToken, botUserId: presence.app.botUserId };
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
