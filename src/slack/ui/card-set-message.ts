/**
 * A card set rides in the Agent's answer message, so redrawing it rewrites
 * that message with `chat.update`, which replaces every block. The set's own
 * blocks come from its record; everything else (the answer, other
 * components, the footer) is put back exactly as Slack holds it: from the
 * click, else from the set's stored copy, else read from the thread.
 */
import { isRecord } from '../../security/content-validation.ts';
import type { SlackStateStore } from '../claim-store.ts';
import { isSlackRateLimitError, slackRetryAfterMs, type SlackReadGate } from '../read-budget.ts';
import { checkSlackBlocks } from './block-kit-limits.ts';
import type { SlackUiMessage } from './interaction-payload.ts';
import { CARD_STATUS_BLOCK, renderCardSet } from './render-display.ts';
import { uiBlockId, type UiSurfaceRecord } from './surface.ts';

type Block = Record<string, unknown>;

/** Slack's clock is not ours: the message may carry a timestamp a little before the set was stored. */
const CLOCK_SKEW_MS = 60_000;
/** One read. A shared app's thread reads return at most 15 messages. */
const READ_LIMIT = 15;
const MAX_MESSAGE_BLOCKS = 50;

export interface SlackRepliesClient {
  conversations: {
    replies(input: { channel: string; ts: string; oldest: string; inclusive: true; limit: number }): Promise<unknown>;
  };
}

/**
 * The message with the set's card or carousel block and its status line
 * drawn from the record; the status line is left out when the message has no
 * room for it. Undefined when the message does not carry the set, or the
 * result would not pass the Block Kit checker.
 */
export function cardSetMessageBlocks(
  message: SlackUiMessage,
  record: UiSurfaceRecord,
): { text?: string; blocks: Block[] } | undefined {
  const setId = uiBlockId('ui', record.id, 1);
  const statusId = uiBlockId('ui', record.id, CARD_STATUS_BLOCK);
  const kept = message.blocks.filter((block) => block.block_id !== statusId);
  const at = kept.findIndex((block) => block.block_id === setId);
  if (at < 0) return undefined;
  // The caption has no id; it is the stored caption and stays where it is.
  const drawn = renderCardSet(record).blocks.filter((block) => block.block_id === setId || block.block_id === statusId);
  const check = checkSlackBlocks(drawn);
  if (!check.ok) {
    console.error('[chickpea] card set redraw failed the Block Kit check', { issues: check.issues.slice(0, 5) });
    return undefined;
  }
  const fits = kept.length - 1 + drawn.length <= MAX_MESSAGE_BLOCKS
    ? drawn
    : drawn.filter((block) => block.block_id !== statusId);
  const blocks = [...kept.slice(0, at), ...fits, ...kept.slice(at + 1)];
  if (blocks.length > MAX_MESSAGE_BLOCKS) return undefined;
  return { ...(message.text !== undefined ? { text: message.text } : {}), blocks };
}

function slackTsAt(ms: number): string {
  return `${Math.floor(Math.max(0, ms) / 1000)}.000000`;
}

/**
 * Read the message that carries the set: by its timestamp once bound, else
 * the first message after the set was stored that holds its block (the last
 * part of a split answer). One read, within the shared read budget.
 */
export async function readCardSetMessage(
  client: SlackRepliesClient,
  gate: SlackReadGate,
  record: UiSurfaceRecord,
): Promise<SlackUiMessage | undefined> {
  if (!(await gate.reserve('conversations.replies')).ok) return undefined;
  let response: unknown;
  try {
    response = await client.conversations.replies({
      channel: record.channelId,
      ts: record.threadTs,
      oldest: record.messageTs ?? slackTsAt(record.createdAt - CLOCK_SKEW_MS),
      inclusive: true,
      limit: READ_LIMIT,
    });
  } catch (error) {
    if (isSlackRateLimitError(error)) await gate.rateLimited('conversations.replies', slackRetryAfterMs(error));
    return undefined;
  }
  const messages = isRecord(response) && Array.isArray(response.messages) ? response.messages : [];
  const setId = uiBlockId('ui', record.id, 1);
  for (const message of messages) {
    if (!isRecord(message) || typeof message.ts !== 'string' || !Array.isArray(message.blocks)) continue;
    const blocks = message.blocks.filter(isRecord);
    const carries = record.messageTs
      ? message.ts === record.messageTs
      : blocks.some((block) => block.block_id === setId);
    if (!carries) continue;
    return { ts: message.ts, ...(typeof message.text === 'string' ? { text: message.text } : {}), blocks };
  }
  return undefined;
}

/**
 * Redraw a card set inside its answer message, from the clicked message,
 * else the set's stored copy, else one read. What was sent becomes the copy
 * (what was read or clicked, when Slack refused the edit), so the next
 * redraw reads nothing. Returns whether Slack took the edit; a failure is
 * logged and never thrown, so it cannot undo the click or the outcome that
 * asked for it.
 */
export async function redrawCardSet(input: {
  state: Pick<SlackStateStore, 'executeUiSurface'>;
  surface: UiSurfaceRecord;
  /** The message a direct click carried, as Slack holds it now. */
  clicked?: SlackUiMessage;
  read: () => Promise<SlackUiMessage | undefined>;
  update: (messageTs: string, rendered: { text?: string; blocks: Block[] }) => Promise<void>;
}): Promise<boolean> {
  const { surface } = input;
  const keep = async (message: SlackUiMessage) => {
    try {
      await input.state.executeUiSurface?.({ kind: 'bind_surface_message', id: surface.id, messageTs: message.ts, message });
    } catch {
      console.warn('[chickpea] card set answer copy not kept');
    }
  };
  let message: SlackUiMessage | undefined;
  try {
    message = input.clicked ?? surface.answerMessage ?? await input.read();
    const rendered = message && cardSetMessageBlocks(message, surface);
    if (!message || !rendered) {
      console.warn('[chickpea] card set redraw skipped: answer message unavailable');
      return false;
    }
    await input.update(message.ts, rendered);
    await keep({ ts: message.ts, ...rendered });
    return true;
  } catch {
    console.warn('[chickpea] card set redraw failed');
    // Slack refused the edit; the message as clicked or read still holds.
    if (message && message !== surface.answerMessage) await keep(message);
    return false;
  }
}
