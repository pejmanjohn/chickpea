import type { WebClient } from '@slack/web-api';

import { UnknownAgentError } from '../../config/errors.ts';
import type { EncryptedCredentialStore, SettingsStore } from '../../config/settings-store.ts';
import { type AppStores, getSettingsStore, type PlatformEnv, resolveStores } from '../../config/state-backend.ts';
import type { ManagementAgentAppSwitchJob, ManagementReceiptOutboxRecord } from '../../management/types.ts';
import type { AgentAppBot, AgentAppPresenceHooks } from '../agent-presence/reconciler.ts';
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
import { appRecordOf, type CustomAgentConfig } from '../../config/types.ts';
import type { SlackSpeaker } from '../speaker.ts';
import { agentSlackAppsHost, type AgentAppRetirement, type AgentSlackAppIngress, type AgentSlackAppsHost } from './host.ts';
import { FINISH_APP_ACTION, START_APP_ACTION, TRY_AGAIN_ACTION } from './pages.ts';
import { type AgentAppSwitchJob, agentAppIsLive, agentAppMoveJob, agentAppRecord } from './lifecycle.ts';
import { readOwnAppSecrets, type SecretDeps } from './secrets.ts';
import { readAgentSlackAppsSetting } from './setting.ts';
import type { AgentAppTransport, AgentSlackApps } from './service.ts';
import { createAgentAppSlackApi, logSlackRefusal } from './slack-api.ts';
import { loadCredentialKeyring } from '../credential-keyring.ts';
import { slackPlatformErrorCode } from '../errors.ts';

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
  // A record that is missing, unreadable, or another Agent's makes the app unavailable; a realm outage is retried with the turn.
  const stored = await readOwnAppSecrets(secretDeps(env), appId, agentId, 'execution');
  if (stored.kind !== 'own' || !stored.secrets.botToken) return { kind: 'unavailable' };
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
 * A turn resolver that answers as the bot its run's admission chose: the
 * Agent's own app's bot for an `own_bot` speaker, the installation's bot for
 * every other. The installation's own resolution runs first either way, so
 * every refusal it enforces (a revoked, erased or gated installation) stands
 * for the Agent app too. Without the port it never reads the realm: an
 * `own_bot` run throws and every other run gets the base. An `own_bot` run
 * whose app is no longer live, or whose token cannot be read, throws too: its
 * owner names the app's bot, so Chickpea's bot never posts for it without the
 * Agent's persona. A run stored before its speaker was keeps the earlier rule:
 * the live app's bot, else the installation's for a user-group Agent, else
 * unavailable. A caller whose base context refuses rate-limited calls passes
 * `rejectRateLimitedCalls` so the app's client refuses them too.
 */
export function withAgentAppExecution(
  base: SlackInstallationExecutionResolver,
  env: PlatformEnv | undefined,
  options: { rejectRateLimitedCalls?: boolean } = {},
): SlackInstallationExecutionResolver {
  const contexts = new Map<string, Promise<SlackInstallationExecutionContext>>();
  return (workspaceId, run) => {
    if (!run) return base(workspaceId);
    const { agentId, speaker } = run;
    const host = agentSlackAppsHost();
    if ((speaker?.kind === 'unavailable' && speaker.reason === 'app_removed') || (speaker?.kind === 'own_bot' && !host)) {
      return Promise.reject(new SlackInstallationUnavailableError(workspaceId, 'agent_app_unavailable', { retryable: false }));
    }
    if (!host) return base(workspaceId);
    // Chickpea's bot answers; where it cannot post, the turn's access check says so.
    if (speaker && speaker.kind !== 'own_bot') return base(workspaceId);
    const key = `${workspaceId}\u0000${agentId}\u0000${speaker ? speaker.botUserId : ''}`;
    let context = contexts.get(key);
    if (!context) {
      context = agentAppExecutionBot(env, agentId).then(async (lookup): Promise<SlackInstallationExecutionContext> => {
        if (!speaker && lookup.kind === 'not_app') return base(workspaceId);
        if (lookup.kind !== 'live' || (speaker && speaker.botUserId !== lookup.bot.botUserId)) {
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
 * The client of a post Chickpea makes for an Agent outside its runs, such as
 * a notice or a pause line: the Agent app's own bot, never with a persona, for
 * an `own_bot` speaker; undefined for any other, where Chickpea's bot posts
 * under the Agent's name. An `own_bot` speaker whose app can no longer post
 * throws, so nothing posts for it as Chickpea instead.
 */
export async function ownBotClient(
  env: PlatformEnv | undefined,
  workspaceId: string,
  agentId: string,
  speaker: SlackSpeaker | undefined,
): Promise<WebClient | undefined> {
  if (speaker?.kind !== 'own_bot') return undefined;
  const lookup = agentSlackAppsHost() ? await agentAppExecutionBot(env, agentId) : undefined;
  if (lookup?.kind !== 'live' || lookup.bot.botUserId !== speaker.botUserId) {
    throw new SlackInstallationUnavailableError(workspaceId, 'agent_app_unavailable', { retryable: false });
  }
  return createSlackWebClient(lookup.bot.botToken);
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
 * unknown or deleted app, or one whose record cannot be opened or names
 * another Agent, so the host acknowledges rather than asking Slack to retry a
 * delivery nothing can verify.
 */
export async function agentAppIngressFacts(env: PlatformEnv, appId: string): Promise<AgentSlackAppIngress | undefined> {
  const stores = resolveStores(env);
  const agent = (await stores.config.listAgents()).find((candidate) => {
    const app = appRecordOf(candidate.slackPresence);
    return app !== undefined && agentAppRecord(app)?.appId === appId;
  });
  if (!agent) return undefined;
  const stored = await readOwnAppSecrets(secretDeps(env), appId, agent.id, 'ingress');
  if (stored.kind !== 'own') return undefined;
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
export function agentAppPresenceHooks(
  env: PlatformEnv | undefined,
  /** The caller's own settings store, where it has one; the env's otherwise. */
  settings?: Pick<SettingsStore, 'getSetting'>,
): AgentAppPresenceHooks | undefined {
  const host = agentSlackAppsHost();
  if (!host) return undefined;
  return {
    async retire(agent) {
      return (await (await liveAgentSlackApps(env, host)).retire(agent)).agent;
    },
    async ownAppMode() {
      return (await readAgentSlackAppsSetting(settings ?? getSettingsStore(env))).mode === 'own_app';
    },
    async bringBotIn(agent, channel) {
      const presence = agent.slackPresence;
      if (!agentAppIsLive(presence)) return undefined;
      const ids = { agentId: agent.id, appId: presence.app.app.appId, channelId: channel.id };
      const lookup = await agentAppExecutionBot(env, agent.id).catch(() => undefined);
      if (lookup?.kind !== 'live') return leftOut(ids, 'bot_unavailable');
      const bot = createDirectSlackTransport(lookup.bot.botToken, undefined);
      const inChannel: AgentAppBot = { placement: 'in_channel', transport: bot };
      // Slack answers a bot's look-up of a private Channel it is not in `channel_not_found`.
      if (await bot.lookupChannel(channel.id).then((found) => found.member, () => false)) return inChannel;
      const refused = await inviteRefusal(installationCredentials(env), channel.id, lookup.bot.botUserId);
      if (!refused) return inChannel;
      logSlackRefusal('invite', ids, { code: refused });
      const reason = await joinRefusal(bot, channel);
      return reason ? leftOut(ids, reason) : inChannel;
    },
  };
}

function leftOut(ids: { agentId: string; appId: string; channelId: string }, reason: string): AgentAppBot {
  console.warn({ event: 'chickpea.agent_app.bot_left_out', ...ids, reason });
  return { placement: 'left_out' };
}

async function inviteRefusal(
  credentials: () => Promise<ResolvedSlackInstallationCredentials>,
  channelId: string,
  botUserId: string,
): Promise<string | undefined> {
  const botToken = await credentials().then((resolved) => resolved.botToken, () => undefined);
  if (!botToken) return 'credentials_unavailable';
  try {
    await createSlackWebClient(botToken).conversations.invite({ channel: channelId, users: botUserId });
    return undefined;
  } catch (error) {
    const code = slackPlatformErrorCode(error) ?? 'failed';
    return code === 'already_in_channel' ? undefined : code;
  }
}

async function joinRefusal(
  bot: Pick<SlackTransport, 'joinPublicChannel'>,
  channel: { id: string; private: boolean },
): Promise<string | undefined> {
  if (channel.private) return 'private_channel';
  try {
    await bot.joinPublicChannel(channel.id);
    return undefined;
  } catch (error) {
    return error instanceof SlackTransportError ? error.code : 'failed';
  }
}

/** Tenant end: every Agent app of this installation, each reported, none throwing. */
export async function retireAgentSlackAppsLive(env: PlatformEnv): Promise<readonly AgentAppRetirement[]> {
  const host = agentSlackAppsHost();
  const stores = resolveStores(env);
  const agents = (await stores.config.listAgents()).filter((agent) => appRecordOf(agent.slackPresence));
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

/**
 * The Owner's App Home lines, keyed by Agent ID; empty without the port, for
 * anyone but an Owner, or when no listed Agent has an app record, so a
 * workspace that never gave an Agent its own app reads and builds nothing.
 */
export async function agentAppHomeRows(input: {
  env: PlatformEnv | undefined;
  viewer: { role?: string | undefined };
  agents: readonly CustomAgentConfig[];
}): Promise<ReadonlyMap<string, readonly object[]>> {
  const host = agentSlackAppsHost();
  if (!host || input.viewer.role !== 'owner' || !input.agents.some((agent) => appRecordOf(agent.slackPresence))) return new Map();
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
  viewer: () => Promise<AgentAppPresser | undefined>;
  /** Runs the press after Slack has its answer, as the neighbouring actions do. */
  detach: (work: Promise<void>) => void;
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
  input.detach((async () => {
    const viewer = await input.viewer();
    if (!viewer) return;
    const owner = viewer.role === 'owner';
    const apps = await liveAgentSlackApps(input.env, host);
    if (action.action_id === START_APP_ACTION) {
      // A message from before Add to Slack was a link. Anyone in its thread can press it; nothing starts here.
      await viewer.tell(await apps.addLinkReply(action.value, owner));
      return;
    }
    if (!owner) return;
    await apps.retry(action.value, slackUserId);
    await viewer.republish();
  })());
  return true;
}

/** Who pressed, as Chickpea's bot sees them: their role, their Home tab, and a private reply where they pressed. */
export interface AgentAppPresser {
  role?: string | undefined;
  republish: () => Promise<void>;
  tell: (text: string) => Promise<void>;
}

const AGENT_APP_ACTIONS = new Set([START_APP_ACTION, FINISH_APP_ACTION, TRY_AGAIN_ACTION]);

/**
 * The stores the service reads and writes; a caller inside the state store
 * passes its own, so nothing calls back into it, the main bot's credentials
 * included.
 */
type AgentAppStores = Pick<AppStores, 'config' | 'management' | 'identity'> & { settings: SettingsStore & EncryptedCredentialStore };

/**
 * The service over an installation's live stores, main bot and public URL.
 * Loaded where it is used, so Worker startup does not carry it.
 */
export async function liveAgentSlackApps(
  env: PlatformEnv | undefined,
  host: AgentSlackAppsHost,
  local?: AgentAppStores,
): Promise<AgentSlackApps> {
  const resolved = resolveStores(env);
  const settings = local?.settings ?? getSettingsStore(env);
  const management = local?.management ?? resolved.management;
  const credentials = installationCredentials(env, local?.identity);
  const config = local?.config ?? resolved.config;
  const identity = local?.identity ?? resolved.identity;
  const { AgentSlackApps } = await import('./service.ts');
  return new AgentSlackApps({
    env,
    stores: { config, settings },
    host,
    transport: mainBotTransport(credentials, settings),
    armSwitch: (job) => armAgentAppSwitch(management, job, Date.now()),
    publicOrigin: () => resolveSlackPublicUrl(env, resolved.settings, resolved.identity),
    userGroupPermissionMissing: async () => hostedSlackUpdateGrantsUserGroupToken() && !(await credentials()).userGroupToken,
    placeInSlack: async (agentId) => {
      const resolved = await credentials();
      const hooks = agentAppPresenceHooks(env, settings);
      const { AgentPresenceReconciler, agentCreatorInSlack } = await import('../agent-presence/reconciler.ts');
      const reconciler = new AgentPresenceReconciler({
        config,
        transport: createDirectSlackTransport(resolved.botToken ?? '', ownerUserGroupToken(resolved, settings)),
        announce: null,
        ...(hooks ? { agentApps: hooks } : {}),
      });
      await reconciler.placeInSlack(agentId, await agentCreatorInSlack(identity, await config.getAgent(agentId)));
    },
  });
}

/**
 * The move's job as an outbox row, numbered per Agent app, so one app's
 * switch and its restore after a Remove App share one sequence and never run
 * side by side; the drain that claims it runs the steps the presence still
 * owes. `rearm` numbers the rows that follow one that settled.
 */
export function agentAppSwitchOutbox(job: AgentAppSwitchJob, at: number, rearm = 0): ManagementReceiptOutboxRecord {
  const outboxId = `agent_app_switch:${job.agentId}:${job.appId}${rearm ? `:${rearm}` : ''}`;
  return {
    outboxId,
    operationId: outboxId,
    destination: { kind: 'slack_dm', workspaceId: job.teamId, slackUserId: job.ownerSlackUserId },
    receipt: { kind: 'agent_app_switch', agentId: job.agentId },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Arm the job for an Agent app whose move has steps left. The outbox keeps a
 * row it already has, settled or not, so a row that settled without finishing
 * (every attempt failed, or it ran before the step was due) is followed by a
 * new one. A row still waiting or running is left alone: one app never has
 * two unsettled jobs, and the one it has runs whatever the presence owes.
 */
export async function armAgentAppSwitch(
  management: Pick<AppStores['management'], 'putOutbox'>,
  job: AgentAppSwitchJob,
  at: number,
): Promise<void> {
  for (let rearm = 0; ; rearm += 1) {
    const row = await management.putOutbox(agentAppSwitchOutbox(job, at, rearm));
    if (row.status !== 'delivered' && row.status !== 'failed') return;
  }
}

/**
 * The drain's run of one move job. Without the port it fails and is retried:
 * nothing here can drive an Agent app. `finalAttempt` is the outbox's last
 * try, after which the Owner's message is given up rather than the move.
 */
export async function continueAgentAppSwitch(
  env: PlatformEnv | undefined,
  job: ManagementAgentAppSwitchJob,
  local?: AgentAppStores,
  options: { finalAttempt?: boolean } = {},
): Promise<{ deliveryRef: string }> {
  const host = agentSlackAppsHost();
  if (!host) throw Object.assign(new Error('Agent apps are not served here.'), { name: 'agent_apps_unavailable' });
  const outcome = await (await liveAgentSlackApps(env, host, local)).continueSwitch(job.agentId, options);
  return { deliveryRef: `agent_app_switch:${outcome}` };
}

/**
 * The state store's sweep: arm the job of every Agent whose move has a step
 * left and no job to run it, so a move cut off before its job was armed, or
 * whose job spent every try, finishes without a person. Arming leaves a
 * waiting or running row alone, so a sweep never starts a second run.
 */
export async function armUnfinishedAgentAppMoves(
  stores: { config: Pick<AppStores['config'], 'listAgents' | 'listWorkspaceInstallations'>; management: Pick<AppStores['management'], 'putOutbox'> },
  at: number,
): Promise<void> {
  if (!agentSlackAppsHost()) return;
  const workspace = (await stores.config.listWorkspaceInstallations())[0];
  if (!workspace) return;
  const teamId = workspace.teamId ?? workspace.workspaceId;
  for (const agent of await stores.config.listAgents()) {
    const job = agentAppMoveJob(agent.id, agent.slackPresence, teamId);
    if (job) await armAgentAppSwitch(stores.management, job, at);
  }
}

/**
 * The installation's own credentials, read only when a step needs them (an
 * Owner's DM, the handle's user group, the permission it needs). Uninstalling
 * and deleting an app use that app's credentials and the configuration token,
 * so they go on when these cannot be read. `identity` is the state store's
 * own, when the caller runs inside it.
 */
function installationCredentials(
  env: PlatformEnv | undefined,
  identity?: AppStores['identity'],
): () => Promise<ResolvedSlackInstallationCredentials> {
  let resolved: Promise<ResolvedSlackInstallationCredentials> | undefined;
  return () => {
    if (!resolved) {
      resolved = resolveSlackInstallationCredentials(
        slackInstallationCredentialId(env), env, identity ? { state: identity, env } : undefined,
      );
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
    lookupChannel: async (channelId) => (await bot()).lookupChannel(channelId),
    joinPublicChannel: async (channelId) => (await bot()).joinPublicChannel(channelId),
  };
}
