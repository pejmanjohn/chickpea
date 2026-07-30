import type { ResolvedAssignment } from '../config/types.ts';
import { opaqueId, safeConfigForAssignment } from '../work/admission.ts';
import { prepareSubmitRun } from '../work/submit-run.ts';
import type {
  AdmitShadowRunInput,
  SourceVisibility,
  RunExecutionAuthority,
} from '../work/types.ts';
import {
  slackConversationsInfo,
  slackUsersInfo,
  type SlackConversationFacts,
  type SlackUserFacts,
} from './credentials.ts';
import type { NormalizedSlackTurn } from './types.ts';
import { classifySlackUserForAdmission } from './user-classification.ts';

export type SlackAdmissionTruthReason =
  | 'eligible'
  | 'slack_truth_unavailable'
  | 'ineligible_actor'
  | 'unsupported_conversation'
  | 'workspace_mismatch';

export type SlackAdmissionTruth =
  | {
      eligible: true;
      reason: 'eligible';
      sourceVisibility: Exclude<SourceVisibility, 'unknown'>;
      actorTrustTier: 'member';
    }
  | {
      eligible: false;
      reason: Exclude<SlackAdmissionTruthReason, 'eligible'>;
    };

export interface SlackAdmissionTruthReader {
  user(userId: string): Promise<{ ok: boolean; user?: SlackUserFacts }>;
  conversation(
    channelId: string,
  ): Promise<{ ok: boolean; facts?: SlackConversationFacts }>;
}

export async function resolveSlackAdmissionTruth(
  turn: NormalizedSlackTurn,
  botUserId: string,
  reader: SlackAdmissionTruthReader,
): Promise<SlackAdmissionTruth> {
  const direct = isDirectTurn(turn);
  const [actor, conversation] = await Promise.all([
    reader.user(turn.userId),
    direct ? Promise.resolve(undefined) : reader.conversation(turn.channelId),
  ]);
  if (!actor.ok || !actor.user) return denied('slack_truth_unavailable');
  if (
    classifySlackUserForAdmission(actor.user, turn.workspaceId, botUserId) !==
    'eligible_human'
  ) {
    return denied('ineligible_actor');
  }
  if (direct) {
    return {
      eligible: true,
      reason: 'eligible',
      sourceVisibility: 'private',
      actorTrustTier: 'member',
    };
  }
  if (!conversation?.ok || !conversation.facts) {
    return denied('slack_truth_unavailable');
  }
  const facts = conversation.facts;
  if (facts.id !== turn.channelId || facts.teamId !== turn.workspaceId) {
    return denied('workspace_mismatch');
  }
  if (
    facts.archived ||
    facts.frozen ||
    facts.shared ||
    facts.externallyShared ||
    facts.organizationShared ||
    facts.pendingShared ||
    facts.im ||
    facts.mpim ||
    !facts.member
  ) {
    return denied('unsupported_conversation');
  }
  return {
    eligible: true,
    reason: 'eligible',
    sourceVisibility: facts.private ? 'private' : 'public',
    actorTrustTier: 'member',
  };
}

export function slackAdmissionTruthReader(
  botToken: string,
  timeoutMs = 750,
): SlackAdmissionTruthReader {
  return {
    async user(userId) {
      const result = await slackUsersInfo(botToken, userId, { timeoutMs });
      return { ok: result.ok, ...(result.user ? { user: result.user } : {}) };
    },
    async conversation(channelId) {
      const result = await slackConversationsInfo(botToken, channelId, { timeoutMs });
      return { ok: result.ok, ...(result.facts ? { facts: result.facts } : {}) };
    },
  };
}

export function prepareSlackShadowAdmission(input: {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  sourceVisibility: Exclude<SourceVisibility, 'unknown'>;
  admittedAt: number;
  executionAuthority?: RunExecutionAuthority;
}): AdmitShadowRunInput {
  const { turn, assignment, sourceVisibility, admittedAt } = input;
  const direct = isDirectTurn(turn);
  const conversationIdentity = direct
    ? `dm:${turn.channelId}`
    : `thread:${turn.channelId}:${turn.threadTs}`;
  const scope = `slack:${turn.workspaceId}:${conversationIdentity}:1`;
  const messageScope = `slack:${turn.workspaceId}:${turn.channelId}:${turn.messageTs}`;
  const workId = opaqueId('work', scope);
  const bindingId = opaqueId('binding', scope);
  const runId = opaqueId('run', messageScope);
  const safeConfig = safeConfigForAssignment(assignment, sourceVisibility);
  return prepareSubmitRun({
    work: {
      id: workId,
      kind: 'conversation',
      createdAt: admittedAt,
    },
    binding: {
      id: bindingId,
      adapterKind: 'slack',
      externalAccountId: opaqueId('account', `slack:${turn.workspaceId}`),
      externalConversationId: opaqueId('conversation', scope),
      generation: 1,
      sourceVisibility,
      configMode: direct ? 'resolve_each_run' : 'frozen_on_open',
      orderingKey: opaqueId('ordering', scope),
      createdAt: admittedAt,
    },
    trigger: {
      runId,
      runKind: 'interactive',
      kind: `slack_${turn.source}`,
      ref: opaqueId('trigger', messageScope),
      dedupeKey: opaqueId('dedupe', messageScope),
      body: turn.text,
      createdAt: admittedAt,
    },
    actor: {
      ref: opaqueId('actor', `slack:${turn.workspaceId}:${turn.userId}`),
      trustTier: 'member',
    },
    sourceContextWatermark: opaqueId(
      'watermark',
      `${turn.workspaceId}:${turn.channelId}:${turn.threadTs}:${turn.messageTs}`,
    ),
    safeConfig,
    execution: {
      authority: input.executionAuthority ?? 'legacy',
      coordinatorKind: 'interactive',
      authorityEpoch: 1,
    },
    audit: {
      eventId: opaqueId('audit', `admit:${messageScope}`),
      idempotencyKey: opaqueId('auditkey', `admit:${messageScope}`),
    },
  });
}

function denied(
  reason: Exclude<SlackAdmissionTruthReason, 'eligible'>,
): SlackAdmissionTruth {
  return { eligible: false, reason };
}

function isDirectTurn(turn: NormalizedSlackTurn): boolean {
  return (
    turn.source === 'dm_message' ||
    turn.channelType === 'im' ||
    turn.channelType === 'app_home' ||
    turn.channelType === 'mpim'
  );
}
