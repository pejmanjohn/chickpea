import { renderSlackMessage, type RenderedSlackMessage, type SlackReplyFormat } from './message-format.ts';

export type SlackReplyKind = 'progress' | 'final';

export interface SlackStatusUpdate {
  text: string;
}

// Status vocabulary for the observe() tool bridge lives here (not in app.ts, which
// is route composition): "is running <tool>" in Slack's status voice.
export function toolStatus(toolName: string): SlackStatusUpdate {
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
  // (e.g. "is running lookup_channel_brief" -> "Running lookup_channel_brief").
  return [statusToLoadingMessage(slackStatusText(stage))];
}

function statusToLoadingMessage(status: string): string {
  const withoutSlackPrefix = status.replace(/^is\s+/i, '');
  return withoutSlackPrefix.charAt(0).toUpperCase() + withoutSlackPrefix.slice(1);
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
