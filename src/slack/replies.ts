import { toolActivityStatus, type ActivityStatus } from '../activity/status.ts';

export type SlackStatusUpdate = ActivityStatus;

// Slack rendering stays here while activity semantics live in the shared
// activity layer. The compatibility helper has no profile context, so MCP
// identifiers remain generic and bash arguments reduce to fixed safe stages.
export function toolStatus(toolName: string, args?: unknown): SlackStatusUpdate {
  return toolActivityStatus(toolName, args);
}

const FALLBACK_STATUS_TEXT = 'is working on the request';
const SLACK_LIVENESS_STATUS_TEXT = 'is thinking...';

export function slackStatusText(_stage: SlackStatusUpdate): string {
  return SLACK_LIVENESS_STATUS_TEXT;
}

export function slackLoadingMessages(stage: SlackStatusUpdate): string[] {
  const activity = statusToLoadingMessage(activityStatusText(stage));
  if (isThinkingActivity(activity)) {
    return [SLACK_LIVENESS_STATUS_TEXT];
  }
  return [SLACK_LIVENESS_STATUS_TEXT, activity];
}

function activityStatusText(stage: SlackStatusUpdate): string {
  return stage.text.trim() || FALLBACK_STATUS_TEXT;
}

// Slack's assistant.threads.setStatus rejects a loading_messages entry of 51+
// characters; a rejected call trips the presenter's statusFailed latch and
// suppresses every later status for the turn. Keep derived loading messages
// within the limit so a longer fact never silently kills the status line.
const SLACK_LOADING_MESSAGE_MAX = 50;

function statusToLoadingMessage(status: string): string {
  const withoutSlackPrefix = status.replace(/^is\s+/i, '');
  const message = withoutSlackPrefix.charAt(0).toUpperCase() + withoutSlackPrefix.slice(1);
  if (message.length <= SLACK_LOADING_MESSAGE_MAX) {
    return message;
  }
  return `${message.slice(0, SLACK_LOADING_MESSAGE_MAX - 1)}…`;
}

function isThinkingActivity(message: string): boolean {
  return message.replace(/\.+$/, '').trim().toLowerCase() === 'thinking';
}
