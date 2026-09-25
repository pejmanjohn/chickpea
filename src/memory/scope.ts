import type { WebClient } from '@slack/web-api';

import {
  isTransientSlackApiError,
  slackConversationsInfo,
  slackConversationsMembers,
  slackUsersInfo,
  type SlackConversationFacts,
  type SlackUserFacts,
} from '../slack/credentials.ts';
import { isRetryableDependencyFailure, SlackTransportError } from '../slack/transport/types.ts';
import { slackWebClientUserFacts } from '../slack/user-classification.ts';

const PAGE_LIMIT = 200;
const MAX_PAGES = 5;

interface MemoryScopeSlackResult<T> {
  ok: boolean;
  error?: string;
  retryAfterMs?: number;
  /** The lookup failed on a transient dependency (rate limit, outage), not a Slack "no". */
  retryable?: boolean;
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
        ...(!result.ok && isTransientSlackApiError(result.error) ? { retryable: true } : {}),
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
        ...(result.facts ? { facts: result.facts } : {}),
      };
    },
    async user(userId) {
      const result = await slackUsersInfo(botToken, userId);
      return {
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        ...(!result.ok && isTransientSlackApiError(result.error) ? { retryable: true } : {}),
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
            ...(isTransientSlackApiError(result.error) ? { retryable: true } : {}),
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
        return { ok: false, ...webClientFailure(error) };
      }
    },
    async user(userId) {
      try {
        const result = await client.users.info({ user: userId });
        const user = slackWebClientUserFacts(result.user);
        return user ? { ok: true, user } : { ok: false, error: 'invalid_response' };
      } catch (error) {
        return { ok: false, ...webClientFailure(error) };
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
        return { ok: false, ids: [], ...webClientFailure(error) };
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

/**
 * Throw when any lookup failed on a transient dependency. A rate-limited or
 * unreachable Slack is not evidence that access was revoked, so a lease check
 * must retry rather than decide.
 */
export function throwIfMemoryScopeRetryable(
  results: ReadonlyArray<Pick<MemoryScopeSlackResult<unknown>, 'ok' | 'error' | 'retryable' | 'retryAfterMs'>>,
): void {
  const failure = results.find((result) => !result.ok && result.retryable);
  if (!failure) return;
  throw new SlackTransportError('memory.scope', failure.error ?? 'slack_unavailable', {
    retryable: true,
    effectOutcome: 'failed',
    ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
  });
}

function webClientFailure(error: unknown): { error: string; retryable?: true; retryAfterMs?: number } {
  if (!isRetryableDependencyFailure(error)) return { error: webClientError(error) };
  const code = error instanceof SlackTransportError ? error.code : webClientError(error);
  const hint = error instanceof SlackTransportError
    ? error.retryAfterMs
    : typeof (error as { retryAfter?: unknown }).retryAfter === 'number'
    ? (error as { retryAfter: number }).retryAfter * 1_000
    : undefined;
  return { error: code, retryable: true, ...(hint === undefined ? {} : { retryAfterMs: hint }) };
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
