import { createHash, randomUUID } from 'node:crypto';

import { getConfigStore, getIdentityStore, type PlatformEnv } from '../config/state-backend.ts';
import { resolveModelPolicyForAssignment } from '../config/model-policy.ts';
import type { ConfigStore } from '../config/store.ts';
import type {
  AgentScheduleReference,
  CustomAgentConfig,
  ResolvedAssignment,
} from '../config/types.ts';
import {
  projectEffectiveConnectionAccounts,
  projectRecoverableConnectionAccounts,
  resolveEffectiveConnectionAccounts,
} from '../connections/runtime.ts';
import type { EffectiveConnectionAccount } from '../connections/types.ts';
import type { IdentityStore } from '../identity/types.ts';
import { routineDestinationBindingDigest } from './ids.ts';
import type { RoutineDefinition } from './types.ts';

type RoutineAuthorityFailure =
  | 'schedule_authority_missing'
  | 'agent_unavailable'
  | 'destination_unavailable'
  | 'creator_ineligible'
  | 'connection_unavailable';

export class RoutineAuthorityError extends Error {
  constructor(
    readonly reason: RoutineAuthorityFailure,
    message: string,
  ) {
    super(message);
    this.name = 'RoutineAuthorityError';
  }
}

export interface ResolvedRoutineAuthority {
  reference: AgentScheduleReference;
  agent: CustomAgentConfig;
  assignment: ResolvedAssignment & { model: string; modelAttribution: NonNullable<ResolvedAssignment['modelAttribution']> };
  actorSlackUserId: string;
  effectiveConnections: EffectiveConnectionAccount[];
}

/** Bind a saved schedule to the Agent and canonical member that created it. */
export async function bindRoutineAgentAuthority(input: {
  routine: RoutineDefinition;
  assignment: ResolvedAssignment;
  actorMembershipId: string;
  env: PlatformEnv | undefined;
  authorityReceiptId?: string;
}, dependencies: { config?: ConfigStore; identity?: IdentityStore } = {}): Promise<AgentScheduleReference> {
  if (
    input.routine.workspaceId !== input.assignment.workspaceId ||
    input.routine.channelId !== input.assignment.channelId
  ) {
    throw new RoutineAuthorityError('destination_unavailable', 'Schedule destination does not match the admitted Agent.');
  }
  const config = dependencies.config ?? getConfigStore(input.env);
  const identity = dependencies.identity ?? getIdentityStore(input.env);
  const directDestination = input.routine.destination.kind === 'direct_thread'
    ? input.routine.destination
    : undefined;
  const direct = directDestination !== undefined;
  if (
    directDestination && (
      input.routine.channelId !== directDestination.conversationId ||
      input.actorMembershipId !== directDestination.ownerMembershipId
    )
  ) {
    throw new RoutineAuthorityError(
      'creator_ineligible',
      'A direct schedule stays bound to the member who owns its destination.',
    );
  }
  await requireActiveMembership(identity, input.actorMembershipId, input.routine.workspaceId);
  if (direct) {
    const agent = await config.getAgent(input.assignment.agentId).catch(() => undefined);
    if (
      !agent || !isActiveUserAgent(agent) ||
      !isActiveUserAgent(input.assignment.agent) ||
      agent.id !== input.assignment.agent.id
    ) {
      throw new RoutineAuthorityError(
        'agent_unavailable',
        'Direct schedules require an active user Agent.',
      );
    }
  } else {
    const grants = await config.listAgentChannelGrants(input.routine.workspaceId, input.routine.channelId);
    if (!grants.some((grant) =>
      grant.agentId === input.assignment.agentId && grant.status === 'active'
    )) {
      throw new RoutineAuthorityError(
        'destination_unavailable',
        'The Agent no longer has access to the schedule destination.',
      );
    }
  }
  const current = await config.getAgentScheduleReference(input.routine.id);
  if (current && current.agentId !== input.assignment.agentId) {
    throw new RoutineAuthorityError('agent_unavailable', 'A schedule cannot silently move to another Agent.');
  }
  if (current && current.runsAsMembershipId !== input.actorMembershipId) {
    throw new RoutineAuthorityError(
      'creator_ineligible',
      'Only the Runs as member can edit this schedule until its authority is explicitly reassigned.',
    );
  }
  const destinationBindingDigest = direct
    ? routineDestinationBindingDigest(
        input.routine.id,
        input.routine.workspaceId,
        directDestination!,
      )
    : null;
  if (current && (
    current.destinationKind !== input.routine.destination.kind ||
    current.destinationBindingDigest !== destinationBindingDigest ||
    (directDestination && (
      current.createdByMembershipId !== directDestination.ownerMembershipId ||
      current.runsAsMembershipId !== directDestination.ownerMembershipId
    ))
  )) {
    throw new RoutineAuthorityError(
      'destination_unavailable',
      'The saved schedule authority no longer matches its destination.',
    );
  }
  const runsAsMembershipId = current?.runsAsMembershipId ?? input.actorMembershipId;
  const [accounts, bindings] = await Promise.all([
    config.listConnectionAccounts(input.routine.workspaceId),
    config.listAgentConnectionBindings(input.assignment.agentId),
  ]);
  const effectiveConnections = projectEffectiveConnectionAccounts(
    accounts,
    bindings,
    runsAsMembershipId,
  );
  const recoverableConnectionAccountIds = new Set(
    projectRecoverableConnectionAccounts(accounts, bindings, runsAsMembershipId)
      .map(({ account }) => account.id),
  );
  const connectionPauseAccountIds = (current?.connectionPauseAccountIds ?? [])
    .filter((accountId) => recoverableConnectionAccountIds.has(accountId));
  const requiredConnectionAccountIds = new Set(
    effectiveConnections.map(({ account }) => account.id),
  );
  if (connectionPauseAccountIds.length > 0) {
    for (const accountId of current?.requiredConnectionAccountIds ?? []) {
      if (recoverableConnectionAccountIds.has(accountId)) requiredConnectionAccountIds.add(accountId);
    }
  }
  return config.putAgentScheduleReference({
    scheduleId: input.routine.id,
    agentId: input.assignment.agentId,
    workspaceId: input.routine.workspaceId,
    channelId: input.routine.channelId,
    destinationKind: input.routine.destination.kind,
    destinationBindingDigest,
    createdByMembershipId: current?.createdByMembershipId ?? input.actorMembershipId,
    runsAsMembershipId,
    authorityReceiptId: current?.authorityReceiptId ?? input.authorityReceiptId ?? authorityReceiptId(
      input.routine.id,
      input.actorMembershipId,
    ),
    requiredConnectionAccountIds: [...requiredConnectionAccountIds],
    ...(connectionPauseAccountIds.length > 0 ? { connectionPauseAccountIds } : {}),
    ...(connectionPauseAccountIds.length > 0 && current?.connectionPausePreservesState
      ? { connectionPausePreservesState: true }
      : {}),
    state: current?.state === 'archived'
      ? 'archived'
      : connectionPauseAccountIds.length > 0 ? 'needs_attention' : 'active',
  }, current?.revision ?? 0);
}

/** Reassignment is the only operation allowed to change a schedule's Runs as actor. */
export async function reassignRoutineAgentAuthority(input: {
  scheduleId: string;
  runsAsMembershipId: string;
  receiptId?: string;
  config: ConfigStore;
  identity: IdentityStore;
}): Promise<AgentScheduleReference> {
  const current = await input.config.getAgentScheduleReference(input.scheduleId);
  if (!current) {
    throw new RoutineAuthorityError('schedule_authority_missing', 'Schedule authority is unavailable.');
  }
  if (current.destinationKind === 'direct_thread') {
    throw new RoutineAuthorityError(
      'creator_ineligible',
      'A direct schedule cannot move to another Runs as member.',
    );
  }
  const agent = await input.config.getAgent(current.agentId);
  if (agent.lifecycle === 'archived') {
    throw new RoutineAuthorityError(
      'agent_unavailable',
      'Restore the Agent before changing its Runs as authority.',
    );
  }
  await requireActiveMembership(input.identity, input.runsAsMembershipId, current.workspaceId);
  const [accounts, bindings] = await Promise.all([
    input.config.listConnectionAccounts(current.workspaceId),
    input.config.listAgentConnectionBindings(current.agentId),
  ]);
  const recoverableConnections = projectRecoverableConnectionAccounts(
    accounts,
    bindings,
    input.runsAsMembershipId,
  );
  const currentRecoverableConnections = projectRecoverableConnectionAccounts(
    accounts,
    bindings,
    current.runsAsMembershipId,
  );
  const currentRequiredAccountIds = new Set([
    ...current.requiredConnectionAccountIds,
    ...(current.connectionPauseAccountIds ?? []),
  ]);
  const previouslyRequiredBindingAccountIds = new Set(
    currentRecoverableConnections
      .filter(({ account }) => currentRequiredAccountIds.has(account.id))
      .map(({ binding }) => binding.connectionAccountId),
  );
  const requiredConnections = recoverableConnections.filter(({ account, binding }) =>
    account.lifecycle === 'ready' ||
    previouslyRequiredBindingAccountIds.has(binding.connectionAccountId)
  );
  const connectionPauseAccountIds = requiredConnections
    .filter(({ account }) => account.lifecycle !== 'ready')
    .map(({ account }) => account.id);
  const connectionPausePreservesState = connectionPauseAccountIds.length > 0 && (
    current.connectionPausePreservesState === true ||
    (current.connectionPauseAccountIds?.length ?? 0) === 0 && current.state !== 'active'
  );
  const {
    connectionPauseAccountIds: _connectionPauseAccountIds,
    connectionPausePreservesState: _connectionPausePreservesState,
    ...currentWithoutPause
  } = current;
  return input.config.putAgentScheduleReference({
    ...currentWithoutPause,
    runsAsMembershipId: input.runsAsMembershipId,
    authorityReceiptId: input.receiptId ?? `schedule_authority_${randomUUID().replaceAll('-', '')}`,
    requiredConnectionAccountIds: requiredConnections.map(({ account }) => account.id),
    ...(connectionPauseAccountIds.length > 0 ? { connectionPauseAccountIds } : {}),
    ...(connectionPausePreservesState ? { connectionPausePreservesState: true } : {}),
    state: current.state === 'archived'
      ? 'archived'
      : connectionPauseAccountIds.length > 0 ? 'needs_attention' : 'active',
  }, current.revision);
}

/** Chickpea-only ownership change for a direct schedule; the private destination stays immutable. */
export async function reassignDirectRoutineAgent(input: {
  scheduleId: string;
  agentId: string;
  ownerMembershipId: string;
  receiptId?: string;
  config: ConfigStore;
  identity: IdentityStore;
}): Promise<AgentScheduleReference> {
  const current = await input.config.getAgentScheduleReference(input.scheduleId);
  if (!current || current.destinationKind !== 'direct_thread' ||
      current.createdByMembershipId !== input.ownerMembershipId ||
      current.runsAsMembershipId !== input.ownerMembershipId) {
    throw new RoutineAuthorityError('schedule_authority_missing', 'Direct schedule authority is unavailable.');
  }
  await requireActiveMembership(input.identity, input.ownerMembershipId, current.workspaceId);
  const agent = await input.config.getAgent(input.agentId).catch(() => undefined);
  if (!agent || !isActiveUserAgent(agent)) {
    throw new RoutineAuthorityError('agent_unavailable', 'The replacement user Agent is unavailable.');
  }
  const [accounts, bindings] = await Promise.all([
    input.config.listConnectionAccounts(current.workspaceId),
    input.config.listAgentConnectionBindings(agent.id),
  ]);
  const recoverable = projectRecoverableConnectionAccounts(
    accounts,
    bindings,
    input.ownerMembershipId,
  );
  const requiredConnectionAccountIds = recoverable
    .filter(({ account }) => account.lifecycle === 'ready')
    .map(({ account }) => account.id);
  const connectionPauseAccountIds = recoverable
    .filter(({ account }) => account.lifecycle !== 'ready')
    .map(({ account }) => account.id);
  const {
    connectionPauseAccountIds: _connectionPauseAccountIds,
    connectionPausePreservesState: _connectionPausePreservesState,
    ...stable
  } = current;
  return input.config.putAgentScheduleReference({
    ...stable,
    agentId: agent.id,
    authorityReceiptId: input.receiptId ?? `schedule_authority_${randomUUID().replaceAll('-', '')}`,
    requiredConnectionAccountIds,
    ...(connectionPauseAccountIds.length > 0 ? { connectionPauseAccountIds } : {}),
    state: current.state === 'archived'
      ? 'archived'
      : connectionPauseAccountIds.length > 0 ? 'needs_attention' : 'active',
  }, current.revision);
}

/** Re-read every authority input immediately before an unattended run. */
export async function resolveRoutineAgentAuthority(
  routine: RoutineDefinition,
  env: PlatformEnv | undefined,
  dependencies: { config?: ConfigStore; identity?: IdentityStore } = {},
): Promise<ResolvedRoutineAuthority> {
  const config = dependencies.config ?? getConfigStore(env);
  const identity = dependencies.identity ?? getIdentityStore(env);
  const reference = await config.getAgentScheduleReference(routine.id);
  if (!reference || reference.state !== 'active') {
    throw new RoutineAuthorityError('schedule_authority_missing', 'This schedule needs an active Runs as assignment.');
  }
  if (
    reference.workspaceId !== routine.workspaceId ||
    reference.channelId !== routine.channelId
  ) {
    throw new RoutineAuthorityError('destination_unavailable', 'The schedule destination changed.');
  }
  const directDestination = routine.destination.kind === 'direct_thread'
    ? routine.destination
    : undefined;
  const direct = directDestination !== undefined;
  const destinationBindingDigest = direct
    ? routineDestinationBindingDigest(routine.id, routine.workspaceId, directDestination!)
    : null;
  if (
    reference.destinationKind !== routine.destination.kind ||
    reference.destinationBindingDigest !== destinationBindingDigest ||
    (directDestination && (
      routine.channelId !== directDestination.conversationId ||
      reference.createdByMembershipId !== directDestination.ownerMembershipId ||
      reference.runsAsMembershipId !== directDestination.ownerMembershipId
    ))
  ) {
    throw new RoutineAuthorityError('destination_unavailable', 'The schedule destination changed.');
  }
  const agent = await config.getAgent(reference.agentId).catch(() => undefined);
  if (!agent || !agent.enabled || agent.lifecycle === 'archived' || (direct && !isActiveUserAgent(agent))) {
    throw new RoutineAuthorityError('agent_unavailable', 'The schedule Agent is unavailable.');
  }
  if (!direct) {
    const grants = await config.listAgentChannelGrants(reference.workspaceId, reference.channelId);
    if (!grants.some((grant) => grant.agentId === reference.agentId && grant.status === 'active')) {
      throw new RoutineAuthorityError('destination_unavailable', 'The Agent no longer has access to the destination Channel.');
    }
  }
  const actorSlackUserId = await requireActiveMembership(
    identity,
    reference.runsAsMembershipId,
    reference.workspaceId,
  );
  const effectiveConnections = await resolveEffectiveConnectionAccounts({
    config,
    workspaceId: reference.workspaceId,
    agentId: reference.agentId,
    actorMembershipId: reference.runsAsMembershipId,
  });
  const available = new Set(effectiveConnections.map(({ account }) => account.id));
  if (reference.requiredConnectionAccountIds.some((id) => !available.has(id))) {
    throw new RoutineAuthorityError('connection_unavailable', 'A required connection is no longer available to the Runs as member.');
  }
  const assignment = await resolveModelPolicyForAssignment({
    workspaceId: reference.workspaceId,
    channelId: reference.channelId,
    agentId: agent.id,
    agent,
  }, config);
  return { reference, agent, assignment, actorSlackUserId, effectiveConnections };
}

export async function markRoutineAuthorityNeedsAttention(
  routineId: string,
  env: PlatformEnv | undefined,
): Promise<void> {
  const config = getConfigStore(env);
  const current = await config.getAgentScheduleReference(routineId);
  if (!current || current.state !== 'active') return;
  await config.putAgentScheduleReference({ ...current, state: 'needs_attention' }, current.revision);
}

/** Revalidate the exact Slack-bound product member before Routine control. */
export async function isActiveRoutineActor(input: {
  actorMembershipId: string;
  workspaceId: string;
  slackUserId: string;
  env: PlatformEnv | undefined;
}, dependencies: { identity?: IdentityStore } = {}): Promise<boolean> {
  try {
    return await requireActiveMembership(
      dependencies.identity ?? getIdentityStore(input.env),
      input.actorMembershipId,
      input.workspaceId,
    ) === input.slackUserId;
  } catch {
    return false;
  }
}

async function requireActiveMembership(
  identity: IdentityStore,
  membershipId: string,
  workspaceId: string,
): Promise<string> {
  const [organization, membership, overlay] = await Promise.all([
    identity.getOrganization(),
    identity.getMembership(membershipId),
    identity.getMembershipAccessOverlay(membershipId),
  ]);
  if (
    !organization || organization.slackTeamId !== workspaceId ||
    !membership || membership.organizationId !== organization.id || membership.status !== 'active' ||
    (overlay && (
      overlay.organizationId !== organization.id || overlay.accessStatus !== 'active'
    ))
  ) {
    throw new RoutineAuthorityError('creator_ineligible', 'The schedule Runs as member is no longer active.');
  }
  const user = await identity.getUser(membership.userId);
  if (!user || user.slackTeamId !== workspaceId) {
    throw new RoutineAuthorityError('creator_ineligible', 'The schedule Runs as member is no longer active.');
  }
  const resolution = await identity.resolveSlackIdentity(
    workspaceId,
    user.slackUserId,
    organization.id,
  );
  if (
    !resolution ||
    resolution.user.id !== membership.userId ||
    resolution.membership.id !== membershipId ||
    resolution.binding.membershipId !== membershipId
  ) {
    throw new RoutineAuthorityError('creator_ineligible', 'The schedule Runs as member is no longer active.');
  }
  return user.slackUserId;
}

function authorityReceiptId(scheduleId: string, membershipId: string): string {
  return `schedule_authority_${createHash('sha256')
    .update(`${scheduleId}\0${membershipId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function isActiveUserAgent(agent: CustomAgentConfig): boolean {
  return agent.kind === 'user' && agent.enabled && agent.lifecycle !== 'draft' && agent.lifecycle !== 'archived';
}
