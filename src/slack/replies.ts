import { toolActivityStatus, type ActivityStatus } from '../activity/status.ts';

export type SlackStatusUpdate = ActivityStatus;

// Slack rendering stays here while activity semantics live in the shared
// activity layer. The compatibility helper has no profile context, so MCP
// identifiers remain generic and bash arguments reduce to fixed safe stages.
export function toolStatus(toolName: string, args?: unknown): SlackStatusUpdate {
  return toolActivityStatus(toolName, args);
}

const FALLBACK_STATUS_TEXT = 'Preparing your request…';

export function slackStatusText(stage: SlackStatusUpdate, _agentName?: string): string {
  return boundedNativeStatusText(stage);
}

export function slackLoadingMessages(stage: SlackStatusUpdate, _agentName?: string): string[] {
  return [boundedNativeStatusText(stage)];
}

function activityStatusText(stage: SlackStatusUpdate): string {
  return stage.text.trim() || FALLBACK_STATUS_TEXT;
}

// Slack rejects a loading_messages entry of 51+ characters. Bound the one
// canonical phrase once so `status` and its one loading entry remain identical.
const SLACK_LOADING_MESSAGE_MAX = 50;

function boundedNativeStatusText(stage: SlackStatusUpdate): string {
  const message = activityStatusText(stage);
  if (message.length <= SLACK_LOADING_MESSAGE_MAX) return message;
  return `${message.slice(0, SLACK_LOADING_MESSAGE_MAX - 1)}…`;
}
