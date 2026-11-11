import {
  compileAgentRunPlan,
  resolveAgentRunPlan,
  type AgentRunPlanParts,
} from '../../agents/run-plan-resolution.ts';
import type { RuntimePlanV2 } from '../../agents/runtime-plan.ts';
import { slackTenantInstructions } from '../../agents/shared-prefix-layout.ts';
import { CHICKPEA_AGENT_ID } from '../../config/agent-id.ts';
import { ModelResolutionError } from '../../config/errors.ts';
import { resolveModelCredentialAttribution } from '../../config/model-credential-refs.ts';
import { resolveModelPolicyForAssignment } from '../../config/model-policy.ts';
import type { ModelUnavailable } from '../../config/model-readiness.ts';
import { isProviderKeyId, PROVIDER_DISPLAY_NAMES } from '../../config/provider-key-ids.ts';
import {
  agentAppIsLive,
  type AgentChannelGrant,
  type CustomAgentConfig,
  type ResolvedAssignment,
  type WorkspaceInstallation,
} from '../../config/types.ts';
import type { MembershipStatus } from '../../identity/types.ts';
import type { WorkspaceManagementService, WorkspaceManagementServiceInput } from '../service.ts';
import {
  ManagementError,
  type LiveManagementActor,
  type ManagementActorContext,
  type ManagementWorkspaceSnapshot,
} from '../types.ts';
import { fail } from './conventions.ts';
import { agentNotFound, requireAgent, type FiveZeroDeps } from './reads.ts';

/**
 * One Agent, one place and one person, read the way a Slack turn admits them
 * (U4's resolveAgentRunPlan), for explain_agent and check_agent. Reads only:
 * the model route is never bound and no credential use is registered. The
 * first credential read on a standalone deployment may materialize the
 * provider's credential metadata, as any turn does
 * (ensureStoredCredentialMetadata: once per provider, idempotent).
 */

type SnapshotAgent = ManagementWorkspaceSnapshot['agents'][number];
export type AgentRunStores = WorkspaceManagementServiceInput;

export interface AgentRunInput {
  agentId: string;
  place?: string | undefined;
  asPerson?: string | undefined;
}

export type AgentRunPlace =
  | { kind: 'dm' }
  | { kind: 'channel'; channelId: string; name?: string };

export interface AgentRunPerson {
  membershipId: string;
  slackUserId?: string;
  name?: string;
  you: boolean;
  status: MembershipStatus;
}

/** What admission and the model check read: one Agent, one person, one place. */
export interface AgentAdmissionReading {
  context: ManagementActorContext;
  actor: LiveManagementActor;
  agent: CustomAgentConfig;
  /** The Agent as the snapshot projects it, as far as these checks read it. */
  snapshotAgent: Pick<SnapshotAgent, 'ownSlackApp'> & {
    effectiveModels: Pick<SnapshotAgent['effectiveModels'], 'model' | 'modelSource' | 'effort'>;
    slackPresence?: Pick<NonNullable<SnapshotAgent['slackPresence']>, 'normalizedHandle'>;
  };
  /** The Channels the caller may see; only a Channel place reads them. */
  snapshot: Pick<ManagementWorkspaceSnapshot, 'channels'>;
  stores: AgentRunStores;
  /** The Slack team the Agent answers in. */
  workspaceId: string;
  installation: WorkspaceInstallation | undefined;
  /**
   * Every Agent's grants in this workspace, including ones in Channels a
   * member may not see: name a grant's Channel only when seesChannel allows.
   */
  grants: readonly AgentChannelGrant[];
  person: AgentRunPerson;
  place: AgentRunPlace;
}

export interface AgentRunReading extends AgentAdmissionReading {
  snapshot: ManagementWorkspaceSnapshot;
  snapshotAgent: SnapshotAgent;
}

/** The caller's authority over the Agent, then whose run in which place. */
export async function readAgentRun(deps: FiveZeroDeps, input: AgentRunInput): Promise<AgentRunReading> {
  const context = await deps.context();
  const { actor, agent, stores } = await managedAgent(deps.service, context, input.agentId);
  const snapshot = await deps.service.inspectWorkspace(context);
  const snapshotAgent = requireAgent(snapshot, input.agentId);
  const workspaceId = snapshot.slackTeamId ?? notConnected();
  const [installation, grants, person] = await Promise.all([
    stores.config.getWorkspaceInstallation(workspaceId),
    stores.config.listAgentChannelGrants(workspaceId),
    personFor(actor, snapshot, stores, input.asPerson),
  ]);
  return {
    context,
    actor,
    agent,
    snapshot,
    snapshotAgent,
    stores,
    workspaceId,
    installation,
    grants,
    person,
    place: placeFor(snapshot, input),
  };
}

/**
 * The Agent for the caller in a direct message, read alone. practice_agent
 * admits a run on it, so it never takes the workspace snapshot, whose reads
 * grow with every Agent and member. It refuses the Agents the snapshot would
 * not list: one the caller cannot edit, Chickpea's own, and any other than
 * the one an Agent acting for itself may see.
 */
export async function readAgentInCallerDm(deps: FiveZeroDeps, agentId: string): Promise<AgentAdmissionReading> {
  const context = await deps.context();
  const { actor, agent, stores } = await managedAgent(deps.service, context, agentId);
  const acting = actor.actingAgentId;
  if (agent.kind !== 'user' || (acting && acting !== CHICKPEA_AGENT_ID && acting !== agentId)) agentNotFound();
  const [organization, user] = await Promise.all([
    stores.identity.getOrganization(),
    stores.identity.getUser(actor.userId),
  ]);
  const workspaceId = organization?.slackTeamId ?? notConnected();
  const [installation, grants] = await Promise.all([
    stores.config.getWorkspaceInstallation(workspaceId),
    stores.config.listAgentChannelGrants(workspaceId),
  ]);
  const name = user?.displayName?.trim() || undefined;
  return {
    context,
    actor,
    agent,
    // As the snapshot projects them; Admin's Workspace chat model fills in at resolution.
    snapshotAgent: {
      effectiveModels: {
        model: agent.model ?? null,
        modelSource: agent.model ? 'pinned' : 'workspace_default',
        effort: (agent.model ? agent.modelEffort : undefined) ?? null,
      },
      ...(agent.slackPresence ? { slackPresence: { normalizedHandle: agent.slackPresence.normalizedHandle } } : {}),
      ...(agentAppIsLive(agent.slackPresence) ? { ownSlackApp: { handle: agent.slackPresence.normalizedHandle } } : {}),
    },
    // A direct message reads no Channel.
    snapshot: { channels: [] },
    stores,
    workspaceId,
    installation,
    grants,
    person: {
      membershipId: actor.membershipId,
      ...(user?.slackUserId ? { slackUserId: user.slackUserId } : {}),
      ...(name ? { name } : {}),
      you: true,
      status: 'active',
    },
    place: { kind: 'dm' },
  };
}

function notConnected(): never {
  return fail('invalid_input', 'Chickpea is not connected to a Slack workspace yet.', {
    nextStep: 'Tell the person to finish connecting Slack in Admin.',
  });
}

/**
 * Whether the caller may see a Channel: an Owner or Admin sees every one, a
 * member only those the snapshot shows them, as Admin's Agent page does. An
 * unseen Channel reads as one the Agent is not in.
 */
export function seesChannel(reading: Pick<AgentAdmissionReading, 'actor' | 'snapshot'>, channelId: string): boolean {
  return reading.actor.role !== 'member' || reading.snapshot.channels.some((channel) => channel.channelId === channelId);
}

async function managedAgent(service: WorkspaceManagementService, context: ManagementActorContext, agentId: string) {
  try {
    return await service.agentReader(context, agentId);
  } catch (error) {
    // As get_agent: an Agent the caller may not edit reads as missing.
    if (error instanceof ManagementError && error.code === 'forbidden') {
      agentNotFound();
    }
    throw error;
  }
}

/** The caller, or for an Owner or Admin any member, by Slack user ID. */
async function personFor(
  actor: LiveManagementActor,
  snapshot: ManagementWorkspaceSnapshot,
  stores: AgentRunStores,
  asPerson: string | undefined,
): Promise<AgentRunPerson> {
  const callerName = snapshot.caller.displayName?.trim() || undefined;
  const callerSlackUserId = (await stores.identity.getUser(actor.userId))?.slackUserId ?? undefined;
  const caller: AgentRunPerson = {
    membershipId: actor.membershipId,
    ...(callerSlackUserId ? { slackUserId: callerSlackUserId } : {}),
    ...(callerName ? { name: callerName } : {}),
    you: true,
    status: 'active',
  };
  if (!asPerson || asPerson === callerSlackUserId) return caller;
  if (actor.role === 'member') {
    fail('not_allowed', 'Only an Owner or Admin can look at an Agent as another person.', {
      nextStep: 'Omit asPerson to look at it as yourself.',
    });
  }
  const member = snapshot.team?.members.find(({ slackUserId }) => slackUserId === asPerson);
  if (!member) {
    fail('not_found', 'That person isn\'t in this workspace.', {
      nextStep: 'Call list_members for the slackUserIds.',
    });
  }
  const name = member.displayName?.trim() || undefined;
  return {
    membershipId: member.id,
    slackUserId: asPerson,
    ...(name ? { name } : {}),
    you: member.id === actor.membershipId,
    status: member.status,
  };
}

/** A Channel's name comes from the snapshot only, which holds back the private ones Admin hides from a member. */
function placeFor(snapshot: ManagementWorkspaceSnapshot, input: AgentRunInput): AgentRunPlace {
  if (!input.place || input.place === 'dm') return { kind: 'dm' };
  const channelId = input.place;
  const name = snapshot.channels.find((candidate) => candidate.channelId === channelId)?.label;
  return { kind: 'channel', channelId, ...(name ? { name } : {}) };
}

export interface AgentRunModel {
  model: string | null;
  source: 'pinned' | 'workspace_default';
  effort: string | null;
  canRun: boolean;
  why?: string;
  /** Why it cannot run: no model resolves, or Admin's readiness answer. */
  unavailable?: 'unresolved' | ModelUnavailable['unavailable'];
}

export interface AgentRun {
  model: AgentRunModel;
  /** Absent when the Agent's model cannot be resolved at all. */
  assignment?: ResolvedAssignment & { model: string };
  parts?: AgentRunPlanParts;
  plan?: RuntimePlanV2;
}

/**
 * The model a message here would run on, resolved as ingress does: the
 * workspace's model policy, then Admin's readiness rule for whether it can
 * run now. Never binds a route or registers a credential use.
 */
export async function resolveAgentModel(reading: AgentAdmissionReading): Promise<Omit<AgentRun, 'parts' | 'plan'>> {
  const { stores, agent, snapshotAgent, workspaceId, installation } = reading;
  const pinned = snapshotAgent.effectiveModels;
  const model: AgentRunModel = {
    model: pinned.model,
    source: pinned.modelSource,
    effort: pinned.effort,
    canRun: true,
  };
  if (!stores.settings) {
    return { model: { ...model, canRun: false, unavailable: 'unresolved', why: 'This deployment cannot resolve models here.' } };
  }
  const { place } = reading;
  const channel = place.kind === 'channel'
    ? reading.snapshot.channels.find(({ channelId }) => channelId === place.channelId)
    : undefined;
  let assignment: ResolvedAssignment & { model: string };
  try {
    assignment = await resolveModelPolicyForAssignment({
      workspaceId,
      channelId: placeChannelId(place),
      agentId: agent.id,
      agent,
      ...(channel?.label ? { channelLabel: channel.label } : {}),
      ...(channel?.revision ? { channelRevision: channel.revision } : {}),
    }, {
      getWorkspaceInstallation: (id) => stores.config.getWorkspaceInstallation(id),
      getWorkspaceModelDefault: (id) => stores.config.getWorkspaceModelDefault(id),
    }, stores.settings, process.env, installation, stores.env);
  } catch (error) {
    if (error instanceof ModelResolutionError) {
      return { model: { ...model, canRun: false, unavailable: 'unresolved', why: error.message } };
    }
    throw error;
  }
  model.model = assignment.model;
  model.effort = assignment.effort ?? model.effort;
  const unavailable = stores.modelReadiness ? await (await stores.modelReadiness())(assignment.model) : undefined;
  if (unavailable) {
    Object.assign(model, { canRun: false, unavailable: unavailable.unavailable, why: unavailableText(unavailable, assignment.model) });
  }
  return { model, assignment };
}

/**
 * The plan a message from this person in this place would run with: the
 * model as above and its credential as ingress freezes it, then U4's parts
 * compiled for a conversation in the place. Admission is not applied here;
 * check_agent reports it.
 */
export async function resolveAgentRun(reading: AgentRunReading): Promise<AgentRun> {
  const { stores, workspaceId } = reading;
  const { model, assignment } = await resolveAgentModel(reading);
  if (!assignment || !stores.settings) return { model };
  const credential = await resolveModelCredentialAttribution(
    assignment.model, stores.env, stores.settings, undefined, { registerUsage: false },
  ).catch(() => null);
  const admitted = credential ? { ...assignment, modelCredential: credential } : assignment;
  const parts = await resolveAgentRunPlan({
    assignment: admitted,
    model: assignment.model,
    workspaceId,
    connections: { actorMembershipId: reading.person.membershipId, config: stores.config },
    env: stores.env,
    settings: stores.settings,
    roles: stores.config,
    // The route is never bound or refreshed here; readiness says whether it can run.
    resolveModel: async (_agentId, canonicalModel) => ({ model: canonicalModel }),
  });
  const plan = compileAgentRunPlan(parts, {
    turn: conversationFor(reading),
    instructions: slackTenantInstructions(admitted),
    memoryEpoch: 1,
  });
  return { model, assignment: admitted, parts, plan };
}

/** A DM has no channel until the person opens one; its ID names no real conversation. */
const DM_CHANNEL_ID = 'D00000000';
const SYNTHETIC_TS = '1000000000.000000';

function placeChannelId(place: AgentRunPlace): string {
  return place.kind === 'channel' ? place.channelId : DM_CHANNEL_ID;
}

/** One message from the person in the place, which the plan's conversation is compiled for. */
function conversationFor(reading: AgentRunReading) {
  return {
    workspaceId: reading.workspaceId,
    channelId: placeChannelId(reading.place),
    eventId: 'Ev_explain',
    text: '',
    userId: reading.person.slackUserId ?? 'U00000000',
    actorMembershipId: reading.person.membershipId,
    messageTs: SYNTHETIC_TS,
    threadTs: SYNTHETIC_TS,
    contextMode: 'thread' as const,
    ...(reading.place.kind === 'channel'
      ? { source: 'app_mention' as const }
      : { source: 'dm_message' as const, channelType: 'im' }),
  };
}

/** Who and where a result is about, as both tools return it: names only, no internal IDs. */
export function readingView(reading: AgentRunReading) {
  const { agent, place, person } = reading;
  const handle = reading.snapshotAgent.slackPresence?.normalizedHandle;
  return {
    agent: { agentId: agent.id, name: agent.name, ...(handle ? { handle } : {}) },
    place: place.kind === 'dm'
      ? { kind: 'dm' as const }
      : { kind: 'channel' as const, channelId: place.channelId, ...(place.name ? { name: place.name } : {}) },
    person: { ...(person.name ? { name: person.name } : {}), you: person.you },
  };
}

/** Why a model cannot run, as an Agent edit refuses it. */
export function unavailableText(answer: ModelUnavailable, model: string): string {
  if (answer.unavailable === 'model_unsupported') return answer.message;
  if (answer.unavailable === 'funding_not_offered') return 'It is not available on Chickpea\'s models.';
  const provider = model.split('/')[0]!;
  return `Its provider, ${isProviderKeyId(provider) ? PROVIDER_DISPLAY_NAMES[provider] : provider}, is not set up.`;
}
