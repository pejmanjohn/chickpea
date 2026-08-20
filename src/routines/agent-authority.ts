import { createHash, randomUUID } from 'node:crypto';

import { getConfigStore, getIdentityStore, type PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type {
  AgentScheduleReference,
  CustomAgentConfig,
  ResolvedAssignment,
} from '../config/types.ts';
import { resolveEffectiveConnectionAccounts } from '../connections/runtime.ts';
import type { EffectiveConnectionAccount } from '../connections/types.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { RoutineDefinition } from './types.ts';

export type RoutineAuthorityFailure =
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
  await requireActiveMembership(identity, input.actorMembershipId, input.routine.workspaceId);
  const grants = await config.listAgentChannelGrants(input.routine.workspaceId, input.routine.channelId);
  if (!grants.some((grant) =>
    grant.agentId === input.assignment.agentId && grant.status === 'active'
  )) {
    throw new RoutineAuthorityError(
      'destination_unavailable',
      'The Agent no longer has access to the schedule destination.',
    );
  }
  const current = await config.getAgentScheduleReference(input.routine.id);
  if (current && current.agentId !== input.assignment.agentId) {
    throw new RoutineAuthorityError('agent_unavailable', 'A schedule cannot silently move to another Agent.');
  }
  const runsAsMembershipId = current?.runsAsMembershipId ?? input.actorMembershipId;
  const effectiveConnections = await resolveEffectiveConnectionAccounts({
    config,
    workspaceId: input.routine.workspaceId,
    agentId: input.assignment.agentId,
    actorMembershipId: runsAsMembershipId,
  });
  return config.putAgentScheduleReference({
    scheduleId: input.routine.id,
    agentId: input.assignment.agentId,
    workspaceId: input.routine.workspaceId,
    channelId: input.routine.channelId,
    createdByMembershipId: current?.createdByMembershipId ?? input.actorMembershipId,
    runsAsMembershipId,
    authorityReceiptId: current?.authorityReceiptId ?? input.authorityReceiptId ?? authorityReceiptId(
      input.routine.id,
      input.actorMembershipId,
    ),
    requiredConnectionAccountIds: effectiveConnections.map(({ account }) => account.id),
    state: current?.state === 'archived' ? 'archived' : 'active',
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
  await requireActiveMembership(input.identity, input.runsAsMembershipId, current.workspaceId);
  const effectiveConnections = await resolveEffectiveConnectionAccounts({
    config: input.config,
    workspaceId: current.workspaceId,
    agentId: current.agentId,
    actorMembershipId: input.runsAsMembershipId,
  });
  return input.config.putAgentScheduleReference({
    ...current,
    runsAsMembershipId: input.runsAsMembershipId,
    authorityReceiptId: input.receiptId ?? `schedule_authority_${randomUUID().replaceAll('-', '')}`,
    requiredConnectionAccountIds: effectiveConnections.map(({ account }) => account.id),
    state: 'active',
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
  const agent = await config.getAgent(reference.agentId).catch(() => undefined);
  if (!agent || !agent.enabled || agent.lifecycle === 'archived') {
    throw new RoutineAuthorityError('agent_unavailable', 'The schedule Agent is unavailable.');
  }
  const grants = await config.listAgentChannelGrants(reference.workspaceId, reference.channelId);
  if (!grants.some((grant) => grant.agentId === reference.agentId && grant.status === 'active')) {
    throw new RoutineAuthorityError('destination_unavailable', 'The Agent no longer has access to the destination Channel.');
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
  return { reference, agent, actorSlackUserId, effectiveConnections };
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

async function requireActiveMembership(
  identity: IdentityStore,
  membershipId: string,
  workspaceId: string,
): Promise<string> {
  const [organization, membership, overlay, bindings] = await Promise.all([
    identity.getOrganization(),
    identity.getMembership(membershipId),
    identity.getMembershipAccessOverlay(membershipId),
    identity.listExternalIdentities(),
  ]);
  const binding = bindings.find((candidate) =>
    candidate.membershipId === membershipId && candidate.slackTeamId === workspaceId
  );
  const user = binding ? await identity.getUser(binding.userId) : undefined;
  if (
    !organization || organization.slackTeamId !== workspaceId ||
    !membership || membership.organizationId !== organization.id || membership.status !== 'active' ||
    !binding || binding.organizationId !== organization.id ||
    !user || user.slackTeamId !== workspaceId || user.slackUserId !== binding.slackUserId ||
    (overlay && (
      overlay.organizationId !== organization.id || overlay.accessStatus !== 'active'
    ))
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
