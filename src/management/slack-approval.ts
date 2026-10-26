import type { ConfigStore } from '../config/store.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import { CONNECTION_CATALOG_PRESETS } from '../config/presets.ts';
import type { IdentityStore } from '../identity/types.ts';
import {
  handoffCreatedAgentThread,
  type CreatedAgentHandoffConfig,
} from '../slack/agent-routing.ts';
import { agentAvatarUrlForPresentation } from '../slack/agent-presence/avatar-assets.ts';
import { isLaterCoAddressedTurn, personRequestTextSource } from '../slack/agent-asks.ts';
import {
  shouldResolveSlackManagementApproval,
  type SlackManagementApproval,
} from '../slack/interaction-intent.ts';
import {
  escapeSlackControlCharacters,
  renderSlackMarkdownActionLink,
  slackActionLink,
} from '../slack/message-format.ts';
import { conversationThreadTs, slackConversationKind } from '../slack/thread-key.ts';
import type { SlackLatestAgentTurnQuery } from '../slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';
import type { ManagementStore } from './store.ts';
import { agentWelcomeInGroupDm } from './receipts.ts';
import { slackManagementOrigin, WorkspaceManagementService } from './service.ts';
import {
  resolveSlackManagementActor,
  type SlackManagementSignal,
} from './slack-tools.ts';
import {
  ManagementError,
  type ManagementAgentCreatedWelcome,
  type ManagementActorContext,
  type ManagementApplyResult,
  type ManagementChangeSetProposalRecord,
  type ManagementOperation,
  type ManagementReceiptOutboxRecord,
} from './types.ts';
import {
  managementActorOriginKey,
  managementApprovalScopeKey,
  managementResultFullyApplied,
} from './contracts.ts';

export interface SlackManagementApprovalDependencies {
  identity: Pick<IdentityStore, 'resolveSlackIdentity'>;
  config: Pick<ConfigStore, 'getAgent'> & CreatedAgentHandoffConfig;
  management: Pick<ManagementStore, 'putOutbox' | 'execute'> & {
    getChangeSetProposal?: ManagementStore['getChangeSetProposal'];
  };
  service: WorkspaceManagementService;
  publicUrl?: string;
  /** The installation Agent avatar URLs name (agentAvatarInstallation). */
  avatarInstallationId?: string;
}

export type HostSlackManagementApprovalResult =
  | { kind: 'message'; text: string }
  | { kind: 'agent_welcome_queued'; outboxId: string };

/**
 * One Slack approval, applied by the state owner. A thread runner holds no
 * management state, so it sends the approved turn across once and the state
 * store runs `executeHostSlackManagementApproval` against its local stores.
 * An approval is a non-idempotent write: callers never replay this request.
 */
export interface SlackManagementApprovalRpcRequest {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  turnJobId: string;
  proposalId: string;
  presentationRunId?: string;
  publicUrl?: string;
}

/** Applies one approval in the state owner (see SlackManagementApprovalRpcRequest). */
export type SlackManagementApprovalInvoke = (
  request: SlackManagementApprovalRpcRequest,
) => Promise<HostSlackManagementApprovalResult>;

export async function resolveHostSlackManagementApproval(input: {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  actorMembershipId: string;
  identity: Pick<IdentityStore, 'resolveSlackIdentity'>;
  management: Pick<ManagementStore, 'getActiveChangeSetProposal'>;
}): Promise<string | undefined> {
  return (await resolveHostSlackManagementProposal(input))?.proposalId;
}

/** The active proposal this requester could approve from this conversation. */
export async function resolveHostSlackManagementProposal(input: {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  actorMembershipId: string;
  identity: Pick<IdentityStore, 'resolveSlackIdentity'>;
  management: Pick<ManagementStore, 'getActiveChangeSetProposal'>;
}): Promise<ManagementChangeSetProposalRecord | undefined> {
  const signal = slackManagementSignal(input.turn, input.assignment, input.turn.eventId);
  let actor: ManagementActorContext;
  try {
    actor = await resolveSlackManagementActor(signal, input.identity);
  } catch (error) {
    if (error instanceof ManagementError && error.code === 'forbidden') return undefined;
    throw error;
  }
  if (actor.membershipId !== input.actorMembershipId) return undefined;
  const proposal = await input.management.getActiveChangeSetProposal({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorMembershipId: actor.membershipId,
    approvalScopeKey: managementApprovalScopeKey(actor),
  });
  if (!proposal) return undefined;
  const conversationKind = slackConversationKind(input.turn);
  const threadedDirectReply = (conversationKind === 'im' || conversationKind === 'mpim') &&
    input.turn.threadTs !== input.turn.messageTs;
  if (threadedDirectReply && proposal.originKey !== managementActorOriginKey(actor)) {
    return undefined;
  }
  return proposal;
}

/** What the person's typed message did to the change set waiting on them. */
export type TypedSlackManagementApproval =
  | { kind: 'approve'; proposalId: string }
  | { kind: 'decline'; proposalId: string };

/**
 * Reads the requester's own typed message against the change set waiting on
 * them in this conversation and Agent. The exact approval words approve it
 * as before. Other wording is judged only when the message answers the set:
 * the turn that proposed it is still the Agent's latest here, so the Agent
 * has asked nothing since. The judge reads the message and a fixed-label
 * summary of the set, never its content. An approval stamps the set for the
 * host to apply, and a decline retires it; anything else leaves it waiting.
 * An Agent's ask, a click, a later co-addressed turn or a reaction is never
 * read.
 */
export async function resolveTypedSlackManagementApproval(input: {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  actorMembershipId: string;
  identity: Pick<IdentityStore, 'resolveSlackIdentity'>;
  management: Pick<ManagementStore, 'getActiveChangeSetProposal' | 'markChangeSetProposalStale'>;
  latestAgentTurnMessageTs: (query: SlackLatestAgentTurnQuery) => Promise<string | undefined>;
  judge: (reply: { text: string; change: string }) => Promise<SlackManagementApproval>;
}): Promise<TypedSlackManagementApproval | undefined> {
  const { turn } = input;
  if (turn.agentAsk || turn.uiResponse || isLaterCoAddressedTurn(turn) || turn.source === 'reaction_added') {
    return undefined;
  }
  const proposal = await resolveHostSlackManagementProposal(input);
  if (!proposal) return undefined;
  if (shouldResolveSlackManagementApproval(turn.text)) return { kind: 'approve', proposalId: proposal.proposalId };
  if (!await answersProposal(input, proposal)) return undefined;
  const approval = await input.judge({ text: turn.text, change: approvalChangeSummary(proposal) });
  if (approval === 'approve') return { kind: 'approve', proposalId: proposal.proposalId };
  if (approval !== 'decline' || proposal.status !== 'pending') return undefined;
  await input.management.markChangeSetProposalStale(proposal.proposalId, Date.now());
  return { kind: 'decline', proposalId: proposal.proposalId };
}

async function answersProposal(
  input: Pick<Parameters<typeof resolveTypedSlackManagementApproval>[0], 'turn' | 'assignment' | 'latestAgentTurnMessageTs'>,
  proposal: ManagementChangeSetProposalRecord,
): Promise<boolean> {
  if (!proposal.proposedMessageTs) return false;
  const latest = await input.latestAgentTurnMessageTs({
    workspaceId: input.turn.workspaceId,
    channelId: input.turn.channelId,
    // A DM's or group DM's approval covers the whole conversation; a Channel's, one thread.
    ...(slackConversationKind(input.turn) === 'channel'
      ? { threadTs: conversationThreadTs(input.turn, input.assignment.runtimeContract) }
      : {}),
    agentId: input.assignment.agent.id,
  });
  return latest === proposal.proposedMessageTs;
}

const APPROVAL_OPERATION_LABELS: Readonly<Record<ManagementOperation['kind'], string>> = {
  create_agent: 'Create an Agent',
  update_agent: 'Change an Agent',
  delete_agent: 'Delete an Agent',
  archive_agent: 'Archive an Agent',
  restore_agent: 'Restore an Agent',
  put_channel: 'Change Channel settings',
  grant_agent_channel: 'Add an Agent to a Channel',
  revoke_agent_channel: 'Remove an Agent from a Channel',
  update_member: 'Change a member\'s access',
  remove_provider_credential: 'Remove a model provider key',
  update_agent_memory: 'Change an Agent\'s memory',
  save_routine: 'Save a routine',
  control_routine: 'Pause, resume or turn off a routine',
  run_routine: 'Run a routine now',
  delete_routine: 'Delete a routine',
  reassign_routine_agent: 'Move a routine to another Agent',
  request_setup: 'Prepare a setup link',
};

const APPROVAL_AGENT_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'name',
  description: 'description',
  instructions: 'instructions',
  requestedHandle: 'Slack handle',
  editPolicy: 'editing authority',
  model: 'model',
  modelEffort: 'effort',
  skills: 'skills',
  mcpServers: 'MCP servers',
  apiConnections: 'API connections',
  repositories: 'repositories',
  enabled: 'on or off',
};

/**
 * The approval judge's view of a change set: one fixed label per operation,
 * and for an Agent change the settings it touches. Nothing a person or a
 * model wrote reaches the judge through it, not even a name.
 */
export function approvalChangeSummary(proposal: Pick<ManagementChangeSetProposalRecord, 'operations'>): string {
  return proposal.operations.map((operation) => {
    const label = APPROVAL_OPERATION_LABELS[operation.kind];
    if (operation.kind !== 'update_agent') return label;
    const fields = Object.keys(operation.patch);
    const known = fields.filter((field) => Object.hasOwn(APPROVAL_AGENT_FIELD_LABELS, field));
    const settings = [
      ...known.map((field) => APPROVAL_AGENT_FIELD_LABELS[field]!),
      ...(known.length < fields.length ? ['other settings'] : []),
    ];
    return settings.length > 0 ? `${label}: ${settings.join(', ')}` : label;
  }).join('\n');
}

/**
 * The person's approval of one proposal, which the host resolved from their
 * typed approval or Approve click. A Slack confirmation applies only with
 * this stamp, and no model tool path can produce it.
 */
export async function resolveSlackApprovalActor(
  signal: SlackManagementSignal,
  identity: Pick<IdentityStore, 'resolveSlackIdentity'>,
  proposalId: string,
): Promise<ManagementActorContext> {
  const actor = await resolveSlackManagementActor(signal, identity);
  return { ...actor, origin: { ...slackManagementOrigin(signal), approvedProposalId: proposalId } };
}

export async function executeHostSlackManagementApproval(input: {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  turnJobId: string;
  proposalId: string;
  dependencies: SlackManagementApprovalDependencies;
  presentationRunId?: string;
  prepareAgentWelcomeTerminal?: () => Promise<void>;
}): Promise<HostSlackManagementApprovalResult> {
  const signal = slackManagementSignal(input.turn, input.assignment, input.turnJobId);
  try {
    const actor = await resolveSlackApprovalActor(signal, input.dependencies.identity, input.proposalId);
    const result = await input.dependencies.service.confirmWorkspaceChange({
      context: actor,
      proposalId: input.proposalId,
    });
    await completeDeferredAgentCreationHandoff({
      turn: input.turn,
      proposalId: input.proposalId,
      actor,
      result,
      config: input.dependencies.config,
      management: input.dependencies.management,
    }).catch(() => {
      console.warn('[chickpea:management] deferred Agent thread handoff failed');
    });
    return formatHostSlackManagementReceipt({
      result,
      turn: input.turn,
      proposalId: input.proposalId,
      actorMembershipId: actor.membershipId,
      config: input.dependencies.config,
      management: input.dependencies.management,
      ...(input.presentationRunId ? { presentationRunId: input.presentationRunId } : {}),
      ...(input.prepareAgentWelcomeTerminal
        ? { prepareAgentWelcomeTerminal: input.prepareAgentWelcomeTerminal }
        : {}),
      ...(input.dependencies.publicUrl ? { publicUrl: input.dependencies.publicUrl } : {}),
      ...(input.dependencies.avatarInstallationId
        ? { avatarInstallationId: input.dependencies.avatarInstallationId }
        : {}),
    });
  } catch (error) {
    if (error instanceof ManagementError) {
      if (error.code === 'operation_in_progress') {
        return {
          kind: 'message',
          text: 'That proposal is still being applied; it won’t be applied twice.',
        };
      }
      return { kind: 'message', text: managementApprovalFailureText(error.code) };
    }
    throw error;
  }
}

async function completeDeferredAgentCreationHandoff(input: {
  turn: NormalizedSlackTurn;
  proposalId: string;
  actor: ManagementActorContext;
  result: ManagementApplyResult;
  config: CreatedAgentHandoffConfig;
  management: Pick<ManagementStore, 'execute'> & {
    getChangeSetProposal?: ManagementStore['getChangeSetProposal'];
  };
}): Promise<void> {
  if (!managementResultFullyApplied(input.result)) return;
  const response = await input.management.execute({
    kind: 'get_deferred_agent_creation_welcome',
    workspaceId: input.turn.workspaceId,
    channelId: input.turn.channelId,
    threadTs: input.turn.threadTs,
    requesterMembershipId: input.actor.membershipId,
    proposalId: input.proposalId,
  });
  if (response.kind !== 'outbox') return;
  const welcome = response.outbox;
  if (!welcome || welcome.destination.kind !== 'thread' ||
      welcome.status !== 'delivered' ||
      !('kind' in welcome.receipt) || welcome.receipt.kind !== 'agent_created_welcome' ||
      welcome.receipt.requesterMembershipId !== input.actor.membershipId ||
      welcome.receipt.deferredHandoffProposalId !== input.proposalId ||
      welcome.receipt.deliveryPersona !== 'agent' ||
      welcome.receipt.publication?.incomplete.includes('slack_presence')) return;
  const delivery = /^slack:([^:]+):(\d+\.\d+)$/.exec(welcome.deliveryRef ?? '');
  if (!delivery || delivery[1] !== input.turn.channelId) return;
  if (agentWelcomeInGroupDm(welcome.receipt, welcome.destination.channelId)) return;
  await handoffCreatedAgentThread({
    workspaceId: welcome.destination.workspaceId,
    channelId: welcome.destination.channelId,
    threadTs: welcome.destination.threadTs,
    welcomeMessageTs: delivery[2]!,
    agentId: welcome.receipt.agentId,
    requesterMembershipId: welcome.receipt.requesterMembershipId,
    surface: welcome.receipt.surface,
    config: input.config,
  });
}

function slackManagementSignal(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  turnJobId: string,
): SlackManagementSignal {
  const requesterTextSource = personRequestTextSource(turn);
  return {
    agentId: assignment.agent.id,
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    threadTs: conversationThreadTs(turn, assignment.runtimeContract),
    conversationKind: slackConversationKind(turn),
    slackUserId: turn.userId,
    eventId: turn.eventId,
    messageTs: turn.messageTs,
    turnJobId,
    // The host resolves an approval only from the person's own message or click.
    requesterText: turn.text,
    ...(requesterTextSource ? { requesterTextSource } : {}),
  };
}

async function formatHostSlackManagementReceipt(input: {
  result: ManagementApplyResult;
  turn: NormalizedSlackTurn;
  proposalId: string;
  actorMembershipId: string;
  config: Pick<ConfigStore, 'getAgent'>;
  management: Pick<ManagementStore, 'putOutbox'> & {
    getChangeSetProposal?: ManagementStore['getChangeSetProposal'];
  };
  presentationRunId?: string;
  prepareAgentWelcomeTerminal?: () => Promise<void>;
  publicUrl?: string;
  avatarInstallationId?: string;
}): Promise<HostSlackManagementApprovalResult> {
  const { result } = input;
  const applied = result.outcomes.filter(({ disposition }) => disposition === 'applied');
  const attention = result.outcomes.filter(({ disposition }) => disposition !== 'applied');
  const warnings = result.outcomes.flatMap(({ warning }) => warning ? [warning] : []);
  const codes = attention.flatMap(({ code }) => code ? [code] : []);
  // The setup the person asked for alongside the change reaches them only here.
  const deferredSetup = result.deferredSetup ?? [];
  const message = (text: string, details: readonly string[] = []): HostSlackManagementApprovalResult => {
    const lines = [
      ...details,
      ...deferredSetup.flatMap((setup) => setup.kind === 'not_issued'
        ? [`Issue: ${escapeSlackControlCharacters(setup.code)}`]
        : []),
      ...deferredSetup.flatMap((setup) => setup.kind === 'issued'
        ? [renderSlackMarkdownActionLink(slackActionLink(setup.setupUrl, `Connect ${setup.label}`))]
        : []),
    ];
    return { kind: 'message', text: lines.length > 0 ? `${text}\n\n${lines.join('\n')}` : text };
  };
  if (applied.length === 0) {
    const detail = codes.length > 0
      ? ` (${[...new Set(codes)].map(escapeSlackControlCharacters).join(', ')})`
      : '';
    return message(`I couldn’t apply the approved changes${detail}. Nothing was changed.`);
  }
  const creation = result.outcomes.find(({ operationKind }) => operationKind === 'create_agent');
  const originKind = slackConversationKind(input.turn);
  const sourceGrant = result.outcomes.find(({ operationKind }) =>
    operationKind === 'grant_agent_channel'
  );
  const cleanCreation = Boolean(
    creation?.disposition === 'applied' &&
    result.status === 'completed' &&
    attention.length === 0 &&
    warnings.length === 0 &&
    result.outcomes.every(({ disposition }) => disposition === 'applied') &&
    deferredSetup.length === 0 &&
    (originKind !== 'channel' || sourceGrant?.disposition === 'applied')
  );
  if (cleanCreation && creation) {
    const agentId = creation.changed?.find(({ kind }) => kind === 'agent')?.id;
    const agent = agentId ? await input.config.getAgent(agentId).catch(() => undefined) : undefined;
    const handle = agent?.slackPresence?.normalizedHandle ??
      agent?.slackPresence?.requestedHandle;
    const published = agent?.slackPresence?.health === 'healthy' && handle;
    if (agent && published) {
      const suggestedConnector = suggestedUnconnectedConnector(agent);
      const avatarUrl = agentAvatarUrlForPresentation(agent, input.publicUrl, input.avatarInstallationId);
      const receipt: ManagementAgentCreatedWelcome = {
        kind: 'agent_created_welcome',
        proposalId: input.proposalId,
        ...(input.presentationRunId ? { presentationRunId: input.presentationRunId } : {}),
        agentId: agent.id,
        agentName: agent.name,
        ...(agent.description ? { agentDescription: agent.description } : {}),
        requesterMembershipId: input.actorMembershipId,
        surface: originKind === 'channel' ? 'channel' : 'direct',
        persona: {
          name: agent.name,
          ...(avatarUrl ? { avatarUrl } : {}),
        },
        ...(creation.handoffUrl ? { setupUrl: creation.handoffUrl } : {}),
        ...(suggestedConnector ? { suggestedConnector } : {}),
      };
      const at = Date.now();
      const outbox: ManagementReceiptOutboxRecord = {
        outboxId: `agent_welcome_${input.proposalId}`,
        operationId: result.operationId,
        destination: {
          kind: 'thread',
          workspaceId: input.turn.workspaceId,
          channelId: input.turn.channelId,
          threadTs: input.turn.threadTs,
        },
        receipt,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        createdAt: at,
        updatedAt: at,
      };
      const stored = await input.management.putOutbox(outbox);
      try {
        await input.prepareAgentWelcomeTerminal?.();
      } catch {
        // The durable outbox owns recovery now. Its acknowledged delivery can
        // reconstruct the terminal intent from presentationRunId.
        console.warn('[chickpea:management] deferred terminal intent will be recovered on delivery');
      }
      return { kind: 'agent_welcome_queued', outboxId: stored.outboxId };
    }
  }
  if (result.status === 'completed' && attention.length === 0 && warnings.length === 0) {
    const skillReceipt = await formatAppliedSkillReceipt(input);
    if (skillReceipt) return message(skillReceipt);
  }
  const receipt = attention.length === 0
    ? 'Applied the approved changes.'
    : `Applied some approved changes, but ${attention.length} ${
      attention.length === 1 ? 'item needs' : 'items need'
    } attention.`;
  return message(receipt, [
    ...codes.map((code) => `Issue: ${escapeSlackControlCharacters(code)}`),
    ...warnings.map(escapeSlackControlCharacters),
  ]);
}

async function formatAppliedSkillReceipt(input: {
  proposalId: string;
  config: Pick<ConfigStore, 'getAgent'>;
  management: {
    getChangeSetProposal?: ManagementStore['getChangeSetProposal'];
  };
}): Promise<string | undefined> {
  if (!input.management.getChangeSetProposal) return undefined;
  const proposal = await input.management.getChangeSetProposal(input.proposalId);
  if (!proposal || proposal.authoringReason !== 'skill_creation' ||
      proposal.operations.length !== 1) return undefined;
  const update = proposal.operations[0];
  if (update?.kind !== 'update_agent' || update.itemId !== 'skill-import' ||
      Object.keys(update.patch).some((field) => field !== 'skills')) return undefined;
  if (!update.patch.skills) return undefined;
  const previewChange = proposal.preview.changes.find(({ itemId }) => itemId === update.itemId);
  const beforeSkills = skillNames(recordValue(previewChange?.before)?.skills);
  const afterSkills = skillNames(recordValue(previewChange?.after)?.skills);
  if (!beforeSkills || !afterSkills) return undefined;
  const changed = [...afterSkills].filter((name) => !beforeSkills.has(name) ||
    !presentationSkillValuesEqual(
      skillRecordByName(recordValue(previewChange?.before)?.skills, name),
      skillRecordByName(recordValue(previewChange?.after)?.skills, name),
    ));
  if (changed.length === 0) return undefined;
  const agent = await input.config.getAgent(update.agentId).catch(() => undefined);
  const agentName = escapeSlackControlCharacters(agent?.name ?? update.agentId);
  const renderedSkills = changed
    .map((name) => `\`${escapeSlackControlCharacters(name)}\``)
    .join(', ');
  if (changed.length === 1) {
    const verb = beforeSkills.has(changed[0]!) ? 'Replaced' : 'Installed';
    return `${verb} skill ${renderedSkills} on ${agentName}. It’s active from the next message.`;
  }
  return `Installed skills ${renderedSkills} on ${agentName}. They’re active from the next message.`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function skillNames(value: unknown): Set<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = new Set<string>();
  for (const skill of value) {
    const name = recordValue(skill)?.name;
    if (typeof name !== 'string' || !name) return undefined;
    names.add(name);
  }
  return names;
}

function skillRecordByName(value: unknown, name: string): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.find((skill) => recordValue(skill)?.name === name);
}

function presentationSkillValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function suggestedUnconnectedConnector(agent: Awaited<ReturnType<ConfigStore['getAgent']>>): string | undefined {
  const corpus = normalizeConnectorText([
    agent.name,
    agent.description ?? '',
    agent.instructions,
  ].join(' '));
  const attached = new Set([
    ...agent.mcpServers.flatMap(({ presetId }) => presetId ? [presetId] : []),
    ...agent.apiConnections.flatMap(({ presetId }) => presetId ? [presetId] : []),
  ]);
  const matches = CONNECTION_CATALOG_PRESETS.filter(({ id, name }) => {
    if (attached.has(id)) return false;
    const candidates = [normalizeConnectorText(id), normalizeConnectorText(name)];
    return candidates.some((candidate) => candidate && ` ${corpus} `.includes(` ${candidate} `));
  });
  return matches.length === 1 ? matches[0]!.name : undefined;
}

function normalizeConnectorText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function managementApprovalFailureText(code: ManagementError['code']): string {
  if (code === 'proposal_not_found' || code === 'proposal_stale' ||
      code === 'revision_conflict') {
    return 'I couldn’t apply that proposal because it is no longer current. Ask me to prepare an updated proposal.';
  }
  if (code === 'forbidden' || code === 'proposal_binding_mismatch') {
    return 'I couldn’t apply that proposal from this requester or conversation.';
  }
  return 'I couldn’t apply the approved changes. Nothing else was proposed or applied.';
}
