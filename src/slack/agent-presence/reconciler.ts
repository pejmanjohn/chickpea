import type { ConfigStore } from '../../config/store.ts';
import type {
  AgentChannelGrant,
  AgentSlackPresence,
  CustomAgentConfig,
  PendingUserGroupCreate,
  UserGroupPresence,
} from '../../config/types.ts';
import {
  SlackTransportError,
  type SlackTransport,
  type SlackUserGroup,
} from '../transport/types.ts';
import { agentSlackHandle } from '../agent-asks.ts';
import type { AgentPresenceAnnouncements } from './announcements.ts';
import {
  AgentPresenceError,
  classifyAgentPresenceError,
} from './errors.ts';
import { agentUserGroupName, alternativeAgentHandles, normalizeAgentHandle } from './handles.ts';

/** What the reconciler asks of an Agent's own Slack app; absent on a host without Agent apps. */
export interface AgentAppPresenceHooks {
  /** Retires the app before the Agent is archived. */
  retire(agent: CustomAgentConfig): Promise<CustomAgentConfig>;
  /** Brings a live app's bot into a Channel the Agent was added to; undefined for an Agent without one. */
  bringBotIn(agent: CustomAgentConfig, channel: { id: string; private: boolean }): Promise<AgentAppBot | undefined>;
}

/** A live app's bot after publishing: in the Channel, with a transport that posts as it, or left out. */
export type AgentAppBot =
  | { placement: 'in_channel'; transport: Pick<SlackTransport, 'postMessage'> }
  | { placement: 'left_out' };

interface AgentPresenceReconcilerDependencies {
  config: ConfigStore;
  transport: SlackTransport;
  announce: AgentPresenceAnnouncements | null;
  agentApps?: AgentAppPresenceHooks;
  now?: () => number;
}

interface PublishAgentInput {
  workspaceId: string;
  agentId: string;
  channelId: string;
  actorMembershipId: string;
  actorSlackUserId: string;
}

interface AgentPublicationResult {
  agent: CustomAgentConfig;
  grant: AgentChannelGrant;
  /** For an Agent with its own live Slack app: whether that app's bot is in the Channel. */
  appBot?: AgentAppBot['placement'];
}

type MentionRepairConfig = Pick<
  ConfigStore,
  'listAgents' | 'listAgentChannelGrants' | 'updateAgent'
>;

/**
 * `unknown`: the directory did not prove the group is this installation's
 * Agent, so the mention is ordinary text (a group of people, another app's
 * Agent, or a group someone else made with an Agent's handle).
 * `not_in_channel`: it is, but that Agent has not been added here.
 * `lookup_failed`: Slack was not asked or did not answer.
 * `temporarily_unavailable`: binding it raced another change.
 */
type MentionedAgentUserGroupRepairResult =
  | { kind: 'repaired' | 'not_in_channel'; agent: CustomAgentConfig }
  | { kind: 'lookup_failed'; reason: 'rate_limited' | 'failed' }
  | { kind: 'unknown' | 'temporarily_unavailable' };

type UserGroupLookupResult =
  | { kind: 'found'; group: SlackUserGroup }
  | { kind: 'missing' | 'rate_limited' | 'failed' };

interface LookupWindow {
  startedAt: number;
  count: number;
}

interface NegativeLookupReceipt {
  until: number;
  kind: 'missing' | 'rate_limited' | 'failed';
}

interface MentionedAgentUserGroupRepairInput {
  workspaceId: string;
  channelId: string;
  userGroupId: string;
  config: MentionRepairConfig;
  transport: Pick<SlackTransport, 'lookupUserGroup'>;
  limiter?: AgentUserGroupLookupLimiter;
  now?: () => number;
}

/**
 * Bounds exceptional directory repair. Normal stored-id routing never reaches
 * this limiter. Failed or rejected ids are cached briefly, while a per-workspace
 * window prevents a stream of novel ids from becoming a Slack API fan-out.
 */
export class AgentUserGroupLookupLimiter {
  private readonly negativeReceipts = new Map<string, NegativeLookupReceipt>();
  private readonly windows = new Map<string, LookupWindow>();
  private readonly repairs = new Map<string, Promise<MentionedAgentUserGroupRepairResult>>();

  constructor(private readonly options: {
    now?: () => number;
    negativeTtlMs?: number;
    windowMs?: number;
    maxLookupsPerWindow?: number;
    maxNegativeEntries?: number;
    maxWorkspaceWindows?: number;
  } = {}) {}

  async lookup(
    workspaceId: string,
    userGroupId: string,
    transport: Pick<SlackTransport, 'lookupUserGroup'>,
  ): Promise<UserGroupLookupResult> {
    const now = (this.options.now ?? Date.now)();
    const key = `${workspaceId}:${userGroupId}`;
    const cached = this.negativeReceipts.get(key);
    if (cached !== undefined) {
      if (cached.until > now) return { kind: cached.kind };
      this.negativeReceipts.delete(key);
    }

    const windowMs = this.options.windowMs ?? 60_000;
    const existing = this.windows.get(workspaceId);
    const window = !existing || now - existing.startedAt >= windowMs
      ? { startedAt: now, count: 0 }
      : existing;
    if (window.count >= (this.options.maxLookupsPerWindow ?? 8)) {
      this.rememberDenied(workspaceId, userGroupId, now, 'rate_limited');
      return { kind: 'rate_limited' };
    }
    window.count += 1;
    this.windows.delete(workspaceId);
    this.windows.set(workspaceId, window);
    this.trimWorkspaceWindows();

    try {
      const group = await transport.lookupUserGroup(userGroupId);
      if (group) return { kind: 'found', group };
      this.rememberDenied(workspaceId, userGroupId, now, 'missing');
      return { kind: 'missing' };
    } catch {
      this.rememberDenied(workspaceId, userGroupId, now, 'failed');
      return { kind: 'failed' };
    }
  }

  rememberDenied(
    workspaceId: string,
    userGroupId: string,
    now?: number,
    kind: NegativeLookupReceipt['kind'] = 'missing',
  ): void {
    const observedAt = now ?? (this.options.now ?? Date.now)();
    const key = `${workspaceId}:${userGroupId}`;
    this.negativeReceipts.delete(key);
    this.negativeReceipts.set(key, {
      until: observedAt + (this.options.negativeTtlMs ?? 30_000),
      kind,
    });
    const maximum = this.options.maxNegativeEntries ?? 256;
    while (this.negativeReceipts.size > maximum) {
      const oldest = this.negativeReceipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.negativeReceipts.delete(oldest);
    }
  }

  runRepair(
    workspaceId: string,
    channelId: string,
    userGroupId: string,
    repair: () => Promise<MentionedAgentUserGroupRepairResult>,
  ): Promise<MentionedAgentUserGroupRepairResult> {
    const key = `${workspaceId}:${channelId}:${userGroupId}`;
    const active = this.repairs.get(key);
    if (active) return active;
    const pending = repair();
    this.repairs.set(key, pending);
    void pending.finally(() => {
      if (this.repairs.get(key) === pending) this.repairs.delete(key);
    }).catch(() => undefined);
    return pending;
  }

  private trimWorkspaceWindows(): void {
    const maximum = this.options.maxWorkspaceWindows ?? 64;
    while (this.windows.size > maximum) {
      const oldest = this.windows.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}

const defaultAgentUserGroupLookupLimiter = new AgentUserGroupLookupLimiter();

export function repairMentionedAgentUserGroup(
  input: MentionedAgentUserGroupRepairInput,
): Promise<MentionedAgentUserGroupRepairResult> {
  const limiter = input.limiter ?? defaultAgentUserGroupLookupLimiter;
  return limiter.runRepair(
    input.workspaceId,
    input.channelId,
    input.userGroupId,
    () => repairMentionedAgentUserGroupOnce(input, limiter),
  );
}

async function repairMentionedAgentUserGroupOnce(
  input: MentionedAgentUserGroupRepairInput,
  limiter: AgentUserGroupLookupLimiter,
): Promise<MentionedAgentUserGroupRepairResult> {
  const lookup = await limiter.lookup(input.workspaceId, input.userGroupId, input.transport);
  if (lookup.kind === 'rate_limited' || lookup.kind === 'failed') return { kind: 'lookup_failed', reason: lookup.kind };
  if (lookup.kind !== 'found') return { kind: 'unknown' };
  if (lookup.group.disabled) {
    limiter.rememberDenied(input.workspaceId, input.userGroupId);
    return { kind: 'unknown' };
  }

  const [agents, grants] = await Promise.all([
    input.config.listAgents(),
    input.config.listAgentChannelGrants(input.workspaceId, input.channelId),
  ]);
  const groupHandle = normalizeAgentHandle(lookup.group.handle);
  const candidates = agents.filter((agent) =>
    agent.kind === 'user' &&
    agent.enabled &&
    agent.lifecycle !== 'archived' &&
    agent.lifecycle !== 'draft' &&
    agent.slackPresence?.kind !== 'agent_app' &&
    agent.slackPresence?.desiredState === 'active' &&
    normalizeAgentHandle(
      agent.slackPresence.normalizedHandle ||
      agent.slackPresence.requestedHandle ||
      agent.name,
    ) === groupHandle
  );
  if (candidates.length !== 1) {
    limiter.rememberDenied(input.workspaceId, input.userGroupId);
    return { kind: 'unknown' };
  }
  const agent = candidates[0]!;
  // Anyone can make a group with an Agent's handle; only the one Chickpea's
  // interrupted create made is this Agent's.
  const competingClaim = agents.some((candidate) =>
    candidate.id !== agent.id && candidate.slackPresence?.userGroupId === lookup.group.id
  );
  if (!hasAmbiguousCreateOwnershipProof(agent, lookup.group) || competingClaim) {
    limiter.rememberDenied(input.workspaceId, input.userGroupId);
    return { kind: 'unknown' };
  }
  if (!grants.some((grant) => grant.agentId === agent.id && grant.status === 'active')) {
    return { kind: 'not_in_channel', agent };
  }

  const presence = userGroupPresence(agent);
  try {
    const repaired = await input.config.updateAgent(
      agent.id,
      {
        lifecycle: 'active',
        slackPresence: {
          ...withoutPendingCreate(withoutPresenceErrors(presence)),
          userGroupId: lookup.group.id,
          desiredState: 'active',
          health: 'healthy',
          observedAt: (input.now ?? Date.now)(),
        },
      },
      agent.revision,
    );
    const claims = (await input.config.listAgents()).filter((candidate) =>
      candidate.slackPresence?.userGroupId === lookup.group.id
    );
    if (claims.length !== 1 || claims[0]?.id !== repaired.id) {
      limiter.rememberDenied(input.workspaceId, input.userGroupId);
      return { kind: 'unknown' };
    }
    return { kind: 'repaired', agent: repaired };
  } catch {
    limiter.rememberDenied(input.workspaceId, input.userGroupId);
    return { kind: 'temporarily_unavailable' };
  }
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
    let channel;
    try {
      channel = await transport.lookupChannel(input.channelId);
    } catch (error) {
      const classified = classifyAgentPresenceError(error);
      await this.recordFailure(agent, classified);
      throw classified;
    }
    const ensurePendingGrant = async (): Promise<AgentChannelGrant> => {
      const existingGrant = (await config.listAgentChannelGrants(
        input.workspaceId,
        input.channelId,
      )).find((grant) => grant.agentId === agent.id);
      if (existingGrant?.status === 'active') return existingGrant;
      return config.putAgentChannelGrant(
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
    };
    // A bot cannot enumerate membership in a private Channel it cannot see.
    // Surface the actionable invite step before attempting that impossible
    // membership probe.
    if (!channel.member && channel.private) {
      await ensurePendingGrant();
      const error = new AgentPresenceError(
        'private_channel_invite_required',
        'Invite Chickpea to the private Slack Channel before retrying.',
      );
      await this.recordFailure(agent, error);
      throw error;
    }
    try {
      if (!await transport.channelHasMember(input.channelId, input.actorSlackUserId)) {
        throw new AgentPresenceError(
          'channel_membership_required',
          'Join the Slack Channel before adding this Agent.',
        );
      }
    } catch (error) {
      const classified = classifyAgentPresenceError(error);
      await this.recordFailure(await config.getAgent(agent.id), classified);
      throw classified;
    }
    const persistedChannel = await config.getChannel(input.workspaceId, input.channelId);
    if (!persistedChannel) {
      try {
        await config.putChannel({
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          ...(channel.name ? { label: channel.name } : {}),
          lifecycle: 'active',
        }, 0);
      } catch (error) {
        // A concurrent publication may have imported the same live Channel.
        // Accept only that proven race; otherwise preserve the original error.
        if (!await config.getChannel(input.workspaceId, input.channelId)) throw error;
      }
    } else if (channel.name && persistedChannel.label !== channel.name) {
      // The Channel was imported under an earlier Slack name.
      await config.refreshChannelLabel(input.workspaceId, input.channelId, channel.name);
    }
    const pendingGrant = await ensurePendingGrant();
    if (!channel.member) {
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
    const appBot = await this.dependencies.agentApps?.bringBotIn(published, { id: input.channelId, private: channel.private });
    if (pendingGrant.status !== 'active') {
      await this.announceBestEffort('joinedChannel', published.id, (announce) => announce.joinedChannel({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        channelIsPrivate: channel.private,
        agent: published,
        grantRevision: grant.revision,
        ...(appBot?.placement === 'in_channel' ? { appBot: appBot.transport } : {}),
      }));
    }
    return { agent: published, grant, ...(appBot ? { appBot: appBot.placement } : {}) };
  }

  /** Reconcile one Agent's desired Slack alias; safe to invoke after ambiguity. */
  async reconcile(agentId: string): Promise<CustomAgentConfig> {
    const before = await this.dependencies.config.getAgent(agentId);
    const wasLive = handleIsLive(before);
    const reconciled = await this.reconcileOnce(agentId, 0);
    if (!wasLive && handleIsLive(reconciled)) {
      await this.announceBestEffort('handleWentLive', reconciled.id, (announce) => announce.handleWentLive(reconciled));
    }
    return reconciled;
  }

  private async reconcileOnce(agentId: string, attempt: number): Promise<CustomAgentConfig> {
    const { config, transport } = this.dependencies;
    let agent = await config.getAgent(agentId);
    if (agent.lifecycle === 'archived') {
      throw new AgentPresenceError('slack_operation_failed', 'Archived Agents cannot be reconciled.');
    }
    const presence = requiredPresence(agent);
    if (presence.kind === 'agent_app') return agent;
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
          throw new AgentPresenceError(
            'handle_collision',
            `@${normalizedHandle} is already in use.`,
            { suggestions: suggestedHandles(normalizedHandle, groups) },
          );
        }
        if (!hasAmbiguousCreateOwnershipProof({ slackPresence: presence }, handleMatch)) {
          throw new AgentPresenceError(
            'user_group_create_ambiguous',
            `Slack has a matching @${normalizedHandle} user group, but Chickpea cannot prove it came from the interrupted create. Change the Agent handle or ask a Slack Admin to resolve the collision.`,
          );
        }
        group = handleMatch;
      }
    }

    if (!group) {
      const pendingCreate = {
        name: agentUserGroupName(agent.name, groups),
        handle: normalizedHandle,
        description: agent.description ?? `${agent.name} Agent`,
        startedAt: this.now(),
      };
      agent = await config.updateAgent(
        agent.id,
        {
          slackPresence: {
            ...userGroupPresence(agent),
            pendingCreate,
          },
        },
        agent.revision,
      );
      try {
        group = await transport.createUserGroup({
          name: pendingCreate.name,
          handle: pendingCreate.handle,
          description: pendingCreate.description,
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
        throw withHandleSuggestions(error, normalizedHandle, groups);
      }
    } else {
      try {
        group = await this.updateGroupIfNeeded(
          group,
          agent,
          normalizedHandle,
          agentUserGroupName(agent.name, groups, group.id),
        );
      } catch (error) {
        throw withHandleSuggestions(error, normalizedHandle, groups);
      }
      if (group.disabled) group = await transport.enableUserGroup(group.id);
    }
    let current = await config.getAgent(agent.id);
    const currentPresence = userGroupPresence(current);
    if (current.lifecycle === 'archived' || currentPresence.desiredState === 'disabled') {
      if (!group.disabled) await transport.disableUserGroup(group.id);
      throw new AgentPresenceError('slack_operation_failed', 'Archived Agents cannot be reconciled.');
    }
    const currentHandle = normalizeAgentHandle(currentPresence.requestedHandle || current.name);
    const desiredChangedDuringSlackIo = current.name !== agent.name ||
      current.description !== agent.description || currentHandle !== normalizedHandle;
    if (desiredChangedDuringSlackIo) {
      // Preserve the observed group id before reconciling the newer desired
      // state. Otherwise a handle edit racing the Slack request could orphan a
      // just-created group and create a second one on Retry.
      current = await config.updateAgent(
        current.id,
        {
          slackPresence: {
            ...currentPresence,
            userGroupId: group.id,
            health: 'pending',
          },
        },
        current.revision,
      );
      if (attempt >= 4) {
        throw new AgentPresenceError(
          'slack_operation_failed',
          'Agent settings kept changing during Slack reconciliation. Retry after edits settle.',
          { retryable: true },
        );
      }
      return this.reconcileOnce(current.id, attempt + 1);
    }
    return config.updateAgent(
      current.id,
      {
        lifecycle: 'active',
        enabled: true,
        slackPresence: {
          ...withoutPendingCreate(withoutPresenceErrors(userGroupPresence(current))),
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
    const agent = await this.dependencies.config.getAgent(agentId);
    if (agent.lifecycle === 'archived') {
      throw new AgentPresenceError('slack_operation_failed', 'Archived Agents cannot be retried.');
    }
    try {
      return agent.slackPresence?.desiredState === 'disabled'
        ? await this.archive(agentId)
        : await this.reconcile(agentId);
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
    const replacement = options.replacementDefaultAgentId;
    if (defaultInstallations.length > 0 && !replacement) {
      throw new AgentPresenceError(
        'slack_operation_failed',
        `Choose a replacement default Agent before archiving ${agent.name}.`,
      );
    }
    if (agent.slackPresence?.kind === 'agent_app') {
      const { agentApps } = this.dependencies;
      if (!agentApps) {
        throw new AgentPresenceError(
          'slack_operation_failed',
          `Chickpea couldn't remove ${agent.name}'s Slack app, so ${agent.name} is not archived. Try again in a minute.`,
        );
      }
      agent = await agentApps.retire(agent);
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
    // The replacement comes with this request only. Apply it once the Agent
    // is marked for archiving and before Slack is asked, so a Retry after a
    // denied disable no longer needs one.
    if (replacement) {
      for (const installation of defaultInstallations) {
        await config.setWorkspaceDefaultAgent(installation.workspaceId, replacement, installation.revision);
      }
    }
    if (presence.userGroupId) {
      try {
        const group = await transport.lookupUserGroup(presence.userGroupId);
        if (!group?.disabled) await disableUserGroup(transport, presence.userGroupId, { missing: !group });
      } catch (error) {
        // An archived Agent leaves no live handle, so archive waits for an
        // Owner or Admin to deactivate the group in Slack, then Retry.
        const classified = classifyAgentPresenceError(error);
        const archiveError = classified.code === 'user_group_policy_denied'
          ? new AgentPresenceError(classified.code,
            `Slack did not allow Chickpea to deactivate the @${presence.normalizedHandle} user group. ` +
              'The Agent is not archived until that user group is deactivated.',
            classified.options)
          : classified;
        await this.recordFailure(agent, archiveError);
        throw archiveError;
      }
    }
    agent = await config.updateAgent(
      agent.id,
      {
        slackPresence: {
          ...withoutPresenceErrors(requiredPresence(agent)),
          desiredState: 'disabled',
          health: presence.userGroupId ? 'healthy' : 'unpublished',
          observedAt: this.now(),
        },
      },
      agent.revision,
    );
    return config.archiveAgent(agent.id, { expectedRevision: agent.revision });
  }

  async restore(agentId: string): Promise<CustomAgentConfig> {
    const { config, transport } = this.dependencies;
    let agent = await config.getAgent(agentId);
    agent = await config.restoreAgent(agent.id, agent.revision);
    let presence = requiredPresence(agent);
    agent = await config.updateAgent(
      agent.id,
      {
        slackPresence: {
          ...withoutPresenceErrors(presence),
          desiredState: 'active',
          health: presence.userGroupId ? 'pending' : 'unpublished',
          observedAt: this.now(),
        },
      },
      agent.revision,
    );
    presence = requiredPresence(agent);
    if (!presence.userGroupId) return agent;
    try {
      await enableUserGroup(transport, presence.userGroupId);
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
    name: string,
  ): Promise<SlackUserGroup> {
    const desiredDescription = agent.description ?? `${agent.name} Agent`;
    if (
      group.name === name &&
      group.handle === normalizedHandle &&
      group.description === desiredDescription
    ) return group;
    return this.dependencies.transport.updateUserGroup(group.id, {
      name,
      handle: normalizedHandle,
      description: desiredDescription,
    });
  }

  private async announceBestEffort(
    transition: keyof AgentPresenceAnnouncements,
    agentId: string,
    run: (announce: AgentPresenceAnnouncements) => Promise<void>,
  ): Promise<void> {
    const { announce } = this.dependencies;
    if (!announce) return;
    try {
      await run(announce);
    } catch (error) {
      console.warn('[chickpea] Agent presence announcement failed', JSON.stringify({
        transition,
        agentId,
        error: error instanceof Error ? error.name : 'unknown',
        ...(error instanceof SlackTransportError ? { code: error.code } : {}),
      }));
    }
  }

  private async recordFailure(
    agent: CustomAgentConfig,
    error: AgentPresenceError,
  ): Promise<void> {
    const current = await this.dependencies.config.getAgent(agent.id);
    const presence = withoutPresenceErrors(requiredPresence(current));
    await this.dependencies.config.updateAgent(
      current.id,
      {
        lifecycle: current.lifecycle === 'archived' ? 'archived' : 'needs_attention',
        slackPresence: {
          ...presence,
          health: 'needs_attention',
          errorCode: error.code,
          errorDetail: error.message,
          ...(error.code === 'handle_collision' && error.suggestions.length > 0
            ? { handleSuggestions: error.suggestions }
            : {}),
          observedAt: this.now(),
        },
      },
      current.revision,
    );
  }
}

/**
 * Disable an Agent's user group. Slack answers `already_disabled` when an
 * Owner or Admin deactivated it first, which is the state archive wants; a
 * group the workspace's list no longer has, and that Slack cannot find
 * (`no_such_subteam`; any other code, `subteam_not_found` included, is not
 * proof it is gone), leaves no live handle either. A not-found answer for a
 * group still listed is a failure.
 */
async function disableUserGroup(
  transport: SlackTransport,
  userGroupId: string,
  options: { missing: boolean },
): Promise<void> {
  try {
    await transport.disableUserGroup(userGroupId);
  } catch (error) {
    if (!(error instanceof SlackTransportError)) throw error;
    if (error.code === 'already_disabled') return;
    if (options.missing && error.code === 'no_such_subteam') return;
    throw error;
  }
}

/** Enable an Agent's user group; Slack's `already_enabled` is the state restore wants. */
async function enableUserGroup(transport: SlackTransport, userGroupId: string): Promise<void> {
  try {
    await transport.enableUserGroup(userGroupId);
  } catch (error) {
    if (error instanceof SlackTransportError && error.code === 'already_enabled') return;
    throw error;
  }
}

function handleIsLive(agent: CustomAgentConfig): boolean {
  return agent.slackPresence?.health === 'healthy' && agentSlackHandle(agent) !== undefined;
}

function suggestedHandles(handle: string, groups: readonly SlackUserGroup[]): string[] {
  return alternativeAgentHandles(handle, new Set(groups.map((group) => group.handle)));
}

function withHandleSuggestions(
  error: unknown,
  handle: string,
  groups: readonly SlackUserGroup[],
): unknown {
  const classified = classifyAgentPresenceError(error);
  if (classified.code !== 'handle_collision') return error;
  return new AgentPresenceError(classified.code, classified.message, {
    ...classified.options,
    suggestions: suggestedHandles(handle, groups),
  });
}

function requiredPresence(agent: CustomAgentConfig): AgentSlackPresence {
  if (!agent.slackPresence) throw new Error(`Agent ${agent.id} has no Slack presence`);
  return agent.slackPresence;
}

/** The presence a user-group step writes; an Agent that got its own Slack app mid-flight is refused. */
function userGroupPresence(agent: CustomAgentConfig): UserGroupPresence {
  const presence = requiredPresence(agent);
  if (presence.kind === 'agent_app') throw new Error(`Agent ${agent.id} has its own Slack app`);
  return presence;
}

type PresenceErrorField = 'errorCode' | 'errorDetail' | 'handleSuggestions';

type WithoutPresenceErrors<P> = P extends AgentSlackPresence ? Omit<P, PresenceErrorField> : never;

function withoutPresenceErrors<P extends AgentSlackPresence>(presence: P): WithoutPresenceErrors<P> {
  const {
    errorCode: _errorCode,
    errorDetail: _errorDetail,
    handleSuggestions: _handleSuggestions,
    ...clean
  } = presence;
  return clean as WithoutPresenceErrors<P>;
}

function withoutPendingCreate(
  presence: WithoutPresenceErrors<UserGroupPresence>,
): Omit<UserGroupPresence, PresenceErrorField | 'pendingCreate'> {
  const { pendingCreate: _pendingCreate, ...clean } = presence;
  return clean;
}

function hasAmbiguousCreateOwnershipProof(
  agent: Pick<CustomAgentConfig, 'slackPresence'>,
  group: SlackUserGroup,
): boolean {
  const presence = agent.slackPresence;
  return presence?.errorCode === 'user_group_create_ambiguous' &&
    matchesAmbiguousCreateLease(group, presence.pendingCreate);
}

function matchesAmbiguousCreateLease(
  group: SlackUserGroup,
  lease: PendingUserGroupCreate | undefined,
): boolean {
  if (!lease || group.updatedAt === undefined) return false;
  return group.name === lease.name &&
    group.handle === lease.handle &&
    group.description === lease.description &&
    // Slack's date_update is expressed in whole Unix seconds.
    group.updatedAt >= Math.floor(lease.startedAt / 1_000);
}
