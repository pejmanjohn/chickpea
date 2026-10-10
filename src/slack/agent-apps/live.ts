import { UnknownAgentError } from '../../config/errors.ts';
import { getSettingsStore, type PlatformEnv, resolveStores } from '../../config/state-backend.ts';
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
import type { CustomAgentConfig } from '../../config/types.ts';
import { agentSlackAppsHost, type AgentAppRetirement, type AgentSlackAppIngress, type AgentSlackAppsHost } from './host.ts';
import { FINISH_APP_ACTION, START_APP_ACTION, TRY_AGAIN_ACTION } from './pages.ts';
import { agentAppIsLive, agentAppRecord } from './lifecycle.ts';
import { AgentAppSecretsUnreadable, readAppSecrets, type SecretDeps, unreadableAsNone } from './secrets.ts';
import { AgentSlackApps, type AgentAppTransport } from './service.ts';
import { createAgentAppSlackApi } from './slack-api.ts';
import { loadCredentialKeyring } from '../credential-keyring.ts';

function secretDeps(env: PlatformEnv | undefined): SecretDeps {
  return { credentials: getSettingsStore(env), keyring: loadCredentialKeyring(env), slack: createAgentAppSlackApi() };
}

export interface AgentAppBotCredentials {
  agentId: string;
  appId: string;
  botToken: string;
  botUserId: string;
  displayName: string;
}

type AgentAppExecutionLookup =
  | { kind: 'live'; bot: AgentAppBotCredentials }
  /** A user-group Agent, or no Agent: the installation's own bot answers. */
  | { kind: 'not_app' }
  /** An Agent with an app that is not live or whose token cannot be read: nothing answers as Chickpea for it. */
  | { kind: 'unavailable' };

async function agentAppExecutionBot(env: PlatformEnv | undefined, agentId: string): Promise<AgentAppExecutionLookup> {
  const agent = await resolveStores(env).config.getAgent(agentId).catch((error: unknown) => {
    if (error instanceof UnknownAgentError) return undefined;
    throw error;
  });
  const presence = agent?.slackPresence;
  if (!agent || presence?.kind !== 'agent_app') return { kind: 'not_app' };
  if (!agentAppIsLive(presence)) return { kind: 'unavailable' };
  const appId = presence.app.app.appId;
  // Only an envelope that cannot be opened makes the app unavailable; a realm read that fails is retried with the turn.
  const stored = await readAppSecrets(secretDeps(env), appId).catch(unreadableAsNone);
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
 * a live app, and as the installation's bot otherwise. The installation's
 * own resolution runs first either way, so every refusal it enforces (a
 * revoked, erased or gated installation) stands for the Agent app too.
 * Without the port it is the base resolver and never reads the realm. A
 * broken app throws, so a reply is never posted as Chickpea on its behalf.
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
      context = agentAppExecutionBot(env, agentId).then(async (lookup): Promise<SlackInstallationExecutionContext> => {
        if (lookup.kind === 'not_app') return base(workspaceId);
        if (lookup.kind === 'unavailable') {
          throw new SlackInstallationUnavailableError(workspaceId, 'agent_app_unavailable', { retryable: false });
        }
        await base(workspaceId);
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

/**
 * What a host needs before it trusts a delivery for this app; undefined for an
 * unknown or deleted app, or one whose secrets cannot be opened, so the host
 * acknowledges rather than asking Slack to retry a delivery nothing can verify.
 */
export async function agentAppIngressFacts(env: PlatformEnv, appId: string): Promise<AgentSlackAppIngress | undefined> {
  const stores = resolveStores(env);
  const agent = (await stores.config.listAgents()).find((candidate) =>
    candidate.slackPresence?.kind === 'agent_app' && agentAppRecord(candidate.slackPresence.app)?.appId === appId
  );
  if (!agent) return undefined;
  const stored = await readAppSecrets(secretDeps(env), appId).catch((error: unknown) => {
    if (error instanceof AgentAppSecretsUnreadable) console.warn(`[chickpea] agent_app_secrets_unreadable ${JSON.stringify({ appId })}`);
    return unreadableAsNone(error);
  });
  if (!stored) return undefined;
  const workspace = (await stores.config.listWorkspaceInstallations())[0];
  const teamId = workspace?.teamId ?? workspace?.workspaceId;
  if (!teamId || workspace?.health === 'revoked') return undefined;
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

/** The reconciler's archive hook: present only with the port. */
export function agentAppRetirement(env: PlatformEnv | undefined): { retire(agent: CustomAgentConfig): Promise<CustomAgentConfig> } | undefined {
  const host = agentSlackAppsHost();
  if (!host) return undefined;
  return {
    async retire(agent) {
      return (await (await liveAgentSlackApps(env, host)).retire(agent)).agent;
    },
  };
}

/** Tenant end: every Agent app of this installation, each reported, none throwing. */
export async function retireAgentSlackAppsLive(env: PlatformEnv): Promise<readonly AgentAppRetirement[]> {
  const host = agentSlackAppsHost();
  const stores = resolveStores(env);
  const agents = (await stores.config.listAgents()).filter((agent) => agent.slackPresence?.kind === 'agent_app');
  if (agents.length === 0) return [];
  if (!host) return agents.map((agent) => ({ agentId: agent.id, outcome: 'left_for_owner' as const }));
  const service = await liveAgentSlackApps(env, host);
  const outcomes: AgentAppRetirement[] = [];
  for (const agent of agents) {
    try {
      outcomes.push({ agentId: agent.id, outcome: (await service.retire(agent)).outcome });
    } catch {
      outcomes.push({ agentId: agent.id, outcome: 'left_for_owner' });
    }
  }
  return outcomes;
}

/** The Owner's App Home lines, keyed by Agent ID; empty without the port or for anyone but an Owner. */
export async function agentAppHomeRows(input: {
  env: PlatformEnv | undefined;
  viewer: { role?: string | undefined };
  agents: readonly CustomAgentConfig[];
}): Promise<ReadonlyMap<string, readonly object[]>> {
  const host = agentSlackAppsHost();
  if (!host || input.viewer.role !== 'owner') return new Map();
  return (await liveAgentSlackApps(input.env, host)).homeRows(input.agents, input.viewer);
}

/**
 * An Owner's click on an App Home or DM control of an Agent app; false when
 * the payload is none of them. The viewer is resolved only for such a click,
 * and only an Owner's click does anything.
 */
export async function handleAgentAppHomeAction(input: {
  env: PlatformEnv | undefined;
  payload: { type?: unknown; user?: { id?: unknown }; actions?: unknown };
  viewer: () => Promise<{ role?: string | undefined; republish: () => Promise<void> } | undefined>;
}): Promise<boolean> {
  const host = agentSlackAppsHost();
  if (!host || input.payload.type !== 'block_actions' || !Array.isArray(input.payload.actions)) return false;
  const action = input.payload.actions.find((candidate): candidate is { action_id: string; value: string } =>
    !!candidate && typeof candidate === 'object' && typeof (candidate as { action_id?: unknown }).action_id === 'string' &&
    AGENT_APP_ACTIONS.has((candidate as { action_id: string }).action_id) && typeof (candidate as { value?: unknown }).value === 'string'
  );
  if (!action) return false;
  const slackUserId = input.payload.user?.id;
  if (typeof slackUserId !== 'string') return true;
  const viewer = await input.viewer();
  if (viewer?.role !== 'owner') return true;
  const service = await liveAgentSlackApps(input.env, host);
  if (action.action_id === START_APP_ACTION) await service.start(action.value, slackUserId);
  else await service.retry(action.value, slackUserId);
  await viewer.republish();
  return true;
}

const AGENT_APP_ACTIONS = new Set([START_APP_ACTION, FINISH_APP_ACTION, TRY_AGAIN_ACTION]);

/** The service over an installation's live stores, main bot and public URL. */
export async function liveAgentSlackApps(env: PlatformEnv | undefined, host: AgentSlackAppsHost): Promise<AgentSlackApps> {
  const stores = resolveStores(env);
  return new AgentSlackApps({
    env,
    stores: { config: stores.config, settings: getSettingsStore(env) },
    host,
    transport: mainBotTransport(env),
    publicOrigin: () => resolveSlackPublicUrl(env, stores.settings, stores.identity),
  });
}

/**
 * The installation's own bot, read only when a step needs it (an Owner's DM,
 * the handle's user group). Uninstalling and deleting an app use that app's
 * credentials and the configuration token, so they go on when this bot's
 * credentials cannot be read.
 */
function mainBotTransport(env: PlatformEnv | undefined): AgentAppTransport {
  let resolved: Promise<AgentAppTransport> | undefined;
  const bot = (): Promise<AgentAppTransport> => {
    if (!resolved) {
      resolved = resolveSlackInstallationCredentials(slackInstallationCredentialId(env), env)
        .then((credentials) => createDirectSlackTransport(credentials.botToken ?? '', credentials.userGroupToken));
      resolved.catch(() => { resolved = undefined; });
    }
    return resolved;
  };
  return {
    disableUserGroup: async (id) => (await bot()).disableUserGroup(id),
    enableUserGroup: async (id) => (await bot()).enableUserGroup(id),
    openDirectConversation: async (userId) => (await bot()).openDirectConversation(userId),
    postMessage: async (input) => (await bot()).postMessage(input),
  };
}
