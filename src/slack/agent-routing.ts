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
import { CHICKPEA_AGENT_ID } from '../config/agent-id.ts';
import { boundedSlackPublicHandoff } from './public-context.ts';
import {
  AgentUserGroupLookupLimiter,
  repairMentionedAgentUserGroup,
} from './agent-presence/reconciler.ts';
import type { SlackTransport } from './transport/types.ts';

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
    const baseAppMention = source === 'default_agent' && turn.source === 'app_mention';
    if (!actor.channelMember || (!baseAppMention && !grant)) {
      return denied('not_available', available);
    }
  } else {
    if (!actor.fullMember) return denied('member_required', []);
    const selectedFromDirectory = selected.kind === 'user' && (
      source === 'app_home' || source === 'agent_handle' || source === 'thread_owner'
    );
    if (selectedFromDirectory && !actor.discoverableAgentIds?.has(selected.id)) {
      return denied('not_available', []);
    }
  }

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
      source === 'default_agent' && turn.source === 'app_mention'
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
    if (agent.kind !== 'user' || !agentIsActive(agent)) continue;
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
