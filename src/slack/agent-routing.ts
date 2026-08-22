import { canEditAgent } from '../auth/permissions.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import type { ConfigStore } from '../config/store.ts';
import {
  type AgentChannelGrant,
  type AgentThreadRoute,
  type CustomAgentConfig,
  type ResolvedAssignment,
} from '../config/types.ts';
import type { NormalizedSlackTurn } from './types.ts';

export type AgentRouteSurface = 'channel' | 'direct';
export type AgentRouteSource =
  | 'agent_handle'
  | 'thread_owner'
  | 'default_agent'
  | 'app_home';

export type AgentRoutingDenialReason =
  | 'not_available'
  | 'multiple_agents'
  | 'member_required'
  | 'installation_unavailable';

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
    };

export interface AgentRoutingActor {
  channelMember: boolean;
  fullMember: boolean;
  /** Agents discoverable in App Home or an Agent-specific DM. */
  discoverableAgentIds?: ReadonlySet<string>;
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
    | 'getAgentThreadRoute'
    | 'putAgentThreadRoute'
  >;
  /** Trusted Agent seed from App Home interactivity, never Slack message text. */
  appHomeAgentId?: string;
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

  const [agents, channelGrants, currentRoute] = await Promise.all([
    config.listAgents(),
    surface === 'channel'
      ? config.listAgentChannelGrants(turn.workspaceId, turn.channelId)
      : Promise.resolve([]),
    config.getAgentThreadRoute(turn.workspaceId, turn.channelId, turn.threadTs),
  ]);
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const agentsByGroupId = new Map(
    agents.flatMap((agent) => agent.slackPresence?.userGroupId
      ? [[agent.slackPresence.userGroupId, agent] as const]
      : []),
  );
  const activeGrants = channelGrants.filter((grant) => grant.status === 'active');
  const available = await availableAlternatives(activeGrants, agentsById);

  const mentionedAgents = parseAgentUserGroupMentions(turn.text)
    .flatMap((groupId) => {
      const agent = agentsByGroupId.get(groupId);
      return agent ? [agent] : [];
    });
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
    selected = agentsById.get(installation.defaultAgentId);
  } else if (currentRoute) {
    source = 'thread_owner';
    selected = agentsById.get(currentRoute.agentId);
  } else if (surface === 'direct') {
    source = 'default_agent';
    selected = agentsById.get(installation.defaultAgentId);
  } else {
    return { kind: 'ignore' };
  }

  if (!selected || !agentIsActive(selected)) {
    return denied('not_available', available);
  }

  if (surface === 'channel') {
    const grant = activeGrants.find((candidate) => candidate.agentId === selected!.id);
    const baseAppMention = source === 'default_agent' && turn.source === 'app_mention';
    if (!actor.channelMember || (!baseAppMention && !grant)) {
      return denied('not_available', available);
    }
  } else {
    if (!actor.fullMember) return denied('member_required', []);
    const selectedFromDirectory = source === 'app_home' || source === 'agent_handle' ||
      (source === 'thread_owner' && selected.id !== installation.defaultAgentId);
    if (selectedFromDirectory && !actor.discoverableAgentIds?.has(selected.id)) {
      return denied('not_available', []);
    }
  }

  const generation = selected.configurationGeneration ?? selected.revision;
  const routeChanged = !currentRoute || currentRoute.agentId !== selected.id ||
    currentRoute.agentGeneration !== generation;
  const route = routeChanged
    ? await config.putAgentThreadRoute({
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        threadTs: turn.threadTs,
        agentId: selected.id,
        agentGeneration: generation,
      }, currentRoute?.revision ?? 0)
    : currentRoute;

  return {
    kind: 'routed',
    source,
    assignment: assignmentForAgent(
      turn,
      selected,
      activeGrants,
      source === 'default_agent' && turn.source === 'app_mention'
        ? 'workspace_management'
        : undefined,
    ),
    route,
    handoff: Boolean(currentRoute && currentRoute.agentId !== selected.id),
    routeChanged,
  };
}

export async function discoverableAgents(input: {
  config: Pick<ConfigStore, 'listAgents' | 'listAgentChannelGrants'>;
  workspaceId: string;
  principal?: AuthPrincipal;
  channelMember: (channelId: string) => Promise<boolean>;
}): Promise<CustomAgentConfig[]> {
  const [agents, grants] = await Promise.all([
    input.config.listAgents(),
    input.config.listAgentChannelGrants(input.workspaceId),
  ]);
  const grantedChannelsByAgent = new Map<string, Set<string>>();
  for (const grant of grants) {
    if (grant.status !== 'active') continue;
    const channels = grantedChannelsByAgent.get(grant.agentId) ?? new Set<string>();
    channels.add(grant.channelId);
    grantedChannelsByAgent.set(grant.agentId, channels);
  }
  const membership = new Map<string, boolean>();
  const channelMember = async (channelId: string): Promise<boolean> => {
    const cached = membership.get(channelId);
    if (cached !== undefined) return cached;
    const allowed = await input.channelMember(channelId);
    membership.set(channelId, allowed);
    return allowed;
  };
  const visible: CustomAgentConfig[] = [];
  for (const agent of agents) {
    if (!agentIsActive(agent)) continue;
    if (input.principal && canEditAgent(input.principal, agent)) {
      visible.push(agent);
      continue;
    }
    const channels = grantedChannelsByAgent.get(agent.id) ?? new Set<string>();
    for (const channelId of channels) {
      if (await channelMember(channelId)) {
        visible.push(agent);
        break;
      }
    }
  }
  return visible.sort((left, right) => left.name.localeCompare(right.name));
}

function agentIsActive(agent: CustomAgentConfig): boolean {
  return agent.enabled && agent.lifecycle !== 'archived';
}

async function availableAlternatives(
  grants: AgentChannelGrant[],
  agentsById: Map<string, CustomAgentConfig>,
): Promise<AgentRouteAlternative[]> {
  return grants
    .flatMap((grant) => {
      const agent = agentsById.get(grant.agentId);
      if (!agent || !agentIsActive(agent)) return [];
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
): ResolvedAssignment {
  const grant = grants.find((candidate) => candidate.agentId === agent.id);
  return {
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    agentId: agent.id,
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
