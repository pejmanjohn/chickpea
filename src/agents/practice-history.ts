/**
 * The message a practice run sends its Agent (practice runs §2, FDE B1). A
 * first question goes as it is. A follow-up quotes the conversation's
 * earlier turns first: each question and reply, and under each reply one
 * line naming what that turn read, never what it returned. The state store
 * writes it from its own rows, so a client sends only the conversation's ID
 * and cannot forge an earlier reply. All of it is escaped as a person's
 * Slack text is.
 */
import type { PracticeStep, PracticeTurn } from '../management/test-run-types.ts';
import { CONNECTION_REQUEST_TOOL_NAME } from '../connections/request-tool.ts';
import { escapeSlackControlCharacters } from '../slack/message-format.ts';
import { READ_WEB_PAGE_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '../web/names.ts';
import { practiceLine } from './practice-steps.ts';

/** The quoted turns, with their heading, in UTF-8 bytes at most; the oldest turns go first. */
export const PRACTICE_HISTORY_BYTES = 48 * 1024;
/** One turn's line naming what it read, at most. */
const DIGEST_CHARS = 1_000;

/**
 * Every character a model, or code on the way to it, may read as the end of
 * a line: a lone carriage return, the Unicode separators, and the file, group
 * and record separators, where Python's `splitlines` breaks too.
 */
const LINE_BREAK = /\r\n?|[\n\v\f\x1c-\x1e\x85\u2028\u2029]/;

export const PRACTICE_HISTORY_HEADING = 'Earlier in this practice conversation (quoted):';
export const PRACTICE_NEW_QUESTION = 'New question:';

/** The message, and how many earlier turns it quotes: none for a first question, or when none fits. */
export function practiceMessage(question: string, earlier: readonly PracticeTurn[]): { message: string; quoted: number } {
  const blocks: string[] = [];
  let bytes = byteLength(PRACTICE_HISTORY_HEADING);
  for (const turn of [...earlier].reverse()) {
    const block = turnBlock(turn);
    bytes += byteLength(`\n\n${block}`);
    if (bytes > PRACTICE_HISTORY_BYTES) break;
    blocks.unshift(block);
  }
  const asked = escapeSlackControlCharacters(question);
  if (blocks.length === 0) return { message: asked, quoted: 0 };
  return {
    message: [PRACTICE_HISTORY_HEADING, ...blocks, `${PRACTICE_NEW_QUESTION}\n${asked}`].join('\n\n'),
    quoted: blocks.length,
  };
}

function turnBlock({ turn, question, reply, steps, moreSteps }: PracticeTurn): string {
  return [
    `Turn ${turn}. They asked:`, quoted(question), 'You answered:', quoted(reply),
    escapeSlackControlCharacters(practiceDigest(steps, moreSteps)),
  ].join('\n');
}

/** Every line behind `> `, so nothing quoted can stand as a line of Chickpea's own. */
function quoted(text: string): string {
  return escapeSlackControlCharacters(text).split(LINE_BREAK).map((line) => line ? `> ${line}` : '>').join('\n');
}

/**
 * What a turn read, by name and outcome, in the order it first did each:
 * `Read: Probe Board (probe_board_search, ok); Release API (GET, refused)`.
 * A request names its method; a repeat is counted, not listed again. The
 * calls past its 25 listed steps are counted at the end: `…and 7 more calls`.
 */
export function practiceDigest(steps: readonly PracticeStep[], moreSteps = 0): string {
  const entries = new Map<string, { what: string[]; times: number }>();
  for (const step of steps) {
    const what = [...digestNames(step), step.outcome];
    const key = what.join('\u0000');
    const entry = entries.get(key);
    if (entry) entry.times += 1;
    else entries.set(key, { what, times: 1 });
  }
  if (entries.size === 0) return 'Read: nothing.';
  const calls = moreSteps > 0 ? `; …and ${moreSteps} more ${moreSteps === 1 ? 'call' : 'calls'}.` : '.';
  const shown = [...entries.values()].map(({ what: [name, ...rest], times }) =>
    `${name} (${[...rest, ...times > 1 ? [`${times} times`] : []].join(', ')})`);
  let line = 'Read:';
  for (const [index, entry] of shown.entries()) {
    const left = shown.length - index - 1;
    const next = `${line}${index === 0 ? ' ' : '; '}${entry}`;
    if (`${next}${left > 0 ? `; and ${left} more` : ''}${calls}`.length > DIGEST_CHARS) return `${line}; and ${left + 1} more${calls}`;
    line = next;
  }
  return `${line}${calls}`;
}

/** [service, tool] for a call; [skill, 'skill'] for a skill load; [tool] for a call of no service. */
function digestNames(step: PracticeStep): string[] {
  if (step.kind === 'skill') return [oneLine(step.tool), 'skill'];
  // The method the settled step recorded from the call's own arguments; never read back from its cut input line.
  const tool = step.tool === CONNECTION_REQUEST_TOOL_NAME ? step.method ?? 'request' : oneLine(step.tool);
  const service = step.service ?? (step.tool === READ_WEB_PAGE_TOOL_NAME || step.tool === WEB_SEARCH_TOOL_NAME ? 'the web' : undefined);
  return service ? [oneLine(service), tool] : [tool];
}

/** A service's or tool's own name on the digest's one line: `practiceLine` keeps a NEL, which is no space to it. */
function oneLine(text: string): string {
  return practiceLine(text.split(LINE_BREAK).join(' '));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
