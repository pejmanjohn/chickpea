/**
 * A card set rides in the Agent's answer message, so redrawing it rewrites
 * that message with `chat.update`, which replaces every block. The set's own
 * blocks come from its record; everything else (the answer, other
 * components, the footer) is put back exactly as Slack holds it: from the
 * click, else from the set's stored copy, else read from the thread.
 *
 * The edit sends blocks only. Slack refuses an edit whose `text` runs past
 * about 4,000 characters (`msg_too_long`), and without one it rebuilds the
 * text from the blocks, as it did for the streamed answer.
 */
import { isRecord } from '../../security/content-validation.ts';
import type { SlackStateStore } from '../claim-store.ts';
import { slackPlatformErrorCode } from '../errors.ts';
import { isSlackRateLimitError, slackRetryAfterMs, type SlackReadGate } from '../read-budget.ts';
import { checkSlackBlocks } from './block-kit-limits.ts';
import type { SlackUiMessage } from './interaction-payload.ts';
import { CARD_STATUS_BLOCK, CARD_STATUS_LINES, renderCardSet } from './render-display.ts';
import { uiBlockId, type UiSurfaceRecord } from './surface.ts';

type Block = Record<string, unknown>;

/** Slack's clock is not ours: the message may carry a timestamp a little before the set was stored. */
const CLOCK_SKEW_MS = 60_000;
/** One read. A shared app's thread reads return at most 15 messages. */
const READ_LIMIT = 15;
const MAX_MESSAGE_BLOCKS = 50;

/** Why a redraw edited nothing. Content-free, for the log line. */
export type CardSetRedrawSkip =
  | 'read_budget'
  | 'read_rate_limited'
  | 'read_failed'
  | 'not_in_thread'
  | 'set_not_in_message'
  | 'block_check'
  | 'block_limit';

export interface CardSetRedraw {
  blocks: Block[];
}

export interface SlackRepliesClient {
  conversations: {
    replies(input: { channel: string; ts: string; oldest: string; inclusive: true; limit: number }): Promise<unknown>;
  };
}

/**
 * The message's blocks with the set's card or carousel block and its status
 * lines drawn from the record; the status lines are left out when the
 * message has no room for them. A skip reason when the message does not
 * carry the set, or the result would not pass the Block Kit checker.
 */
export function cardSetMessageBlocks(
  message: SlackUiMessage,
  record: UiSurfaceRecord,
): CardSetRedraw | CardSetRedrawSkip {
  const setId = uiBlockId('ui', record.id, 1);
  const statusIds = new Set(Array.from({ length: CARD_STATUS_LINES }, (_, line) => uiBlockId('ui', record.id, CARD_STATUS_BLOCK + line)));
  const isStatus = (block: Block) => typeof block.block_id === 'string' && statusIds.has(block.block_id);
  const kept = message.blocks.filter((block) => !isStatus(block));
  const at = kept.findIndex((block) => block.block_id === setId);
  if (at < 0) return 'set_not_in_message';
  // The caption has no id; it is the stored caption and stays where it is.
  const drawn = renderCardSet(record).blocks.filter((block) => block.block_id === setId || isStatus(block));
  const check = checkSlackBlocks(drawn);
  if (!check.ok) {
    console.error('[chickpea] card set redraw failed the Block Kit check', { issues: check.issues.slice(0, 5) });
    return 'block_check';
  }
  const fits = kept.length - 1 + drawn.length <= MAX_MESSAGE_BLOCKS
    ? drawn
    : drawn.filter((block) => !isStatus(block));
  const blocks = [...kept.slice(0, at), ...fits, ...kept.slice(at + 1)];
  if (blocks.length > MAX_MESSAGE_BLOCKS) return 'block_limit';
  return { blocks };
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
): Promise<SlackUiMessage | CardSetRedrawSkip> {
  if (!(await gate.reserve('conversations.replies')).ok) return 'read_budget';
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
    if (!isSlackRateLimitError(error)) return 'read_failed';
    await gate.rateLimited('conversations.replies', slackRetryAfterMs(error));
    return 'read_rate_limited';
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
  return 'not_in_thread';
}

/**
 * Redraw a card set inside its answer message, from the clicked message,
 * else the set's stored copy, else one read. What was sent becomes the copy
 * (what was read or clicked, when Slack refused the edit), so the next
 * redraw reads nothing. Returns whether Slack took the edit. A redraw that
 * edits nothing logs one line saying why, with no message content, and
 * never throws, so it cannot undo the click or the outcome that asked for it.
 */
export async function redrawCardSet(input: {
  state: Pick<SlackStateStore, 'executeUiSurface'>;
  surface: UiSurfaceRecord;
  /** The message a direct click carried, as Slack holds it now. */
  clicked?: SlackUiMessage;
  read: () => Promise<SlackUiMessage | CardSetRedrawSkip>;
  update: (messageTs: string, rendered: CardSetRedraw) => Promise<void>;
}): Promise<boolean> {
  const { surface } = input;
  const keep = async (message: SlackUiMessage) => {
    try {
      await input.state.executeUiSurface?.({ kind: 'bind_surface_message', id: surface.id, messageTs: message.ts, message });
    } catch {
      console.warn('[chickpea] card set answer copy not kept');
    }
  };
  const skip = (reason: CardSetRedrawSkip) => {
    console.warn('[chickpea] card set redraw skipped', { reason });
    return false;
  };
  let message: SlackUiMessage | undefined;
  try {
    const found = input.clicked ?? surface.answerMessage ?? await input.read();
    if (typeof found === 'string') return skip(found);
    message = found;
    const rendered = cardSetMessageBlocks(message, surface);
    if (typeof rendered === 'string') return skip(rendered);
    await input.update(message.ts, rendered);
    await keep({ ts: message.ts, ...rendered });
    return true;
  } catch (error) {
    console.warn('[chickpea] card set redraw failed', { error: slackPlatformErrorCode(error) ?? 'unknown' });
    // Slack refused the edit; the message as clicked or read still holds.
    if (message && message !== surface.answerMessage) await keep(message);
    return false;
  }
}
