import type { NormalizedSlackTurn } from './types.ts';

export function slackThreadKey(turn: NormalizedSlackTurn): string {
  return `${turn.workspaceId}:${turn.channelId}:${turn.sessionThreadTs ?? turn.threadTs}`;
}

export function parseSlackThreadKey(threadKey: string): {
  workspaceId: string;
  channelId: string;
  threadTs: string;
} {
  const [workspaceId, channelId, threadTs] = threadKey.split(':');
  if (!workspaceId || !channelId || !threadTs) {
    throw new Error(`Invalid Slack thread key ${threadKey}`);
  }
  return { workspaceId, channelId, threadTs };
}

export function slackArtifactThreadTs(threadKey: string): string {
  return parseSlackThreadKey(threadKey).threadTs;
}
