/**
 * Who a message delivered through an Agent's own Slack app is from. In Slack
 * the app belongs to the Owner whose token made it, and Slack shows that
 * person and any collaborator they add the app's signing secret, so a
 * delivery that verifies can still name any member as its sender. A
 * message, mention, edit or delete it delivers is therefore read back from
 * Slack on the app's own bot token first, and goes on only when Slack holds
 * that message, in that conversation, from that person, with that text.
 * Loaded only for an Agent app's delivery.
 */
import { isTransientSlackApiError, slackMessageAt } from '../credentials.ts';
import { preserveSlackRichTextLinks } from '../rich-text-links.ts';
import { SlackTransportError } from '../transport/types.ts';

export type AgentAppMessageCheck = { confirmed: true } | { confirmed: false; reason: string };

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
  if (author === bot.botUserId) return { confirmed: true };
  const ts = deleted ? (event.deleted_ts ?? previous?.ts) : claimed?.ts;
  if (typeof ts !== 'string') return refused('malformed');
  const threadTs = (deleted ? previous : claimed)?.thread_ts;
  if (event.type === 'app_mention' && !String(claimed?.text ?? '').includes(`<@${bot.botUserId}`)) {
    return refused('not_a_mention');
  }

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
  if (deleted) return held && held.subtype !== 'tombstone' ? refused('still_in_slack') : { confirmed: true };
  if (!held || !claimed) return refused('not_in_slack');
  if (held.user !== claimed.user) return refused('other_sender');
  if (threadOf(held) !== threadOf(claimed)) return refused('other_thread');
  if (readable(held) !== readable(claimed)) return refused('other_text');
  if (fileIds(held) !== fileIds(claimed)) return refused('other_files');
  return { confirmed: true };
}

function record(value: unknown): Message | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Message : undefined;
}

/** A thread's parent carries its own ts as `thread_ts` in Slack's copy, and none in its event. */
function threadOf(message: Message): unknown {
  return message.thread_ts ?? message.ts;
}

/** The text admission reads: Slack's fallback text with the links of its rich text. */
function readable(message: Message): string {
  return preserveSlackRichTextLinks(typeof message.text === 'string' ? message.text : undefined, message.blocks);
}

function fileIds(message: Message): string {
  const files = Array.isArray(message.files) ? message.files : [];
  return files.map((file) => String(record(file)?.id)).join(',');
}
