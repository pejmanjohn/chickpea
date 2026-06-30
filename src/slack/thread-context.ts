import type { NormalizedSlackTurn, SlackContextMode } from './types.ts';

export interface SlackContextMessage {
  userId: string;
  text: string;
  ts: string;
  isTrigger: boolean;
}

export interface SlackContextWindow {
  mode: SlackContextMode;
  latest?: string;
  oldest?: string;
  reason?: string;
}

export interface SlackTurnContext {
  mode: SlackContextMode;
  messages: SlackContextMessage[];
  window?: SlackContextWindow;
  truncated: boolean;
  degradations: string[];
}

export interface SlackContextClient {
  hydrate(turn: NormalizedSlackTurn): Promise<SlackTurnContext>;
}

export interface SlackWebApiContextClientOptions {
  botToken: string;
  fetch?: typeof fetch;
  maxMessages?: number;
  maxPages?: number;
}

interface SlackWebApiMessage {
  type?: string;
  user?: string;
  text?: string;
  ts?: string;
  subtype?: string;
  bot_id?: string;
}

interface SlackMessagesResponse {
  ok: boolean;
  messages?: SlackWebApiMessage[];
  error?: string;
  response_metadata?: {
    next_cursor?: string;
  };
}

const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_MAX_PAGES = 3;
const SECONDS_PER_HOUR = 60 * 60;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;

export class NoopSlackContextClient implements SlackContextClient {
  async hydrate(turn: NormalizedSlackTurn): Promise<SlackTurnContext> {
    return {
      mode: turn.contextMode,
      messages: [],
      truncated: false,
      degradations: [],
    };
  }
}

export class SlackWebApiContextClient implements SlackContextClient {
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxMessages: number;
  private readonly maxPages: number;

  constructor(options: SlackWebApiContextClientOptions) {
    this.botToken = options.botToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  }

  async hydrate(turn: NormalizedSlackTurn): Promise<SlackTurnContext> {
    try {
      if (turn.contextMode === 'channel_history' || turn.contextMode === 'dm_history') {
        return await this.fetchConversationHistory(turn);
      }
      return await this.fetchThread(turn);
    } catch (error) {
      return currentMessageOnlyContext(turn, [
        `slack_context.${turn.contextMode}:${sanitizeError(error)}`,
      ]);
    }
  }

  private async fetchThread(turn: NormalizedSlackTurn): Promise<SlackTurnContext> {
    const collected: SlackContextMessage[] = [];
    const degradations: string[] = [];
    let cursor: string | undefined;
    let truncated = false;

    for (let page = 0; page < this.maxPages && collected.length < this.maxMessages; page += 1) {
      const remaining = this.maxMessages - collected.length;
      const payload: Record<string, unknown> = {
        channel: turn.channelId,
        ts: turn.threadTs,
        limit: Math.min(remaining, this.maxMessages),
      };
      if (cursor) {
        payload.cursor = cursor;
      }

      const response = await this.slackApi('conversations.replies', payload);
      collected.push(...toContextMessages(response.messages ?? []).slice(0, remaining));
      cursor = response.response_metadata?.next_cursor?.trim() || undefined;
      if (!cursor) {
        break;
      }
    }

    if (cursor) {
      truncated = true;
      degradations.push('slack_context.thread:truncated');
    }

    const messages = ensureTriggerMessage(orderMessages(collected), turn);
    return {
      mode: 'thread',
      messages,
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

  private async fetchConversationHistory(turn: NormalizedSlackTurn): Promise<SlackTurnContext> {
    if (turn.contextMode === 'thread') {
      throw new Error('thread_context_requires_conversations_replies');
    }

    const window = computeHistoryWindow(turn.contextMode, turn.text, turn.messageTs);
    const response = await this.slackApi('conversations.history', {
      channel: turn.channelId,
      latest: window.latest,
      oldest: window.oldest,
      inclusive: false,
      limit: this.maxMessages,
    });
    const hasCursor = Boolean(response.response_metadata?.next_cursor?.trim());
    const messages = ensureTriggerMessage(orderMessages(toContextMessages(response.messages ?? [])), turn);
    const degradations = hasCursor ? [`slack_context.${turn.contextMode}:truncated`] : [];

    return {
      mode: 'channel_history',
      messages,
      window,
      truncated: hasCursor,
      degradations,
    };
  }

  private async slackApi(
    method: 'conversations.replies' | 'conversations.history',
    payload: Record<string, unknown>,
  ): Promise<SlackMessagesResponse> {
    const formBody = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      formBody.set(key, String(value));
    }

    const response = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.botToken}`,
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: formBody,
    });

    let body: SlackMessagesResponse;
    try {
      body = (await response.json()) as SlackMessagesResponse;
    } catch {
      throw new Error(`http_${response.status}`);
    }

    if (!response.ok || !body.ok) {
      throw new Error(body.error ?? `http_${response.status}`);
    }

    return body;
  }
}

export function currentMessageOnlyContext(
  turn: NormalizedSlackTurn,
  degradations: string[] = [],
): SlackTurnContext {
  return {
    mode: turn.contextMode,
    messages: [triggerMessage(turn)],
    window:
      turn.contextMode === 'thread'
        ? {
            mode: 'thread',
            oldest: turn.threadTs,
            latest: turn.messageTs,
            reason: 'fallback_current_message',
          }
        : computeHistoryWindow(turn.contextMode, turn.text, turn.messageTs),
    truncated: false,
    degradations,
  };
}

export function computeChannelHistoryWindow(text: string, latest: string): SlackContextWindow {
  return computeHistoryWindow('channel_history', text, latest);
}

function computeHistoryWindow(
  mode: Exclude<SlackContextMode, 'thread'>,
  text: string,
  latest: string,
): SlackContextWindow {
  const latestSeconds = parseSlackTs(latest);
  const lowered = text.toLowerCase();
  const lastWindow = /\blast\s+(\d{1,3})\s+(hour|hours|day|days)\b/i.exec(text);
  if (lastWindow?.[1] && lastWindow[2]) {
    const amount = Number(lastWindow[1]);
    const unit = lastWindow[2].toLowerCase();
    const seconds = unit.startsWith('hour') ? amount * SECONDS_PER_HOUR : amount * SECONDS_PER_DAY;
    return {
      mode,
      latest,
      oldest: formatSlackTs(latestSeconds - seconds),
      reason: `last_${amount}_${unit}`,
    };
  }

  const sinceWindow = /\bsince\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(text);
  const weekday = sinceWindow?.[1]?.toLowerCase();
  if (weekday) {
    return {
      mode,
      latest,
      oldest: formatSlackTs(startOfMostRecentUtcWeekday(latestSeconds, weekday)),
      reason: `since_${weekday}`,
    };
  }

  if (/\btoday\b/.test(lowered)) {
    return {
      mode,
      latest,
      oldest: formatSlackTs(startOfUtcDay(latestSeconds)),
      reason: 'today',
    };
  }
  if (/\byesterday\b/.test(lowered)) {
    return {
      mode,
      latest,
      oldest: formatSlackTs(startOfUtcDay(latestSeconds) - SECONDS_PER_DAY),
      reason: 'yesterday',
    };
  }
  if (/\bthis\s+week\b/.test(lowered)) {
    return {
      mode,
      latest,
      oldest: formatSlackTs(startOfUtcWeek(latestSeconds)),
      reason: 'this_week',
    };
  }
  if (/\blast\s+week\b/.test(lowered)) {
    return {
      mode,
      latest,
      oldest: formatSlackTs(startOfUtcWeek(latestSeconds) - SECONDS_PER_WEEK),
      reason: 'last_week',
    };
  }

  return {
    mode,
    latest,
    oldest: formatSlackTs(latestSeconds - SECONDS_PER_DAY),
    reason: 'default_24h',
  };
}

function toContextMessages(messages: SlackWebApiMessage[]): SlackContextMessage[] {
  return messages.flatMap((message) => {
    if (!message.user || !message.text || !message.text.trim() || !message.ts) {
      return [];
    }
    if (message.bot_id || message.subtype) {
      return [];
    }
    return [
      {
        userId: message.user,
        text: message.text,
        ts: message.ts,
        isTrigger: false,
      },
    ];
  });
}

function orderMessages(messages: SlackContextMessage[]): SlackContextMessage[] {
  return [...messages].sort((left, right) => parseSlackTs(left.ts) - parseSlackTs(right.ts));
}

function ensureTriggerMessage(
  messages: SlackContextMessage[],
  turn: NormalizedSlackTurn,
): SlackContextMessage[] {
  const triggerIndex = messages.findIndex((message) => message.ts === turn.messageTs);
  if (triggerIndex >= 0) {
    return messages.map((message, index) => ({
      ...message,
      isTrigger: index === triggerIndex,
    }));
  }

  return orderMessages([...messages, triggerMessage(turn)]);
}

function triggerMessage(turn: NormalizedSlackTurn): SlackContextMessage {
  return {
    userId: turn.userId,
    text: turn.text,
    ts: turn.messageTs,
    isTrigger: true,
  };
}

function parseSlackTs(ts: string): number {
  const parsed = Number(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatSlackTs(seconds: number): string {
  return Math.max(0, seconds).toFixed(6);
}

function startOfUtcDay(seconds: number): number {
  const date = new Date(seconds * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
}

function startOfUtcWeek(seconds: number): number {
  const dayStart = startOfUtcDay(seconds);
  const day = new Date(dayStart * 1000).getUTCDay();
  const mondayOffset = (day + 6) % 7;
  return dayStart - mondayOffset * SECONDS_PER_DAY;
}

function startOfMostRecentUtcWeekday(seconds: number, weekday: string): number {
  const weekdayToDay: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const target = weekdayToDay[weekday] ?? 1;
  const dayStart = startOfUtcDay(seconds);
  const current = new Date(dayStart * 1000).getUTCDay();
  const delta = (current - target + 7) % 7;
  return dayStart - delta * SECONDS_PER_DAY;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}
