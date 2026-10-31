import { activityStatus, type TypedActivityStatus } from '../activity/semantic.ts';
import { parseMemoryCommand } from '../memory/commands.ts';
import { parseRoutineCommand } from '../routines/commands.ts';
import { stripUnresolvedSlackCommandAddress } from './command-address.ts';
import { formatSlackContextRows, SLACK_CONTEXT_CONTINUATION_MARKER } from './context-format.ts';
import type { NormalizedSlackTurn } from './types.ts';

/**
 * Follow-ups: messages people sent after the head turn in the same thread,
 * queued behind it, that its run takes as part of one request and answers in
 * one reply. A teammate's message in a run that uses the requester's own
 * connections is taken as information only: the run reads it, and it gets
 * its own turn afterwards. The state store decides which rows join
 * (TurnJobStoreLogic.fold); this module holds the rules and words both sides
 * share.
 */

/** One queued message that the head's run took. */
export interface FoldedMessage {
  turnJobId: string;
  userId: string;
  messageTs: string;
  text: string;
  /** The run reads it but does not answer it (see foldedInformationOnly). */
  informationOnly?: true;
}

/**
 * Whether the head's run takes a message as information only: a teammate's,
 * while the run may use the requester's own connections.
 */
export function foldedInformationOnly(
  senderId: string,
  requesterId: string,
  usesPersonalAccess: boolean,
): boolean {
  return senderId !== requesterId && usesPersonalAccess;
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
 * The requester's own words for a fold group, oldest first, one message per
 * paragraph: what the classifier, connection selection and the typed-text
 * checks read, so a link or a request sent in a follow-up counts as typed. A
 * teammate's words never choose the requester's connections.
 */
export function foldedRequestText(
  head: Pick<FoldedMessage, 'userId' | 'text'>,
  members: readonly Pick<FoldedMessage, 'userId' | 'text'>[],
): string {
  return [head, ...members.filter((member) => member.userId === head.userId)]
    .map((message) => message.text).join('\n\n').slice(0, MAX_FOLDED_TEXT_CHARS);
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

/**
 * What a late fold tells the running model: the messages that arrived while
 * it worked, then the head's current-request envelope verbatim, so tool
 * policy still reads this turn's envelope as the last one.
 */
export function followUpSignalBody(input: {
  messages: readonly Pick<FoldedMessage, 'userId' | 'messageTs' | 'text'>[];
  userId: string;
  timezone: string;
  envelope: string;
}): string {
  return [
    followUpSignalHeading(input.userId, input.messages.length),
    frameFoldedMessages(input.messages, input.timezone),
    'Your draft reply has not been sent. Read these with the request above, in order, since a later message may correct or add to an earlier one. Do any extra work they need, then write your next message as the complete reply to the whole request, not only to these messages.',
    input.envelope,
  ].join('\n\n');
}

function followUpSignalHeading(userId: string, count: number): string {
  return `While you were working, <@${userId}> sent ${count === 1 ? 'another message' : `${count} more messages`} in this thread:`;
}

/** One row of frameFoldedMessages: an optional local time, the ts, the human role, the sender's id, the text. */
const FOLLOW_UP_SIGNAL_ROW = /^- \[(?:[^\]]*; )?(\d+\.\d+) role=human\] ([^\s:]+): ([\s\S]*)$/;

/**
 * The messages a late fold's signal carried, read back from its body;
 * undefined for any other body. The rows are the paragraph after the
 * heading, and the heading must be the one followUpSignalBody writes for
 * their sender and count. Message text cannot start a row or end the row
 * block: every later line of it carries the continuation marker.
 */
export function followUpSignalMessages(
  body: string,
): Pick<FoldedMessage, 'userId' | 'messageTs' | 'text'>[] | undefined {
  const [heading, block] = body.split('\n\n', 2);
  if (heading === undefined || block === undefined) return undefined;
  const rows: string[] = [];
  for (const line of block.split('\n')) {
    if (rows.length > 0 && line.startsWith(SLACK_CONTEXT_CONTINUATION_MARKER)) {
      rows[rows.length - 1] += `\n${line.slice(SLACK_CONTEXT_CONTINUATION_MARKER.length)}`;
    } else {
      rows.push(line);
    }
  }
  const messages: Pick<FoldedMessage, 'userId' | 'messageTs' | 'text'>[] = [];
  for (const row of rows) {
    const [, messageTs, userId, text] = row.match(FOLLOW_UP_SIGNAL_ROW) ?? [];
    if (messageTs === undefined || userId === undefined || text === undefined) return undefined;
    messages.push({ userId, messageTs, text });
  }
  const sender = messages[0]?.userId;
  if (sender === undefined || messages.some((message) => message.userId !== sender)) return undefined;
  return heading === followUpSignalHeading(sender, messages.length) ? messages : undefined;
}

/**
 * The status while a turn reads its request's messages: at its start
 * `count` includes the head; a late fold counts only the new messages.
 */
export function foldActivityStatus(count: number, phase: 'start' | 'finish'): TypedActivityStatus {
  if (phase === 'start') return activityStatus('reading', 'Reading', `${count} messages`);
  return activityStatus('reading', 'Reading', count === 1 ? '1 new message' : `${count} new messages`);
}
