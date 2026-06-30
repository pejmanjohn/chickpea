export type SlackReplyKind = 'progress' | 'final';

export type SlackPresentationStage =
  | 'checking_context'
  | 'gathering_channel_context'
  | 'channel_context_ready'
  | 'generating_answer'
  | 'provider_failed';

export interface SlackReplyPost {
  kind: SlackReplyKind;
  channelId: string;
  threadTs: string;
  text: string;
  postedAt: number;
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
  post(
    kind: SlackReplyKind,
    post: Omit<SlackReplyPost, 'kind'>,
  ): SlackReplyPost | Promise<SlackReplyPost>;
  setStatus?(
    context: SlackPresentationContext,
    stage: SlackPresentationStage,
  ): SlackPresentationEvent | Promise<SlackPresentationEvent>;
  clearStatus?(context: SlackPresentationContext): SlackPresentationEvent | Promise<SlackPresentationEvent>;
  deliverFinal?(context: SlackPresentationContext, text: string): SlackFinalDelivery | Promise<SlackFinalDelivery>;
}

export class LocalSlackReplySink implements SlackReplySink {
  readonly posts: SlackReplyPost[] = [];
  readonly presentationEvents: SlackPresentationEvent[] = [];

  post(kind: SlackReplyKind, post: Omit<SlackReplyPost, 'kind'>): SlackReplyPost {
    const saved = { kind, ...post };
    this.posts.push(saved);
    return saved;
  }

  setStatus(context: SlackPresentationContext, stage: SlackPresentationStage): SlackPresentationEvent {
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

  deliverFinal(context: SlackPresentationContext, text: string): SlackFinalDelivery {
    this.savePresentationEvent(context, 'stream_started', { ok: true });
    this.savePresentationEvent(context, 'stream_appended', { ok: true, text });
    this.savePresentationEvent(context, 'stream_stopped', { ok: true });
    const finalReply = this.post('final', {
      channelId: context.channelId,
      threadTs: context.threadTs,
      text,
      postedAt: context.postedAt,
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

const STATUS_TEXT: Record<SlackPresentationStage, string> = {
  checking_context: 'is checking context',
  gathering_channel_context: 'is gathering channel context',
  channel_context_ready: 'has channel context ready',
  generating_answer: 'is composing an answer',
  provider_failed: 'hit a provider error',
};

const LOADING_MESSAGES: Record<SlackPresentationStage, string[]> = {
  checking_context: [
    'Checking the Slack thread context',
    'Reviewing the channel assignment',
    'Preparing a concise answer',
  ],
  gathering_channel_context: [
    'Gathering channel context',
    'Reading the configured channel brief',
    'Checking allowed Slack context tools',
  ],
  channel_context_ready: [
    'Channel context gathered',
    'Selecting the useful details',
    'Preparing the answer',
  ],
  generating_answer: [
    'Composing answer',
    'Keeping the reply concise',
    'Formatting the final response',
  ],
  provider_failed: [
    'Provider call failed',
    'Preparing a safe failure response',
    'Clearing the working state',
  ],
};

export function slackStatusText(stage: SlackPresentationStage): string {
  return STATUS_TEXT[stage] ?? 'is working on the request';
}

export function slackLoadingMessages(stage: SlackPresentationStage): string[] {
  return LOADING_MESSAGES[stage] ?? ['Working on the request'];
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
