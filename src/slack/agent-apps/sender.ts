/**
 * Who a message delivered through an Agent's own Slack app is from. In Slack
 * the app belongs to the Owner whose token made it, and Slack shows that
 * person and any collaborator they add the app's signing secret, so a
 * delivery that verifies can still name any member as its sender. A
 * message, mention, edit or delete it delivers is therefore read back from
 * Slack on the app's own bot token first, and goes on only when Slack holds
 * that message, in that conversation and thread, from that person. What goes
 * on is Slack's copy: the delivery's text, rich text and files are never
 * read, so an edit Slack already holds is admitted as edited.
 * Loaded only for an Agent app's delivery.
 */
import { isTransientSlackApiError, slackMessageAt } from '../credentials.ts';
import { SlackTransportError } from '../transport/types.ts';

/** `event` is what admission reads in the delivery's place. */
export type AgentAppMessageCheck = { confirmed: true; event: Message } | { confirmed: false; reason: string };

type Message = Record<string, unknown>;

const refused = (reason: string): AgentAppMessageCheck => ({ confirmed: false, reason });

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
  // An Agent app holds no group DM history, so Slack cannot show it a group DM's message.
  if (event.channel_type === 'mpim') return refused('group_dm');
  // Admission takes a DM, a Channel or a group DM from the delivery's channel_type: it must be the conversation's.
  if ((event.channel_type === 'im') !== channelId.startsWith('D')) return refused('conversation_mismatch');
  if (event.type === 'message' && event.channel_type !== 'im') return refused('not_subscribed');
  if (event.type !== 'message' && event.type !== 'app_mention') return refused('not_subscribed');

  const deleted = event.type === 'message' && event.subtype === 'message_deleted';
  const previous = record(event.previous_message);
  const claimed = deleted
    ? undefined
    : event.type === 'message' && event.subtype === 'message_changed' ? record(event.message) : event;
  const author = deleted ? previous?.user : claimed?.user;
  // The app's own bot's posts and their stream updates: whoever holds its secrets can already post as it.
  if (author === bot.botUserId) return { confirmed: true, event };
  const ts = deleted ? (event.deleted_ts ?? previous?.ts) : claimed?.ts;
  if (typeof ts !== 'string') return refused('malformed');
  const threadTs = (deleted ? previous : claimed)?.thread_ts;

  const read = await slackMessageAt(bot.botToken, {
    channelId, ts, ...(typeof threadTs === 'string' ? { threadTs } : {}),
  });
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

function record(value: unknown): Message | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Message : undefined;
}

/** A thread's parent carries its own ts as `thread_ts` in Slack's copy, and none in its event. */
function threadOf(message: Message): unknown {
  return message.thread_ts ?? message.ts;
}
