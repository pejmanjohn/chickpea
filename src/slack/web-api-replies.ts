import {
  createSlackPresentationEvent,
  slackLoadingMessages,
  slackStatusText,
  type SlackFinalDelivery,
  type SlackPresentationContext,
  type SlackPresentationEvent,
  type SlackPresentationStage,
  type SlackReplyKind,
  type SlackReplyPost,
  type SlackReplySink,
} from './replies.ts';

export interface SlackWebApiReplySinkOptions {
  botToken: string;
  fetch?: typeof fetch;
}

interface SlackWebApiResponse {
  ok: boolean;
  channel?: string;
  ts?: string;
  error?: string;
}

export class SlackWebApiReplySink implements SlackReplySink {
  readonly posts: SlackReplyPost[] = [];
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SlackWebApiReplySinkOptions) {
    this.botToken = options.botToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async post(kind: SlackReplyKind, post: Omit<SlackReplyPost, 'kind'>): Promise<SlackReplyPost> {
    const response = await this.slackApi(
      'chat.postMessage',
      {
        channel: post.channelId,
        thread_ts: post.threadTs,
        text: post.text,
        unfurl_links: false,
        unfurl_media: false,
      },
      {
        httpErrorFallback: 'status',
      },
    );

    if (!response.ok) {
      throw new Error(`Slack chat.postMessage failed: ${response.error ?? 'unknown_error'}`);
    }

    const saved = { kind, ...post };
    this.posts.push(saved);
    return saved;
  }

  async setStatus(
    context: SlackPresentationContext,
    stage: SlackPresentationStage,
  ): Promise<SlackPresentationEvent> {
    const status = slackStatusText(stage);
    const loadingMessages = slackLoadingMessages(stage);
    const response = await this.slackApi('assistant.threads.setStatus', {
      channel_id: context.channelId,
      thread_ts: context.threadTs,
      status,
      loading_messages: loadingMessages,
    });

    return createSlackPresentationEvent(context, 'status_set', {
      ok: response.ok,
      text: status,
      loadingMessages,
      error: response.ok ? undefined : response.error,
    });
  }

  async clearStatus(context: SlackPresentationContext): Promise<SlackPresentationEvent> {
    const response = await this.slackApi('assistant.threads.setStatus', {
      channel_id: context.channelId,
      thread_ts: context.threadTs,
      status: '',
    });

    return createSlackPresentationEvent(context, 'status_cleared', {
      ok: response.ok,
      text: '',
      error: response.ok ? undefined : response.error,
    });
  }

  async deliverFinal(context: SlackPresentationContext, text: string): Promise<SlackFinalDelivery> {
    const degradations: string[] = [];

    const started = await this.startStream(context, text);
    if (started.ok) {
      const stopped = await this.stopStream(context, started.streamTs);
      const finalReply = this.saveFinalPost(context, text);
      if (stopped.ok) {
        return {
          finalReply,
          deliveryMode: 'stream',
          degradations,
        };
      }
      degradations.push(`chat.stopStream:${stopped.error ?? 'unknown_error'}`);
      return {
        finalReply,
        deliveryMode: 'stream',
        degradations,
      };
    }

    degradations.push(`chat.startStream:${started.error ?? 'unknown_error'}`);
    const fallback = await this.post('final', {
      channelId: context.channelId,
      threadTs: context.threadTs,
      text,
      postedAt: context.postedAt,
    });
    return {
      finalReply: fallback,
      deliveryMode: 'fallback_post',
      degradations,
    };
  }

  private async startStream(
    context: SlackPresentationContext,
    text: string,
  ): Promise<{ ok: true; streamTs: string } | { ok: false; error: string }> {
    if (!context.userId || !context.workspaceId) {
      return { ok: false, error: 'missing_recipient' };
    }

    const response = await this.slackApi('chat.startStream', {
      channel: context.channelId,
      thread_ts: context.threadTs,
      recipient_user_id: context.userId,
      recipient_team_id: context.workspaceId,
      markdown_text: text,
    });

    if (!response.ok || !response.ts) {
      return { ok: false, error: response.error ?? 'missing_stream_ts' };
    }

    return { ok: true, streamTs: response.ts };
  }

  private async stopStream(
    context: SlackPresentationContext,
    streamTs: string,
  ): Promise<SlackPresentationEvent> {
    const response = await this.slackApi('chat.stopStream', {
      channel: context.channelId,
      ts: streamTs,
    });

    return createSlackPresentationEvent(context, 'stream_stopped', {
      ok: response.ok,
      error: response.ok ? undefined : response.error,
    });
  }

  private async slackApi(
    method: string,
    payload: Record<string, unknown>,
    options: { httpErrorFallback?: 'http_status' | 'status' } = {},
  ): Promise<SlackWebApiResponse> {
    const response = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    });

    let body: SlackWebApiResponse;
    try {
      body = (await response.json()) as SlackWebApiResponse;
    } catch {
      return {
        ok: false,
        error: `http_${response.status}`,
      };
    }

    if (!response.ok || !body.ok) {
      const fallback =
        options.httpErrorFallback === 'status'
          ? String(response.status)
          : `http_${response.status}`;
      return {
        ok: false,
        error: sanitizeSlackError(body.error ?? fallback),
      };
    }

    return body;
  }

  private saveFinalPost(context: SlackPresentationContext, text: string): SlackReplyPost {
    const finalReply = {
      kind: 'final' as const,
      channelId: context.channelId,
      threadTs: context.threadTs,
      text,
      postedAt: context.postedAt,
    };
    this.posts.push(finalReply);
    return finalReply;
  }
}

function sanitizeSlackError(error: string): string {
  return error.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}
