import type { AgentChannelGrant, CustomAgentConfig } from '../config/types.ts';
import type { SlackConversationKind } from './thread-key.ts';
import {
  SlackTransportError,
  type SlackChannel,
  type SlackTransport,
} from './transport/types.ts';

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

/** The Slack facts one Agent's access is decided from: its placed Channels, and the person's. */
export type PrivateAgentPlacementFacts = Pick<SlackTransport, 'lookupChannel' | 'listMemberChannels'>;

/**
 * Whether Slack shows a person a Channel: `shown` for a public one, or a
 * private one they are in; `unavailable` when Slack could not answer.
 */
export type MemberChannelView = 'shown' | 'hidden' | 'unavailable';

interface PrivateAgentAccessInput {
  agent: CustomAgentConfig;
  workspaceId: string;
  grants: readonly AgentChannelGrant[];
  actor: PrivateAgentActor;
  transport: PrivateAgentPlacementFacts;
}

interface PrivateAgentAudienceInput {
  agent: CustomAgentConfig;
  workspaceId: string;
  grants: readonly AgentChannelGrant[];
  transport?: PrivateAgentPlacementFacts;
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
  const facts = await collectTargetedFacts(grants.map(({ channelId }) => channelId), input.transport);
  const placement = placementState(grants, facts);
  const memberChannels = input.actor.fullMember && input.actor.slackUserId &&
      !placement.verifiedPublic && placement.verifiedPrivateChannelIds.size > 0
    ? await listMemberChannels(input.transport, input.actor.slackUserId)
    : undefined;
  return evaluateAccess(input.agent, input.actor, placement, memberChannels);
}

/** Slack's view of these Channels for one person, read the way Agent placement is. */
export async function memberChannelViews(
  channelIds: readonly string[],
  slackUserId: string,
  transport: PrivateAgentPlacementFacts,
): Promise<ReadonlyMap<string, MemberChannelView>> {
  const facts = await collectTargetedFacts(channelIds, transport);
  const memberChannels = [...facts.values()].some((channel) => channel?.private)
    ? await listMemberChannels(transport, slackUserId)
    : undefined;
  return new Map(channelIds.map((channelId) => {
    const channel = facts.get(channelId);
    if (!channel) return [channelId, 'unavailable'];
    if (channel.archived) return [channelId, 'hidden'];
    if (!channel.private) return [channelId, 'shown'];
    if (!memberChannels) return [channelId, 'unavailable'];
    return [channelId, channel.member && memberChannels.has(channelId) ? 'shown' : 'hidden'];
  }));
}

/**
 * Private use of one user Agent for one turn. A group DM's answer reaches
 * everyone in it, and nothing records who may use an Agent there, so only an
 * Agent every workspace member may use answers in one. Elsewhere the asker's
 * own private use decides.
 */
export async function resolveTurnAgentAccess(
  input: PrivateAgentAccessInput & { conversation: SlackConversationKind },
): Promise<PrivateAgentAccessResult> {
  if (input.conversation !== 'mpim') return resolvePrivateAgentAccess(input);
  const audience = await resolvePrivateAgentAudience(input);
  const status = audience === 'unavailable'
    ? 'unavailable'
    : audience === 'workspace_members' && input.actor.fullMember ? 'allowed' : 'denied';
  return { status, audience };
}

/** Derive the non-sensitive audience explanation used by Agent Admin. */
export async function resolvePrivateAgentAudience(
  input: PrivateAgentAudienceInput,
): Promise<PrivateAgentAudience> {
  if (!agentIsEligible(input.agent)) return 'unavailable';
  const grants = activeAgentGrants(input);
  if (grants.length === 0) return 'creator_only';
  if (!input.transport) return 'unavailable';
  const facts = await collectTargetedFacts(grants.map(({ channelId }) => channelId), input.transport);
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
  const grantsByAgent = new Map<string, AgentChannelGrant[]>();
  for (const grant of grants) {
    const agentGrants = grantsByAgent.get(grant.agentId) ?? [];
    agentGrants.push(grant);
    grantsByAgent.set(grant.agentId, agentGrants);
  }
  const facts = await collectDirectoryFacts(grants, input.transport);
  const placements = new Map<string, PlacementState>();
  for (const agent of agents) {
    placements.set(agent.id, placementState(
      grantsByAgent.get(agent.id) ?? [],
      facts,
    ));
  }

  const privateMembershipNeeded = [...placements.values()].some((placement) =>
    !placement.verifiedPublic && placement.verifiedPrivateChannelIds.size > 0
  );
  const memberChannels = privateMembershipNeeded && input.actor.slackUserId
    ? await listMemberChannels(input.transport, input.actor.slackUserId)
    : undefined;

  return agents.filter((agent) =>
    evaluateAccess(agent, input.actor, placements.get(agent.id)!, memberChannels).status === 'allowed'
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
  channelIds: readonly string[],
  transport: Pick<SlackTransport, 'lookupChannel'>,
): Promise<ReadonlyMap<string, SlackChannel | undefined>> {
  const facts = new Map<string, SlackChannel | undefined>();
  let firstFailure: unknown;
  let failed = false;
  await Promise.all([...new Set(channelIds)].map(
    async (channelId) => {
      try {
        const channel = await transport.lookupChannel(channelId);
        facts.set(channelId, channel.id === channelId ? channel : undefined);
      } catch (error) {
        if (!failed) firstFailure = error;
        failed = true;
        facts.set(channelId, undefined);
      }
    },
  ));
  if (failed) logUnavailableFacts('placement', firstFailure);
  return facts;
}

async function collectDirectoryFacts(
  grants: readonly AgentChannelGrant[],
  transport: AgentAccessTransport,
): Promise<ReadonlyMap<string, SlackChannel | undefined>> {
  const channelIds = [...new Set(grants.map(({ channelId }) => channelId))];
  if (channelIds.length < DIRECTORY_CROSSOVER) {
    return collectTargetedFacts(channelIds, transport);
  }

  const wanted = new Set(channelIds);
  const facts = new Map<string, SlackChannel | undefined>();
  try {
    const directory = await transport.listChannels();
    for (const channel of directory.channels) {
      if (wanted.has(channel.id)) facts.set(channel.id, channel);
    }
  } catch (error) {
    logUnavailableFacts('directory', error);
    // Targeted lookups below recover any placement Slack can still verify.
  }

  const targeted = await collectTargetedFacts(
    channelIds.filter((channelId) => !facts.has(channelId)),
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

/** The person's Channels, or undefined when Slack could not list them. */
async function listMemberChannels(
  transport: Pick<SlackTransport, 'listMemberChannels'>,
  slackUserId: string,
): Promise<ReadonlySet<string> | undefined> {
  try {
    return await transport.listMemberChannels(slackUserId);
  } catch (error) {
    logUnavailableFacts('member-channels', error);
    return undefined;
  }
}

function evaluateAccess(
  agent: CustomAgentConfig,
  actor: PrivateAgentActor,
  placement: PlacementState,
  memberChannels: ReadonlySet<string> | undefined,
): PrivateAgentAccessResult {
  if (!agentIsEligible(agent)) return { status: 'unavailable', audience: 'unavailable' };
  if (placement.verifiedPublic) {
    return {
      status: actor.fullMember ? 'allowed' : 'denied',
      audience: 'workspace_members',
    };
  }
  if (placement.verifiedPrivateChannelIds.size > 0) {
    if (!memberChannels) {
      return { status: 'unavailable', audience: 'unavailable' };
    }
    const isMember = [...placement.verifiedPrivateChannelIds].some((channelId) =>
      memberChannels.has(channelId)
    );
    if (actor.fullMember && isMember) {
      return { status: 'allowed', audience: 'private_channel_members' };
    }
    if (placement.unavailable) {
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

export function logUnavailableFacts(
  category: 'placement' | 'directory' | 'member-channels' | 'transport',
  error: unknown,
): void {
  const reason = error instanceof SlackTransportError
    ? `${error.operation}:${error.code}`
    : 'unexpected_error';
  console.warn(`[chickpea] Agent private-use ${category} facts unavailable (${reason})`);
}
