import type { PlatformEnv } from '../config/state-backend.ts';
import {
  resolveSlackCredentials,
  slackAuthTest,
  slackConversationsInfo,
  slackConversationsMembers,
} from '../slack/credentials.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';

const MAX_MEMBER_PAGES = 5;

/** Routine controls and natural-language requests work in mentions and their channel threads. */
export function isRoutineSlackTurn(turn: NormalizedSlackTurn): boolean {
  return (turn.source === 'app_mention' || turn.source === 'implicit_thread_reply') &&
    turn.channelType !== 'im' &&
    turn.channelType !== 'app_home' &&
    turn.channelType !== 'mpim';
}

/** Reauthorize a mentioned channel without revealing private-channel existence on failure. */
export async function canManageRoutineChannel(
  workspaceId: string,
  channelId: string,
  actorId: string,
  env: PlatformEnv | undefined,
): Promise<boolean> {
  try {
    const { botToken } = await resolveSlackCredentials(env);
    if (!botToken) return false;
    const [auth, conversation] = await Promise.all([
      slackAuthTest(botToken),
      slackConversationsInfo(botToken, channelId),
    ]);
    if (
      !auth.ok ||
      (auth.teamId && auth.teamId !== workspaceId) ||
      !conversation.ok ||
      !conversation.facts ||
      conversation.facts.id !== channelId ||
      (conversation.facts.teamId && conversation.facts.teamId !== workspaceId) ||
      !conversation.facts.member ||
      conversation.facts.archived ||
      conversation.facts.frozen ||
      conversation.facts.im ||
      conversation.facts.mpim
    ) {
      return false;
    }
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
      const members = await slackConversationsMembers(botToken, channelId, {
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      if (!members.ok) return false;
      if (members.memberIds.includes(actorId)) return true;
      cursor = members.nextCursor;
      if (!cursor) return false;
    }
    return false;
  } catch {
    return false;
  }
}

export function parseSlackChannelMention(value: string): string | undefined {
  const match = value.match(/^<#([A-Za-z0-9_-]{1,200})(?:\|[^>]{0,200})?>$/);
  return match?.[1];
}
