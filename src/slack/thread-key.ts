import type { NormalizedSlackTurn } from './types.ts';
import type { ResolvedAssignment } from '../config/types.ts';

export function slackThreadKey(turn: NormalizedSlackTurn): string {
  return `${turn.workspaceId}:${turn.channelId}:${turn.sessionThreadTs ?? turn.threadTs}`;
}

/**
 * Agent-platform continuity is rooted in the real Slack thread and rotates on
 * ownership transfer. Legacy installations retain their channel-wide DM key.
 */
export function slackAgentThreadKey(
  turn: NormalizedSlackTurn,
  assignment: Pick<ResolvedAssignment, 'runtimeContract' | 'ownerIncarnation'>,
): string {
  if (assignment.runtimeContract !== 'chickpea-v1') return slackThreadKey(turn);
  const incarnation = assignment.ownerIncarnation ?? 1;
  if (!Number.isInteger(incarnation) || incarnation < 1) {
    throw new Error('Slack Agent owner incarnation must be a positive integer');
  }
  return `${turn.workspaceId}:${turn.channelId}:${turn.threadTs}:owner-i${incarnation}`;
}

export function memoryEpochThreadKey(baseThreadKey: string, epoch: number): string {
  if (!Number.isInteger(epoch) || epoch < 1) {
    throw new Error('Memory conversation epoch must be a positive integer');
  }
  return `${continuityBaseSlackThreadKey(baseThreadKey)}:memory-e${epoch}`;
}

export function memoryQuarantineThreadKey(baseThreadKey: string, eventId: string): string {
  const safeEvent = eventId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'event';
  return `${continuityBaseSlackThreadKey(baseThreadKey)}:memory-q-${safeEvent}`;
}

export function workspaceManagementThreadKey(baseThreadKey: string): string {
  return `${continuityBaseSlackThreadKey(baseThreadKey)}:workspace-management`;
}

function continuityBaseSlackThreadKey(threadKey: string): string {
  const base = baseSlackThreadKey(threadKey);
  const owner = threadKey.split(':')[3];
  return owner && /^owner-i[1-9]\d*$/.test(owner) ? `${base}:${owner}` : base;
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
