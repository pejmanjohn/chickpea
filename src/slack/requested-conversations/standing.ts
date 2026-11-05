import type { RuntimePlanV2 } from '../../agents/runtime-plan.ts';
import { isActiveConnectionActor } from '../../connections/runtime.ts';
import type { AgentChannelGrant, CustomAgentConfig } from '../../config/types.ts';
import type { IdentityStore } from '../../identity/types.ts';
import { resolveSlackManagementActor, type SlackManagementSignal } from '../../management/slack-tools.ts';
import { agentSlackAppsHost } from '../agent-apps/index.ts';
import { agentIsActive } from '../agent-routing.ts';

export type RequesterAgentRefusal = 'requester_unavailable' | 'agent_unavailable' | 'agent_app';

export async function requesterAgentRefusal(input: {
  plan: Pick<RuntimePlanV2, 'agentId' | 'actorMembershipId'>;
  signal: SlackManagementSignal;
  agent: CustomAgentConfig;
  identity: IdentityStore;
  grants: () => Promise<readonly AgentChannelGrant[]>;
}): Promise<RequesterAgentRefusal | undefined> {
  const { plan, signal, agent, identity } = input;
  const actor = await resolveSlackManagementActor(signal, identity).catch(() => undefined);
  if (!actor || actor.membershipId !== plan.actorMembershipId ||
      !await isActiveConnectionActor({ identity, workspaceId: signal.workspaceId, actorMembershipId: actor.membershipId })) {
    return 'requester_unavailable';
  }
  if (!agentIsActive(agent)) return 'agent_unavailable';
  if (agentSlackAppsHost() && agent.slackPresence?.kind === 'agent_app') return 'agent_app';
  if (agent.kind !== 'user') return undefined;
  const direct = signal.conversationKind === 'im' || signal.conversationKind === 'mpim';
  if (!direct && !(await input.grants()).some((grant) =>
    grant.channelId === signal.channelId && grant.agentId === agent.id && grant.status === 'active')) {
    return 'agent_unavailable';
  }
  return undefined;
}
