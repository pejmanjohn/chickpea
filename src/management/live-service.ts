import {
  getConfigStore,
  getIdentityStore,
  getManagementStore,
  getMemoryStateStore,
  getRoutineStore,
  getSettingsStore,
  getUsageStore,
  getWorkStore,
  getSlackCredentialDependencies,
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../config/types.ts';
import {
  deleteProviderApiKey,
  describeProviderKeySources,
} from '../config/provider-keys.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { storedCredentialMetadata } from '../config/model-credential-refs.ts';
import { clearRepointedMcpCredentials } from '../config/mcp-connection-lifecycle.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { UsageStore } from '../usage/types.ts';
import { AgentPresenceError } from '../slack/agent-presence/errors.ts';
import { AgentPresenceReconciler } from '../slack/agent-presence/reconciler.ts';
import { createGatewayDeploymentClient } from '../slack/gateway/runtime.ts';
import { resolveSlackInstallationCredentials } from '../slack/installation-credentials.ts';
import { createDirectSlackTransport } from '../slack/transport/direct.ts';
import { createGatewaySlackTransport } from '../slack/transport/gateway.ts';
import type { SlackTransport } from '../slack/transport/types.ts';
import { WorkspaceManagementService, type WorkspaceManagementServiceInput } from './service.ts';
import { ManagementError } from './types.ts';
import {
  testManagedMcpConnection,
} from './discovery.ts';

export interface LiveWorkspaceManagementServiceOptions {
  identity?: IdentityStore;
  settings?: SettingsStore;
  usage?: UsageStore;
  overrides?: Partial<WorkspaceManagementServiceInput>;
}

/** Keep production MCP, Slack, and Admin management dependencies aligned. */
export function createLiveWorkspaceManagementService(
  env?: PlatformEnv,
  options: LiveWorkspaceManagementServiceOptions = {},
): WorkspaceManagementService {
  const overrides = options.overrides ?? {};
  const settings = options.settings ?? getSettingsStore(env);
  const identity = options.identity ?? getIdentityStore(env);
  const config = overrides.config ?? getConfigStore(env);
  const slackTransport = async (workspaceId: string): Promise<SlackTransport> => {
    const installation = await config.getWorkspaceInstallation(workspaceId);
    if (!installation || installation.health === 'revoked') {
      throw new AgentPresenceError(
        'slack_operation_failed',
        'Connect Chickpea to this Slack workspace before publishing an Agent.',
      );
    }
    if (installation.transportMode === 'gateway') {
      return createGatewaySlackTransport(createGatewayDeploymentClient(env));
    }
    const credentials = await resolveSlackInstallationCredentials(
      WORKSPACE_SLACK_INSTALLATION_ID,
      env,
      getSlackCredentialDependencies(env),
    );
    if (!credentials.botToken) {
      throw new AgentPresenceError(
        'slack_operation_failed',
        'Connect Chickpea to Slack before publishing an Agent.',
      );
    }
    return createDirectSlackTransport(credentials.botToken);
  };
  const actorSlackUser = async (actor: { userId: string }, workspaceId: string) => {
    const user = await identity.getUser(actor.userId);
    if (!user || user.slackTeamId !== workspaceId) {
      throw new AgentPresenceError(
        'channel_membership_required',
        'The acting Slack member is not bound to this workspace.',
      );
    }
    return user;
  };
  const presenceReconciler = async (workspaceId: string) => new AgentPresenceReconciler({
    config: config as ConfigStore,
    transport: await slackTransport(workspaceId),
  });
  return new WorkspaceManagementService({
    identity: overrides.identity ?? identity,
    config,
    management: getManagementStore(env),
    memory: getMemoryStateStore(env),
    routines: getRoutineStore(env),
    work: getWorkStore(env),
    routineSchedulingAvailable: isCloudflareTarget(),
    providerCredentialSource: async (providerId) =>
      (await describeProviderKeySources(env, settings))[providerId],
    providerCredentialRevision: async (providerId) =>
      (await storedCredentialMetadata(providerId, settings))?.version ?? 0,
    removeProviderCredential: async (providerId) =>
      (await deleteProviderApiKey(
        providerId,
        env,
        settings,
        options.usage ?? getUsageStore(env),
      )).source,
    prepareAgentUpdate: (agent, patch) => clearRepointedMcpCredentials({
      agentId: agent.id,
      current: agent.mcpServers,
      next: patch.mcpServers,
      settings,
      ...(env ? { env } : {}),
    }),
    reconcileAgentUpdate: async ({ actor, agent, patch }) => {
      const presentationChanged = patch.name !== undefined ||
        patch.description !== undefined || patch.slackPresence !== undefined;
      if (!presentationChanged || agent.slackPresence?.desiredState !== 'active') return agent;
      const organization = await identity.getOrganization();
      if (!organization?.slackTeamId) {
        throw new ManagementError('invalid_request', 'The connected Slack directory is unavailable.');
      }
      const user = await actorSlackUser(actor, organization.slackTeamId);
      try {
        return await (await presenceReconciler(user.slackTeamId)).retry(agent.id);
      } catch (error) {
        if (!(error instanceof AgentPresenceError)) throw error;
        return config.getAgent(agent.id);
      }
    },
    discoverSlackChannels: async (_refresh, actor) => {
      const organization = await identity.getOrganization();
      if (!organization?.slackTeamId) {
        throw new ManagementError('invalid_request', 'The connected Slack directory is unavailable.');
      }
      try {
        const transport = await slackTransport(organization.slackTeamId);
        const result = await transport.listChannels();
        const actorUser = await actorSlackUser(actor, organization.slackTeamId);
        const memberChannels = await transport.listMemberChannels(actorUser.slackUserId);
        const visibleChannels = result.channels.filter(
          ({ id, archived }) => !archived && memberChannels.has(id),
        );
        return {
          teamId: organization.slackTeamId,
          truncated: result.truncated,
          channels: visibleChannels
            .map((channel) => ({
              id: channel.id,
              name: channel.name ?? channel.id,
              isPrivate: channel.private,
              isMember: channel.member,
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        };
      } catch (error) {
        if (error instanceof ManagementError) throw error;
        throw new ManagementError('invalid_request', 'The connected Slack directory is unavailable.');
      }
    },
    testMcpConnection: (agentId, connectionId) => testManagedMcpConnection({
      agentId,
      connectionId,
      ...(env ? { env } : {}),
      config,
      settings,
    }),
    publishAgentChannel: async ({ actor, workspaceId, channelId, agentId }) => {
      const user = await actorSlackUser(actor, workspaceId);
      return (await presenceReconciler(workspaceId)).publish({
        workspaceId,
        channelId,
        agentId,
        actorMembershipId: actor.membershipId,
        actorSlackUserId: user.slackUserId,
      });
    },
    assertAgentChannelMembership: async ({ actor, workspaceId, channelId }) => {
      const user = await actorSlackUser(actor, workspaceId);
      if (!await (await slackTransport(workspaceId)).channelHasMember(channelId, user.slackUserId)) {
        throw new AgentPresenceError(
          'channel_membership_required',
          'Join the Slack Channel before changing this Agent grant.',
        );
      }
    },
    archiveAgent: async ({
      actor,
      agentId,
      expectedRevision,
      replacementDefaultAgentId,
    }) => {
      const user = await identity.getUser(actor.userId);
      if (!user) {
        throw new ManagementError('forbidden', 'The workspace management actor is unavailable.');
      }
      const current = await config.getAgent(agentId);
      const archiveRetry = current.lifecycle === 'archived' ||
        current.slackPresence?.desiredState === 'disabled';
      if (current.revision !== expectedRevision && !archiveRetry) {
        throw new ManagementError('revision_conflict', 'The Agent changed before archive.');
      }
      return (await presenceReconciler(user.slackTeamId)).archive(agentId, {
        ...(replacementDefaultAgentId ? { replacementDefaultAgentId } : {}),
      });
    },
    restoreAgent: async ({ actor, agentId, expectedRevision }) => {
      const user = await identity.getUser(actor.userId);
      if (!user) {
        throw new ManagementError('forbidden', 'The workspace management actor is unavailable.');
      }
      const current = await config.getAgent(agentId);
      const restoreRetry = current.lifecycle !== 'archived' &&
        current.slackPresence?.desiredState === 'active' &&
        current.slackPresence.health !== 'healthy' &&
        current.slackPresence.health !== 'unpublished';
      if (current.revision !== expectedRevision && !restoreRetry) {
        throw new ManagementError('revision_conflict', 'The Agent changed before restore.');
      }
      return (await presenceReconciler(user.slackTeamId)).restore(agentId);
    },
    ...overrides,
  });
}
