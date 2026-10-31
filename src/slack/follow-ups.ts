import { activityStatus, type TypedActivityStatus } from '../activity/semantic.ts';
import { parseMemoryCommand } from '../memory/commands.ts';
import { parseRoutineCommand } from '../routines/commands.ts';
import { stripUnresolvedSlackCommandAddress } from './command-address.ts';
import { formatSlackContextRows } from './context-format.ts';
import type { NormalizedSlackTurn } from './types.ts';

/**
 * Follow-ups: messages the head turn's requester sent after it in the same
 * thread, queued behind it, that its run takes as part of one request and
 * answers in one reply. The state store decides which rows join
 * (TurnJobStoreLogic.fold); this module holds the rules and words both sides
 * share.
 */

/** One queued message from the head's requester that the head's run took. */
export interface FoldedMessage {
  turnJobId: string;
  userId: string;
  messageTs: string;
  text: string;
}

/** Rows one claim may take, oldest first. */
export const MAX_FOLDED_MESSAGES = 8;
/** The person's words one fold group may hold; a claim's first row is always taken whole. */
export const MAX_FOLDED_TEXT_CHARS = 40_000;
/** Late folds per response. Leftovers run as their own turn, which takes them at its start. */
export const MAX_FOLD_CYCLES = 3;

const FOLDABLE_SOURCES: ReadonlySet<NormalizedSlackTurn['source']> = new Set([
  'app_mention',
  'implicit_thread_reply',
  'dm_message',
]);

/**
 * Whether a turn may take part in a fold group, as head or as member: a plain
 * message a person typed to the Agent. A command, an approval, a click or a
 * reaction, an ask, a message several Agents were mentioned in, and a message
 * with files each keep a turn of their own, as does any new kind of turn
 * until someone decides otherwise.
 */
export function foldableTurn(turn: NormalizedSlackTurn): boolean {
  const intent = turn.interactionIntent?.disposition;
  return FOLDABLE_SOURCES.has(turn.source) &&
    turn.text.trim().length > 0 &&
    !turn.reaction && !turn.reactionTargetTs && !turn.uiResponse &&
    !turn.agentAsk && !turn.coAddressed &&
    !turn.managementApprovalProposalId && !turn.approvedBrowserActionId &&
    !turn.attachments?.length && !turn.attachmentIntake &&
    (intent === undefined || intent === 'reply' || intent === 'work') &&
    !parseMemoryCommand(turn.text) &&
    !parseRoutineCommand(stripUnresolvedSlackCommandAddress(turn.text));
}

/**
 * The person's own words for a fold group, oldest first, one message per
 * paragraph: what the classifier, connection selection and the typed-text
 * checks read, so a link or a request sent in a follow-up counts as typed.
 */
export function foldedRequestText(
  headText: string,
  members: readonly Pick<FoldedMessage, 'text'>[],
): string {
  return [headText, ...members.map((member) => member.text)].join('\n\n').slice(0, MAX_FOLDED_TEXT_CHARS);
}

/** A fold group's messages in the row format of the prompt's Slack context. */
export function frameFoldedMessages(
  messages: readonly Pick<FoldedMessage, 'userId' | 'messageTs' | 'text'>[],
  timezone: string,
): string {
  return formatSlackContextRows(
    messages.map((message) => ({
      userId: message.userId,
      text: message.text,
      ts: message.messageTs,
      isTrigger: false,
      role: 'human' as const,
    })),
    { prefix: '- ', separator: '\n', timezone },
  );
}

/** The prompt's request heading for a head and its follow-ups (`count` includes the head). */
export function foldedRequestHeading(count: number, userId: string): string {
  return `Current Slack request, sent as ${count} messages by <@${userId}> (together they are the only current user intent: read them in order, since a later message may correct or add to an earlier one; answer all of them in one reply and let current system truth take precedence):`;
}

/** The status while a turn reads its request's messages (`count` includes the head). */
export function foldActivityStatus(count: number): TypedActivityStatus {
  return activityStatus('reading', 'Reading', `${count} messages`);
}
