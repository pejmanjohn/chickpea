import type { RuntimePlanV2 } from '../../agents/runtime-plan.ts';
import { canEditAgent } from '../../auth/permissions.ts';
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
import { resolvePrivateAgentAudience, type PrivateAgentPlacementFacts } from '../agent-access.ts';
import { addableAgentHandle, offerAgentForChannel } from '../agent-channel-offer.ts';
import { agentAvatarInstallation, agentAvatarUrlForPresentation } from '../agent-presence/avatar-assets.ts';
import { resolveSlackPublicUrl } from '../credentials.ts';
import { resolveSlackInstallationExecutionContext } from '../installation-execution.ts';
import { slackConversationFacts } from '../reading/authority.ts';
import { RequestReceipt } from '../requested-conversations/receipts.ts';
import { routeRepliesToAgent } from '../requested-conversations/replies.ts';
import { requesterAgentRefusal } from '../requested-conversations/standing.ts';
import { createDirectSlackTransportFromWebClient } from '../transport/direct.ts';
import {
  CHANNEL_CREATE_RECEIPT_CODEC,
  channelCreateFailure,
  SLACK_CHANNEL_CREATE_RECEIPT_PREFIX,
  SlackChannelCreateRefusal,
  SlackChannelCreateService,
  type ChannelAgentAccess,
  type ChannelRequest,
  type ChannelVisibility,
} from './service.ts';

export async function createSlackChannel(
  plan: Pick<RuntimePlanV2, 'agentId' | 'actorMembershipId'>,
  signal: SlackManagementSignal,
  env: PlatformEnv | undefined,
  request: ChannelRequest,
): Promise<Record<string, unknown>> {
  let service: SlackChannelCreateService;
  try {
    service = await slackChannelCreateService(plan, signal, env);
  } catch (error) {
    return channelCreateFailure(error, request.visibility, deploymentTenancy(env) === 'installation');
  }
  return service.create(request);
}

async function slackChannelCreateService(
  plan: Pick<RuntimePlanV2, 'agentId' | 'actorMembershipId'>,
  signal: SlackManagementSignal,
  env: PlatformEnv | undefined,
): Promise<SlackChannelCreateService> {
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
  const transport = createDirectSlackTransportFromWebClient(workspace.client);
  return new SlackChannelCreateService({
    workspaceId: signal.workspaceId,
    requesterSlackUserId: signal.slackUserId,
    requesterText: signal.requesterText,
    requesterTextSource: signal.requesterTextSource,
    webContentRead: signal.publicDocRead === true,
    currentConversation: { current, conversation: slackConversationFacts(workspace.client, current) },
    chickpeaBot: workspace.client,
    persona: { username: agent.name, ...(avatarUrl ? { icon_url: avatarUrl } : {}) },
    assertStanding: (visibility) => assertChannelCreateStanding({
      plan, signal, agent, visibility, config, identity, placementFacts: transport,
    }),
    receipt: new RequestReceipt(settings, `${SLACK_CHANNEL_CREATE_RECEIPT_PREFIX}${signal.turnJobId}`, CHANNEL_CREATE_RECEIPT_CODEC),
    routeRepliesToAgent: (channelId, messageTs, text) => routeRepliesToAgent(config, {
      workspaceId: signal.workspaceId,
      channelId,
      messageTs,
      text,
      agent,
    }),
    agentAccess: (channel) => offerChannelAgentAccess({
      signal,
      agent,
      channel,
      identity,
      transport,
      client: workspace.client,
      adminUrl: publicUrl ? new URL('/admin/agents', publicUrl).toString() : undefined,
    }),
    hosted: deploymentTenancy(env) === 'installation',
  });
}

export async function offerChannelAgentAccess(input: {
  signal: Pick<SlackManagementSignal, 'workspaceId' | 'slackUserId'>;
  agent: CustomAgentConfig;
  channel: { id: string; requesterInvited: boolean };
  identity: Pick<IdentityStore, 'resolveSlackIdentity' | 'listMemberships' | 'listExternalIdentities'>;
  transport: Parameters<typeof offerAgentForChannel>[0]['transport'];
  client: Parameters<typeof offerAgentForChannel>[0]['client'];
  adminUrl: string | undefined;
}): Promise<ChannelAgentAccess> {
  const { signal, agent, channel } = input;
  if (agent.kind !== 'user') return { status: 'not_needed' };
  const resolution = await input.identity.resolveSlackIdentity(signal.workspaceId, signal.slackUserId).catch(() => undefined);
  const principal = resolution && { role: resolution.membership.role, membershipId: resolution.membership.id };
  const offer = () => offerAgentForChannel({
    workspaceId: signal.workspaceId,
    channelId: channel.id,
    userId: signal.slackUserId,
    agent,
    actor: { principal },
    identity: input.identity,
    transport: input.transport,
    client: input.client,
  });
  if (!canEditAgent(principal, agent)) {
    if (channel.requesterInvited) await offer().catch(() => undefined);
    return { status: 'ask_owner' };
  }
  if (!channel.requesterInvited || !addableAgentHandle(agent)) return { status: 'add_in_admin', adminUrl: input.adminUrl };
  return offer().then(
    () => ({ status: 'add_offered' as const }),
    () => ({ status: 'add_in_admin' as const, adminUrl: input.adminUrl }),
  );
}

export async function assertChannelCreateStanding(input: {
  plan: Pick<RuntimePlanV2, 'agentId' | 'actorMembershipId'>;
  signal: SlackManagementSignal;
  agent: CustomAgentConfig;
  visibility: ChannelVisibility;
  config: Pick<ConfigStore, 'listAgentChannelGrants'>;
  identity: IdentityStore;
  placementFacts: PrivateAgentPlacementFacts;
}): Promise<void> {
  const { signal, agent } = input;
  let grants: Promise<AgentChannelGrant[]> | undefined;
  const listGrants = () => grants ??= input.config.listAgentChannelGrants(signal.workspaceId);
  const refusal = await requesterAgentRefusal({ ...input, grants: listGrants });
  if (refusal) throw new SlackChannelCreateRefusal(refusal);
  if (input.visibility !== 'public' || agent.kind !== 'user') return;
  const audience = await resolvePrivateAgentAudience({
    agent,
    workspaceId: signal.workspaceId,
    grants: await listGrants(),
    transport: input.placementFacts,
  });
  if (audience === 'unavailable') throw new SlackChannelCreateRefusal('unavailable');
  if (audience !== 'workspace_members') throw new SlackChannelCreateRefusal('not_workspace_wide');
}
