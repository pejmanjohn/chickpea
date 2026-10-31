import type { ResolvedAssignment } from '../config/types.ts';
import type { RunExecutionAuthority } from '../work/types.ts';
import { foldableTurn } from './follow-ups.ts';
import { compareSlackTs, turnRequestTs } from './thread-context.ts';
import type { TurnJob } from './turn-job-types.ts';
import type { NormalizedSlackTurn, SlackTurnEdit } from './types.ts';

/**
 * Edits: a person's text edit of a message whose turn is queued or running
 * steers that turn. The edit is a turn row of its own, carrying the message's
 * turn with the new text; the fold protocol then decides what the run reads
 * (see TurnJobStoreLogic.fold and readFoldClaim), and an edit no fold takes
 * runs as its own turn after the reply.
 */

/** A person's real text edit of one Slack message, parsed at the boundary (parseSlackMessageEdit). */
export interface SlackMessageEdit {
  workspaceId: string;
  channelId: string;
  /** The edited message's own ts: the message whose turn the edit steers. */
  messageTs: string;
  /** Slack's `message.edited.ts`. */
  editedTs: string;
  /** The author: only the author can edit a Slack message. */
  userId: string;
  /** The new text, normalized exactly as a new message's text is. */
  text: string;
  /** The edit event's own id: its `evt:` claim. */
  eventId: string;
}

const EDIT_TURN_JOB_ID_PREFIX = 'edit:';

/** The row an edit is admitted as. It is also the row's `msg_key`, so a redelivery dedups. */
export function editTurnJobId(channelId: string, messageTs: string, editedTs: string): string {
  return `${EDIT_TURN_JOB_ID_PREFIX}${channelId}:${messageTs}:${editedTs}`;
}

/** The primary-key range holding every edit row of one message. */
export function editTurnJobIdRange(channelId: string, messageTs: string): { from: string; to: string } {
  return {
    from: `${EDIT_TURN_JOB_ID_PREFIX}${channelId}:${messageTs}:`,
    to: `${EDIT_TURN_JOB_ID_PREFIX}${channelId}:${messageTs};`,
  };
}

/** Whether a turn is an edit row's: every count of messages skips these. */
export function isEditTurn<T extends Pick<NormalizedSlackTurn, 'edit'>>(
  turn: T,
): turn is T & { edit: SlackTurnEdit } {
  return turn.edit !== undefined;
}

/** isEditTurn for a site that holds only the row's id. */
export function isEditTurnJobId(id: string): boolean {
  return id.startsWith(EDIT_TURN_JOB_ID_PREFIX);
}

/** isEditTurnJobId over `turn_jobs.id` in SQL, as a primary-key range. */
export const EDIT_TURN_JOB_ID_SQL = `(id >= '${EDIT_TURN_JOB_ID_PREFIX}' AND id < 'edit;')`;

/** One stored version of a message: its own row or one of its edit rows. */
export interface MessageVersionRow {
  id: string;
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  runId?: string;
  executionAuthority: RunExecutionAuthority;
  /** Undelivered and not held for recovery: a queued or running turn still owns it. */
  live: boolean;
}

/** Why an edit steers nothing; logged as content-free counts. */
export type SlackEditRefusal =
  /** Its message's answer is done, or the message was never addressed. */
  | 'no_live_turn'
  /** A file, command, approval, co-addressed or ledger turn, or new text that would be a command or empty. */
  | 'not_foldable'
  /** Someone other than the message's author. */
  | 'not_author'
  /** An older edit delivered after a newer one. */
  | 'stale'
  /** The same text as the newest version. */
  | 'unchanged';

export type SlackEditDecision =
  | { kind: 'refuse'; reason: SlackEditRefusal }
  | {
      kind: 'admit';
      /** The edit row, without a Run: admission adds one when the message's row has one. */
      job: Omit<TurnJob, 'runId'>;
      /** The message's Run, whose binding and presentation the edit's Run copies. */
      laneRunId?: string;
    };

/**
 * Decide an edit against its message's stored versions. Pure: it never asks
 * whether a run has read the message, since claims decide that.
 */
export function decideEdit(versions: readonly MessageVersionRow[], edit: SlackMessageEdit): SlackEditDecision {
  const refuse = (reason: SlackEditRefusal): SlackEditDecision => ({ kind: 'refuse', reason });
  const [first] = versions;
  if (!first || !versions.some((row) => row.live)) return refuse('no_live_turn');
  // An edit row carries its message's turn, so it stands in once the message's own row is purged.
  const base = versions.find((row) => !isEditTurn(row.turn)) ?? first;
  if (base.executionAuthority !== 'legacy') return refuse('not_foldable');
  if (edit.userId !== base.turn.userId || edit.workspaceId !== base.turn.workspaceId) return refuse('not_author');
  if (!foldableTurn(base.turn) || !foldableTurn({ ...base.turn, text: edit.text })) return refuse('not_foldable');
  const newest = versions.reduce((latest, row) =>
    compareSlackTs(turnRequestTs(row.turn), turnRequestTs(latest.turn)) > 0 ? row : latest);
  if (compareSlackTs(edit.editedTs, turnRequestTs(newest.turn)) <= 0) return refuse('stale');
  if (edit.text === newest.turn.text) return refuse('unchanged');
  const id = editTurnJobId(edit.channelId, edit.messageTs, edit.editedTs);
  return {
    kind: 'admit',
    job: {
      id,
      evtKey: `evt:${edit.eventId}`,
      msgKey: id,
      turn: editedTurn(base.turn, edit, newest.turn.text),
      assignment: base.assignment,
      executionAuthority: 'legacy',
    },
    ...(base.runId ? { laneRunId: base.runId } : {}),
  };
}

function editedTurn(base: NormalizedSlackTurn, edit: SlackMessageEdit, previousText: string): NormalizedSlackTurn {
  const { edit: _earlier, ...original } = base;
  return {
    ...original,
    text: edit.text,
    eventId: edit.eventId,
    // Run on its own, it follows its message's reply in that message's thread.
    ...(original.contextMode === 'channel_history' ? { contextMode: 'thread' as const } : {}),
    edit: { editedTs: edit.editedTs, previousText },
  };
}
