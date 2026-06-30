import type { NormalizedSlackTurn } from './types.ts';

export function slackThreadKey(turn: NormalizedSlackTurn): string {
  return `${turn.workspaceId}:${turn.channelId}:${turn.sessionThreadTs ?? turn.threadTs}`;
}
