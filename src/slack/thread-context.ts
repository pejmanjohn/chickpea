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

export interface SlackWebApiMessage {
  type?: string;
  user?: string;
  text?: string;
  ts?: string;
  subtype?: string;
  bot_id?: string;
}

export const DEFAULT_MAX_MESSAGES = 50;
export const DEFAULT_MAX_PAGES = 3;
const SECONDS_PER_HOUR = 60 * 60;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;

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

export function computeHistoryWindow(
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

export function toContextMessages(messages: SlackWebApiMessage[]): SlackContextMessage[] {
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

export function orderMessages(messages: SlackContextMessage[]): SlackContextMessage[] {
  return [...messages].sort((left, right) => parseSlackTs(left.ts) - parseSlackTs(right.ts));
}

export function ensureTriggerMessage(
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
