import { canEditAgent, requireAgentChannelPublication } from '../auth/permissions.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import type { ConfigStore } from '../config/store.ts';
import type {
  AgentChannelGrant,
  CustomAgentConfig,
  WorkspaceInstallation,
} from '../config/types.ts';
import type { ManagementStore } from '../management/store.ts';
import {
  ManagementError,
  type PrivateChannelSetupAgentSnapshot,
  type PrivateChannelSetupInstallationSnapshot,
  type PrivateChannelSetupIntent,
} from '../management/types.ts';
import type { SlackChannel } from './transport/types.ts';

const SETUP_TTL_MS = 30 * 60_000;
const DEFAULT_CLAIM_OBSERVATION_MS = 15_000;
const MAX_AGENT_CHOICES = 100;

export interface PrivateChannelSetupActor {
  principal?: AuthPrincipal;
  routing: {
    fullMember: boolean;
    channelMember: boolean;
  };
}

export interface PrivateChannelSetupChoice {
  agentId: string;
  name: string;
  handle: string;
}

export interface BeginPrivateChannelSetupInput {
  workspaceId: string;
  channelId: string;
  inviterSlackUserId: string;
}

export interface AddPrivateChannelAgentInput extends BeginPrivateChannelSetupInput {
  setupId: string;
  agentId: string;
}

export type AddPrivateChannelAgentResult =
  | {
      kind: 'completed';
      agentId: string;
      handle: string;
      replayed: boolean;
    }
  | { kind: 'in_progress' }
  | { kind: 'no_longer_added' }
  | {
      kind: 'recovery_required';
      message: string;
    };

export class PrivateChannelSetupError extends Error {
  readonly name = 'PrivateChannelSetupError';

  constructor(
    readonly code: 'forbidden' | 'unavailable' | 'unverifiable' | 'expired' | 'stale',
    message = 'This private Channel setup is no longer available. Invite Chickpea again to start over.',
  ) {
    super(message);
  }
}

export interface PrivateChannelSetupServiceDependencies {
  config: Pick<
    ConfigStore,
    | 'listUserAgents'
    | 'getAgent'
    | 'getWorkspaceInstallation'
    | 'getChannel'
    | 'listAgentChannelGrants'
  >;
  management: Pick<
    ManagementStore,
    | 'putPrivateChannelSetupIntent'
    | 'getPrivateChannelSetupIntent'
    | 'claimPrivateChannelSetupIntent'
    | 'completePrivateChannelSetupIntent'
    | 'requirePrivateChannelSetupRecovery'
  >;
  resolveActor(input: BeginPrivateChannelSetupInput): Promise<PrivateChannelSetupActor>;
  lookupChannel(workspaceId: string, channelId: string): Promise<SlackChannel>;
  prepareGeneratedAvatar(input: {
    workspaceId: string;
    agent: CustomAgentConfig;
  }): Promise<CustomAgentConfig>;
  publishAgentChannel(input: {
    actor: AuthPrincipal;
    workspaceId: string;
    channelId: string;
    agentId: string;
  }): Promise<{ agent: CustomAgentConfig; grant: AgentChannelGrant }>;
  now?: () => number;
  randomId?: () => string;
  claimObservationMs?: number;
}

/** Inviter-bound orchestration for one private Channel setup card. */
export class PrivateChannelSetupService {
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly claimObservationMs: number;

  constructor(private readonly dependencies: PrivateChannelSetupServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.randomId = dependencies.randomId ?? (() => crypto.randomUUID());
    this.claimObservationMs = dependencies.claimObservationMs ?? DEFAULT_CLAIM_OBSERVATION_MS;
  }

  async begin(input: BeginPrivateChannelSetupInput): Promise<{
    setupId: string;
    expiresAt: number;
    agents: PrivateChannelSetupChoice[];
    choicesTruncated: boolean;
  }> {
    const [actor, channel, installation] = await Promise.all([
      this.dependencies.resolveActor(input),
      this.dependencies.lookupChannel(input.workspaceId, input.channelId),
      this.dependencies.config.getWorkspaceInstallation(input.workspaceId),
    ]);
    const principal = requireCurrentActor(actor);
    requirePrivateChannel(channel, input.channelId);
    const installed = requireInstallation(installation, input.workspaceId);

    const [agents, grants, persistedChannel] = await Promise.all([
      this.dependencies.config.listUserAgents(),
      this.dependencies.config.listAgentChannelGrants(input.workspaceId, input.channelId),
      this.dependencies.config.getChannel(input.workspaceId, input.channelId),
    ]);
    const grantByAgent = new Map(grants.map((grant) => [grant.agentId, grant]));
    const eligible = agents
      .filter((agent) => eligibleAgent(principal, agent, grantByAgent.get(agent.id)))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const choicesTruncated = eligible.length > MAX_AGENT_CHOICES;
    const visible = eligible.slice(0, MAX_AGENT_CHOICES);
    const snapshots = visible.map((agent) => agentSnapshot(agent, grantByAgent.get(agent.id)));
    const at = this.now();
    const setupId = this.randomId();
    const expiresAt = at + SETUP_TTL_MS;
    await this.dependencies.management.putPrivateChannelSetupIntent({
      record: {
        setupId,
        origin: 'private_channel_invitation',
        organizationId: principal.organizationId,
        actorUserId: principal.userId,
        actorMembershipId: principal.membershipId,
        inviterSlackUserId: input.inviterSlackUserId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        installation: installationSnapshot(installed),
        channelRevision: persistedChannel?.revision ?? 0,
        eligibleAgents: snapshots,
        choicesTruncated,
        status: 'open',
        expiresAt,
        createdAt: at,
        updatedAt: at,
      },
    });
    return {
      setupId,
      expiresAt,
      choicesTruncated,
      agents: snapshots.map(({ agentId, name, handle }) => ({ agentId, name, handle })),
    };
  }

  async add(input: AddPrivateChannelAgentInput): Promise<AddPrivateChannelAgentResult> {
    const intent = await this.dependencies.management.getPrivateChannelSetupIntent(input.setupId);
    if (!intent) throw new PrivateChannelSetupError('unavailable');
    const actor = await this.dependencies.resolveActor(input);
    const principal = requireCurrentActor(actor);
    assertInputBinding(intent, input, principal);
    const at = this.now();
    if (intent.status === 'open' && at >= intent.expiresAt) {
      throw new PrivateChannelSetupError('expired');
    }

    const [channel, installation, selectedAgent] = await Promise.all([
      this.dependencies.lookupChannel(input.workspaceId, input.channelId),
      this.dependencies.config.getWorkspaceInstallation(input.workspaceId),
      this.findUserAgent(input.agentId),
    ]);
    requirePrivateChannel(channel, input.channelId);
    const installed = requireInstallation(installation, input.workspaceId);
    assertInstallationSnapshot(intent.installation, installed);
    requirePublicationAuthority(principal, actor, selectedAgent);

    if (intent.status === 'open') await this.assertInitialSnapshots(intent, input.agentId);
    let claim;
    try {
      claim = await this.dependencies.management.claimPrivateChannelSetupIntent({
        setupId: input.setupId,
        organizationId: principal.organizationId,
        actorUserId: principal.userId,
        actorMembershipId: principal.membershipId,
        inviterSlackUserId: input.inviterSlackUserId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        agentId: input.agentId,
        at,
      });
    } catch (error) {
      throw translateStoreError(error);
    }
    const claimed = claim.intent;
    if (claimed.status === 'completed' && claimed.result) {
      const current = await this.readCurrentPublication(claimed, false);
      return current
        ? { kind: 'completed', ...current, replayed: true }
        : { kind: 'no_longer_added' };
    }
    if (!claim.claimedByThisCall) {
      const recovered = await this.readCurrentPublication(claimed, true);
      if (recovered) return { kind: 'completed', ...recovered, replayed: true };
      if (claimed.status === 'claimed' &&
          at - (claimed.claimedAt ?? at) < this.claimObservationMs) {
        return { kind: 'in_progress' };
      }
      await this.markRecovery(claimed, principal, 'publication_interrupted');
      return recoveryResult();
    }

    try {
      await this.dependencies.prepareGeneratedAvatar({
        workspaceId: input.workspaceId,
        agent: selectedAgent,
      });
      const published = await this.dependencies.publishAgentChannel({
        actor: principal,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        agentId: input.agentId,
      });
      const result = publicationResult(published.agent);
      await this.complete(claimed, principal, result);
      return { kind: 'completed', ...result, replayed: false };
    } catch {
      const recovered = await this.readCurrentPublication(claimed, true);
      if (recovered) return { kind: 'completed', ...recovered, replayed: false };
      await this.markRecovery(claimed, principal, 'publication_failed');
      return recoveryResult();
    }
  }

  private async findUserAgent(agentId: string): Promise<CustomAgentConfig> {
    const agent = (await this.dependencies.config.listUserAgents())
      .find((candidate) => candidate.id === agentId);
    if (!agent) throw new PrivateChannelSetupError('unavailable');
    return agent;
  }

  private async assertInitialSnapshots(
    intent: PrivateChannelSetupIntent,
    selectedAgentId: string,
  ): Promise<void> {
    const [channel, agent, grants] = await Promise.all([
      this.dependencies.config.getChannel(intent.workspaceId, intent.channelId),
      this.findUserAgent(selectedAgentId),
      this.dependencies.config.listAgentChannelGrants(intent.workspaceId, intent.channelId),
    ]);
    if ((channel?.revision ?? 0) !== intent.channelRevision) {
      throw new PrivateChannelSetupError('stale');
    }
    const snapshot = intent.eligibleAgents.find(({ agentId }) => agentId === selectedAgentId);
    const grant = grants.find(({ agentId }) => agentId === selectedAgentId);
    if (!snapshot || agent.revision !== snapshot.agentRevision ||
        (grant?.revision ?? 0) !== snapshot.grantRevision) {
      throw new PrivateChannelSetupError('stale');
    }
  }

  private async readCurrentPublication(
    intent: PrivateChannelSetupIntent,
    settle: boolean,
  ): Promise<{ agentId: string; handle: string } | undefined> {
    const selectedAgentId = intent.selectedAgentId;
    if (!selectedAgentId) return undefined;
    try {
      const actorInput = {
        workspaceId: intent.workspaceId,
        channelId: intent.channelId,
        inviterSlackUserId: intent.inviterSlackUserId,
      };
      const [actor, channel, installation, agent, grants] = await Promise.all([
        this.dependencies.resolveActor(actorInput),
        this.dependencies.lookupChannel(intent.workspaceId, intent.channelId),
        this.dependencies.config.getWorkspaceInstallation(intent.workspaceId),
        this.findUserAgent(selectedAgentId),
        this.dependencies.config.listAgentChannelGrants(intent.workspaceId, intent.channelId),
      ]);
      const principal = requireCurrentActor(actor);
      requirePrivateChannel(channel, intent.channelId);
      assertInstallationSnapshot(
        intent.installation,
        requireInstallation(installation, intent.workspaceId),
      );
      assertActorBinding(intent, principal);
      requirePublicationAuthority(principal, actor, agent);
      const grant = grants.find((candidate) => candidate.agentId === selectedAgentId);
      if (grant?.status !== 'active' || !publishedPresenceActive(agent)) return undefined;
      const result = publicationResult(agent);
      if (settle) await this.complete(intent, principal, result);
      return result;
    } catch (error) {
      if (!settle) {
        if (error instanceof PrivateChannelSetupError) throw error;
        throw new PrivateChannelSetupError(
          'unverifiable',
          'This Agent could not be checked right now. Try again in a moment.',
        );
      }
      return undefined;
    }
  }

  private complete(
    intent: PrivateChannelSetupIntent,
    principal: AuthPrincipal,
    result: { agentId: string; handle: string },
  ) {
    return this.dependencies.management.completePrivateChannelSetupIntent({
      setupId: intent.setupId,
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      actorMembershipId: principal.membershipId,
      inviterSlackUserId: intent.inviterSlackUserId,
      agentId: result.agentId,
      result,
      at: this.now(),
    });
  }

  private markRecovery(
    intent: PrivateChannelSetupIntent,
    principal: AuthPrincipal,
    failureCode: string,
  ) {
    return this.dependencies.management.requirePrivateChannelSetupRecovery({
      setupId: intent.setupId,
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      actorMembershipId: principal.membershipId,
      inviterSlackUserId: intent.inviterSlackUserId,
      agentId: intent.selectedAgentId!,
      failureCode,
      at: this.now(),
    });
  }
}

function requireCurrentActor(actor: PrivateChannelSetupActor): AuthPrincipal {
  if (!actor.routing.fullMember || !actor.routing.channelMember || !actor.principal) {
    throw new PrivateChannelSetupError('forbidden');
  }
  return actor.principal;
}

function requirePublicationAuthority(
  principal: AuthPrincipal,
  actor: PrivateChannelSetupActor,
  agent: CustomAgentConfig,
): void {
  try {
    requireAgentChannelPublication(principal, agent, actor.routing.channelMember);
  } catch {
    throw new PrivateChannelSetupError('forbidden');
  }
}

function requirePrivateChannel(channel: SlackChannel, channelId: string): void {
  if (channel.id !== channelId || !channel.private || channel.archived || !channel.member) {
    throw new PrivateChannelSetupError('unavailable');
  }
}

function requireInstallation(
  installation: WorkspaceInstallation | undefined,
  workspaceId: string,
): WorkspaceInstallation {
  if (!installation || installation.workspaceId !== workspaceId ||
      installation.health === 'revoked') {
    throw new PrivateChannelSetupError('unavailable');
  }
  return installation;
}

function eligibleAgent(
  principal: AuthPrincipal,
  agent: CustomAgentConfig,
  grant: AgentChannelGrant | undefined,
): boolean {
  return agent.kind === 'user' && (agent.enabled || agent.lifecycle === 'draft') &&
    agent.lifecycle !== 'archived' &&
    canEditAgent(principal, agent) && grant?.status !== 'active';
}

function agentSnapshot(
  agent: CustomAgentConfig,
  grant: AgentChannelGrant | undefined,
): PrivateChannelSetupAgentSnapshot {
  return {
    agentId: agent.id,
    name: agent.name,
    handle: agent.slackPresence?.normalizedHandle ||
      agent.slackPresence?.requestedHandle || agent.name,
    agentRevision: agent.revision,
    grantRevision: grant?.revision ?? 0,
  };
}

function installationSnapshot(
  installation: WorkspaceInstallation,
): PrivateChannelSetupInstallationSnapshot {
  return {
    revision: installation.revision,
    transportMode: installation.transportMode,
    ...(installation.teamId ? { teamId: installation.teamId } : {}),
    ...(installation.appId ? { appId: installation.appId } : {}),
    ...(installation.botUserId ? { botUserId: installation.botUserId } : {}),
    ...(installation.gatewayBindingId
      ? { gatewayBindingId: installation.gatewayBindingId }
      : {}),
  };
}

function assertInstallationSnapshot(
  expected: PrivateChannelSetupInstallationSnapshot,
  actual: WorkspaceInstallation,
): void {
  const current = installationSnapshot(actual);
  for (const key of [
    'revision',
    'transportMode',
    'teamId',
    'appId',
    'botUserId',
    'gatewayBindingId',
  ] as const) {
    if (expected[key] !== current[key]) throw new PrivateChannelSetupError('stale');
  }
}

function assertInputBinding(
  intent: PrivateChannelSetupIntent,
  input: AddPrivateChannelAgentInput,
  principal: AuthPrincipal,
): void {
  if (intent.workspaceId !== input.workspaceId || intent.channelId !== input.channelId ||
      intent.inviterSlackUserId !== input.inviterSlackUserId ||
      intent.organizationId !== principal.organizationId ||
      intent.actorUserId !== principal.userId ||
      intent.actorMembershipId !== principal.membershipId) {
    throw new PrivateChannelSetupError('unavailable');
  }
  if (!intent.eligibleAgents.some(({ agentId }) => agentId === input.agentId) ||
      (intent.selectedAgentId && intent.selectedAgentId !== input.agentId)) {
    throw new PrivateChannelSetupError('unavailable');
  }
}

function assertActorBinding(
  intent: PrivateChannelSetupIntent,
  principal: AuthPrincipal,
): void {
  if (intent.organizationId !== principal.organizationId ||
      intent.actorUserId !== principal.userId ||
      intent.actorMembershipId !== principal.membershipId) {
    throw new PrivateChannelSetupError('unavailable');
  }
}

function publishedPresenceActive(agent: CustomAgentConfig): boolean {
  const presence = agent.slackPresence;
  return agent.enabled && agent.lifecycle !== 'archived' &&
    presence?.desiredState === 'active' && presence.health === 'healthy' &&
    Boolean(presence.userGroupId) && Boolean(presence.normalizedHandle);
}

function publicationResult(agent: CustomAgentConfig): { agentId: string; handle: string } {
  if (!publishedPresenceActive(agent)) throw new Error('Agent publication did not become active.');
  return { agentId: agent.id, handle: agent.slackPresence!.normalizedHandle };
}

function recoveryResult(): Extract<AddPrivateChannelAgentResult, { kind: 'recovery_required' }> {
  return {
    kind: 'recovery_required',
    message: 'Open Admin and retry this Agent’s pending Channel publication.',
  };
}

function translateStoreError(error: unknown): PrivateChannelSetupError {
  if (error instanceof ManagementError && error.code === 'setup_expired') {
    return new PrivateChannelSetupError('expired');
  }
  if (error instanceof PrivateChannelSetupError) return error;
  return new PrivateChannelSetupError('unavailable');
}
