import type { ConfigStore } from '../config/store.ts';
import {
  type AgentChannelGrant,
  type AgentThreadRoute,
  type CustomAgentConfig,
  type ResolvedAssignment,
} from '../config/types.ts';
import type { NormalizedSlackTurn } from './types.ts';
import { CHICKPEA_AGENT_ID } from '../config/agent-id.ts';
import { boundedSlackPublicHandoff } from './public-context.ts';
import {
  AgentUserGroupLookupLimiter,
  repairMentionedAgentUserGroup,
} from './agent-presence/reconciler.ts';
import type { SlackTransport } from './transport/types.ts';
import type { PrivateAgentAccessResult } from './agent-access.ts';

export type AgentRouteSurface = 'channel' | 'direct';
export type AgentRouteSource =
  | 'agent_handle'
  | 'thread_owner'
  | 'default_agent'
  | 'app_home'
  | 'creation_handoff';

export type AgentRoutingDenialReason =
  | 'not_available'
  | 'multiple_agents'
  | 'member_required'
  | 'installation_unavailable'
  | 'temporarily_unavailable';

export interface AgentRouteAlternative {
  id: string;
  name: string;
  handle: string;
}

export type AgentRoutingResult =
  | { kind: 'ignore' }
  | {
      kind: 'denied' | 'ambiguous';
      reason: AgentRoutingDenialReason;
      alternatives: AgentRouteAlternative[];
    }
  | {
      kind: 'routed';
      source: AgentRouteSource;
      assignment: ResolvedAssignment;
      route: AgentThreadRoute;
      handoff: boolean;
      routeChanged: boolean;
      previousAgentId?: string;
      handoffFallbackRequired?: boolean;
    };

export interface AgentRoutingActor {
  channelMember: boolean;
  fullMember: boolean;
}

export interface ResolveAgentRouteInput {
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
  /** Authenticated Slack directory seam used only when a mentioned immutable
   * group id is absent from the stored Agent map. */
  transport?: Pick<SlackTransport, 'lookupUserGroup'>;
  userGroupLookupLimiter?: AgentUserGroupLookupLimiter;
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

  const mentionedGroupIds = parseAgentUserGroupMentions(turn.text);
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
  if (
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
    return denied(
      repair.kind === 'temporarily_unavailable'
        ? 'temporarily_unavailable'
        : 'not_available',
      [],
    );
  }
  if (mentionedAgents.length !== mentionedGroupIds.length) {
    return denied('not_available', []);
  }
  if (mentionedAgents.length > 1) {
    return denied('multiple_agents', available, 'ambiguous');
  }

  let source: AgentRouteSource;
  let selected: CustomAgentConfig | undefined;
  if (input.appHomeAgentId) {
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

  if (!selected || !agentIsActive(selected)) {
    return denied('not_available', available);
  }

  if (surface === 'channel') {
    const grant = activeGrants.find((candidate) => candidate.agentId === selected!.id);
    const workspaceManagementRoute = isWorkspaceManagementRoute(
      selected,
      source,
      turn,
      surface,
    );
    if (!actor.channelMember || (!workspaceManagementRoute && !grant)) {
      return denied('not_available', available);
    }
  } else {
    if (selected.kind === 'user') {
      const access = await input.authorizeUserAgent?.(selected);
      if (access?.status !== 'allowed') {
        return denied('not_available', []);
      }
    }
  }

  return commitSelectedAgentRoute({
    turn,
    surface,
    config,
    installation,
    selected,
    source,
    activeGrants,
    currentRoute,
  });
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

function denied(
  reason: AgentRoutingDenialReason,
  alternatives: AgentRouteAlternative[],
  kind: 'denied' | 'ambiguous' = 'denied',
): Extract<AgentRoutingResult, { kind: 'denied' | 'ambiguous' }> {
  return { kind, reason, alternatives };
}
