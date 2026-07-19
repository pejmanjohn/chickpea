export interface SlackStatusUpdate {
  text: string;
}

// Status vocabulary for the observe() tool bridge lives here (not in app.ts, which
// is route composition). MCP tools arrive as Flue's `mcp__<server>__<tool>` —
// render them as "is calling <server>: <tool>" so the status line names the
// connection a human recognizes. Tool NAMES only; arguments never reach here.
export function toolStatus(toolName: string): SlackStatusUpdate {
  if (toolName.startsWith('mcp__')) {
    const rest = toolName.slice(5);
    const sep = rest.indexOf('__');
    if (sep > 0) {
      return { text: `is calling ${rest.slice(0, sep)}: ${rest.slice(sep + 2)}` };
    }
  }
  return { text: `is running ${toolName}` };
}

const FALLBACK_STATUS_TEXT = 'is working on the request';

export function slackStatusText(stage: SlackStatusUpdate): string {
  return stage.text.trim() || FALLBACK_STATUS_TEXT;
}

export function slackLoadingMessages(stage: SlackStatusUpdate): string[] {
  // The loading phrase is derived from the same event-derived status text
  // (e.g. "is running mcp__search__query" -> "Running mcp__search__query").
  return [statusToLoadingMessage(slackStatusText(stage))];
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
