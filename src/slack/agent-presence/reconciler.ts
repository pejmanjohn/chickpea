import type { ConfigStore } from '../../config/store.ts';
import type {
  AgentChannelGrant,
  AgentSlackPresence,
  CustomAgentConfig,
} from '../../config/types.ts';
import type { SlackTransport, SlackUserGroup } from '../transport/types.ts';
import {
  AgentPresenceError,
  classifyAgentPresenceError,
} from './errors.ts';
import { alternativeAgentHandles, normalizeAgentHandle } from './handles.ts';

export interface AgentPresenceReconcilerDependencies {
  config: ConfigStore;
  transport: SlackTransport;
  now?: () => number;
}

export interface PublishAgentInput {
  workspaceId: string;
  agentId: string;
  channelId: string;
  actorMembershipId: string;
  actorSlackUserId: string;
}

export interface AgentPublicationResult {
  agent: CustomAgentConfig;
  grant: AgentChannelGrant;
}

export class AgentPresenceReconciler {
  private readonly now: () => number;

  constructor(private readonly dependencies: AgentPresenceReconcilerDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async publish(input: PublishAgentInput): Promise<AgentPublicationResult> {
    const { config, transport } = this.dependencies;
    const agent = await config.getAgent(input.agentId);
    if (agent.lifecycle === 'archived') {
      throw new AgentPresenceError('slack_operation_failed', 'Archived Agents cannot be published.');
    }
    if (!await transport.channelHasMember(input.channelId, input.actorSlackUserId)) {
      throw new AgentPresenceError(
        'channel_membership_required',
        'Join the Slack Channel before adding this Agent.',
      );
    }
    const channel = await transport.lookupChannel(input.channelId);
    const existingGrant = (await config.listAgentChannelGrants(
      input.workspaceId,
      input.channelId,
    )).find((grant) => grant.agentId === agent.id);
    const pendingGrant = await config.putAgentChannelGrant(
      {
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        agentId: agent.id,
        status: 'pending',
        createdByMembershipId: input.actorMembershipId,
        ...(channel.name ? { channelLabel: channel.name } : {}),
        channelIsPrivate: channel.private,
      },
      existingGrant?.revision ?? 0,
    );
    if (!channel.member) {
      if (channel.private) {
        const error = new AgentPresenceError(
          'private_channel_invite_required',
          'Invite Chickpea to the private Slack Channel before retrying.',
        );
        await this.recordFailure(agent, error);
        throw error;
      }
      try {
        await transport.joinPublicChannel(input.channelId);
      } catch (error) {
        const classified = classifyAgentPresenceError(error);
        await this.recordFailure(agent, classified);
        throw classified;
      }
    }

    let published: CustomAgentConfig;
    try {
      published = await this.reconcile(agent.id);
    } catch (error) {
      const classified = classifyAgentPresenceError(error);
      await this.recordFailure(await config.getAgent(agent.id), classified);
      throw classified;
    }
    const grant = await config.putAgentChannelGrant(
      { ...pendingGrant, status: 'active' },
      pendingGrant.revision,
    );
    return { agent: published, grant };
  }

  /** Reconcile one Agent's desired Slack alias; safe to invoke after ambiguity. */
  async reconcile(agentId: string): Promise<CustomAgentConfig> {
    const { config, transport } = this.dependencies;
    let agent = await config.getAgent(agentId);
    const presence = requiredPresence(agent);
    const normalizedHandle = normalizeAgentHandle(presence.requestedHandle || agent.name);
    agent = await config.updateAgent(
      agent.id,
      {
        slackPresence: {
          ...withoutPresenceErrors(presence),
          normalizedHandle,
          desiredState: 'active',
          health: 'pending',
        },
      },
      agent.revision,
    );

    const groups = await transport.listUserGroups({ includeDisabled: true });
    let group = groups.find((candidate) => candidate.id === presence.userGroupId);
    if (!group) {
      const handleMatch = groups.find((candidate) => candidate.handle === normalizedHandle);
      if (handleMatch) {
        // A retry may adopt only the exact group Chickpea was reconciling. A
        // group found before this Agent ever entered pending state is a
        // workspace-global collision, never an ownership signal.
        if (presence.errorCode !== 'user_group_create_ambiguous' && !presence.userGroupId) {
          const collision = new AgentPresenceError(
            'handle_collision',
            `@${normalizedHandle} is already in use.`,
            {
              suggestions: alternativeAgentHandles(
                normalizedHandle,
                new Set(groups.map((candidate) => candidate.handle)),
              ),
            },
          );
          throw collision;
        }
        group = handleMatch;
      }
    }

    if (!group) {
      try {
        group = await transport.createUserGroup({
          name: agent.name,
          handle: normalizedHandle,
          description: agent.description ?? `${agent.name} Agent`,
        });
      } catch (error) {
        if (error instanceof Error &&
            'operation' in error && error.operation === 'usergroups.create' &&
            'retryable' in error && error.retryable === true) {
          throw new AgentPresenceError(
            'user_group_create_ambiguous',
            'Slack may have created the Agent handle before the connection failed. Retry will reconcile it safely.',
            { retryable: true },
          );
        }
        throw error;
      }
    } else {
      group = await this.updateGroupIfNeeded(group, agent, normalizedHandle);
      if (group.disabled) group = await transport.enableUserGroup(group.id);
    }
    const current = await config.getAgent(agent.id);
    return config.updateAgent(
      current.id,
      {
        lifecycle: 'active',
        enabled: true,
        slackPresence: {
          ...withoutPresenceErrors(requiredPresence(current)),
          requestedHandle: presence.requestedHandle || normalizedHandle,
          normalizedHandle,
          desiredState: 'active',
          health: 'healthy',
          userGroupId: group.id,
          observedAt: this.now(),
        },
      },
      current.revision,
    );
  }

  async retry(agentId: string): Promise<CustomAgentConfig> {
    try {
      return await this.reconcile(agentId);
    } catch (error) {
      const classified = classifyAgentPresenceError(error);
      await this.recordFailure(await this.dependencies.config.getAgent(agentId), classified);
      throw classified;
    }
  }

  async archive(
    agentId: string,
    options: { replacementDefaultAgentId?: string } = {},
  ): Promise<CustomAgentConfig> {
    const { config, transport } = this.dependencies;
    let agent = await config.getAgent(agentId);
    const defaultInstallations = (await config.listWorkspaceInstallations()).filter(
      (installation) => installation.defaultAgentId === agentId,
    );
    if (defaultInstallations.length > 0 && !options.replacementDefaultAgentId) {
      throw new AgentPresenceError(
        'slack_operation_failed',
        `Choose a replacement default Agent before archiving ${agent.name}.`,
      );
    }
    const presence = requiredPresence(agent);
    agent = await config.updateAgent(
      agent.id,
      {
        slackPresence: {
          ...presence,
          desiredState: 'disabled',
          health: presence.userGroupId ? 'pending' : 'unpublished',
        },
      },
      agent.revision,
    );
    if (presence.userGroupId) {
      try {
        await transport.disableUserGroup(presence.userGroupId);
      } catch (error) {
        const classified = classifyAgentPresenceError(error);
        await this.recordFailure(agent, classified);
        throw classified;
      }
    }
    agent = await config.updateAgent(
      agent.id,
      {
        slackPresence: {
          ...requiredPresence(agent),
          desiredState: 'disabled',
          health: presence.userGroupId ? 'healthy' : 'unpublished',
          observedAt: this.now(),
        },
      },
      agent.revision,
    );
    return config.archiveAgent(agent.id, {
      expectedRevision: agent.revision,
      ...(options.replacementDefaultAgentId
        ? { replacementDefaultAgentId: options.replacementDefaultAgentId }
        : {}),
    });
  }

  async restore(agentId: string): Promise<CustomAgentConfig> {
    const { config, transport } = this.dependencies;
    let agent = await config.getAgent(agentId);
    agent = await config.restoreAgent(agent.id, agent.revision);
    const presence = requiredPresence(agent);
    if (!presence.userGroupId) return agent;
    try {
      await transport.enableUserGroup(presence.userGroupId);
      return config.updateAgent(
        agent.id,
        {
          slackPresence: {
            ...withoutPresenceErrors(presence),
            desiredState: 'active',
            health: 'healthy',
            observedAt: this.now(),
          },
        },
        agent.revision,
      );
    } catch (error) {
      const classified = classifyAgentPresenceError(error);
      await this.recordFailure(agent, classified);
      throw classified;
    }
  }

  private async updateGroupIfNeeded(
    group: SlackUserGroup,
    agent: CustomAgentConfig,
    normalizedHandle: string,
  ): Promise<SlackUserGroup> {
    const desiredDescription = agent.description ?? `${agent.name} Agent`;
    if (
      group.name === agent.name &&
      group.handle === normalizedHandle &&
      group.description === desiredDescription
    ) return group;
    return this.dependencies.transport.updateUserGroup(group.id, {
      name: agent.name,
      handle: normalizedHandle,
      description: desiredDescription,
    });
  }

  private async recordFailure(
    agent: CustomAgentConfig,
    error: AgentPresenceError,
  ): Promise<void> {
    const current = await this.dependencies.config.getAgent(agent.id);
    const presence = requiredPresence(current);
    await this.dependencies.config.updateAgent(
      current.id,
      {
        lifecycle: current.lifecycle === 'archived' ? 'archived' : 'needs_attention',
        slackPresence: {
          ...presence,
          health: 'needs_attention',
          errorCode: error.code,
          errorDetail: error.message,
          observedAt: this.now(),
        },
      },
      current.revision,
    );
  }
}

function requiredPresence(agent: CustomAgentConfig): AgentSlackPresence {
  if (!agent.slackPresence) throw new Error(`Agent ${agent.id} has no Slack presence`);
  return agent.slackPresence;
}

function withoutPresenceErrors(
  presence: AgentSlackPresence,
): Omit<AgentSlackPresence, 'errorCode' | 'errorDetail'> {
  const { errorCode: _errorCode, errorDetail: _errorDetail, ...clean } = presence;
  return clean;
}
