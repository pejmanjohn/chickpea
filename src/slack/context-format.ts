import type { SlackContextMessage, SlackTurnContext } from './thread-context.ts';

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
      return `${options.prefix ?? ''}[${timestamp}${triggerMarker}] ${message.userId}: ${message.text}`;
    })
    .join(options.separator);
}

export interface SlackLocalContextTime {
  date: string;
  weekday: string;
  time: string;
  timezone: string;
}

/** Format a trusted Slack timestamp in an already validated profile timezone. */
export function slackLocalContextTime(
  timestamp: string,
  timezone: string,
): SlackLocalContextTime | undefined {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return undefined;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US-u-ca-iso8601', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(seconds * 1_000).map((part) => [part.type, part.value]));
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
