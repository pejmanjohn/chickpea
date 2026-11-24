/**
 * Who a message delivered through an Agent's own Slack app is from. In Slack
 * the app belongs to the Owner whose token made it, and Slack shows that
 * person and any collaborator they add the app's signing secret, so a
 * delivery that verifies can still name any member as its sender. A
 * message, mention, edit or delete it delivers is therefore read back from
 * Slack on the app's own bot token first, and goes on only when Slack holds
 * that message, in that conversation and thread, from that person. What goes
 * on is Slack's copy: the delivery's text, rich text and files are never
 * read, so an edit Slack already holds is admitted as edited. A press cannot
 * be read back, but the card it was made on can (agentAppCardRefusal).
 * Loaded only for an Agent app's delivery.
 */
import { isTransientSlackApiError, slackMessageAt, type SlackMessageReadResult } from '../credentials.ts';
import { SlackTransportError } from '../transport/types.ts';

/** `event` is what admission reads in the delivery's place. A refusal with no reason is dropped without a line. */
export type AgentAppMessageCheck = { confirmed: true; event: Message } | { confirmed: false; reason: string | undefined };

type Message = Record<string, unknown>;
type MessagePlace = { channelId: string; ts: string; threadTs?: string };

/**
 * Half the life of a message's claim (two hours from its admission, longer while its turn is unfinished), so a
 * message young enough to pass still holds it.
 */
const STALE_AFTER_MS = 60 * 60_000;
/** A message this young that Slack does not show yet is read once more, after a pause. */
const JUST_SENT_MS = 10_000;
const REREAD_AFTER_MS = 500;
/**
 * All a message's check may pause, for a rate limit waited out and a re-read together: Slack sends a delivery again
 * after three seconds without its acknowledgement, and the pauses alone stay well inside that.
 */
const PAUSE_BUDGET_MS = 1_500;
/** A press is acknowledged, and a modal opened from it, within Slack's three seconds: its read waits for no more. */
const CARD_READ_TIMEOUT_MS = 2_000;

const refused = (reason: string | undefined): AgentAppMessageCheck => ({ confirmed: false, reason });

/**
 * Whether Slack holds what a `message` or `app_mention` event delivered
 * through an Agent's app says it holds. Its app subscribes to messages in its
 * own DM and to mentions of its bot, so anything else it delivers is refused
 * unread. A read Slack does not answer (an outage, a rate limit) throws a
 * retryable `SlackTransportError`: the delivery is retried, never trusted.
 */
export async function confirmAgentAppMessage(
  delivered: unknown,
  bot: { botToken: string; botUserId: string },
): Promise<AgentAppMessageCheck> {
  const event = record(delivered) ?? {};
  const channelId = typeof event.channel === 'string' ? event.channel : undefined;
  if (!channelId) return refused('malformed');
  // Admission takes a DM, a Channel or a group DM from the delivery's channel_type: it must be the conversation's.
  if ((event.channel_type === 'im') !== channelId.startsWith('D')) return refused('conversation_mismatch');
  if (event.type === 'message' && event.channel_type !== 'im') return refused('not_subscribed');
  if (event.type !== 'message' && event.type !== 'app_mention') return refused('not_subscribed');

  const deleted = event.type === 'message' && event.subtype === 'message_deleted';
  const changed = event.type === 'message' && event.subtype === 'message_changed';
  const previous = record(event.previous_message);
  const claimed = deleted ? undefined : changed ? record(event.message) : event;
  if (!deleted && claimed?.user === bot.botUserId) {
    // A post of the app's own bot, which whoever holds its secrets can already make, starts nothing. Its edits go no
    // further: Chickpea records what an Agent posts and updates as it does so, and an edit acts on whichever message
    // its ts names.
    return changed ? refused(undefined) : { confirmed: true, event };
  }
  const ts = deleted ? (event.deleted_ts ?? previous?.ts) : claimed?.ts;
  if (typeof ts !== 'string') return refused('malformed');
  // An older real message delivered again could outlive its claim and start a second turn. An edit steers only a
  // live turn, and a delete is the same delete again.
  if (!deleted && !changed && Date.now() - slackTsMs(ts) > STALE_AFTER_MS) return refused('stale');
  const threadTs = (deleted ? previous : claimed)?.thread_ts;
  const place = { channelId, ts, ...(typeof threadTs === 'string' ? { threadTs } : {}) };

  let budget = PAUSE_BUDGET_MS;
  const pauseWithin = async (ms: number): Promise<boolean> => {
    if (ms > budget) return false;
    budget -= ms;
    await pause(ms);
    return true;
  };
  let read = await readMessage(bot.botToken, place, pauseWithin);
  if (!deleted && read.ok && !read.message && Math.abs(Date.now() - slackTsMs(ts)) < JUST_SENT_MS &&
      await pauseWithin(REREAD_AFTER_MS)) {
    read = await readMessage(bot.botToken, place, pauseWithin);
  }
  if (!read.ok) {
    const code = read.error ?? 'invalid_response';
    if (isTransientSlackApiError(code)) {
      throw new SlackTransportError('message confirmation', code, {
        retryable: true, effectOutcome: 'failed', ...(read.retryAfterMs === undefined ? {} : { retryAfterMs: read.retryAfterMs }),
      });
    }
    return refused(code);
  }
  const held = read.message;
  if (deleted) return held && held.subtype !== 'tombstone' ? refused('still_in_slack') : { confirmed: true, event };
  if (!held || !claimed) return refused('not_in_slack');
  if (held.subtype === 'tombstone') return refused('deleted');
  if (held.user !== claimed.user) return refused('other_sender');
  if (threadOf(held) !== threadOf(claimed)) return refused('other_thread');
  if (event.type === 'app_mention' && !String(held.text ?? '').includes(`<@${bot.botUserId}`)) return refused('not_a_mention');

  // A top-level message carries no `thread_ts` in its event, and Slack's copy gains one with its first reply.
  const { thread_ts: _thread, ...copy } = held;
  const message = typeof claimed.thread_ts === 'string' ? { ...copy, thread_ts: claimed.thread_ts } : copy;
  // Of the delivery, only what kind of event it is and where it happened go on. An edit's earlier text stays the
  // delivery's: it only decides whether Slack's copy counts as changed.
  const { type, channel_type, event_ts } = event;
  const where = { type, channel: channelId, channel_type, event_ts };
  return {
    confirmed: true,
    event: claimed === event
      ? { ...message, ...where }
      : { ...where, subtype: event.subtype, ts: event.ts, message, previous_message: event.previous_message },
  };
}

/**
 * Why a press or modal submission delivered through an Agent's app is not
 * honored, or undefined when it is: Slack sends a card's presses, and the
 * submission of a modal a press opened, only to the app whose bot posted the
 * card, so the card must be one Slack shows that app's own bot posted. Slack
 * does not send a press again, so a read it does not answer refuses it, with
 * Slack's transient error as the reason; the read waits out no rate limit.
 */
export async function agentAppCardRefusal(
  card: { channelId: string; messageTs: string; threadTs?: string | null | undefined },
  bot: { botToken: string; botUserId: string },
  appId: string,
): Promise<string | undefined> {
  const read = await slackMessageAt(bot.botToken, {
    channelId: card.channelId, ts: card.messageTs, ...(card.threadTs ? { threadTs: card.threadTs } : {}),
  }, { timeoutMs: CARD_READ_TIMEOUT_MS });
  if (!read.ok) return read.error ?? 'invalid_response';
  if (!read.message) return 'not_in_slack';
  return read.message.user === bot.botUserId || read.message.app_id === appId ? undefined : 'other_poster';
}

/** A read whose rate limit fits in what is left of the check's pauses is waited out, and made once more. */
async function readMessage(
  botToken: string,
  place: MessagePlace,
  pauseWithin: (ms: number) => Promise<boolean>,
): Promise<SlackMessageReadResult> {
  const read = await slackMessageAt(botToken, place);
  if (read.ok || read.error !== 'ratelimited' || read.retryAfterMs === undefined || !await pauseWithin(read.retryAfterMs)) return read;
  return slackMessageAt(botToken, place);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slackTsMs(ts: string): number {
  return Number(ts) * 1_000;
}

function record(value: unknown): Message | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Message : undefined;
}

/** A thread's parent carries its own ts as `thread_ts` in Slack's copy, and none in its event. */
function threadOf(message: Message): unknown {
  return message.thread_ts ?? message.ts;
}
