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
import { getProviderFavorites } from '../config/provider-models.ts';
import { clearRepointedMcpCredentials } from '../config/mcp-connection-lifecycle.ts';
import { activeModelCatalogSnapshot } from '../model-catalog/index.ts';
import { managedProviderAvailability } from '../connections/managed.ts';
import { resolveManagedAuthorizationProviderContext } from '../connections/managed-provider-context.ts';
import { ConnectionAccountService } from '../connections/store.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { UsageStore } from '../usage/types.ts';
import { AgentPresenceError } from '../slack/agent-presence/errors.ts';
import { AgentPresenceReconciler } from '../slack/agent-presence/reconciler.ts';
import { GatewayDeploymentClient } from '../slack/gateway/client.ts';
import {
  createGatewayDeploymentClient,
  resolveChickpeaGatewayUrl,
} from '../slack/gateway/runtime.ts';
import {
  resolveSlackInstallationCredentials,
  type SlackCredentialDependencies,
} from '../slack/installation-credentials.ts';
import { createDirectSlackTransport } from '../slack/transport/direct.ts';
import { createGatewaySlackTransport } from '../slack/transport/gateway.ts';
import type { SlackTransport } from '../slack/transport/types.ts';
import {
  managementActorPrincipal,
  WorkspaceManagementService,
  type WorkspaceManagementServiceInput,
} from './service.ts';
import { ManagementError } from './types.ts';
import {
  testManagedMcpConnection,
} from './discovery.ts';

export interface LiveWorkspaceManagementServiceOptions {
  identity?: IdentityStore;
  settings?: SettingsStore;
  usage?: UsageStore;
  slackCredentials?: SlackCredentialDependencies;
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
  const slackCredentials = options.slackCredentials ?? getSlackCredentialDependencies(env);
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
      slackCredentials,
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
    managedConnectorAvailable: async ({ toolkit, accessLane }) => {
      const context = await resolveManagedAuthorizationProviderContext({
        settings,
        ...(env ? { platformEnv: env } : {}),
      });
      const provider = context.providers.get('composio');
      return Boolean(provider?.authorize) &&
        managedProviderAvailability(provider, { toolkit, accessLane }).status === 'ready';
    },
    listAvailableModels: async () => {
      const sources = await describeProviderKeySources(env, settings);
      const entries: Array<{ id: string; name?: string }> =
        activeModelCatalogSnapshot().entries.flatMap((entry) => {
          if (entry.id.startsWith('anthropic/') &&
              entry.lanes.anthropic_api_key && sources.anthropic !== 'missing') {
            return [{ id: entry.id, ...(entry.displayName ? { name: entry.displayName } : {}) }];
          }
          if (entry.id.startsWith('openai/') &&
              entry.lanes.openai_api_key && sources.openai !== 'missing') {
            return [{ id: entry.id, ...(entry.displayName ? { name: entry.displayName } : {}) }];
          }
          return [];
        });
      if (sources.openrouter !== 'missing') {
        entries.push(...(await getProviderFavorites('openrouter', settings)).map((id) => ({
          id: `openrouter/${id}`,
        })));
      }
      return entries;
    },
    publishAgentPresence: async ({ actor, agentId, inferredHandle }) => {
      const organization = await identity.getOrganization();
      if (!organization?.slackTeamId) {
        return {
          agent: await config.getAgent(agentId),
          warning: 'The Agent was created, but its Slack handle could not be published because the connected Slack workspace is unavailable.',
        };
      }
      try {
        await actorSlackUser(actor, organization.slackTeamId);
        return {
          agent: await (await presenceReconciler(organization.slackTeamId)).retry(agentId),
        };
      } catch (error) {
        if (!(error instanceof AgentPresenceError)) throw error;
        if (inferredHandle && error.code === 'handle_collision' && error.suggestions.length > 0) {
          throw error;
        }
        return {
          agent: await config.getAgent(agentId),
          warning: `The Agent was created, but its Slack handle needs attention: ${error.message}`,
        };
      }
    },
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
    publishGeneratedAgentAvatar: async ({ workspaceId, agentId, revision, seed }) => {
      const installation = await config.getWorkspaceInstallation(workspaceId);
      if (installation?.transportMode !== 'gateway') return undefined;
      const gateway = new GatewayDeploymentClient({
        settings,
        config: config as ConfigStore,
        identity,
        keyring: slackCredentials.keyring,
        gatewayBaseUrl: resolveChickpeaGatewayUrl(env),
      });
      return gateway.generateAvatar({
        workspaceId,
        agentId,
        revision,
        seed,
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
    deleteAgent: async ({ actor, agentId, expectedRevision }) => {
      const providerContext = await resolveManagedAuthorizationProviderContext({
        settings,
        ...(env ? { platformEnv: env } : {}),
      });
      await new ConnectionAccountService({
        config: config as ConfigStore,
        settings,
        managedProviders: providerContext.providers,
      }).prepareAgentDeletion({
        principal: managementActorPrincipal(actor),
        agentId,
        expectedRevision,
      });
      return config.deleteAgent(agentId, expectedRevision);
    },
    ...overrides,
  });
}
