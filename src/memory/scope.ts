import type { WebClient } from '@slack/web-api';

import {
  slackConversationsInfo,
  slackConversationsMembers,
  slackUsersInfo,
  type SlackConversationFacts,
  type SlackUserFacts,
} from '../slack/credentials.ts';

const PAGE_LIMIT = 200;
const MAX_PAGES = 5;

export interface MemoryScopeSlackResult<T> {
  ok: boolean;
  error?: string;
  retryAfterMs?: number;
  incomplete?: boolean;
  facts?: T;
}

export interface MemoryScopeSlack {
  conversation(channelId: string): Promise<MemoryScopeSlackResult<SlackConversationFacts>>;
  user(userId: string): Promise<MemoryScopeSlackResult<SlackUserFacts> & { user?: SlackUserFacts }>;
  members(channelId: string): Promise<MemoryScopeSlackResult<never> & { ids: string[] }>;
}

export async function verifyMemoryMutationMembership(
  channelId: string,
  actorId: string,
  slack: MemoryScopeSlack,
): Promise<boolean> {
  const members = await slack.members(channelId);
  return members.ok && !members.incomplete && members.ids.includes(actorId);
}

export function createMemoryScopeSlack(botToken: string, _workspaceId?: string): MemoryScopeSlack {
  return {
    async conversation(channelId) {
      const result = await slackConversationsInfo(botToken, channelId);
      return {
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
        ...(result.facts ? { facts: result.facts } : {}),
      };
    },
    async user(userId) {
      const result = await slackUsersInfo(botToken, userId);
      return {
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
        ...(result.user ? { user: result.user } : {}),
      };
    },
    async members(channelId) {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await slackConversationsMembers(botToken, channelId, {
          limit: PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        if (!result.ok) {
          return {
            ok: false,
            ids: [],
            ...(result.error ? { error: result.error } : {}),
            ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
          };
        }
        ids.push(...result.memberIds);
        cursor = result.nextCursor;
        if (!cursor) return { ok: true, ids };
      }
      return { ok: true, ids, incomplete: Boolean(cursor) };
    },
  };
}

/** Tokenless Slack membership seam for the shared-app gateway. */
export function createMemoryScopeSlackFromWebClient(
  client: WebClient,
  _workspaceId?: string,
): MemoryScopeSlack {
  return {
    async conversation(channelId) {
      try {
        const result = await client.conversations.info({ channel: channelId });
        const facts = webClientConversationFacts(result.channel);
        return facts ? { ok: true, facts } : { ok: false, error: 'invalid_response' };
      } catch (error) {
        return { ok: false, error: webClientError(error) };
      }
    },
    async user(userId) {
      try {
        const result = await client.users.info({ user: userId });
        const user = webClientUserFacts(result.user);
        return user ? { ok: true, user } : { ok: false, error: 'invalid_response' };
      } catch (error) {
        return { ok: false, error: webClientError(error) };
      }
    },
    async members(channelId) {
      const ids: string[] = [];
      let cursor: string | undefined;
      try {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const result = await client.conversations.members({
            channel: channelId,
            limit: PAGE_LIMIT,
            ...(cursor ? { cursor } : {}),
          });
          ids.push(...(result.members ?? []));
          cursor = result.response_metadata?.next_cursor || undefined;
          if (!cursor) return { ok: true, ids };
        }
        return { ok: true, ids, incomplete: Boolean(cursor) };
      } catch (error) {
        return { ok: false, ids: [], error: webClientError(error) };
      }
    },
  };
}

function webClientConversationFacts(raw: unknown): SlackConversationFacts | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const channel = raw as Record<string, unknown>;
  if (typeof channel.id !== 'string') return undefined;
  return {
    id: channel.id,
    name: typeof channel.name === 'string' ? channel.name : '',
    im: channel.is_im === true,
    mpim: channel.is_mpim === true,
    private: channel.is_private === true,
    archived: channel.is_archived === true,
    frozen: channel.is_frozen === true,
    shared: channel.is_shared === true,
    externallyShared: channel.is_ext_shared === true,
    organizationShared: channel.is_org_shared === true,
    pendingShared: Array.isArray(channel.pending_shared) && channel.pending_shared.length > 0,
    member: channel.is_member === true,
    teamId: typeof channel.context_team_id === 'string'
      ? channel.context_team_id
      : typeof channel.team_id === 'string' ? channel.team_id : undefined,
  };
}

function webClientUserFacts(raw: unknown): SlackUserFacts | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const user = raw as Record<string, unknown>;
  if (typeof user.id !== 'string') return undefined;
  const profile = user.profile && typeof user.profile === 'object' && !Array.isArray(user.profile)
    ? user.profile as Record<string, unknown>
    : {};
  return {
    id: user.id,
    teamId: typeof user.team_id === 'string' ? user.team_id : undefined,
    ...(typeof profile.display_name === 'string' ? { displayName: profile.display_name } : {}),
    ...(typeof profile.email === 'string' ? { email: profile.email } : {}),
    ...(typeof user.tz === 'string' ? { timezone: user.tz } : {}),
    deleted: user.deleted === true,
    bot: user.is_bot === true,
    appUser: user.is_app_user === true,
    restricted: user.is_restricted === true,
    ultraRestricted: user.is_ultra_restricted === true,
    stranger: user.is_stranger === true,
  };
}

function webClientError(error: unknown): string {
  if (error && typeof error === 'object') {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
      return (data as { error: string }).error;
    }
  }
  return 'slack_unavailable';
}
