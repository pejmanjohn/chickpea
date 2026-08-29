import type { ConfigStore } from '../config/store.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import { REUSABLE_CONNECTOR_PRESETS } from '../config/presets.ts';
import type { IdentityStore } from '../identity/types.ts';
import { agentAvatarUrlForPresentation } from '../slack/agent-presence/avatar-assets.ts';
import { escapeSlackControlCharacters } from '../slack/message-format.ts';
import { slackConversationKind } from '../slack/thread-key.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';
import type { ManagementStore } from './store.ts';
import { WorkspaceManagementService } from './service.ts';
import {
  resolveSlackManagementActor,
  type SlackManagementSignal,
} from './slack-tools.ts';
import {
  ManagementError,
  type ManagementAgentCreatedWelcome,
  type ManagementActorContext,
  type ManagementApplyResult,
  type ManagementReceiptOutboxRecord,
} from './types.ts';
import {
  managementActorOriginKey,
  managementApprovalScopeKey,
} from './contracts.ts';

export interface SlackManagementApprovalDependencies {
  identity: Pick<IdentityStore, 'resolveSlackIdentity'>;
  config: Pick<ConfigStore, 'getAgent'>;
  management: Pick<ManagementStore, 'putOutbox'> & {
    getChangeSetProposal?: ManagementStore['getChangeSetProposal'];
  };
  service: WorkspaceManagementService;
  publicUrl?: string;
}

export type HostSlackManagementApprovalResult =
  | { kind: 'message'; text: string }
  | { kind: 'agent_welcome_queued'; outboxId: string };

export async function resolveHostSlackManagementApproval(input: {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  actorMembershipId: string;
  identity: Pick<IdentityStore, 'resolveSlackIdentity'>;
  management: Pick<ManagementStore, 'getActiveChangeSetProposal'>;
}): Promise<string | undefined> {
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
  return proposal.proposalId;
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
    const actor = await resolveSlackManagementActor(signal, input.dependencies.identity);
    const result = await input.dependencies.service.confirmWorkspaceChange({
      context: actor,
      proposalId: input.proposalId,
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

function slackManagementSignal(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  turnJobId: string,
): SlackManagementSignal {
  return {
    agentId: assignment.agent.id,
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    threadTs: assignment.runtimeContract === 'chickpea-v1'
      ? turn.threadTs
      : turn.sessionThreadTs ?? turn.threadTs,
    conversationKind: slackConversationKind(turn),
    slackUserId: turn.userId,
    eventId: turn.eventId,
    messageTs: turn.messageTs,
    turnJobId,
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
}): Promise<HostSlackManagementApprovalResult> {
  const { result } = input;
  const applied = result.outcomes.filter(({ disposition }) => disposition === 'applied');
  const attention = result.outcomes.filter(({ disposition }) => disposition !== 'applied');
  const warnings = result.outcomes.flatMap(({ warning }) => warning ? [warning] : []);
  const codes = attention.flatMap(({ code }) => code ? [code] : []);
  if (applied.length === 0) {
    const detail = codes.length > 0
      ? ` (${[...new Set(codes)].map(escapeSlackControlCharacters).join(', ')})`
      : '';
    return {
      kind: 'message',
      text: `I couldn’t apply the approved changes${detail}. Nothing was changed.`,
    };
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
      const avatarUrl = agentAvatarUrlForPresentation(agent, input.publicUrl);
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
    if (skillReceipt) return { kind: 'message', text: skillReceipt };
  }
  const receipt = attention.length === 0
    ? 'Applied the approved changes.'
    : `Applied some approved changes, but ${attention.length} ${
      attention.length === 1 ? 'item needs' : 'items need'
    } attention.`;
  const details = [
    ...codes.map((code) => `Issue: ${escapeSlackControlCharacters(code)}`),
    ...warnings.map(escapeSlackControlCharacters),
  ];
  return {
    kind: 'message',
    text: details.length > 0 ? `${receipt}\n\n${details.join('\n')}` : receipt,
  };
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
  const matches = REUSABLE_CONNECTOR_PRESETS.filter(({ id, name }) => {
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
