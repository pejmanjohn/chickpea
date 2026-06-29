export type SlackReplyKind = 'progress' | 'final';

export interface SlackReplyPost {
  kind: SlackReplyKind;
  channelId: string;
  threadTs: string;
  text: string;
  postedAt: number;
}

export interface SlackReplySink {
  readonly posts: SlackReplyPost[];
  post(
    kind: SlackReplyKind,
    post: Omit<SlackReplyPost, 'kind'>,
  ): SlackReplyPost | Promise<SlackReplyPost>;
}

export class LocalSlackReplySink implements SlackReplySink {
  readonly posts: SlackReplyPost[] = [];

  post(kind: SlackReplyKind, post: Omit<SlackReplyPost, 'kind'>): SlackReplyPost {
    const saved = { kind, ...post };
    this.posts.push(saved);
    return saved;
  }
}
