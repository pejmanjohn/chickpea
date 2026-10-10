import { UnknownAgentError } from '../../config/errors.ts';
import type { SettingsStore } from '../../config/settings-store.ts';
import { getSettingsStore, type PlatformEnv, resolveStores } from '../../config/state-backend.ts';
import type { AgentAppPresenceHooks } from '../agent-presence/reconciler.ts';
import { resolveSlackPublicUrl } from '../credentials.ts';
import { hostedSlackUpdateGrantsUserGroupToken } from '../hosted-permissions.ts';
import { slackInstallationCredentialId } from '../hosted-slack-app.ts';
import { type ResolvedSlackInstallationCredentials, resolveSlackInstallationCredentials } from '../installation-credentials.ts';
import {
  SlackInstallationUnavailableError,
  type SlackInstallationExecutionContext,
  type SlackInstallationExecutionResolver,
} from '../installation-execution.ts';
import type { PrivateAgentPlacementFacts } from '../agent-access.ts';
import { createDirectSlackTransport } from '../transport/direct.ts';
import { SlackTransportError, type SlackTransport } from '../transport/types.ts';
import { ownerUserGroupToken } from '../user-group-authority.ts';
import { createSlackWebClient } from '../web-client.ts';
import type { CustomAgentConfig } from '../../config/types.ts';
import { agentSlackAppsHost, type AgentAppRetirement, type AgentSlackAppIngress, type AgentSlackAppsHost } from './host.ts';
import { FINISH_APP_ACTION, START_APP_ACTION, TRY_AGAIN_ACTION } from './pages.ts';
import { agentAppIsLive, agentAppRecord } from './lifecycle.ts';
import { loggedUnreadableAsNone, readAppSecrets, type SecretDeps, unreadableAsNone } from './secrets.ts';
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
 * A caller whose base context refuses rate-limited calls passes
 * `rejectRateLimitedCalls` so the app's client refuses them too.
 */
export function withAgentAppExecution(
  base: SlackInstallationExecutionResolver,
  env: PlatformEnv | undefined,
  options: { rejectRateLimitedCalls?: boolean } = {},
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
          client: createSlackWebClient(bot.botToken, options),
        };
      });
      contexts.set(key, context);
      context.catch(() => contexts.delete(key));
    }
    return context;
  };
}

/**
 * Where an app Agent's private-use placements are read on its own app's
 * delivery. The Agent works in a Channel through its own bot (mentions) or
 * Chickpea's (replies in its threads), and a grant made before it had an app
 * was checked against Chickpea's bot: a Channel counts as joined when either
 * bot is in it, and a person's Channels are those either bot can see.
 */
export function agentAppPlacementFacts(
  own: PrivateAgentPlacementFacts,
  chickpea: PrivateAgentPlacementFacts,
): PrivateAgentPlacementFacts {
  return {
    async lookupChannel(channelId) {
      const mine = await own.lookupChannel(channelId).catch(() => undefined);
      if (mine?.member) return mine;
      return chickpea.lookupChannel(channelId).catch((error: unknown) => {
        if (mine) return mine;
        throw error;
      });
    },
    async listMemberChannels(userId) {
      const [mine, theirs] = await Promise.all([own.listMemberChannels(userId), chickpea.listMemberChannels(userId)]);
      return new Set([...mine, ...theirs]);
    },
  };
}

/**
 * Where Admin reads an Agent's DM audience: the placement facts its own app's
 * deliveries decide from while that app is live, so Admin and Slack agree;
 * Chickpea's bot alone for any other Agent, or without the port.
 */
export async function agentDmPlacementFacts(
  env: PlatformEnv | undefined,
  agent: CustomAgentConfig,
  chickpea: PrivateAgentPlacementFacts,
): Promise<PrivateAgentPlacementFacts> {
  if (!agentSlackAppsHost() || agent.slackPresence?.kind !== 'agent_app') return chickpea;
  const lookup = await agentAppExecutionBot(env, agent.id);
  if (lookup.kind !== 'live') return chickpea;
  return agentAppPlacementFacts(createDirectSlackTransport(lookup.bot.botToken, undefined), chickpea);
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
  const stored = await readAppSecrets(secretDeps(env), appId).catch(loggedUnreadableAsNone);
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

/** The reconciler's hooks for an Agent's own app: present only with the port. */
export function agentAppPresenceHooks(env: PlatformEnv | undefined): AgentAppPresenceHooks | undefined {
  const host = agentSlackAppsHost();
  if (!host) return undefined;
  return {
    async retire(agent) {
      return (await (await liveAgentSlackApps(env, host)).retire(agent)).agent;
    },
    async bringBotIn(agent, channel) {
      const presence = agent.slackPresence;
      if (!agentAppIsLive(presence)) return undefined;
      const appId = presence.app.app.appId;
      const lookup = await agentAppExecutionBot(env, agent.id).catch(() => undefined);
      const bot = lookup?.kind === 'live' ? createDirectSlackTransport(lookup.bot.botToken, undefined) : undefined;
      const reason = bot ? await botLeftOutReason(bot, channel) : 'bot_unavailable';
      if (bot && !reason) return { placement: 'in_channel', transport: bot };
      console.warn({ event: 'chickpea.agent_app.bot_left_out', agentId: agent.id, appId, channelId: channel.id, reason });
      return { placement: 'left_out' };
    },
  };
}

/**
 * Why the app's bot is not in the Channel after trying, or undefined when it
 * is. It joins a public Channel itself; only someone in a private Channel can
 * add it there, so for one of those it is only looked for. Slack answers that
 * look-up `channel_not_found` when the bot is not in the private Channel.
 */
async function botLeftOutReason(
  bot: Pick<SlackTransport, 'joinPublicChannel' | 'lookupChannel'>,
  channel: { id: string; private: boolean },
): Promise<string | undefined> {
  try {
    if (!channel.private) {
      await bot.joinPublicChannel(channel.id);
      return undefined;
    }
    return (await bot.lookupChannel(channel.id)).member ? undefined : 'private_channel';
  } catch (error) {
    if (!(error instanceof SlackTransportError)) return 'failed';
    return channel.private && error.code === 'channel_not_found' ? 'private_channel' : error.code;
  }
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
  const settings = getSettingsStore(env);
  const credentials = installationCredentials(env);
  return new AgentSlackApps({
    env,
    stores: { config: stores.config, settings },
    host,
    transport: mainBotTransport(credentials, settings),
    publicOrigin: () => resolveSlackPublicUrl(env, stores.settings, stores.identity),
    userGroupPermissionMissing: async () => hostedSlackUpdateGrantsUserGroupToken() && !(await credentials()).userGroupToken,
  });
}

/**
 * The installation's own credentials, read only when a step needs them (an
 * Owner's DM, the handle's user group, the permission it needs). Uninstalling
 * and deleting an app use that app's credentials and the configuration token,
 * so they go on when these cannot be read.
 */
function installationCredentials(env: PlatformEnv | undefined): () => Promise<ResolvedSlackInstallationCredentials> {
  let resolved: Promise<ResolvedSlackInstallationCredentials> | undefined;
  return () => {
    if (!resolved) {
      resolved = resolveSlackInstallationCredentials(slackInstallationCredentialId(env), env);
      resolved.catch(() => { resolved = undefined; });
    }
    return resolved;
  };
}

function mainBotTransport(
  credentials: () => Promise<ResolvedSlackInstallationCredentials>,
  settings: SettingsStore,
): AgentAppTransport {
  const bot = async (): Promise<AgentAppTransport> => {
    const resolved = await credentials();
    return createDirectSlackTransport(resolved.botToken ?? '', ownerUserGroupToken(resolved, settings));
  };
  return {
    disableUserGroup: async (id) => (await bot()).disableUserGroup(id),
    enableUserGroup: async (id) => (await bot()).enableUserGroup(id),
    openDirectConversation: async (userId) => (await bot()).openDirectConversation(userId),
    postMessage: async (input) => (await bot()).postMessage(input),
  };
}
