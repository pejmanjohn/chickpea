import { renderSlackMessage } from './message-format.ts';
import {
  defaultSlackReplyFormat,
  type SlackReplyInput,
  type SlackReplyKind,
  type SlackReplyPost,
  type SlackReplySink,
} from './replies.ts';

export interface SlackWebApiReplySinkOptions {
  botToken: string;
  fetch?: typeof fetch;
}

interface SlackPostMessageResponse {
  ok: boolean;
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

  async post(kind: SlackReplyKind, post: SlackReplyInput): Promise<SlackReplyPost> {
    const format = post.format ?? defaultSlackReplyFormat(kind);
    const rendered = renderSlackMessage(post.text, format);
    const response = await this.fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: post.channelId,
        thread_ts: post.threadTs,
        ...rendered,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });

    const body = (await response.json()) as SlackPostMessageResponse;
    if (!response.ok || !body.ok) {
      throw new Error(`Slack chat.postMessage failed: ${body.error ?? response.status}`);
    }

    const saved = { kind, ...post, format, rendered };
    this.posts.push(saved);
    return saved;
  }
}
