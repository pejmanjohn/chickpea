import type { AgentChannelGrant, CustomAgentConfig } from '../config/types.ts';
import type { SlackChannel, SlackTransport } from './transport/types.ts';

export type PrivateAgentAudience =
  | 'workspace_members'
  | 'private_channel_members'
  | 'creator_only'
  | 'unavailable';

export type PrivateAgentAccessResult = {
  status: 'allowed' | 'denied' | 'unavailable';
  audience: PrivateAgentAudience;
};

export interface PrivateAgentActor {
  fullMember: boolean;
  membershipId?: string;
  slackUserId?: string;
}

type AgentAccessTransport = Pick<
  SlackTransport,
  'lookupChannel' | 'listChannels' | 'listMemberChannels'
>;

interface PrivateAgentAccessInput {
  agent: CustomAgentConfig;
  workspaceId: string;
  grants: readonly AgentChannelGrant[];
  actor: PrivateAgentActor;
  transport: AgentAccessTransport;
}

interface PrivateAgentAudienceInput {
  agent: CustomAgentConfig;
  workspaceId: string;
  grants: readonly AgentChannelGrant[];
  transport: AgentAccessTransport;
}

interface PrivateAgentDirectoryInput {
  agents: readonly CustomAgentConfig[];
  workspaceId: string;
  grants: readonly AgentChannelGrant[];
  actor: PrivateAgentActor;
  transport: AgentAccessTransport;
}

interface PlacementState {
  activeGrantCount: number;
  verifiedPublic: boolean;
  verifiedPrivateChannelIds: ReadonlySet<string>;
  unavailable: boolean;
}

const DIRECTORY_CROSSOVER = 8;

/** Resolve one selected user-created Agent without inspecting unrelated Agents. */
export async function resolvePrivateAgentAccess(
  input: PrivateAgentAccessInput,
): Promise<PrivateAgentAccessResult> {
  const grants = activeAgentGrants(input);
  const facts = await collectTargetedFacts(grants, input.transport);
  const placement = placementState(grants, facts);
  let memberChannels: ReadonlySet<string> | undefined;
  let memberChannelsUnavailable = false;
  if (
    input.actor.fullMember && input.actor.slackUserId &&
    !placement.verifiedPublic && placement.verifiedPrivateChannelIds.size > 0
  ) {
    try {
      memberChannels = await input.transport.listMemberChannels(input.actor.slackUserId);
    } catch {
      memberChannelsUnavailable = true;
    }
  }
  return evaluateAccess(input.agent, input.actor, placement, {
    memberChannelsUnavailable,
    ...(memberChannels ? { memberChannels } : {}),
  });
}

/** Derive the non-sensitive audience explanation used by Agent Admin. */
export async function resolvePrivateAgentAudience(
  input: PrivateAgentAudienceInput,
): Promise<PrivateAgentAudience> {
  const grants = activeAgentGrants(input);
  const facts = await collectTargetedFacts(grants, input.transport);
  return audienceForPlacement(placementState(grants, facts));
}

/** Resolve the App Home directory with one fact snapshot for this interaction. */
export async function listPrivatelyUsableAgents(
  input: PrivateAgentDirectoryInput,
): Promise<CustomAgentConfig[]> {
  if (!input.actor.fullMember) return [];
  const agents = input.agents
    .filter(agentIsEligible)
    .sort((left, right) => left.name.localeCompare(right.name));
  const agentIds = new Set(agents.map(({ id }) => id));
  const grants = input.grants.filter((grant) =>
    grant.workspaceId === input.workspaceId &&
    grant.status === 'active' &&
    agentIds.has(grant.agentId)
  );
  const facts = await collectDirectoryFacts(grants, input.transport);
  const placements = new Map<string, PlacementState>();
  for (const agent of agents) {
    placements.set(agent.id, placementState(
      grants.filter((grant) => grant.agentId === agent.id),
      facts,
    ));
  }

  let memberChannels: ReadonlySet<string> | undefined;
  let memberChannelsUnavailable = false;
  const privateMembershipNeeded = [...placements.values()].some((placement) =>
    !placement.verifiedPublic && placement.verifiedPrivateChannelIds.size > 0
  );
  if (privateMembershipNeeded && input.actor.slackUserId) {
    try {
      memberChannels = await input.transport.listMemberChannels(input.actor.slackUserId);
    } catch {
      memberChannelsUnavailable = true;
    }
  }

  return agents.filter((agent) =>
    evaluateAccess(agent, input.actor, placements.get(agent.id)!, {
      memberChannelsUnavailable,
      ...(memberChannels ? { memberChannels } : {}),
    }).status === 'allowed'
  );
}

function activeAgentGrants(input: {
  agent: CustomAgentConfig;
  workspaceId: string;
  grants: readonly AgentChannelGrant[];
}): AgentChannelGrant[] {
  if (!agentIsEligible(input.agent)) return [];
  return input.grants.filter((grant) =>
    grant.workspaceId === input.workspaceId &&
    grant.agentId === input.agent.id &&
    grant.status === 'active'
  );
}

function agentIsEligible(agent: CustomAgentConfig): boolean {
  return agent.kind === 'user' && agent.enabled &&
    agent.lifecycle !== 'draft' && agent.lifecycle !== 'archived';
}

async function collectTargetedFacts(
  grants: readonly AgentChannelGrant[],
  transport: AgentAccessTransport,
): Promise<ReadonlyMap<string, SlackChannel | undefined>> {
  const facts = new Map<string, SlackChannel | undefined>();
  await Promise.all([...new Set(grants.map(({ channelId }) => channelId))].map(
    async (channelId) => {
      try {
        const channel = await transport.lookupChannel(channelId);
        facts.set(channelId, channel.id === channelId ? channel : undefined);
      } catch {
        facts.set(channelId, undefined);
      }
    },
  ));
  return facts;
}

async function collectDirectoryFacts(
  grants: readonly AgentChannelGrant[],
  transport: AgentAccessTransport,
): Promise<ReadonlyMap<string, SlackChannel | undefined>> {
  const channelIds = [...new Set(grants.map(({ channelId }) => channelId))];
  if (channelIds.length < DIRECTORY_CROSSOVER) {
    return collectTargetedFacts(grants, transport);
  }

  const wanted = new Set(channelIds);
  const facts = new Map<string, SlackChannel | undefined>();
  try {
    const directory = await transport.listChannels();
    for (const channel of directory.channels) {
      if (wanted.has(channel.id)) facts.set(channel.id, channel);
    }
  } catch {
    // Targeted lookups below recover any placement Slack can still verify.
  }

  const unresolved = channelIds.filter((channelId) => !facts.has(channelId));
  const targeted = await collectTargetedFacts(
    grants.filter((grant) => unresolved.includes(grant.channelId)),
    transport,
  );
  for (const [channelId, channel] of targeted) facts.set(channelId, channel);
  return facts;
}

function placementState(
  grants: readonly AgentChannelGrant[],
  facts: ReadonlyMap<string, SlackChannel | undefined>,
): PlacementState {
  const verifiedPrivateChannelIds = new Set<string>();
  let verifiedPublic = false;
  let unavailable = false;
  for (const grant of grants) {
    const channel = facts.get(grant.channelId);
    if (!channel || channel.archived || !channel.member) {
      unavailable = true;
      continue;
    }
    if (channel.private) verifiedPrivateChannelIds.add(channel.id);
    else verifiedPublic = true;
  }
  return {
    activeGrantCount: grants.length,
    verifiedPublic,
    verifiedPrivateChannelIds,
    unavailable,
  };
}

function audienceForPlacement(placement: PlacementState): PrivateAgentAudience {
  if (placement.verifiedPublic) return 'workspace_members';
  if (placement.unavailable) return 'unavailable';
  if (placement.verifiedPrivateChannelIds.size > 0) return 'private_channel_members';
  if (placement.activeGrantCount === 0) return 'creator_only';
  return 'unavailable';
}

function evaluateAccess(
  agent: CustomAgentConfig,
  actor: PrivateAgentActor,
  placement: PlacementState,
  membership: {
    memberChannels?: ReadonlySet<string>;
    memberChannelsUnavailable: boolean;
  },
): PrivateAgentAccessResult {
  if (!agentIsEligible(agent)) return { status: 'unavailable', audience: 'unavailable' };
  if (placement.verifiedPublic) {
    return {
      status: actor.fullMember ? 'allowed' : 'denied',
      audience: 'workspace_members',
    };
  }
  if (placement.verifiedPrivateChannelIds.size > 0) {
    const isMember = [...placement.verifiedPrivateChannelIds].some((channelId) =>
      membership.memberChannels?.has(channelId)
    );
    if (actor.fullMember && isMember) {
      return { status: 'allowed', audience: 'private_channel_members' };
    }
    if (placement.unavailable || membership.memberChannelsUnavailable || !membership.memberChannels) {
      return { status: 'unavailable', audience: 'unavailable' };
    }
    return { status: 'denied', audience: 'private_channel_members' };
  }
  if (placement.activeGrantCount === 0) {
    return {
      status: actor.fullMember && Boolean(agent.creatorMembershipId) &&
          agent.creatorMembershipId === actor.membershipId
        ? 'allowed'
        : 'denied',
      audience: 'creator_only',
    };
  }
  return { status: 'unavailable', audience: 'unavailable' };
}
