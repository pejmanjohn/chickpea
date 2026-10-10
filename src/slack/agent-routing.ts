import type { ConfigStore } from '../config/store.ts';
import {
  type AgentChannelGrant,
  type AgentTeammate,
  type AgentThreadRoute,
  type CustomAgentConfig,
  type ResolvedAssignment,
} from '../config/types.ts';
import { agentAppPostingBot, agentAppRouteSelection } from './agent-apps/index.ts';
import { agentMayAskTeammates, agentSlackHandle } from './agent-asks.ts';
import type { NormalizedSlackTurn, SlackCoAddressed } from './types.ts';
import { CHICKPEA_AGENT_ID } from '../config/agent-id.ts';
import { boundedSlackPublicHandoff } from './public-context.ts';
import {
  AgentUserGroupLookupLimiter,
  repairMentionedAgentUserGroup,
} from './agent-presence/reconciler.ts';
import type { SlackTransport } from './transport/types.ts';
import type { PrivateAgentAccessResult } from './agent-access.ts';

type AgentRouteSurface = 'channel' | 'direct';
type AgentRouteSource =
  | 'agent_app'
  | 'agent_handle'
  | 'thread_owner'
  | 'default_agent'
  | 'app_home'
  | 'creation_handoff'
  | 'agent_ask';

type AgentRoutingDenialReason =
  | 'not_available'
  | 'member_required'
  | 'installation_unavailable'
  | 'temporarily_unavailable';

interface AgentRouteAlternative {
  id: string;
  name: string;
  handle: string;
}

export type AgentRoutingResult =
  | { kind: 'ignore' }
  | {
      kind: 'denied';
      reason: AgentRoutingDenialReason;
      alternatives: AgentRouteAlternative[];
    }
  /**
   * A Channel member mentioned an active Agent that has not been added to
   * this Channel, or whose posting bot is not in it (`postingBotAbsent`).
   */
  | { kind: 'not_in_channel'; agent: CustomAgentConfig; postingBotAbsent?: true }
  | {
      kind: 'routed';
      source: AgentRouteSource;
      assignment: ResolvedAssignment;
      route: AgentThreadRoute;
      handoff: boolean;
      routeChanged: boolean;
      previousAgentId?: string;
      handoffFallbackRequired?: boolean;
      /**
       * Every Agent one person's message mentioned, in mention order, when
       * there were several: the routed first one at position 0, and the
       * rest, who answer after it as guests.
       */
      coAddressed?: SlackCoAddressed;
    };

export interface AgentRoutingActor {
  channelMember: boolean;
  fullMember: boolean;
}

interface ResolveAgentRouteInput {
  turn: NormalizedSlackTurn;
  surface: AgentRouteSurface;
  actor: AgentRoutingActor;
  config: Pick<
    ConfigStore,
    | 'listAgents'
    | 'getAgent'
    | 'getWorkspaceInstallation'
    | 'listAgentChannelGrants'
    | 'updateAgent'
    | 'getAgentThreadRoute'
    | 'putAgentThreadRoute'
    | 'listSlackPublicContext'
  >;
  /** Trusted Agent seed from App Home interactivity, never Slack message text. */
  appHomeAgentId?: string;
  /** The Agent whose own Slack app received this delivery; never Slack message text. */
  agentApp?: { agentId: string };
  /**
   * Trusted host admission for one Agent already in this thread: the Agent
   * another Agent mentioned in a reply it delivered, or the Agent whose
   * approval card a person clicked. It answers in the thread without taking
   * the thread over; never Slack message text.
   */
  askAgentId?: string;
  /** Authenticated Slack directory seam used only when a mentioned immutable
   * group id is absent from the stored Agent map. */
  transport?: Pick<SlackTransport, 'lookupUserGroup'>;
  userGroupLookupLimiter?: AgentUserGroupLookupLimiter;
  /**
   * Whether the bot an Agent posts as (its own app's, or Chickpea's) is in
   * this conversation. A message naming several Agents reaches some of them
   * through another Agent's bot.
   */
  postingBotInChannel?: (agent: CustomAgentConfig) => Promise<boolean>;
  /** Live placement-derived authority for the selected user-created Agent. */
  authorizeUserAgent?: (
    agent: CustomAgentConfig,
  ) => Promise<PrivateAgentAccessResult>;
}

type Awaitable<T> = T | Promise<T>;
type AgentRouteCommitConfig = {
  putAgentThreadRoute(
    ...args: Parameters<ConfigStore['putAgentThreadRoute']>
  ): Awaitable<Awaited<ReturnType<ConfigStore['putAgentThreadRoute']>>>;
  listSlackPublicContext(
    ...args: Parameters<ConfigStore['listSlackPublicContext']>
  ): Awaitable<Awaited<ReturnType<ConfigStore['listSlackPublicContext']>>>;
};

export interface CreatedAgentHandoffConfig {
  getWorkspaceInstallation(
    workspaceId: string,
  ): Awaitable<Awaited<ReturnType<ConfigStore['getWorkspaceInstallation']>>>;
  getAgent(agentId: string): Awaitable<Awaited<ReturnType<ConfigStore['getAgent']>>>;
  listAgentChannelGrants(
    workspaceId?: string,
    channelId?: string,
  ): Awaitable<Awaited<ReturnType<ConfigStore['listAgentChannelGrants']>>>;
  getAgentThreadRoute(
    workspaceId: string,
    channelId: string,
    threadTs: string,
  ): Awaitable<Awaited<ReturnType<ConfigStore['getAgentThreadRoute']>>>;
  putAgentThreadRoute(
    ...args: Parameters<ConfigStore['putAgentThreadRoute']>
  ): Awaitable<Awaited<ReturnType<ConfigStore['putAgentThreadRoute']>>>;
  listSlackPublicContext(
    ...args: Parameters<ConfigStore['listSlackPublicContext']>
  ): Awaitable<Awaited<ReturnType<ConfigStore['listSlackPublicContext']>>>;
}

const USER_GROUP_MENTION = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g;

/** Slack user-group ids are the only trusted address in message text. */
export function parseAgentUserGroupMentions(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(USER_GROUP_MENTION)) {
    const id = match[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export async function resolveAgentRoute(
  input: ResolveAgentRouteInput,
): Promise<AgentRoutingResult> {
  const { turn, config, surface, actor } = input;
  const installation = await config.getWorkspaceInstallation(turn.workspaceId);
  if (!installation) {
    return denied('installation_unavailable', []);
  }
  if (!actor.fullMember) {
    return denied(surface === 'direct' ? 'member_required' : 'not_available', []);
  }

  const [agents, channelGrants, currentRoute] = await Promise.all([
    config.listAgents(),
    surface === 'channel'
      ? config.listAgentChannelGrants(turn.workspaceId, turn.channelId)
      : Promise.resolve([]),
    config.getAgentThreadRoute(turn.workspaceId, turn.channelId, turn.threadTs),
  ]);
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const agentClaimsByGroupId = new Map<string, CustomAgentConfig[]>();
  for (const agent of agents) {
    if (agent.kind !== 'user' || !agent.slackPresence?.userGroupId) continue;
    const claims = agentClaimsByGroupId.get(agent.slackPresence.userGroupId) ?? [];
    claims.push(agent);
    agentClaimsByGroupId.set(agent.slackPresence.userGroupId, claims);
  }
  const agentsByGroupId = new Map(
    [...agentClaimsByGroupId.entries()].flatMap(([groupId, claims]) =>
      claims.length === 1 ? [[groupId, claims[0]!] as const] : []
    ),
  );
  const activeGrants = channelGrants.filter((grant) => grant.status === 'active');
  const available = await availableAlternatives(activeGrants, agentsById);
  let answered: Promise<string[]> | undefined;
  // A person's row never counts: a refused mention is recorded too.
  const answeredInThread = () => answered ??= Promise.resolve(
    config.listSlackPublicContext(turn.workspaceId, turn.channelId, turn.threadTs),
  ).then((rows) => rows.flatMap((row) => row.role === 'agent' && row.agentId ? [row.agentId] : []));
  const askableAgentIds = async (addressedIds: readonly string[]): Promise<ReadonlySet<string>> =>
    new Set(surface === 'channel'
      ? activeGrants.map(({ agentId }) => agentId)
      : [...(currentRoute ? [currentRoute.agentId, ...await answeredInThread()] : []), ...addressedIds]);
  const withTeammates = async (
    routed: Extract<AgentRoutingResult, { kind: 'routed' }>,
    addressedIds: readonly string[],
  ): Promise<Extract<AgentRoutingResult, { kind: 'routed' }>> => {
    if (installation.runtimeContract !== 'chickpea-v1') return routed;
    if (!agentMayAskTeammates(routed.assignment.agent)) return routed;
    const teammates = teammatesAmong(await askableAgentIds(addressedIds), agentsById, routed.assignment.agentId);
    return teammates.length
      ? { ...routed, assignment: { ...routed.assignment, teammates } }
      : routed;
  };

  if (input.askAgentId !== undefined) {
    // An ask continues a thread its asker is part of; it never opens one. A
    // later Agent a person's message mentioned is in the thread by that message.
    if (!currentRoute) return denied('not_available', []);
    const addressedIds = turn.coAddressed?.agents.map(({ agentId }) => agentId) ?? [];
    if (!(await askableAgentIds(addressedIds)).has(input.askAgentId)) return denied('not_available', []);
    const asked = agentsById.get(input.askAgentId);
    const access = await agentAccess({
      agent: asked,
      surface,
      actor,
      activeGrants,
      workspaceManagementRoute: false,
      ...(input.authorizeUserAgent ? { authorizeUserAgent: input.authorizeUserAgent } : {}),
    });
    if (!asked || asked.kind !== 'user' || access !== 'allowed') return denied('not_available', []);
    const assignment = assignmentForAgent(
      turn,
      asked,
      activeGrants,
      undefined,
      currentRoute.ownerIncarnation,
      installation.runtimeContract,
    );
    return withTeammates({
      kind: 'routed',
      source: 'agent_ask',
      assignment: asked.id === currentRoute.agentId ? assignment : { ...assignment, threadGuest: true },
      route: currentRoute,
      handoff: false,
      routeChanged: false,
    }, addressedIds);
  }

  const appSelection = agentAppRouteSelection(turn, surface, agents, input.agentApp);
  const mentionedGroupIds = parseAgentUserGroupMentions(turn.text);
  // A message that also names one of this installation's user-group Agents
  // addresses every Agent it names, here as on the app's own ingress.
  if (appSelection?.kind === 'ignore' && !mentionedGroupIds.some((groupId) => agentClaimsByGroupId.has(groupId))) {
    return { kind: 'ignore' };
  }
  const appAgentId = appSelection?.kind === 'select' ? appSelection.agentId : undefined;
  // A group that is not one of this installation's Agents (people, or another
  // app's Agent) is ordinary text: the message goes where it would without it.
  const mentionedAgents = mentionedGroupIds
    .flatMap((groupId) => {
      const agent = agentsByGroupId.get(groupId);
      return agent ? [agent] : [];
    });
  if (mentionedGroupIds.some((groupId) =>
    (agentClaimsByGroupId.get(groupId)?.length ?? 0) > 1
  )) {
    return denied('not_available', []);
  }
  // Directory repair binds only an Agent granted in this Channel.
  if (
    surface === 'channel' &&
    activeGrants.length > 0 &&
    mentionedGroupIds.length === 1 &&
    mentionedAgents.length === 0 &&
    input.transport
  ) {
    const repair = await repairMentionedAgentUserGroup({
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      userGroupId: mentionedGroupIds[0]!,
      config,
      transport: input.transport,
      ...(input.userGroupLookupLimiter
        ? { limiter: input.userGroupLookupLimiter }
        : {}),
    });
    if (repair.kind === 'repaired') {
      // Re-enter the ordinary stored-id path so routing, grants, handoff, and
      // memory preparation remain identical to a previously healthy mapping.
      return resolveAgentRoute(input);
    }
    if (repair.kind === 'temporarily_unavailable') return denied('temporarily_unavailable', []);
  }
  // Several handles address each of those Agents, in order: the first takes
  // the thread and the rest answer after it, as guests. Every one must be
  // reachable by this person here, or none is asked; the first is checked
  // below as the routed Agent. In a Channel an Agent app's bot is its
  // Agent's handle while the host serves that app. Chickpea's bot and that
  // app's bot each hear such a message and route it alike, so whichever hears
  // it first admits every Agent it names and the other delivery finds the
  // message taken.
  const addressed = (surface === 'channel'
    ? agentsNamed(turn.text, agentsByGroupId, agents)
    : mentionedAgents).slice(0, MAX_ADDRESSED_AGENTS);
  const severalAgents = addressed.length > 1 && !input.appHomeAgentId &&
    (appAgentId === undefined || surface === 'channel');
  // Each of them answers as its own bot: its app's, or Chickpea's. An Agent
  // this person could use or be offered here whose bot is not in the Channel
  // is not in it either: its reply could not be posted, and an Add that only
  // grants it would leave that bot out.
  const postingBotAbsent = async (agent: CustomAgentConfig, access: AgentAccess): Promise<boolean> =>
    severalAgents && (access === 'allowed' || access === 'not_in_channel') &&
    input.postingBotInChannel !== undefined && !await input.postingBotInChannel(agent);
  if (severalAgents) {
    for (const agent of addressed.slice(1)) {
      const access = await agentAccess({
        agent,
        surface,
        actor,
        activeGrants,
        workspaceManagementRoute: false,
        ...(input.authorizeUserAgent ? { authorizeUserAgent: input.authorizeUserAgent } : {}),
      });
      if (await postingBotAbsent(agent, access)) return { kind: 'not_in_channel', agent, postingBotAbsent: true };
      if (access !== 'allowed') return refusal(agent, access, available, true);
    }
  }

  let source: AgentRouteSource;
  let selected: CustomAgentConfig | undefined;
  if (severalAgents) {
    source = 'agent_handle';
    selected = addressed[0];
  } else if (appAgentId !== undefined) {
    source = 'agent_app';
    selected = agentsById.get(appAgentId);
  } else if (input.appHomeAgentId) {
    source = 'app_home';
    selected = agentsById.get(input.appHomeAgentId);
  } else if (mentionedAgents[0]) {
    source = 'agent_handle';
    selected = mentionedAgents[0];
  } else if (turn.source === 'app_mention') {
    // The base app mention is the workspace-management entry point. It must
    // remain available anywhere Chickpea has joined for another Agent, even
    // when the default Agent itself has no grant in that Channel. An explicit
    // @Chickpea also takes ownership from an existing Agent thread.
    source = 'default_agent';
    selected = agentsById.get(
      installation.runtimeContract === 'chickpea-v1'
        ? CHICKPEA_AGENT_ID
        : installation.defaultAgentId,
    );
  } else if (currentRoute) {
    source = 'thread_owner';
    selected = agentsById.get(currentRoute.agentId);
  } else if (surface === 'direct') {
    source = 'default_agent';
    selected = agentsById.get(
      installation.runtimeContract === 'chickpea-v1'
        ? CHICKPEA_AGENT_ID
        : installation.defaultAgentId,
    );
  } else {
    return { kind: 'ignore' };
  }

  const access = await agentAccess({
    agent: selected,
    surface,
    actor,
    activeGrants,
    workspaceManagementRoute: selected
      ? isWorkspaceManagementRoute(selected, source, turn, surface)
      : false,
    ...(input.authorizeUserAgent ? { authorizeUserAgent: input.authorizeUserAgent } : {}),
  });
  if (selected && await postingBotAbsent(selected, access)) {
    return { kind: 'not_in_channel', agent: selected, postingBotAbsent: true };
  }
  if (!selected || access !== 'allowed') {
    return refusal(selected, access, available, source === 'agent_handle' || source === 'agent_app');
  }

  const routed = await withTeammates(await commitSelectedAgentRoute({
    turn,
    surface,
    config,
    installation,
    selected,
    source,
    activeGrants,
    currentRoute,
  }), addressed.map(({ id }) => id));
  return severalAgents
    ? { ...routed, coAddressed: { agents: addressed.map(addressedAgent), position: 0 } }
    : routed;
}

const AGENT_ADDRESS = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>|<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** The Agents a Channel message names by user group or by served app bot, once each, in the order it names them. */
function agentsNamed(
  text: string,
  byGroupId: ReadonlyMap<string, CustomAgentConfig>,
  agents: readonly CustomAgentConfig[],
): CustomAgentConfig[] {
  const byBotUserId = new Map(agents.flatMap((agent) => {
    const bot = agentAppPostingBot(agent);
    return bot ? [[bot, agent] as const] : [];
  }));
  const named = new Map<string, CustomAgentConfig>();
  for (const [, groupId, userId] of text.matchAll(AGENT_ADDRESS)) {
    const agent = groupId ? byGroupId.get(groupId) : byBotUserId.get(userId!);
    if (agent && !named.has(agent.id)) named.set(agent.id, agent);
  }
  return [...named.values()];
}

/**
 * Whether the actor may talk to `agent`, whose run is still going in this
 * thread although the thread was handed to another Agent since (a stop or
 * check-in reaches that run, R3): routing's own rule for a reply to the
 * thread's owner, without selecting or committing a route. A system Agent's
 * Channel thread is a workspace-management thread, which needs no grant.
 */
export async function mayUseThreadAgent(input: {
  workspaceId: string;
  channelId: string;
  agent: CustomAgentConfig | undefined;
  surface: AgentRouteSurface;
  actor: AgentRoutingActor;
  config: Pick<ConfigStore, 'listAgentChannelGrants'>;
  authorizeUserAgent?: ResolveAgentRouteInput['authorizeUserAgent'];
}): Promise<boolean> {
  const activeGrants = input.surface === 'channel'
    ? (await input.config.listAgentChannelGrants(input.workspaceId, input.channelId))
        .filter((grant) => grant.status === 'active')
    : [];
  return await agentAccess({
    agent: input.agent,
    surface: input.surface,
    actor: input.actor,
    activeGrants,
    workspaceManagementRoute: input.surface === 'channel' && input.agent?.kind === 'system',
    ...(input.authorizeUserAgent ? { authorizeUserAgent: input.authorizeUserAgent } : {}),
  }) === 'allowed';
}

type AgentAccess = 'allowed' | 'unavailable' | 'private_denied' | 'not_in_channel';

/**
 * Whether the actor may talk to the Agent routing selected: a full member and
 * an active Agent; in a Channel, a member of it with the Agent's active grant
 * there (a workspace-management route needs none; a user-created Agent
 * without one is `not_in_channel`); elsewhere, a user-created Agent's live
 * placement authority (`private_denied` when that says no).
 */
async function agentAccess(input: {
  agent: CustomAgentConfig | undefined;
  surface: AgentRouteSurface;
  actor: AgentRoutingActor;
  activeGrants: AgentChannelGrant[];
  workspaceManagementRoute: boolean;
  authorizeUserAgent?: ResolveAgentRouteInput['authorizeUserAgent'];
}): Promise<AgentAccess> {
  const { agent, actor } = input;
  if (!actor.fullMember || !agent || !agentIsActive(agent)) return 'unavailable';
  if (input.surface === 'channel') {
    if (!actor.channelMember) return 'unavailable';
    if (input.workspaceManagementRoute ||
        input.activeGrants.some((candidate) => candidate.agentId === agent.id)) return 'allowed';
    return agent.kind === 'user' ? 'not_in_channel' : 'unavailable';
  }
  if (agent.kind !== 'user') return 'allowed';
  const access = await input.authorizeUserAgent?.(agent);
  return access?.status === 'allowed' ? 'allowed' : 'private_denied';
}

/**
 * Transfers the exact creation thread only after Slack acknowledges the new
 * Agent's welcome. The durable source grant or creator relationship is checked
 * again here so an outbox retry cannot widen access.
 */
export async function handoffCreatedAgentThread(input: {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  welcomeMessageTs: string;
  agentId: string;
  requesterMembershipId: string;
  surface: AgentRouteSurface;
  config: CreatedAgentHandoffConfig;
}): Promise<Extract<AgentRoutingResult, { kind: 'routed' }>> {
  const [installation, selected, grants, currentRoute] = await Promise.all([
    input.config.getWorkspaceInstallation(input.workspaceId),
    input.config.getAgent(input.agentId),
    input.surface === 'channel'
      ? input.config.listAgentChannelGrants(input.workspaceId, input.channelId)
      : Promise.resolve([]),
    input.config.getAgentThreadRoute(input.workspaceId, input.channelId, input.threadTs),
  ]);
  if (!installation || !agentIsActive(selected) || selected.kind !== 'user') {
    throw new Error('The created Agent is unavailable for thread handoff.');
  }
  const activeGrants = grants.filter(({ status }) => status === 'active');
  if (input.surface === 'channel') {
    if (!activeGrants.some(({ agentId }) => agentId === selected.id)) {
      throw new Error('The created Agent does not have an active source Channel grant.');
    }
  } else if (selected.creatorMembershipId !== input.requesterMembershipId) {
    throw new Error('The requester cannot hand this direct thread to the created Agent.');
  }
  const turn: NormalizedSlackTurn = {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    eventId: `agent-welcome:${input.agentId}`,
    text: '',
    userId: '',
    actorMembershipId: input.requesterMembershipId,
    messageTs: input.welcomeMessageTs,
    threadTs: input.threadTs,
    source: input.surface === 'channel' ? 'implicit_thread_reply' : 'dm_message',
    contextMode: input.surface === 'channel' ? 'thread' : 'dm_history',
  };
  return commitSelectedAgentRoute({
    turn,
    surface: input.surface,
    config: input.config,
    installation,
    selected,
    source: 'creation_handoff',
    activeGrants,
    currentRoute,
  });
}

async function commitSelectedAgentRoute(input: {
  turn: NormalizedSlackTurn;
  surface: AgentRouteSurface;
  config: AgentRouteCommitConfig;
  installation: NonNullable<Awaited<ReturnType<ConfigStore['getWorkspaceInstallation']>>>;
  selected: CustomAgentConfig;
  source: AgentRouteSource;
  activeGrants: AgentChannelGrant[];
  currentRoute: AgentThreadRoute | undefined;
}): Promise<Extract<AgentRoutingResult, { kind: 'routed' }>> {
  const { turn, surface, config, installation, selected, source, activeGrants, currentRoute } = input;
  const generation = selected.configurationGeneration ?? selected.revision;
  const ownerChanged = Boolean(currentRoute && currentRoute.agentId !== selected.id);
  const persistedHandoffRetry = installation.runtimeContract === 'chickpea-v1' &&
    !ownerChanged && currentRoute?.handoff?.transferMessageTs === turn.messageTs
      ? currentRoute.handoff
      : undefined;
  const freshHandoffContext = installation.runtimeContract === 'chickpea-v1' && ownerChanged
    ? boundedSlackPublicHandoff(await config.listSlackPublicContext(
        turn.workspaceId,
        turn.channelId,
        turn.threadTs,
      ))
    : undefined;
  const handoffContext = persistedHandoffRetry?.context ?? freshHandoffContext;
  const routeChanged = !currentRoute || ownerChanged ||
    currentRoute.agentGeneration !== generation;
  const route = routeChanged
    ? await config.putAgentThreadRoute({
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        threadTs: turn.threadTs,
        agentId: selected.id,
        agentGeneration: generation,
        ownerIncarnation: currentRoute
          ? currentRoute.ownerIncarnation + (ownerChanged ? 1 : 0)
          : 1,
        ...(ownerChanged && currentRoute
          ? {
              handoff: {
                transferMessageTs: turn.messageTs,
                previousAgentId: currentRoute.agentId,
                ...(freshHandoffContext?.length
                  ? { context: freshHandoffContext }
                  : {}),
              },
            }
          : {}),
      }, currentRoute?.revision ?? 0)
    : currentRoute;

  return {
    kind: 'routed',
    source,
    assignment: assignmentForAgent(
      turn,
      selected,
      activeGrants,
      isWorkspaceManagementRoute(selected, source, turn, surface)
        ? 'workspace_management'
        : undefined,
      route.ownerIncarnation,
      installation.runtimeContract,
      handoffContext,
    ),
    route,
    handoff: ownerChanged || Boolean(persistedHandoffRetry),
    routeChanged,
    ...((ownerChanged && currentRoute) || persistedHandoffRetry
      ? {
          previousAgentId: ownerChanged
            ? currentRoute!.agentId
            : persistedHandoffRetry!.previousAgentId,
        }
      : {}),
    ...((ownerChanged && !freshHandoffContext?.length) ||
        (persistedHandoffRetry && persistedHandoffRetry.context === undefined)
      ? { handoffFallbackRequired: true }
      : {}),
  };
}

/**
 * An explicit base-app mention opens a Chickpea-owned workspace-management
 * thread. Later plain replies continue that exact trusted route. Requiring a
 * Channel grant on those replies would make the route unusable because the
 * system Agent deliberately cannot receive user-Agent Channel grants.
 */
function isWorkspaceManagementRoute(
  selected: CustomAgentConfig,
  source: AgentRouteSource,
  turn: NormalizedSlackTurn,
  surface: AgentRouteSurface,
): boolean {
  if (surface !== 'channel' || selected.kind !== 'system') return false;
  return (source === 'thread_owner' && turn.source === 'implicit_thread_reply') ||
    (source === 'default_agent' && turn.source === 'app_mention');
}

function agentIsActive(agent: CustomAgentConfig): boolean {
  return agent.enabled && agent.lifecycle !== 'archived' && agent.lifecycle !== 'draft';
}

async function availableAlternatives(
  grants: AgentChannelGrant[],
  agentsById: Map<string, CustomAgentConfig>,
): Promise<AgentRouteAlternative[]> {
  return grants
    .flatMap((grant) => {
      const agent = agentsById.get(grant.agentId);
      if (!agent || agent.kind !== 'user' || !agentIsActive(agent)) return [];
      return [{
        id: agent.id,
        name: agent.name,
        handle: agent.slackPresence?.normalizedHandle ?? agent.id,
      }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Agents one person's message can address; later handles are not asked. */
const MAX_ADDRESSED_AGENTS = 6;

/** How a turn names one of the Agents a person's message addressed. */
function addressedAgent(agent: CustomAgentConfig): SlackCoAddressed['agents'][number] {
  return {
    agentId: agent.id,
    name: agent.name,
    handle: agentSlackHandle(agent)?.handle ?? agent.id,
  };
}

/** Most teammates one Agent is told about. */
const MAX_TEAMMATES = 20;

/**
 * The active user Agents among `agentIds` with a Slack handle, other than
 * `selfId`: whom that Agent can ask here. Ordered by name.
 */
function teammatesAmong(
  agentIds: Iterable<string>,
  agentsById: Map<string, CustomAgentConfig>,
  selfId: string,
): AgentTeammate[] {
  return [...new Set(agentIds)]
    .flatMap((agentId) => {
      const agent = agentsById.get(agentId);
      const presence = agent && agentSlackHandle(agent);
      if (!agent || !presence || agent.id === selfId || agent.kind !== 'user' || !agentIsActive(agent)) return [];
      return [{ name: agent.name, ...presence }];
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_TEAMMATES);
}

function assignmentForAgent(
  turn: NormalizedSlackTurn,
  agent: CustomAgentConfig,
  grants: AgentChannelGrant[],
  interactionMode?: ResolvedAssignment['interactionMode'],
  ownerIncarnation?: number,
  runtimeContract?: ResolvedAssignment['runtimeContract'],
  handoffContext?: ResolvedAssignment['handoffContext'],
): ResolvedAssignment {
  const grant = grants.find((candidate) => candidate.agentId === agent.id);
  return {
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    agentId: agent.id,
    ...(runtimeContract ? { runtimeContract } : {}),
    ...(ownerIncarnation ? { ownerIncarnation } : {}),
    ...(handoffContext?.length ? { handoffContext } : {}),
    ...(interactionMode ? { interactionMode } : {}),
    ...(grant?.channelLabel ? { channelLabel: grant.channelLabel } : {}),
    agent,
  };
}

/**
 * How routing answers someone who cannot use `agent` here. Only an Agent the
 * person mentioned is named as missing from the Channel; any other refusal
 * lists the Agents this Channel has, unless that would disclose a private one.
 */
function refusal(
  agent: CustomAgentConfig | undefined,
  access: AgentAccess,
  available: AgentRouteAlternative[],
  mentioned: boolean,
): Exclude<AgentRoutingResult, { kind: 'ignore' | 'routed' }> {
  if (mentioned && agent && access === 'not_in_channel') return { kind: 'not_in_channel', agent };
  return denied('not_available', access === 'private_denied' ? [] : available);
}

function denied(
  reason: AgentRoutingDenialReason,
  alternatives: AgentRouteAlternative[],
): Extract<AgentRoutingResult, { kind: 'denied' }> {
  return { kind: 'denied', reason, alternatives };
}
