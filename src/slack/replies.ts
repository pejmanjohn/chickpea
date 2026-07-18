import { renderSlackMessage, type RenderedSlackMessage, type SlackReplyFormat } from './message-format.ts';

export type SlackReplyKind = 'progress' | 'final';

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

export interface SlackReplyInput {
  channelId: string;
  threadTs: string;
  text: string;
  postedAt: number;
  format?: SlackReplyFormat;
}

export interface SlackReplyPost extends SlackReplyInput {
  kind: SlackReplyKind;
  format: SlackReplyFormat;
  rendered: RenderedSlackMessage;
}

export interface SlackPresentationContext {
  channelId: string;
  threadTs: string;
  postedAt: number;
  workspaceId?: string;
  userId?: string;
}

export type SlackPresentationEventKind =
  | 'status_set'
  | 'status_cleared'
  | 'stream_started'
  | 'stream_appended'
  | 'stream_stopped';

export interface SlackPresentationEvent {
  kind: SlackPresentationEventKind;
  channelId: string;
  threadTs: string;
  ok: boolean;
  postedAt: number;
  text?: string;
  loadingMessages?: string[];
  error?: string;
}

export interface SlackFinalDelivery {
  finalReply: SlackReplyPost;
  deliveryMode: 'stream' | 'fallback_post';
  degradations: string[];
}

export interface SlackReplySink {
  readonly posts: SlackReplyPost[];
  post(kind: SlackReplyKind, post: SlackReplyInput): SlackReplyPost | Promise<SlackReplyPost>;
  setStatus?(
    context: SlackPresentationContext,
    stage: SlackStatusUpdate,
  ): SlackPresentationEvent | Promise<SlackPresentationEvent>;
  clearStatus?(context: SlackPresentationContext): SlackPresentationEvent | Promise<SlackPresentationEvent>;
  deliverFinal?(
    context: SlackPresentationContext,
    text: string,
    format?: SlackReplyFormat,
  ): SlackFinalDelivery | Promise<SlackFinalDelivery>;
}

export function defaultSlackReplyFormat(kind: SlackReplyKind): SlackReplyFormat {
  return kind === 'final' ? 'markdown' : 'plain_text';
}

export class LocalSlackReplySink implements SlackReplySink {
  readonly posts: SlackReplyPost[] = [];
  readonly presentationEvents: SlackPresentationEvent[] = [];

  post(kind: SlackReplyKind, post: SlackReplyInput): SlackReplyPost {
    const format = post.format ?? defaultSlackReplyFormat(kind);
    const saved: SlackReplyPost = {
      kind,
      ...post,
      format,
      rendered: renderSlackMessage(post.text, format),
    };
    this.posts.push(saved);
    return saved;
  }

  setStatus(context: SlackPresentationContext, stage: SlackStatusUpdate): SlackPresentationEvent {
    return this.savePresentationEvent(context, 'status_set', {
      ok: true,
      text: slackStatusText(stage),
      loadingMessages: slackLoadingMessages(stage),
    });
  }

  clearStatus(context: SlackPresentationContext): SlackPresentationEvent {
    return this.savePresentationEvent(context, 'status_cleared', {
      ok: true,
      text: '',
    });
  }

  deliverFinal(
    context: SlackPresentationContext,
    text: string,
    format?: SlackReplyFormat,
  ): SlackFinalDelivery {
    this.savePresentationEvent(context, 'stream_started', { ok: true });
    this.savePresentationEvent(context, 'stream_appended', { ok: true, text });
    this.savePresentationEvent(context, 'stream_stopped', { ok: true });
    const finalReply = this.post('final', {
      channelId: context.channelId,
      threadTs: context.threadTs,
      text,
      postedAt: context.postedAt,
      ...(format ? { format } : {}),
    });

    return {
      finalReply,
      deliveryMode: 'stream',
      degradations: [],
    };
  }

  private savePresentationEvent(
    context: SlackPresentationContext,
    kind: SlackPresentationEventKind,
    details: {
      ok: boolean;
      text?: string | undefined;
      loadingMessages?: string[] | undefined;
      error?: string | undefined;
    },
  ): SlackPresentationEvent {
    const event = createSlackPresentationEvent(context, kind, details);
    this.presentationEvents.push(event);
    return event;
  }
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

export function createSlackPresentationEvent(
  context: SlackPresentationContext,
  kind: SlackPresentationEventKind,
  details: {
    ok: boolean;
    text?: string | undefined;
    loadingMessages?: string[] | undefined;
    error?: string | undefined;
  },
): SlackPresentationEvent {
  return {
    kind,
    channelId: context.channelId,
    threadTs: context.threadTs,
    ok: details.ok,
    postedAt: context.postedAt,
    ...(details.text === undefined ? {} : { text: details.text }),
    ...(details.loadingMessages === undefined ? {} : { loadingMessages: details.loadingMessages }),
    ...(details.error === undefined ? {} : { error: details.error }),
  };
}
