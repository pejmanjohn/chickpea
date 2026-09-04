import {
  defineLiveCase,
  requiredSuitesForVariant,
  type AssertionToken,
  type CleanupIntent,
} from '../schema.ts';
import {
  hasSettledActivity,
  integerAt,
  markerAt,
  maybeObject,
  objectAt,
  stringAt,
  upstreamRecord,
  type FoundationEvaluation,
} from './_shared.ts';

const agentResidue: CleanupIntent = {
  strategy: 'attributed_residue',
  fixtureClass: 'attributed_residue',
  reversalActionId: 'agent.archive',
  residue: {
    kind: 'agent_tombstone',
    markerRequired: true,
    expectedState: 'The run-marked Agent is archived and has no active Slack route.',
  },
};

const slackResidue: CleanupIntent = {
  strategy: 'attributed_residue',
  fixtureClass: 'attributed_residue',
  residue: {
    kind: 'slack_message',
    markerRequired: true,
    expectedState: 'The exact run-marked Slack message is attributed to this run.',
  },
};

export const AGENT_LIFECYCLE_CONTRACT = defineLiveCase({
  id: 'LC-01',
  title: 'Immediate Agent lifecycle',
  area: 'agents',
  feature: 'agent_lifecycle',
  entryPoints: ['admin', 'slack_root'],
  variants: [
    {
      id: 'LC01-V1-create-welcome',
      title: 'Create an Agent and observe its welcome',
      suites: requiredSuitesForVariant('LC01-V1-create-welcome'),
      fixtures: [
        { slot: 'owner', kind: 'actor', fixtureClass: 'immutable_baseline' },
        { slot: 'channel', kind: 'slack_channel', fixtureClass: 'immutable_baseline' },
      ],
      actions: [{
        id: 'agent.create',
        message: 'Create the run-marked acceptance Agent {{runMarker}} and assign it to the QA channel.',
        mutation: 'create',
        humanGate: 'none',
        fixtureSlots: ['owner', 'channel'],
        cleanup: agentResidue,
      }],
      generatedEffects: [{
        id: 'slack.message.generated',
        message: 'Chickpea publishes the exact welcome for Agent {{runMarker}} in its assigned channel.',
        fixtureSlots: ['channel'],
        observerId: 'slack.messages.read',
        cleanup: slackResidue,
      }],
      observers: ['agent.read', 'slack.messages.read'],
      expected: [
        { token: 'agent.exists', observerId: 'agent.read' },
        { token: 'slack.message_matches', observerId: 'slack.messages.read' },
      ],
      forbidden: [{ token: 'forbidden.no_duplicate', observerId: 'slack.messages.read' }],
      regressions: [{
        candidateId: 'CAND-LC01-create-welcome',
        lesson: 'Creation is incomplete until the Agent and its exact Slack welcome are both observable.',
      }],
      evidence: ['immutable_id', 'revision', 'observed_state', 'actor_alias', 'action_receipt', 'cleanup_receipt'],
    },
    {
      id: 'LC01-V2-update-approve',
      title: 'Apply the full frozen update through bare approval',
      suites: requiredSuitesForVariant('LC01-V2-update-approve'),
      fixtures: [
        { slot: 'owner', kind: 'actor', fixtureClass: 'immutable_baseline' },
        { slot: 'agent', kind: 'agent', fixtureClass: 'resettable_fixture' },
      ],
      actions: [{
        id: 'agent.update',
        message: 'Preview the complete run-marked update for {{runMarker}}, then apply that frozen value after bare approval.',
        mutation: 'update',
        humanGate: 'approval',
        fixtureSlots: ['owner', 'agent'],
        cleanup: {
          strategy: 'revision_restore',
          fixtureClass: 'resettable_fixture',
          reversalActionId: 'agent.update',
        },
      }],
      generatedEffects: [],
      observers: ['agent.read'],
      expected: [{ token: 'agent.instructions_equal', observerId: 'agent.read' }],
      forbidden: [{ token: 'forbidden.no_early_mutation', observerId: 'agent.read' }],
      regressions: [{
        candidateId: 'CAND-LC01-update-approve',
        lesson: 'Approval applies the complete frozen preview, never a partial or regenerated value.',
      }],
      evidence: ['immutable_id', 'revision', 'observed_state', 'actor_alias', 'action_receipt', 'cleanup_receipt'],
    },
  ],
});

export type AgentLifecycleVariant = typeof AGENT_LIFECYCLE_CONTRACT.variants[number]['id'];

export const AGENT_LIFECYCLE_FAILURES = [
  'agent_missing',
  'welcome_missing',
  'welcome_duplicate',
  'welcome_wrong_channel',
  'welcome_false_claim',
  'presence_missing',
  'proposal_binding_mismatch',
  'bare_approval_missing',
  'reaction_only_approval',
  'frozen_value_mismatch',
  'durable_value_truncated',
  'revision_not_advanced',
  'early_mutation',
  'activity_lingering',
] as const;

export type AgentLifecycleFailure = typeof AGENT_LIFECYCLE_FAILURES[number];

/**
 * Normalize Admin and Slack API response shapes. This module deliberately has
 * no network client. A live observer supplies the same response bodies that
 * deterministic fixtures use here.
 */
export function evaluateAgentLifecycle(
  variantId: AgentLifecycleVariant,
  upstream: unknown,
): FoundationEvaluation<AgentLifecycleFailure> {
  const input = upstreamRecord(upstream);
  if (variantId === 'LC01-V1-create-welcome') return evaluateCreate(input);
  if (variantId === 'LC01-V2-update-approve') return evaluateUpdate(input);
  throw new Error('UNKNOWN_VARIANT');
}

export function evaluateAgentArchive(upstream: unknown): FoundationEvaluation<'archive_id_mismatch' | 'active_route_remains' | 'residue_unattributed'> {
  const input = upstreamRecord(upstream);
  const expectedAgentId = stringAt(input, 'expectedAgentId');
  const archivedAgent = objectAt(objectAt(input, 'admin'), 'agent');
  const failures: Array<'archive_id_mismatch' | 'active_route_remains' | 'residue_unattributed'> = [];
  if (stringAt(archivedAgent, 'id') !== expectedAgentId || stringAt(archivedAgent, 'lifecycle') !== 'archived') {
    failures.push('archive_id_mismatch');
  }
  const routes = arrayAt(archivedAgent, 'routes');
  if (routes.some((route) => isRecord(route) && route.active === true)) failures.push('active_route_remains');
  const residue = objectAt(input, 'residue');
  if (stringAt(residue, 'kind') !== 'agent_tombstone'
    || stringAt(residue, 'agentId') !== expectedAgentId
    || stringAt(residue, 'runMarker') !== stringAt(input, 'runMarker')) {
    failures.push('residue_unattributed');
  }
  return { pass: failures.length === 0, observedTokens: [], failures };
}

function evaluateCreate(input: Record<string, unknown>): FoundationEvaluation<AgentLifecycleFailure> {
  const request = objectAt(input, 'request');
  const admin = objectAt(input, 'admin');
  const slack = objectAt(input, 'slack');
  const marker = markerAt(input);
  const expectedAgentName = stringAt(request, 'expectedAgentName');
  const sourceChannelId = stringAt(request, 'sourceChannelId');
  const sourceThreadTs = stringAt(request, 'sourceThreadTs');
  const agents = arrayAt(admin, 'agents').filter(isRecord);
  const candidates = agents.filter((agent) => agent.name === expectedAgentName && expectedAgentName.includes(marker));
  const failures: AgentLifecycleFailure[] = [];
  const agent = candidates[0];
  if (candidates.length !== 1 || agent === undefined || stringAt(agent, 'lifecycle') !== 'active') {
    failures.push('agent_missing');
  }

  const agentId = agent === undefined ? '' : stringAt(agent, 'id');
  const outboxes = arrayAt(admin, 'outboxes').filter(isRecord);
  const welcomeOutboxes = outboxes.filter((outbox) => {
    const receipt = maybeObject(outbox.receipt);
    return receipt?.kind === 'agent_created_welcome' && receipt.agentId === agentId;
  });
  const welcomeOutbox = welcomeOutboxes[0];
  const receipt = maybeObject(welcomeOutbox?.receipt);
  const destination = maybeObject(welcomeOutbox?.destination);
  const publication = maybeObject(receipt?.publication);
  const messages = arrayAt(slack, 'messages').filter(isRecord);
  const deliveryMessageTs = deliveryTs(welcomeOutbox?.deliveryRef);
  const welcomes = messages.filter((message) =>
    message.ts === deliveryMessageTs
      && message.channel === sourceChannelId
      && message.thread_ts === sourceThreadTs
      && typeof message.text === 'string'
      && message.text.includes(marker)
  );
  if (welcomes.length === 0) failures.push('welcome_missing');
  if (welcomes.length > 1 || welcomeOutboxes.length > 1) failures.push('welcome_duplicate');
  if (destination?.kind !== 'thread'
    || destination.channelId !== sourceChannelId
    || destination.threadTs !== sourceThreadTs) {
    failures.push('welcome_wrong_channel');
  }
  if (welcomeOutbox?.status !== 'delivered'
    || publication?.status !== 'complete'
    || !Array.isArray(publication.incomplete)
    || publication.incomplete.length !== 0) failures.push('welcome_false_claim');
  const presence = agent === undefined ? undefined : maybeObject(agent.slackPresence);
  if (presence?.health !== 'healthy' || presence.desiredState !== 'active') failures.push('presence_missing');
  const grants = arrayAt(admin, 'channelGrants').filter(isRecord);
  if (!grants.some((grant) =>
    grant.agentId === agentId && grant.channelId === sourceChannelId && grant.status === 'active'
  )) failures.push('welcome_false_claim');
  if (!hasSettledActivity(admin)) failures.push('activity_lingering');

  const observedTokens: AssertionToken[] = [];
  if (!failures.includes('agent_missing')) observedTokens.push('agent.exists');
  if (!failures.some((failure) => [
    'welcome_missing', 'welcome_duplicate', 'welcome_wrong_channel', 'welcome_false_claim', 'presence_missing',
  ].includes(failure))) observedTokens.push('slack.message_matches', 'forbidden.no_duplicate');
  return { pass: failures.length === 0, observedTokens, failures };
}

function evaluateUpdate(input: Record<string, unknown>): FoundationEvaluation<AgentLifecycleFailure> {
  const request = objectAt(input, 'request');
  const admin = objectAt(input, 'admin');
  const slack = objectAt(input, 'slack');
  const proposal = objectAt(admin, 'proposal');
  const requester = maybeObject(admin.requester);
  const agent = objectAt(admin, 'agent');
  const agentId = stringAt(request, 'agentId');
  const requesterUserId = stringAt(request, 'requesterUserId');
  const requestThreadTs = stringAt(request, 'threadTs');
  const fullInstructions = stringAt(request, 'fullInstructions');
  markerAt(input);
  const failures: AgentLifecycleFailure[] = [];

  const operations = arrayAt(proposal, 'operations').filter(isRecord);
  const operation = operations.find((candidate) => candidate.kind === 'update_agent');
  const patch = maybeObject(operation?.patch);
  const expectedScopeKey = stringAt(request, 'approvalScopeKey');
  if (typeof requester?.userId !== 'string' || !requester.userId
    || typeof requester.membershipId !== 'string' || !requester.membershipId
    || requester.slackUserId !== requesterUserId
    || proposal.actorUserId !== requester.userId
    || proposal.actorMembershipId !== requester.membershipId
    || proposal.approvalScopeKey !== expectedScopeKey
    || !expectedScopeKey.includes(requestThreadTs)
    || operation?.agentId !== agentId) {
    failures.push('proposal_binding_mismatch');
  }
  const approvalMessages = arrayAt(slack, 'messages').filter((value): value is Record<string, unknown> =>
    isRecord(value)
      && value.user === requesterUserId
      && value.thread_ts === requestThreadTs
      && typeof value.text === 'string'
      && value.text.trim().toLowerCase() === 'approve'
  );
  const approvalReactions = arrayAt(slack, 'reactions').filter((value) => isRecord(value) && value.user === requesterUserId);
  if (approvalMessages.length !== 1) failures.push('bare_approval_missing');
  if (approvalMessages.length === 0 && approvalReactions.length > 0) failures.push('reaction_only_approval');
  if (patch?.instructions !== fullInstructions) failures.push('frozen_value_mismatch');
  if (stringAt(agent, 'instructions') !== fullInstructions) failures.push('durable_value_truncated');
  if (integerAt(agent, 'revision') <= integerAt(admin, 'beforeRevision')
    || !arrayAt(objectAt(proposal, 'result'), 'outcomes').filter(isRecord).some((outcome) =>
      optionalArrayAt(outcome, 'changed').filter(isRecord).some((changed) =>
        changed.kind === 'agent' && changed.id === agentId && changed.revision === integerAt(agent, 'revision')
      )
    )) {
    failures.push('revision_not_advanced');
  }
  if (proposal.status !== 'completed' || admin.preApprovalRevision !== admin.beforeRevision) failures.push('early_mutation');
  if (!hasSettledActivity(admin)) failures.push('activity_lingering');

  const observedTokens: AssertionToken[] = [];
  if (!failures.some((failure) => [
    'proposal_binding_mismatch', 'bare_approval_missing', 'reaction_only_approval', 'frozen_value_mismatch',
    'durable_value_truncated', 'revision_not_advanced', 'activity_lingering',
  ].includes(failure))) observedTokens.push('agent.instructions_equal');
  if (!failures.includes('early_mutation')) observedTokens.push('forbidden.no_early_mutation');
  return { pass: failures.length === 0, observedTokens, failures };
}

function deliveryTs(input: unknown): string {
  if (typeof input !== 'string') throw new Error('INVALID_UPSTREAM_SHAPE');
  const match = /^slack:[A-Z0-9_]+:([0-9]+\.[0-9]+)$/u.exec(input);
  if (match?.[1] === undefined) throw new Error('INVALID_UPSTREAM_SHAPE');
  return match[1];
}

function arrayAt(input: Record<string, unknown>, key: string): unknown[] {
  const value = input[key];
  if (!Array.isArray(value)) throw new Error('INVALID_UPSTREAM_SHAPE');
  return value;
}

function optionalArrayAt(input: Record<string, unknown>, key: string): unknown[] {
  const value = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('INVALID_UPSTREAM_SHAPE');
  return value;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}
