import type { WebClient } from '@slack/web-api';

import { readSlackIdentityProfile } from './identity-profile.ts';
import { boundedDisplayName } from './message-text.ts';
import type { SlackContextMessage, SlackTurnContext } from './thread-context.ts';
import { SLACK_USER_ID } from './ui/text.ts';

/**
 * Display names for the people in a turn's Slack context, so "summarize what
 * Dana said" or "who asked for this" can be answered. Rows keep the Slack user
 * id beside the name (mentions and task assignment need the exact id).
 *
 * users.info is outside Slack's special limits for non-Marketplace apps, but
 * lookups are still bounded per turn and cached per isolate. A failed lookup
 * leaves that row with its id only; it never fails the turn.
 */

const MAX_LOOKUPS_PER_TURN = 20;
const LOOKUP_CONCURRENCY = 5;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 2_000;

const cache = new Map<string, { name: string | null; at: number }>();

export async function resolveSlackContextNames(
  client: Pick<WebClient, 'users'>,
  workspaceId: string,
  context: SlackTurnContext,
  now: () => number = Date.now,
): Promise<SlackTurnContext> {
  const ids = [...new Set(context.messages
    .filter((message) => message.role !== 'app' && message.role !== 'agent' && !message.authorName)
    .map((message) => message.userId)
    .filter((id) => SLACK_USER_ID.test(id)))];
  if (ids.length === 0) return context;
  const names = await lookupSlackDisplayNames(client, workspaceId, ids, now);
  if (names.size === 0) return context;
  return {
    ...context,
    messages: context.messages.map((message) => withName(message, names)),
  };
}

/** Cached display names for Slack user ids; absent when a lookup failed. */
export async function lookupSlackDisplayNames(
  client: Pick<WebClient, 'users'>,
  workspaceId: string,
  ids: readonly string[],
  now: () => number = Date.now,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const missing: string[] = [];
  for (const id of ids) {
    const cached = cache.get(cacheKey(workspaceId, id));
    if (cached && now() - cached.at < CACHE_TTL_MS) {
      if (cached.name) names.set(id, cached.name);
    } else {
      missing.push(id);
    }
  }
  const pending = missing.slice(0, MAX_LOOKUPS_PER_TURN);
  for (let index = 0; index < pending.length; index += LOOKUP_CONCURRENCY) {
    await Promise.all(pending.slice(index, index + LOOKUP_CONCURRENCY).map(async (id) => {
      try {
        const response = await client.users.info({ user: id });
        const name = boundedDisplayName(readSlackIdentityProfile(response.user).displayName);
        remember(workspaceId, id, name ?? null, now());
        if (name) names.set(id, name);
      } catch {
        // Transient or permission failure: the row keeps its id. Not cached,
        // so the next turn tries again.
      }
    }));
  }
  return names;
}

/** Test seam: forget cached names. */
export function clearSlackContextNameCache(): void {
  cache.clear();
}

function withName(message: SlackContextMessage, names: Map<string, string>): SlackContextMessage {
  if (message.authorName || message.role === 'app' || message.role === 'agent') return message;
  const name = names.get(message.userId);
  return name ? { ...message, authorName: name } : message;
}

function remember(workspaceId: string, id: string, name: string | null, at: number): void {
  const key = cacheKey(workspaceId, id);
  // Re-insert so a refreshed name moves to the newest end; evict only for a new key.
  if (!cache.delete(key) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { name, at });
}

function cacheKey(workspaceId: string, id: string): string {
  return `${workspaceId}\u0000${id}`;
}
