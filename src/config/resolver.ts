import { parseSlackThreadKey } from '../slack/thread-key.ts';

import { DisabledAgentError, NoAssignmentError, UnknownAgentError } from './errors.ts';
import { seededAgents, seededAssignments } from './seed.ts';
import type { ChannelAssignment, CustomAgentConfig, ResolvedAssignment } from './types.ts';

export interface AgentReader {
  getAgent(agentId: string): CustomAgentConfig;
}

// A turn's surface. The global '*,*' wildcard assignment is the default for
// DIRECT conversations only (DMs, App Home): a direct message is a separate
// surface, not a channel that access attaches to. CHANNELS are fail-closed —
// they resolve only via an explicit (exact / workspace / channel) assignment
// and never fall through to the global wildcard.
export type AssignmentSurface = 'channel' | 'direct';

export interface AssignmentLookupOptions {
  surface?: AssignmentSurface;
}

// Infer the surface from a channel id, for the paths that resolve from a thread
// key rather than a live turn (the durable agent and admin). Prefer the live
// turn's authoritative source/channel_type when available (see turnSurface in
// the Slack channel) — this id heuristic is the fallback.
//
// Slack 1:1 DM and App Home channel ids are 'D…'; public channels are 'C…'.
// A 'G…' id is ambiguous — legacy private channel vs group DM (mpim) — and the
// app_mention event carries no channel_type to disambiguate, so it is treated
// as a channel: the fail-closed default (better to require an explicit
// assignment than to let a private channel answer via the DM wildcard). The
// literal '*' key is the direct-message default row itself.
export function surfaceForChannelId(channelId: string): AssignmentSurface {
  if (channelId === '*') {
    return 'direct';
  }
  return channelId.startsWith('D') ? 'direct' : 'channel';
}

export interface AssignmentReader {
  find(
    workspaceId: string,
    channelId: string,
    options?: AssignmentLookupOptions,
  ): ChannelAssignment | undefined;
}

export interface ConfigStores {
  agents: AgentReader;
  assignments: AssignmentReader;
}

export class AgentStore {
  readonly agents: Map<string, CustomAgentConfig>;

  constructor(agents: CustomAgentConfig[] = seededAgents) {
    this.agents = new Map(agents.map((agent) => [agent.id, agent]));
  }

  getAgent(agentId: string): CustomAgentConfig {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new UnknownAgentError(agentId);
    }
    return agent;
  }
}

export class AssignmentStore {
  readonly assignments: ChannelAssignment[];

  constructor(assignments: ChannelAssignment[] = seededAssignments) {
    this.assignments = assignments;
  }

  find(
    workspaceId: string,
    channelId: string,
    options: AssignmentLookupOptions = {},
  ): ChannelAssignment | undefined {
    const surface = options.surface ?? 'direct';
    const exact = this.assignments.find(
      (assignment) =>
        assignment.workspaceId === workspaceId &&
        assignment.channelId === channelId &&
        assignment.enabled,
    );
    if (exact) {
      return exact;
    }

    return this.assignments.find(
      (assignment) =>
        assignment.enabled &&
        (assignment.workspaceId === workspaceId || assignment.workspaceId === '*') &&
        (assignment.channelId === channelId || assignment.channelId === '*') &&
        // Channels never fall through to the global wildcard (fail-closed).
        !(surface === 'channel' && assignment.workspaceId === '*' && assignment.channelId === '*'),
    );
  }
}

export function resolveAssignment(
  workspaceId: string,
  channelId: string,
  stores: ConfigStores,
  options: AssignmentLookupOptions = {},
): ResolvedAssignment {
  const assignment = stores.assignments.find(workspaceId, channelId, options);
  if (!assignment) {
    throw new NoAssignmentError(`No enabled agent assignment for ${workspaceId}/${channelId}`);
  }

  const agent = stores.agents.getAgent(assignment.agentId);
  if (!agent.enabled) {
    throw new DisabledAgentError(agent.id);
  }

  return {
    workspaceId,
    channelId,
    agentId: agent.id,
    ...(assignment.channelPromptAddendum
      ? { channelPromptAddendum: assignment.channelPromptAddendum }
      : {}),
    agent,
  };
}

export function resolveAssignmentFromThreadKey(
  threadKey: string,
  stores: ConfigStores,
): ResolvedAssignment {
  const { workspaceId, channelId } = parseSlackThreadKey(threadKey);
  return resolveAssignment(workspaceId, channelId, stores, {
    surface: surfaceForChannelId(channelId),
  });
}
