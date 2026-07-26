import type { NormalizedSlackTurn } from './types.ts';

export function slackThreadKey(turn: NormalizedSlackTurn): string {
  return `${turn.workspaceId}:${turn.channelId}:${turn.sessionThreadTs ?? turn.threadTs}`;
}

export function memoryEpochThreadKey(baseThreadKey: string, epoch: number): string {
  if (!Number.isInteger(epoch) || epoch < 1) {
    throw new Error('Memory conversation epoch must be a positive integer');
  }
  return `${baseSlackThreadKey(baseThreadKey)}:memory-e${epoch}`;
}

export function memoryQuarantineThreadKey(baseThreadKey: string, eventId: string): string {
  const safeEvent = eventId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'event';
  return `${baseSlackThreadKey(baseThreadKey)}:memory-q-${safeEvent}`;
}

export function baseSlackThreadKey(threadKey: string): string {
  const { workspaceId, channelId, threadTs } = parseSlackThreadKey(threadKey);
  return `${workspaceId}:${channelId}:${threadTs}`;
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
