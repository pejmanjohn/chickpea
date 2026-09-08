import { slackConversationsList, type SlackChannelSummary } from './credentials.ts';

// The bot self-join helper lives with the other raw Slack fetch helpers (it
// needs the private SLACK_API_URL base), but the auto-join-on-assignment flow
// belongs conceptually to this channels module — re-export so callers reach it
// from here.
export {
  slackConversationsJoin,
  type SlackConversationsJoinResult,
} from './credentials.ts';

/**
 * Server-side channel listing for the admin Add-channel picker.
 *
 * The admin never gets a raw Slack token in the browser: it asks this proxy,
 * which cursor-paginates `conversations.list` with the resolved bot token,
 * merges every page (capped so a huge workspace can't run the admin out of
 * memory), and hands back a name-sorted summary. Results are cached per isolate
 * for a short TTL so re-opening the picker does not re-hit Slack; `refresh`
 * bypasses the cache after the operator invites the bot to a new channel.
 */

const CHANNEL_LIST_CACHE_TTL_MS = 60_000;
/** Hard cap on channels returned — a defensive bound on very large workspaces. */
const MAX_CHANNELS = 2000;
const PAGE_LIMIT = 200;
/** Loop guard: (2000 / 200) = 10 pages of headroom, plus slack for smaller pages. */
const MAX_PAGES = 64;

export interface SlackChannelListResult {
  channels: SlackChannelSummary[];
  /** True when the workspace has more channels than the cap returned here. */
  truncated: boolean;
}

/** A live Slack error while listing (e.g. `invalid_auth`, `missing_scope`). */
export class SlackChannelsError extends Error {
  constructor(readonly slackError: string) {
    super(slackError);
    this.name = 'SlackChannelsError';
  }
}

interface CacheEntry {
  expiresAt: number;
  value: SlackChannelListResult;
}

// Keyed by bot token: a wizard save that changes the token naturally misses the
// old entry, and tests using distinct tokens never collide.
let cache = new Map<string, CacheEntry>();

/** Drop the in-isolate channel cache (tests; never needed in the normal flow). */
export function invalidateSlackChannelsCache(): void {
  cache = new Map();
}

export async function listSlackChannels(
  botToken: string,
  options: { refresh?: boolean } = {},
): Promise<SlackChannelListResult> {
  const now = Date.now();
  if (!options.refresh) {
    const hit = cache.get(botToken);
    if (hit && hit.expiresAt > now) {
      return hit.value;
    }
  }

  const collected: SlackChannelSummary[] = [];
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await slackConversationsList(botToken, {
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (!result.ok) {
      throw new SlackChannelsError(result.error ?? 'conversations_list_failed');
    }
    for (const channel of result.channels) {
      collected.push(channel);
    }
    // Advance the cursor BEFORE any exit so `cursor` at loop end always means
    // "Slack had more" — including the page-bound exit below, which would
    // otherwise leave a stale previous-page cursor behind a `break`.
    cursor = result.nextCursor;
    if (collected.length >= MAX_CHANNELS) {
      // More than we return: mark truncated if this page overflowed the cap or
      // Slack still had a cursor to keep going.
      truncated = collected.length > MAX_CHANNELS || Boolean(cursor);
      collected.length = MAX_CHANNELS;
      break;
    }
    if (!cursor) {
      break;
    }
  }
  // Exhausted MAX_PAGES with Slack still paginating (small pages can hit the
  // page bound before the channel cap): the list is incomplete, say so — the
  // UI's manual-ID fallback hint hangs off this flag.
  if (cursor) {
    truncated = true;
  }

  const channels = collected.sort((a, b) => a.name.localeCompare(b.name));
  const value: SlackChannelListResult = { channels, truncated };
  cache.set(botToken, { expiresAt: now + CHANNEL_LIST_CACHE_TTL_MS, value });
  return value;
}
