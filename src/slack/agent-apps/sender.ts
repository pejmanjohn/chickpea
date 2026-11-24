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
 * be read back, but the card it was made on can (agentAppCardRefused).
 * Loaded only for an Agent app's delivery.
 */
import {
  isTransientSlackApiError, SLACK_TRUTH_FETCH_TIMEOUT_MS, slackMessageAt, type SlackMessageReadResult,
} from '../credentials.ts';
import { slackMessageChangeIsEmpty } from '../message-change.ts';
import { SlackTransportError } from '../transport/types.ts';
import { createSlackWebClient } from '../web-client.ts';
import type { UiSurfaceRecord } from '../ui/surface.ts';
import type { AgentAppBotCredentials } from './live.ts';

/**
 * `event` is what admission reads in the delivery's place. A refusal with no reason is dropped without a line. One
 * `unanswered` is a read Slack did not answer in time: it fails the delivery, after asking the person at `noticeAt`.
 */
export type AgentAppMessageCheck =
  | { confirmed: true; event: Message }
  | { confirmed: false; reason: string | undefined }
  | { confirmed: false; reason: string; unanswered: { retryAfterMs: number | undefined; noticeAt: MessagePlace | undefined } };

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
 * How long a message's check may take from its first read, reads and pauses together. The host has already
 * acknowledged the delivery, so Slack never sends it again, and it serves the delivery only in the time its platform
 * leaves after that answer (30 seconds on Cloudflare). Twelve seconds outlasts a usual Retry-After and a short outage,
 * and leaves the notice and admission more than they need: a person whose message cannot be read is told within
 * about seventeen seconds.
 */
const CHECK_DEADLINE_MS = 12_000;
/** A pause is taken only when it leaves at least this before the deadline for the read after it. */
const READ_ROOM_MS = 1_000;
/** The notice is posted within this, or not at all. */
const NOTICE_TIMEOUT_MS = 5_000;
/** The first pause after a read Slack did not answer and named no wait; each later one doubles. */
const FIRST_BACKOFF_MS = 250;
/** What the Agent's bot says in a person's thread when Slack would not let it read their message. */
export const UNREAD_MESSAGE_NOTICE = "I couldn't read your message just now, so please send it again.";
/** A press is acknowledged, and a modal opened from it, within Slack's three seconds: its read waits for no more. */
const CARD_READ_TIMEOUT_MS = 2_000;

const refused = (reason: string | undefined): AgentAppMessageCheck => ({ confirmed: false, reason });

/**
 * A message an Agent app delivers names its sender, and whoever holds the
 * app's secrets can name anyone: it goes on only once Slack shows that
 * message from that person, and as Slack's copy of it. Undefined for one it
 * stops, with one line and no content (none for an edit of the app's own
 * bot); a read Slack still does not answer by the check's deadline is logged,
 * then noticed, and thrown, and the delivery ends as a failure.
 */
export async function agentAppMessageConfirmed(
  event: unknown,
  bot: AgentAppBotCredentials,
  appId: string,
): Promise<Message | undefined> {
  const warn = (reason: string) => console.warn(JSON.stringify({
    component: 'agent_apps', event: 'delivery_not_confirmed', appId, reason,
  }));
  let check: AgentAppMessageCheck;
  try {
    check = await confirmAgentAppMessage(event, bot);
  } catch (error) {
    warn('unavailable');
    throw error;
  }
  if (check.confirmed) return check.event;
  if (check.reason) warn(check.reason);
  if (!('unanswered' in check)) return undefined;
  // After the line, which then stands if the host's time runs out while the notice is posted.
  if (check.unanswered.noticeAt) await postUnreadNotice(bot.botToken, check.unanswered.noticeAt);
  const { retryAfterMs } = check.unanswered;
  throw new SlackTransportError('message confirmation', check.reason, {
    retryable: true, effectOutcome: 'failed', ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/**
 * Slack sends a card's presses only to the app whose bot posted it, so one an
 * Agent's app delivers is honored only for a card its own bot posted. An
 * app's bot posts only its own Agent's cards, so the stored `card` it names,
 * when it names one, must be that Agent's: a card not pressed before has no
 * message stored to hold the press to. The message at `place` must then be
 * one Slack shows that bot posted. Any other is refused with one line and no
 * content, `unread` when Slack could not be asked, so it may be a real one.
 * Undefined for one that is honored.
 */
export async function agentAppCardRefused(
  card: Pick<UiSurfaceRecord, 'agentId'> | undefined,
  place: { channelId: string; messageTs: string; threadTs?: string | null } | undefined,
  bot: AgentAppBotCredentials,
): Promise<{ unread: boolean } | undefined> {
  const reason = card && card.agentId !== bot.agentId
    ? 'other_agent'
    : place ? await agentAppCardRefusal(place, bot, bot.appId) : 'no_card';
  if (!reason) return undefined;
  console.warn(JSON.stringify({ component: 'agent_apps', event: 'interaction_refused', appId: bot.appId, reason }));
  return { unread: isTransientSlackApiError(reason) };
}

/**
 * Whether Slack holds what a `message` or `app_mention` event delivered
 * through an Agent's app says it holds. Its app subscribes to messages in its
 * own DM and to mentions of its bot, so anything else it delivers is refused
 * unread. A read Slack does not answer (an outage, a rate limit) is made again
 * until the check's deadline, then is `unanswered`: nothing is trusted, and a
 * new message or mention names its thread, where the Agent's bot asks the
 * person to send it again.
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
  // Slack sends an edit each time a reply changes its message's thread counts. One whose own two bodies agree on all
  // that is acted on would start nothing once read, so it is not read: dropping it admits nothing, whoever sent it.
  if (changed && claimed && previous && slackMessageChangeIsEmpty(claimed, previous)) return refused(undefined);
  const ts = deleted ? (event.deleted_ts ?? previous?.ts) : claimed?.ts;
  if (typeof ts !== 'string') return refused('malformed');
  // An older real message delivered again could outlive its claim and start a second turn. An edit steers only a
  // live turn, and a delete is the same delete again.
  if (!deleted && !changed && Date.now() - slackTsMs(ts) > STALE_AFTER_MS) return refused('stale');
  const threadTs = (deleted ? previous : claimed)?.thread_ts;
  const place = { channelId, ts, ...(typeof threadTs === 'string' ? { threadTs } : {}) };

  const deadline = Date.now() + CHECK_DEADLINE_MS;
  let read = await readMessage(bot.botToken, place, deadline);
  if (!deleted && read.ok && !read.message && Math.abs(Date.now() - slackTsMs(ts)) < JUST_SENT_MS &&
      await pausedBefore(deadline, REREAD_AFTER_MS)) {
    read = await readMessage(bot.botToken, place, deadline);
  }
  if (!read.ok) {
    const code = read.error ?? 'invalid_response';
    if (!isTransientSlackApiError(code)) return refused(code);
    // The notice goes where the delivery says, unconfirmed: it carries none of the delivery, names nobody, and is
    // posted with the app's own token, which whoever could forge the delivery already holds.
    return { confirmed: false, reason: code, unanswered: { retryAfterMs: read.retryAfterMs, noticeAt: deleted || changed ? undefined : place } };
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
async function agentAppCardRefusal(
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

/**
 * A read Slack did not answer is made again after Slack's Retry-After or a backoff, whichever is longer, while that
 * pause ends before `deadline` with room for the read. Each read gives up by `deadline`. A refusal that is not
 * transient is never read again.
 */
async function readMessage(botToken: string, place: MessagePlace, deadline: number): Promise<SlackMessageReadResult> {
  const readOnce = () => slackMessageAt(botToken, place, {
    timeoutMs: Math.min(SLACK_TRUTH_FETCH_TIMEOUT_MS, deadline - Date.now()),
  });
  let read = await readOnce();
  for (let backoff = FIRST_BACKOFF_MS; !read.ok && isTransientSlackApiError(read.error); backoff *= 2) {
    if (!await pausedBefore(deadline, Math.max(read.retryAfterMs ?? 0, backoff))) break;
    read = await readOnce();
  }
  return read;
}

/** Pauses `ms` when that leaves a read room before `deadline`, and says whether it did. */
async function pausedBefore(deadline: number, ms: number): Promise<boolean> {
  if (Date.now() + ms + READ_ROOM_MS > deadline) return false;
  await pause(ms);
  return true;
}

/** Posted once, in the message's thread; a notice Slack does not take in time is left at that. */
async function postUnreadNotice(botToken: string, place: MessagePlace): Promise<void> {
  await createSlackWebClient(botToken, { rejectRateLimitedCalls: true, timeoutMs: NOTICE_TIMEOUT_MS }).chat.postMessage({
    channel: place.channelId, thread_ts: place.threadTs ?? place.ts, text: UNREAD_MESSAGE_NOTICE,
  }).catch(() => undefined);
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
