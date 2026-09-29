import type { SlackContextMessage, SlackTurnContext } from './thread-context.ts';
import { formatSlackFileSummary } from './message-text.ts';

export function slackContextWindowLabel(
  context: SlackTurnContext | undefined,
  fallback: string,
): string {
  return context?.window?.reason ?? context?.mode ?? fallback;
}

export function formatSlackContextRows(
  messages: SlackContextMessage[],
  options: { prefix?: string; separator: string; timezone?: string },
): string {
  return messages
    .map((message) => {
      const triggerMarker = message.isTrigger ? ' trigger' : '';
      const local = options.timezone
        ? slackLocalContextTime(message.ts, options.timezone)
        : undefined;
      const timestamp = local
        ? `${local.weekday} ${local.date} ${local.time} ${local.timezone}; ${message.ts}`
        : message.ts;
      const provenance = [
        message.role ? `role=${message.role}` : undefined,
        message.rootTs ? `root=${message.rootTs}` : undefined,
        message.replyCount ? `replies=${message.replyCount}` : undefined,
      ].filter(Boolean).join(' ');
      const files = message.files?.length
        ? `${message.text ? ' ' : ''}[files: ${message.files.map(formatSlackFileSummary).join('; ')}]`
        : '';
      return `${options.prefix ?? ''}[${timestamp}${triggerMarker}${provenance ? ` ${provenance}` : ''}] ${slackContextAuthorLabel(message)}: ${message.text}${files}`;
    })
    .join(options.separator);
}

/**
 * The author as the model sees it. People keep their Slack id beside the
 * name, so a mention or a task assignment can still use the exact id. Apps
 * and Agents are named by what they posted as; the row's role says which.
 */
export function slackContextAuthorLabel(
  message: Pick<SlackContextMessage, 'userId' | 'role' | 'authorName'>,
): string {
  const name = message.authorName ? JSON.stringify(message.authorName) : undefined;
  if (message.role === 'app' || message.role === 'agent') return name ?? message.userId;
  return name ? `${name} (${message.userId})` : message.userId;
}

export interface SlackLocalContextTime {
  date: string;
  weekday: string;
  time: string;
  timezone: string;
}

/** Format a trusted Slack timestamp in an already validated profile timezone. */
const slackContextTimeFormatters = new Map<string, Intl.DateTimeFormat>();

export function slackLocalContextTime(
  timestamp: string,
  timezone: string,
): SlackLocalContextTime | undefined {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return undefined;
  try {
    let formatter = slackContextTimeFormatters.get(timezone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
      slackContextTimeFormatters.set(timezone, formatter);
    }
    const parts = Object.fromEntries(formatter.formatToParts(seconds * 1_000)
      .map((part) => [part.type, part.value]));
    if (!parts.year || !parts.month || !parts.day || !parts.weekday ||
        !parts.hour || !parts.minute) return undefined;
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      weekday: parts.weekday,
      time: `${parts.hour}:${parts.minute}`,
      timezone,
    };
  } catch {
    return undefined;
  }
}
