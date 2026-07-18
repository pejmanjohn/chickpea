import type { WebClient } from '@slack/web-api';

import { formatSlackContextRows, slackContextWindowLabel } from './context-format.ts';
import {
  computeHistoryWindow,
  currentMessageOnlyContext,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_PAGES,
  ensureTriggerMessage,
  orderMessages,
  toContextMessages,
  type SlackContextMessage,
  type SlackTurnContext,
  type SlackWebApiMessage,
} from './thread-context.ts';
import type { NormalizedSlackTurn } from './types.ts';

/**
 * WebClient-backed hydration of the bounded Slack context that feeds a turn's
 * prompt. This is the Flue lane's transport equivalent of the hand-rolled
 * lane's `SlackWebApiContextClient` (src/slack/thread-context.ts): it reuses
 * that module's *pure* policy helpers verbatim — window computation
 * (`computeHistoryWindow`), bot/app/subtype row filtering (`toContextMessages`),
 * ordering (`orderMessages`), trigger insertion (`ensureTriggerMessage`), and
 * the page/message limits (`DEFAULT_MAX_*`) — and only reimplements the thin
 * fetch orchestration on top of a `@slack/web-api` WebClient.
 *
 * Policy parity (per contextMode):
 *   - channel_history / dm_history -> conversations.history, window-bounded,
 *     limit DEFAULT_MAX_MESSAGES (never conversations.replies for DMs).
 *   - thread -> conversations.replies, paginated (limit 50 first page, cursor +
 *     decremented limit on later pages, capped at DEFAULT_MAX_PAGES).
 * Any hydration failure degrades to current-message-only context so the turn
 * still completes (matching the hand-rolled lane).
 */
export interface HydrateSlackContextOptions {
  maxMessages?: number;
  maxPages?: number;
}

export async function hydrateSlackContextViaWebClient(
  client: WebClient,
  turn: NormalizedSlackTurn,
  options: HydrateSlackContextOptions = {},
): Promise<SlackTurnContext> {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  try {
    if (turn.contextMode === 'thread') {
      return await fetchThread(client, turn, maxMessages, maxPages);
    }
    return await fetchHistory(client, turn, maxMessages);
  } catch (error) {
    return currentMessageOnlyContext(turn, [
      `slack_context.${turn.contextMode}:${sanitizeError(error)}`,
    ]);
  }
}

async function fetchHistory(
  client: WebClient,
  turn: NormalizedSlackTurn,
  maxMessages: number,
): Promise<SlackTurnContext> {
  // dm_history and channel_history share the same bounded-history policy; only
  // conversations.history is used (never conversations.replies for DMs).
  const mode = turn.contextMode as Exclude<NormalizedSlackTurn['contextMode'], 'thread'>;
  const window = computeHistoryWindow(mode, turn.text, turn.messageTs);

  const response = await client.conversations.history({
    channel: turn.channelId,
    ...(window.latest !== undefined ? { latest: window.latest } : {}),
    ...(window.oldest !== undefined ? { oldest: window.oldest } : {}),
    inclusive: false,
    limit: maxMessages,
  });

  const rawMessages = (response.messages ?? []) as unknown as SlackWebApiMessage[];
  const hasCursor = Boolean(response.response_metadata?.next_cursor?.trim());
  const messages = ensureTriggerMessage(orderMessages(toContextMessages(rawMessages)), turn);
  const degradations = hasCursor ? [`slack_context.${turn.contextMode}:truncated`] : [];

  return {
    mode: turn.contextMode,
    messages,
    window,
    truncated: hasCursor,
    degradations,
  };
}

async function fetchThread(
  client: WebClient,
  turn: NormalizedSlackTurn,
  maxMessages: number,
  maxPages: number,
): Promise<SlackTurnContext> {
  // conversations.replies paginates OLDEST-first from the thread root. A long
  // thread's most recent messages (including the one that triggered this turn)
  // live on the LAST page, so we must not stop after the first maxMessages —
  // that kept the oldest 50 and dropped all recent context. Walk pages (bounded
  // by maxPages) and retain the NEWEST maxMessages as a rolling tail.
  const collected: SlackContextMessage[] = [];
  const degradations: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await client.conversations.replies({
      channel: turn.channelId,
      ts: turn.threadTs,
      limit: maxMessages,
      ...(cursor ? { cursor } : {}),
    });

    const rawMessages = (response.messages ?? []) as unknown as SlackWebApiMessage[];
    collected.push(...toContextMessages(rawMessages));
    // Keep only the newest maxMessages so an early page never crowds out the
    // recent tail; slicing each round bounds memory on very long threads.
    if (collected.length > maxMessages) {
      collected.splice(0, collected.length - maxMessages);
    }
    cursor = response.response_metadata?.next_cursor?.trim() || undefined;
    if (!cursor) {
      break;
    }
  }

  // Truncated when the thread had more pages than maxPages allowed us to walk —
  // we then hold the most-recent window we could reach, not the whole thread.
  const truncated = Boolean(cursor);
  if (truncated) {
    degradations.push('slack_context.thread:truncated');
  }

  return {
    mode: 'thread',
    messages: ensureTriggerMessage(orderMessages(collected), turn),
    window: {
      mode: 'thread',
      oldest: turn.threadTs,
      latest: turn.messageTs,
      reason: 'thread_root',
    },
    truncated,
    degradations,
  };
}

/**
 * Build the user-message prompt for the durable agent from the trigger text and
 * the hydrated (already bot-filtered) context rows. Reuses the shared
 * `formatSlackContextRows` / `slackContextWindowLabel` helpers so the emitted
 * provider request observably carries the human context rows and excludes the
 * filtered bot rows (scenario S07). The agent's own instructions are assembled
 * separately inside the agent module.
 */
export function assembleSlackPrompt(turn: NormalizedSlackTurn, context: SlackTurnContext): string {
  if (context.messages.length === 0) {
    return turn.text;
  }

  const rows = formatSlackContextRows(context.messages, { prefix: '- ', separator: '\n' });
  const label = slackContextWindowLabel(context, 'none');
  return [turn.text, '', `Bounded Slack context (${label}):`, rows].join('\n');
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}
