import type { AgentReferenceSummary, CustomAgentConfig } from '../../config/types.ts';

/**
 * Why an Agent cannot be deleted yet, or undefined once it has left Slack: no
 * Channel grants, no Slack app of its own, and no user group unless Slack
 * turned it off. Slack cannot delete a user group, so an archived Agent keeps
 * its group, turned off. Every door that deletes an Agent applies this rule.
 */
export function agentStillInSlackRefusal(
  agent: CustomAgentConfig,
  references: AgentReferenceSummary,
): string | undefined {
  const presence = agent.slackPresence;
  const userGroupOff = presence?.desiredState === 'disabled' && presence.health === 'healthy';
  if (references.channelGrants.length > 0 || presence?.kind === 'agent_app' ||
      (presence?.userGroupId !== undefined && !userGroupOff)) {
    return archiveBeforeDeleting(agent.name);
  }
  return undefined;
}

export function archiveBeforeDeleting(agentName: string): string {
  return `Archive ${agentName} first, then delete it. Archiving takes it out of its Slack Channels and turns off its Slack handle.`;
}
