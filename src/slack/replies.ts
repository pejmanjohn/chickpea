export interface SlackStatusUpdate {
  text: string;
}

// Status vocabulary for the observe() tool bridge lives here (not in app.ts, which
// is route composition). MCP tools arrive as Flue's `mcp__<server>__<tool>` —
// render them as "is calling <server>: <tool>" so the status line names the
// connection a human recognizes. Bash arguments are reduced to fixed stage
// labels here; raw commands never leave the agent isolate or reach Slack.
export function toolStatus(toolName: string, args?: unknown): SlackStatusUpdate {
  if (toolName === 'bash') {
    return bashToolStatus(args);
  }
  if (toolName.startsWith('mcp__')) {
    const rest = toolName.slice(5);
    const sep = rest.indexOf('__');
    if (sep > 0) {
      return { text: `is calling ${rest.slice(0, sep)}: ${rest.slice(sep + 2)}` };
    }
  }
  return { text: `is running ${toolName}` };
}

function bashToolStatus(args: unknown): SlackStatusUpdate {
  const command = bashCommand(args);
  if (!command) return { text: 'is running a workspace command' };

  if (/\bgit\s+clone\b/i.test(command)) {
    return { text: 'is cloning the repository' };
  }
  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i)\b/i.test(command) ||
    /\b(?:pip|pip3)\s+install\b/i.test(command) ||
    /\bpython(?:3)?\s+-m\s+pip\s+install\b/i.test(command)
  ) {
    return { text: 'is installing dependencies' };
  }
  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)/i.test(command) ||
    /\b(?:pytest|vitest|jest)\b/i.test(command)
  ) {
    return { text: 'is running the test suite' };
  }
  if (/\b(?:playwright|chromium|google-chrome)\b|\bscreenshot(?:\.png)?\b/i.test(command)) {
    return { text: 'is capturing a screenshot' };
  }
  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start)(?:\s|$)/i.test(command) ||
    /\bwrangler\s+dev\b/i.test(command)
  ) {
    return { text: 'is starting the app' };
  }
  if (/api\.github\.com\/repos\/[^/\s]+\/[^/\s]+\/pulls(?:[?'"\s]|$)/i.test(command)) {
    return { text: 'is opening the pull request' };
  }
  if (/\bgit\s+push\b/i.test(command)) {
    return { text: 'is pushing the branch' };
  }
  if (/\bgit\s+commit\b/i.test(command)) {
    return { text: 'is committing the changes' };
  }
  if (
    /\bcat\b[^\n;|&]*>{1,2}/i.test(command) ||
    /\b(?:tee|apply_patch)\b|\bsed\s+-i\b|\bperl\s+-pi\b/i.test(command)
  ) {
    return { text: 'is editing the code' };
  }
  if (
    /\bgit\s+(?:status|log|diff|branch)\b/i.test(command) ||
    /\b(?:ls|find|cat|head|tail|rg|grep|pwd)\b/i.test(command)
  ) {
    return { text: 'is inspecting the workspace' };
  }
  return { text: 'is running a workspace command' };
}

function bashCommand(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || !('command' in args)) {
    return undefined;
  }
  const command = (args as { command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
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
