import { resolveBetterAuthEnvironment, withBetterAuthAccessRevoker } from '../auth/better-auth-environment.ts';
import {
  getAgentSnapshotStore,
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
import { agentAppPresenceHooks, agentDmPlacementFacts } from '../slack/agent-apps/index.ts';
import type { ConfigStore } from '../config/store.ts';
import {
  deleteProviderApiKey,
  describeProviderKeySources,
} from '../config/provider-keys.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { installationModelCredentialVersion } from '../config/model-credential-refs.ts';
import { resolveModelReadiness } from '../config/model-readiness.ts';
import { modelEffortChoiceError } from '../config/model-effort-capability.ts';
import { managedProviderAvailability } from '../connections/managed.ts';
import { resolveManagedAuthorizationProviderContext } from '../connections/managed-provider-context.ts';
import { ConnectionAccountService } from '../connections/store.ts';
import { platformRepositoryGrants } from '../config/agent-write-rules.ts';
import { finishAgentSecretCleanup, stageAgentSecretCleanup } from '../config/agent-secret-cleanup.ts';
import {
  agentDeletionWebsiteLogins,
  removeDeletedAgentWebsiteLogins,
  WebsiteLoginNotRemovableError,
} from '../browser/agent-website-logins.ts';
import { websiteLoginDependencies } from '../browser/logins.ts';
import { agentCredentialConfigurationBinding } from '../config/connection-credential-binding.ts';
import { createPlatformProductTelemetry } from '../telemetry/platform.ts';
import { nodeRoutineSchedulerAvailable } from '../routines/runtime-state.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { UsageStore } from '../usage/types.ts';
import { AgentPresenceError } from '../slack/agent-presence/errors.ts';
import { livePresenceAnnouncements } from '../slack/agent-presence/announcements.ts';
import { AgentPresenceReconciler } from '../slack/agent-presence/reconciler.ts';
import { publishGeneratedAgentAvatar } from '../slack/agent-presence/gateway-avatar.ts';
import { GatewayDeploymentClient } from '../slack/gateway/client.ts';
import {
  createGatewayDeploymentClient,
  resolveChickpeaGatewayUrl,
} from '../slack/gateway/runtime.ts';
import { slackInstallationCredentialId } from '../slack/hosted-slack-app.ts';
import { agentAvatarInstallationField } from '../slack/agent-presence/avatar-assets.ts';
import {
  resolveSlackInstallationCredentials,
  type SlackCredentialDependencies,
} from '../slack/installation-credentials.ts';
import { createDirectSlackTransport } from '../slack/transport/direct.ts';
import { ownerUserGroupToken } from '../slack/user-group-authority.ts';
import { createGatewaySlackTransport } from '../slack/transport/gateway.ts';
import type { SlackTransport } from '../slack/transport/types.ts';
import {
  managementActorPrincipal,
  WorkspaceManagementService,
  type WorkspaceManagementServiceInput,
} from './service.ts';
import { createManagementModelSources } from './model-sources.ts';
import { ManagementError } from './types.ts';
import {
  discoverOpenMcpServer,
  saveManagedConnectionKey,
  testManagedConnection,
} from './discovery.ts';

interface LiveWorkspaceManagementServiceOptions {
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
      slackInstallationCredentialId(env),
      env,
      slackCredentials,
    );
    if (!credentials.botToken) {
      throw new AgentPresenceError(
        'slack_operation_failed',
        'Connect Chickpea to Slack before publishing an Agent.',
      );
    }
    return createDirectSlackTransport(credentials.botToken, ownerUserGroupToken(credentials, settings));
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
  const management = getManagementStore(env);
  const presenceReconciler = async (workspaceId: string) => {
    const transport = await slackTransport(workspaceId);
    const agentApps = agentAppPresenceHooks(env);
    return new AgentPresenceReconciler({
      config: config as ConfigStore,
      transport,
      announce: await livePresenceAnnouncements({ env, settings, identity, management, transport, installationBot: transport }),
      ...(agentApps ? { agentApps } : {}),
    });
  };
  const productTelemetry = overrides.productTelemetry ?? createPlatformProductTelemetry({
    ...(env ? { env } : {}),
    settings,
    config: config as ConfigStore,
  });
  return new WorkspaceManagementService({
    identity: overrides.identity ?? identity,
    config,
    connectionAccounts: new ConnectionAccountService({
      config: config as ConfigStore,
      settings,
      productTelemetry,
    }),
    repositoryGrants: (grants, stored) => platformRepositoryGrants(settings, env, grants, stored),
    management,
    memory: getMemoryStateStore(env),
    routines: getRoutineStore(env),
    work: getWorkStore(env),
    routineSchedulingAvailable: isCloudflareTarget()
      ? true
      : nodeRoutineSchedulerAvailable,
    productTelemetry,
    providerCredentialSource: async (providerId) =>
      (await describeProviderKeySources(env, settings))[providerId],
    modelReadiness: () => resolveModelReadiness({ env, settings }),
    modelEffortChoice: (model, effort) => modelEffortChoiceError(model, effort, { env, settings }),
    providerCredentialRevision: async (providerId) =>
      installationModelCredentialVersion(providerId, env, settings),
    removeProviderCredential: async (providerId) =>
      (await deleteProviderApiKey(
        providerId,
        env,
        settings,
        options.usage ?? getUsageStore(env),
      )).source,
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
        // Retry cannot fix a taken handle or a name Slack finds too long, so
        // the update fails and the service puts the Agent back.
        if (!(error instanceof AgentPresenceError) || error.code === 'handle_collision' ||
            error.slackCode === 'name_too_long') throw error;
        return config.getAgent(agent.id);
      }
    },
    discoverSlackChannels: async (actor) => {
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
    discoverMcpServer: (server) => discoverOpenMcpServer({ server }),
    testConnection: (input) => testManagedConnection({
      ...input,
      ...(env ? { env } : {}),
      config: config as ConfigStore,
      identity,
      settings,
    }),
    saveConnectionKey: (input) => saveManagedConnectionKey({
      ...input,
      ...(env ? { env } : {}),
      config: config as ConfigStore,
      settings,
      productTelemetry,
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
    models: createManagementModelSources({ env, settings }),
    publishAgentPresence: async ({ actor, agentId }) => {
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
        if (error.code === 'handle_collision' && error.suggestions.length > 0) throw error;
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
      return publishGeneratedAgentAvatar({
        agentId,
        revision,
        seed,
        publish: (avatar) => gateway.publishAvatar({
          workspaceId,
          ...avatar,
        }),
      });
    },
    slackFacts: async ({ workspaceId, agent }) => {
      const transport = await slackTransport(workspaceId);
      return agent ? agentDmPlacementFacts(env, agent, transport) : transport;
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
      expectedCredentialIncarnation,
      replacementDefaultAgentId,
    }) => {
      const user = await identity.getUser(actor.userId);
      if (!user) {
        throw new ManagementError('forbidden', 'The workspace management actor is unavailable.');
      }
      const current = await config.getAgent(agentId);
      if (expectedCredentialIncarnation &&
          current.credentialIncarnation !== expectedCredentialIncarnation) {
        throw new ManagementError('revision_conflict', 'The Agent identity changed before archive.');
      }
      const archiveRetry = current.lifecycle === 'archived' ||
        current.slackPresence?.desiredState === 'disabled';
      if (current.revision !== expectedRevision && !archiveRetry) {
        throw new ManagementError('revision_conflict', 'The Agent changed before archive.');
      }
      return (await presenceReconciler(user.slackTeamId)).archive(agentId, {
        ...(expectedCredentialIncarnation ? { expectedCredentialIncarnation } : {}),
        ...(replacementDefaultAgentId ? { replacementDefaultAgentId } : {}),
      });
    },
    restoreAgent: async ({
      actor,
      agentId,
      expectedRevision,
      expectedCredentialIncarnation,
    }) => {
      const user = await identity.getUser(actor.userId);
      if (!user) {
        throw new ManagementError('forbidden', 'The workspace management actor is unavailable.');
      }
      const current = await config.getAgent(agentId);
      if (expectedCredentialIncarnation &&
          current.credentialIncarnation !== expectedCredentialIncarnation) {
        throw new ManagementError('revision_conflict', 'The Agent identity changed before restore.');
      }
      const restoreRetry = current.lifecycle !== 'archived' &&
        current.slackPresence?.desiredState === 'active' &&
        current.slackPresence.health !== 'healthy' &&
        current.slackPresence.health !== 'unpublished';
      if (current.revision !== expectedRevision && !restoreRetry) {
        throw new ManagementError('revision_conflict', 'The Agent changed before restore.');
      }
      return (await presenceReconciler(user.slackTeamId)).restore(
        agentId,
        expectedCredentialIncarnation,
      );
    },
    deleteAgent: async ({
      actor,
      agentId,
      expectedRevision,
      expectedCredentialIncarnation,
      idempotencyKey,
    }) => {
      const principal = managementActorPrincipal(actor);
      const websiteLoginIds = await agentDeletionWebsiteLogins({
        principal,
        agent: await config.getAgent(agentId),
        config,
        logins: settings,
      }).catch((error: unknown) => {
        throw error instanceof WebsiteLoginNotRemovableError
          ? new ManagementError('forbidden', error.message)
          : error;
      });
      const providerContext = await resolveManagedAuthorizationProviderContext({
        settings,
        ...(env ? { platformEnv: env } : {}),
      });
      await new ConnectionAccountService({
        config: config as ConfigStore,
        settings,
        managedProviders: providerContext.providers,
      }).prepareAgentDeletion({
        principal,
        agentId,
        expectedRevision,
        expectedCredentialIncarnation,
      });
      const cleanupScope = agentCredentialConfigurationBinding(expectedCredentialIncarnation);
      const agent = await config.getAgent(agentId);
      await stageAgentSecretCleanup(agent, env, settings, cleanupScope);
      const deleted = config.deleteAgentWithMemory
        ? await config.deleteAgentWithMemory(
            agentId,
            idempotencyKey,
            expectedRevision,
            expectedCredentialIncarnation,
          )
        : await config.deleteAgent(agentId, expectedRevision, expectedCredentialIncarnation);
      await removeDeletedAgentWebsiteLogins({
        loginIds: websiteLoginIds,
        config,
        deletion: () => websiteLoginDependencies(env),
      });
      await finishAgentSecretCleanup(agentId, env, settings, cleanupScope);
      return deleted;
    },
    agentLiveThreadCount: async (agentId) =>
      (await getAgentSnapshotStore(env).listLiveRootsByAgent(agentId)).length,
    withBetterAuthAccessRevoker: async (use) => withBetterAuthAccessRevoker(
      { control: await identity.getAuthControl(), platformEnv: env },
      use,
    ),
    mcpOAuthClients: async () => {
      const control = await identity.getAuthControl();
      return control ? (await resolveBetterAuthEnvironment({ control, platformEnv: env }))?.backend : undefined;
    },
    ...agentAvatarInstallationField(env),
    ...overrides,
  });
}
