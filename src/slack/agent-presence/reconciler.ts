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

type MentionRepairConfig = Pick<
  ConfigStore,
  'listAgents' | 'listAgentChannelGrants' | 'updateAgent'
>;

export type MentionedAgentUserGroupRepairResult =
  | { kind: 'repaired'; agent: CustomAgentConfig }
  | { kind: 'not_available' | 'temporarily_unavailable' };

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
  if (lookup.kind !== 'found') {
    if (lookup.kind === 'failed' || lookup.kind === 'rate_limited') {
      return { kind: 'temporarily_unavailable' };
    }
    return { kind: 'not_available' };
  }
  if (lookup.group.disabled) {
    limiter.rememberDenied(input.workspaceId, input.userGroupId);
    return { kind: 'not_available' };
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
    agent.slackPresence?.desiredState === 'active' &&
    normalizeAgentHandle(
      agent.slackPresence.normalizedHandle ||
      agent.slackPresence.requestedHandle ||
      agent.name,
    ) === groupHandle
  );
  if (candidates.length !== 1) {
    limiter.rememberDenied(input.workspaceId, input.userGroupId);
    return { kind: 'not_available' };
  }
  const agent = candidates[0]!;
  const activeGrants = grants.filter((grant) =>
    grant.agentId === agent.id && grant.status === 'active'
  );
  const competingClaim = agents.some((candidate) =>
    candidate.id !== agent.id && candidate.slackPresence?.userGroupId === lookup.group.id
  );
  if (activeGrants.length !== 1 || competingClaim) {
    limiter.rememberDenied(input.workspaceId, input.userGroupId);
    return { kind: 'not_available' };
  }

  const presence = agent.slackPresence!;
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
      return { kind: 'not_available' };
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
    return { agent: published, grant };
  }

  /** Reconcile one Agent's desired Slack alias; safe to invoke after ambiguity. */
  async reconcile(agentId: string, attempt = 0): Promise<CustomAgentConfig> {
    const { config, transport } = this.dependencies;
    let agent = await config.getAgent(agentId);
    if (agent.lifecycle === 'archived') {
      throw new AgentPresenceError('slack_operation_failed', 'Archived Agents cannot be reconciled.');
    }
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
        name: agent.name,
        handle: normalizedHandle,
        description: agent.description ?? `${agent.name} Agent`,
        startedAt: this.now(),
      };
      agent = await config.updateAgent(
        agent.id,
        {
          slackPresence: {
            ...requiredPresence(agent),
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
        throw error;
      }
    } else {
      group = await this.updateGroupIfNeeded(group, agent, normalizedHandle);
      if (group.disabled) group = await transport.enableUserGroup(group.id);
    }
    let current = await config.getAgent(agent.id);
    const currentPresence = requiredPresence(current);
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
      return this.reconcile(current.id, attempt + 1);
    }
    return config.updateAgent(
      current.id,
      {
        lifecycle: 'active',
        enabled: true,
        slackPresence: {
          ...withoutPendingCreate(withoutPresenceErrors(requiredPresence(current))),
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

function withoutPendingCreate(
  presence: Omit<AgentSlackPresence, 'errorCode' | 'errorDetail'>,
): Omit<AgentSlackPresence, 'errorCode' | 'errorDetail' | 'pendingCreate'> {
  const { pendingCreate: _pendingCreate, ...clean } = presence;
  return clean;
}

export function hasAmbiguousCreateOwnershipProof(
  agent: Pick<CustomAgentConfig, 'slackPresence'>,
  group: SlackUserGroup,
): boolean {
  const presence = agent.slackPresence;
  return presence?.errorCode === 'user_group_create_ambiguous' &&
    matchesAmbiguousCreateLease(group, presence.pendingCreate);
}

function matchesAmbiguousCreateLease(
  group: SlackUserGroup,
  lease: AgentSlackPresence['pendingCreate'],
): boolean {
  if (!lease || group.updatedAt === undefined) return false;
  return group.name === lease.name &&
    group.handle === lease.handle &&
    group.description === lease.description &&
    // Slack's date_update is expressed in whole Unix seconds.
    group.updatedAt >= Math.floor(lease.startedAt / 1_000);
}
