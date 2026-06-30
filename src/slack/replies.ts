import { renderSlackMessage, type RenderedSlackMessage, type SlackReplyFormat } from './message-format.ts';

export type SlackReplyKind = 'progress' | 'final';

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

export interface SlackReplySink {
  readonly posts: SlackReplyPost[];
  post(kind: SlackReplyKind, post: SlackReplyInput): SlackReplyPost | Promise<SlackReplyPost>;
}

export function defaultSlackReplyFormat(kind: SlackReplyKind): SlackReplyFormat {
  return kind === 'final' ? 'markdown' : 'plain_text';
}

export class LocalSlackReplySink implements SlackReplySink {
  readonly posts: SlackReplyPost[] = [];

  post(kind: SlackReplyKind, post: SlackReplyInput): SlackReplyPost {
    const format = post.format ?? defaultSlackReplyFormat(kind);
    const saved = {
      kind,
      ...post,
      format,
      rendered: renderSlackMessage(post.text, format),
    };
    this.posts.push(saved);
    return saved;
  }
}
