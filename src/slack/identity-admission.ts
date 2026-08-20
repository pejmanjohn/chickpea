import {
  WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  type CustomAgentConfig,
  type ResolvedAssignment,
  type SlackIdentity,
} from '../config/types.ts';

interface SlackIdentityAgentReader {
  getAgent(agentId: string): CustomAgentConfig | Promise<CustomAgentConfig>;
}

/** Resolve old snapshots safely while new assignments carry an explicit identity. */
export function effectiveSlackIdentityId(assignment: ResolvedAssignment): string {
  void assignment;
  return WORKSPACE_DEFAULT_SLACK_IDENTITY_ID;
}

export function assignmentUsesSlackIdentity(
  assignment: ResolvedAssignment,
  identityId: string,
): boolean {
  return effectiveSlackIdentityId(assignment) === identityId;
}

/**
 * A DM belongs to the receiving Slack app. Its one live DM Profile binding is
 * authoritative; the legacy global wildcard is compatibility state only.
 */
export async function resolveSlackIdentityDmAssignment(
  identity: SlackIdentity,
  workspaceId: string,
  channelId: string,
  store: SlackIdentityAgentReader,
): Promise<ResolvedAssignment | undefined> {
  if (identity.dmState !== 'on' || !identity.dmAgentId) return undefined;
  const agent = await store.getAgent(identity.dmAgentId);
  if (!agent.enabled) return undefined;
  return {
    workspaceId,
    channelId,
    agentId: agent.id,
    agent,
  };
}
