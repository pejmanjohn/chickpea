import { canEditAgent } from '../../auth/permissions.ts';
import type { ConfigStore } from '../../config/store.ts';
import type { CustomAgentConfig } from '../../config/types.ts';
import type { IdentityStore, OrganizationRole } from '../../identity/types.ts';
import type { AgentPresenceReconciler } from './reconciler.ts';

/** An active member as a person in Slack, for the publish of a Channel they added; undefined when unknown. */
export interface MemberInSlack {
  membershipId: string;
  slackUserId: string;
  role: OrganizationRole;
}

export async function memberInSlack(
  identity: Pick<IdentityStore, 'getMembership' | 'getUser'>,
  membershipId: string,
): Promise<MemberInSlack | undefined> {
  const membership = await identity.getMembership(membershipId);
  const user = membership?.status === 'active' ? await identity.getUser(membership.userId) : undefined;
  return user && membership ? { membershipId, slackUserId: user.slackUserId, role: membership.role } : undefined;
}

/**
 * A workspace back to one user group per Agent: give an Agent that waited
 * for its own app its group, then finish each Channel it was added to
 * meanwhile with the publish of whoever added it, as the add would have
 * ended in that mode. A Channel whose publish fails, or whose writer is no
 * longer an active member or may no longer edit the Agent, stays pending;
 * the group stands.
 */
export async function placeInSlack(
  input: {
    reconciler: AgentPresenceReconciler;
    config: Pick<ConfigStore, 'listAgentChannelGrants'>;
    identity: Pick<IdentityStore, 'getMembership' | 'getUser'>;
  },
  agentId: string,
): Promise<CustomAgentConfig> {
  let agent = await input.reconciler.retry(agentId);
  if (!agent.slackPresence?.userGroupId) return agent;
  const waited = (await input.config.listAgentChannelGrants()).filter((grant) =>
    grant.agentId === agentId && grant.status === 'pending');
  for (const grant of waited) {
    try {
      const writer = await memberInSlack(input.identity, grant.createdByMembershipId);
      if (!writer || !canEditAgent(writer, agent)) continue;
      agent = (await input.reconciler.publish({
        workspaceId: grant.workspaceId,
        agentId,
        channelId: grant.channelId,
        actorMembershipId: writer.membershipId,
        actorSlackUserId: writer.slackUserId,
      })).agent;
    } catch {
      // Recorded on the Agent and kept pending, as a failed add is.
    }
  }
  return agent;
}
