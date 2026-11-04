import type { RuntimePlanV2 } from '../../agents/runtime-plan.ts';
import { deploymentTenancy } from '../../config/installation-scope.ts';
import {
  getConfigStore,
  getIdentityStore,
  getSettingsStore,
  getSlackCredentialResolutionDependencies,
  type PlatformEnv,
} from '../../config/state-backend.ts';
import type { ConfigStore } from '../../config/store.ts';
import type { AgentChannelGrant, CustomAgentConfig } from '../../config/types.ts';
import type { IdentityStore } from '../../identity/types.ts';
import type { SlackManagementSignal } from '../../management/slack-tools.ts';
import { resolveGroupDmEligibility, type PrivateAgentPlacementFacts } from '../agent-access.ts';
import { agentAvatarInstallation, agentAvatarUrlForPresentation } from '../agent-presence/avatar-assets.ts';
import { resolveSlackPublicUrl } from '../credentials.ts';
import { resolveSlackInstallationExecutionContext } from '../installation-execution.ts';
import { slackConversationFacts } from '../reading/authority.ts';
import { routeRepliesToAgent } from '../requested-conversations/replies.ts';
import { requesterAgentRefusal } from '../requested-conversations/standing.ts';
import { createDirectSlackTransportFromWebClient } from '../transport/direct.ts';
import { GroupDmReceipts } from './receipts.ts';
import { groupDmFailure, SlackGroupDmRefusal, SlackGroupDmService } from './service.ts';

export async function startSlackGroupDm(
  plan: Pick<RuntimePlanV2, 'agentId' | 'actorMembershipId'>,
  signal: SlackManagementSignal,
  env: PlatformEnv | undefined,
  people: readonly string[],
  message: string,
): Promise<Record<string, unknown>> {
  let service: SlackGroupDmService;
  try {
    service = await slackGroupDmService(plan, signal, env);
  } catch (error) {
    return groupDmFailure(error, deploymentTenancy(env) === 'installation');
  }
  return service.start(people, message);
}

async function slackGroupDmService(
  plan: Pick<RuntimePlanV2, 'agentId' | 'actorMembershipId'>,
  signal: SlackManagementSignal,
  env: PlatformEnv | undefined,
): Promise<SlackGroupDmService> {
  const config = getConfigStore(env);
  const identity = getIdentityStore(env);
  const settings = getSettingsStore(env);
  const workspace = await resolveSlackInstallationExecutionContext(signal.workspaceId, env, {
    config,
    settings,
    credentialDependencies: getSlackCredentialResolutionDependencies(env),
    rejectRateLimitedCalls: true,
  });
  const [agent, publicUrl] = await Promise.all([config.getAgent(plan.agentId), resolveSlackPublicUrl(env, settings)]);
  const avatarUrl = agentAvatarUrlForPresentation(agent, publicUrl, agentAvatarInstallation(env));
  const current = { channelId: signal.channelId, threadTs: signal.threadTs, messageTs: signal.messageTs };
  return new SlackGroupDmService({
    workspaceId: signal.workspaceId,
    requesterSlackUserId: signal.slackUserId,
    requesterText: signal.requesterText,
    requesterTextSource: signal.requesterTextSource,
    currentConversation: { current, conversation: slackConversationFacts(workspace.client, current) },
    chickpeaBot: workspace.client,
    persona: { username: agent.name, ...(avatarUrl ? { icon_url: avatarUrl } : {}) },
    assertStanding: () => assertGroupDmStanding({
      plan,
      signal,
      agent,
      config,
      identity,
      placementFacts: createDirectSlackTransportFromWebClient(workspace.client),
    }),
    receipts: new GroupDmReceipts(settings, signal.turnJobId),
    routeRepliesToAgent: (channelId, messageTs, message) => routeRepliesToAgent(config, {
      workspaceId: signal.workspaceId,
      channelId,
      messageTs,
      text: message,
      agent,
    }),
    hosted: deploymentTenancy(env) === 'installation',
  });
}

export async function assertGroupDmStanding(input: {
  plan: Pick<RuntimePlanV2, 'agentId' | 'actorMembershipId'>;
  signal: SlackManagementSignal;
  agent: CustomAgentConfig;
  config: Pick<ConfigStore, 'listAgentChannelGrants'>;
  identity: IdentityStore;
  placementFacts: PrivateAgentPlacementFacts;
}): Promise<void> {
  const { signal, agent } = input;
  let grants: Promise<AgentChannelGrant[]> | undefined;
  const listGrants = () => grants ??= input.config.listAgentChannelGrants(signal.workspaceId);
  const refusal = await requesterAgentRefusal({ ...input, grants: listGrants });
  if (refusal) throw new SlackGroupDmRefusal(refusal);
  if (agent.kind !== 'user') return;
  const eligibility = await resolveGroupDmEligibility({
    agent,
    workspaceId: signal.workspaceId,
    grants: await listGrants(),
    transport: input.placementFacts,
  });
  if (eligibility === 'unknown') throw new SlackGroupDmRefusal('unavailable');
  if (eligibility === 'not_eligible') throw new SlackGroupDmRefusal('not_in_group_dms');
}
