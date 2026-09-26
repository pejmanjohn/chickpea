import type { WebClient } from '@slack/web-api';

import type { NormalizedSlackTurn } from './types.ts';
import { slackConversationKind } from './thread-key.ts';

/**
 * Where a steering reply goes: the person it answers, in the thread it is
 * about. Only that person may see it (R11).
 */
export interface SteeringReplyTarget {
  channelId: string;
  /** The thread the stop or check-in addressed; absent for a top-level DM. */
  threadTs?: string;
  userId: string;
  conversation: ReturnType<typeof slackConversationKind>;
}

export function steeringReplyTarget(
  turn: Pick<NormalizedSlackTurn, 'channelId' | 'threadTs' | 'userId' | 'source' | 'channelType'>,
): SteeringReplyTarget {
  return {
    channelId: turn.channelId,
    ...(turn.threadTs ? { threadTs: turn.threadTs } : {}),
    userId: turn.userId,
    conversation: slackConversationKind(turn),
  };
}

/**
 * Chickpea's own reply to a stop or check-in, never the busy Agent's (KTD8):
 * an ephemeral message in the thread for channels and group DMs, and an
 * ordinary threaded reply in a DM, where only the person and the Agent are.
 */
export async function postSteeringReply(
  client: Pick<WebClient, 'chat'>,
  target: SteeringReplyTarget,
  text: string,
): Promise<void> {
  if (target.conversation === 'im') {
    await client.chat.postMessage({
      channel: target.channelId,
      ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      text,
    });
    return;
  }
  await client.chat.postEphemeral({
    channel: target.channelId,
    user: target.userId,
    ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
    text,
  });
}
