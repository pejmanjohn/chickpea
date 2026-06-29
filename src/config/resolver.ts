import { seededAgents, seededAssignments } from './seed.ts';
import type { ChannelAssignment, CustomAgentConfig, ResolvedAssignment } from './types.ts';

export class AgentStore {
  readonly agents: Map<string, CustomAgentConfig>;

  constructor(agents: CustomAgentConfig[] = seededAgents) {
    this.agents = new Map(agents.map((agent) => [agent.id, agent]));
  }

  getAgent(agentId: string): CustomAgentConfig {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent ${agentId}`);
    }
    return agent;
  }
}

export class AssignmentStore {
  readonly assignments: ChannelAssignment[];

  constructor(assignments: ChannelAssignment[] = seededAssignments) {
    this.assignments = assignments;
  }

  find(workspaceId: string, channelId: string): ChannelAssignment | undefined {
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
        (assignment.channelId === channelId || assignment.channelId === '*'),
    );
  }
}

export function resolveAssignment(
  workspaceId: string,
  channelId: string,
  stores: { agents: AgentStore; assignments: AssignmentStore },
): ResolvedAssignment {
  const assignment = stores.assignments.find(workspaceId, channelId);
  if (!assignment) {
    throw new Error(`No enabled agent assignment for ${workspaceId}/${channelId}`);
  }

  const agent = stores.agents.getAgent(assignment.agentId);
  if (!agent.enabled) {
    throw new Error(`Assigned agent ${agent.id} is disabled`);
  }

  return {
    workspaceId,
    channelId,
    agentId: agent.id,
    agent,
  };
}

export function resolveAssignmentFromThreadKey(
  threadKey: string,
  stores: { agents: AgentStore; assignments: AssignmentStore },
): ResolvedAssignment {
  const [workspaceId, channelId] = threadKey.split(':');
  if (!workspaceId || !channelId) {
    throw new Error(`Invalid Slack thread key ${threadKey}`);
  }
  return resolveAssignment(workspaceId, channelId, stores);
}
