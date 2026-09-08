import type { SlackContextMessage, SlackTurnContext } from './thread-context.ts';

export function slackContextWindowLabel(
  context: SlackTurnContext | undefined,
  fallback: string,
): string {
  return context?.window?.reason ?? context?.mode ?? fallback;
}

export function formatSlackContextRows(
  messages: SlackContextMessage[],
  options: { prefix?: string; separator: string },
): string {
  return messages
    .map((message) => {
      const triggerMarker = message.isTrigger ? ' trigger' : '';
      return `${options.prefix ?? ''}[${message.ts}${triggerMarker}] ${message.userId}: ${message.text}`;
    })
    .join(options.separator);
}
