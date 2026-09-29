import { SLACK_CHANNEL_ID } from '../ui/text.ts';
import { SlackReadError } from './errors.ts';

/** A Slack conversation, optionally one message in it, named by id or link. */
export interface SlackReadTarget {
  channelId: string;
  /** A message timestamp: a thread root or any reply in it. */
  ts?: string;
  /** The thread root, when the link says which thread the message is in. */
  threadTs?: string;
}

export const SLACK_MESSAGE_TS = /^\d{1,12}\.\d{1,6}$/;
const MAX_LINK_CHARS = 2_048;

/**
 * Parse a Slack message or channel link into a conversation and message.
 * Accepts the permalink form Slack copies (`/archives/C…/p…?thread_ts=…`),
 * a channel link (`/archives/C…`), and the web client form
 * (`app.slack.com/client/T…/C…[/thread/C…-ts]`), with or without Slack's
 * `<url|label>` wrapping. The link grants nothing: the caller authorizes the
 * conversation it names like any other.
 */
export function parseSlackLink(raw: string): SlackReadTarget {
  const trimmed = raw.trim().replace(/^<([^|>]+)(\|[^>]*)?>$/, '$1');
  if (!trimmed || trimmed.length > MAX_LINK_CHARS) throw new SlackReadError('invalid_link');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SlackReadError('invalid_link');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      (host !== 'slack.com' && !host.endsWith('.slack.com'))) {
    throw new SlackReadError('invalid_link');
  }
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'archives' && parts[1]) {
    const channelId = linkConversationId(parts[1]);
    const permalink = parts[2] ? /^p(\d{10})(\d{6})$/.exec(parts[2]) : undefined;
    if (parts[2] && !permalink) throw new SlackReadError('invalid_link');
    const threadTs = url.searchParams.get('thread_ts') ?? undefined;
    if (threadTs !== undefined && !SLACK_MESSAGE_TS.test(threadTs)) throw new SlackReadError('invalid_link');
    return {
      channelId,
      ...(permalink ? { ts: `${permalink[1]}.${permalink[2]}` } : {}),
      ...(threadTs ? { threadTs } : {}),
    };
  }
  if (parts[0] === 'client' && parts[2]) {
    const channelId = linkConversationId(parts[2]);
    if (parts[3] === 'thread' && parts[4]) {
      // `C…-ts`: the thread's channel and its root.
      const [threadChannel, threadTs, ...rest] = parts[4].split('-');
      if (rest.length || threadChannel !== channelId || !threadTs || !SLACK_MESSAGE_TS.test(threadTs)) {
        throw new SlackReadError('invalid_link');
      }
      return { channelId, ts: threadTs, threadTs };
    }
    return { channelId };
  }
  throw new SlackReadError('invalid_link');
}

/** A target from either a link or explicit ids; exactly one form. */
export function resolveSlackReadTarget(input: {
  link?: string | undefined;
  channel?: string | undefined;
  ts?: string | undefined;
}): SlackReadTarget {
  if (input.link !== undefined) {
    if (input.channel !== undefined || input.ts !== undefined) {
      throw new SlackReadError('invalid_target', 'Pass either a Slack link or a channel id, not both.');
    }
    return parseSlackLink(input.link);
  }
  if (input.channel === undefined) {
    throw new SlackReadError('invalid_target', 'Pass a Slack link or a channel id.');
  }
  return {
    channelId: conversationId(channelFromMention(input.channel)),
    ...(input.ts !== undefined ? { ts: messageTs(input.ts) } : {}),
  };
}

function linkConversationId(value: string): string {
  if (!SLACK_CHANNEL_ID.test(value)) throw new SlackReadError('invalid_link');
  return value;
}

/** `<#C123|name>` as Slack writes a channel mention, or a bare id. */
function channelFromMention(value: string): string {
  const trimmed = value.trim();
  return /^<#([^|>]+)(\|[^>]*)?>$/.exec(trimmed)?.[1] ?? trimmed;
}

function conversationId(value: string): string {
  if (!SLACK_CHANNEL_ID.test(value)) {
    throw new SlackReadError('invalid_target', 'That is not a Slack conversation id. Channel ids start with C or G.');
  }
  return value;
}

function messageTs(value: string): string {
  if (!SLACK_MESSAGE_TS.test(value)) {
    throw new SlackReadError('invalid_target', 'That is not a Slack message timestamp.');
  }
  return value;
}
