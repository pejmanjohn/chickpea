import type { ThreadImageRecord } from './thread-images.ts';
import type { NormalizedSlackTurn, SlackContextMode } from './types.ts';
import { isSlackContextMessageSubtype } from './message-subtypes.ts';
import { slackFileSummaries, slackMessageText, type SlackFileSummary } from './message-text.ts';

/**
 * Who wrote a context row, derived by the host from Slack's author fields:
 * a person, one of this installation's Chickpea Agents, or any other app or
 * integration (alert bots, webhooks, other AI agents).
 */
export type SlackContextRole = 'human' | 'agent' | 'app';

export interface SlackContextMessage {
  /** Slack user id for people; the bot or app id for apps; a label for Agents. */
  userId: string;
  text: string;
  ts: string;
  isTrigger: boolean;
  /** Host-derived Slack-visible provenance; absent only on legacy fixtures. */
  role?: SlackContextRole;
  /** Display name: a person's resolved profile name, an app's or Agent's posting name. */
  authorName?: string;
  /** The Chickpea Agent that wrote an `agent` row, when the host knows it. */
  agentId?: string;
  /** Slack root that owns this message. Top-level DM roots equal their message ts. */
  rootTs?: string;
  contentVersionTs?: string;
  /** Files shared with this message: names, types, sizes only. */
  files?: SlackFileSummary[];
  /** Replies under this message, for a channel-history row that starts a thread. */
  replyCount?: number;
}

export interface SlackContextExchange {
  rootTs: string;
  messages: SlackContextMessage[];
  incomplete: boolean;
}

export interface SlackContextPartition {
  activeThread?: SlackContextExchange;
  historicalBackground: SlackContextMessage[];
}

interface SlackContextWindow {
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
  /** Replies Slack reports under the thread root, when a read returned the root. */
  threadReplyCount?: number;
  /**
   * Additive: images found in the raw fetch rows, collected before the
   * projection above filters them. Consumers of `messages` are unchanged and
   * no prompt text is derived from this field.
   */
  images?: ThreadImageRecord[];
}

/**
 * One raw Slack row. `files` is read only by the thread image inventory in
 * thread-images.ts, from the raw rows: the projection below drops bot rows and
 * text-less rows, which is exactly where an Agent's own file share and a bare
 * upload live.
 */
export interface SlackWebApiMessage {
  type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  app_id?: string;
  /** Posting name an app chose for this message (chat:write.customize, webhooks). */
  username?: string;
  bot_profile?: { name?: string; app_id?: string };
  edited?: { ts: string };
  files?: unknown[];
  blocks?: unknown[];
  attachments?: unknown[];
  reply_count?: number;
}

/** This installation's own bot, so its rows are labeled as Agents, not apps. */
export interface SlackContextSelf {
  botUserId?: string;
  appId?: string;
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

export function toContextMessages(
  messages: SlackWebApiMessage[],
  self: SlackContextSelf = {},
): SlackContextMessage[] {
  return messages.flatMap((message) => {
    const row = toContextMessage(message, self);
    return row ? [row] : [];
  });
}

/**
 * One raw Slack row as a labeled context row, or undefined for mutation
 * wrappers, system events, and rows with nothing to show. App and bot rows
 * are kept: an alert the Agent is asked about must be visible to it. They
 * are labeled so the model can weigh them; the prompt treats every row as
 * data, never instructions.
 */
export function toContextMessage(
  message: SlackWebApiMessage,
  self: SlackContextSelf = {},
): SlackContextMessage | undefined {
  if (!message.ts || !isSlackContextMessageSubtype(message.subtype)) return undefined;
  const text = slackMessageText(message);
  const files = slackFileSummaries(message.files);
  if (!text && files.length === 0) return undefined;
  const author = slackContextAuthor(message, self);
  if (!author) return undefined;
  return {
    ...author,
    text,
    ts: message.ts,
    isTrigger: false,
    rootTs: message.thread_ts ?? message.ts,
    ...(message.edited?.ts ? { contentVersionTs: message.edited.ts } : {}),
    ...(files.length ? { files } : {}),
    ...(typeof message.reply_count === 'number' && message.reply_count > 0
      ? { replyCount: message.reply_count }
      : {}),
  };
}

function slackContextAuthor(
  message: SlackWebApiMessage,
  self: SlackContextSelf,
): Pick<SlackContextMessage, 'userId' | 'role' | 'authorName'> | undefined {
  const appId = message.app_id ?? message.bot_profile?.app_id;
  const postingName = boundedName(message.username) ?? boundedName(message.bot_profile?.name);
  const own = (self.botUserId !== undefined && message.user === self.botUserId) ||
    (self.appId !== undefined && appId === self.appId);
  if (own) {
    return { userId: message.user ?? 'agent', role: 'agent', ...(postingName ? { authorName: postingName } : {}) };
  }
  if (message.bot_id || appId || message.subtype === 'bot_message' || !message.user) {
    const id = message.bot_id ?? appId ?? message.user;
    if (!id && !postingName) return undefined;
    return { userId: id ?? 'app', role: 'app', authorName: postingName ?? 'an app' };
  }
  return { userId: message.user, role: 'human' };
}

function boundedName(value: string | undefined): string | undefined {
  const name = value?.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return name ? name.slice(0, 80) : undefined;
}

/**
 * Preserve the current same-root exchange for direct threaded replies. Other
 * visible rows remain one chronological background stream: admission and the
 * retained-context privacy filter decide which rows are visible, while this
 * projection does not guess that one different root continues another.
 */
export function partitionSlackContext(
  turn: NormalizedSlackTurn,
  context: SlackTurnContext,
): SlackContextPartition {
  const background = context.messages.filter((message) => !message.isTrigger);
  const degraded = context.truncated || context.degradations.length > 0;
  const direct = turn.channelType === 'im' ||
    (!turn.channelType && turn.channelId.startsWith('D'));
  const hasRoot = (messages: SlackContextMessage[], rootTs: string) =>
    messages.some((message) => message.ts === rootTs);
  const exchange = (rootTs: string, messages: SlackContextMessage[]): SlackContextExchange => ({
    rootTs,
    messages,
    incomplete: degraded || !hasRoot(messages, rootTs),
  });

  if (direct && context.mode === 'thread' && turn.messageTs !== turn.threadTs) {
    const messages = background.filter((message) => message.rootTs === turn.threadTs);
    const selected = new Set(messages);
    return {
      activeThread: exchange(turn.threadTs, messages),
      historicalBackground: background.filter((message) => !selected.has(message)),
    };
  }
  return { historicalBackground: background };
}

export function orderMessages(messages: SlackContextMessage[]): SlackContextMessage[] {
  return [...messages].sort((left, right) => compareSlackTs(left.ts, right.ts));
}

/**
 * Thread order for a Slack `ts`. A value that is not a number sorts as 0 —
 * every caller validates the shape upstream, so this is the fail-quiet floor
 * rather than a second ordering rule.
 */
export function compareSlackTs(left: string, right: string): number {
  return parseSlackTs(left) - parseSlackTs(right);
}

/** Reject rows newer than the admitted trigger even if Slack returns them. */
export function atOrBeforeSlackWatermark(timestamp: string, watermark: string): boolean {
  const value = slackTimestampUnits(timestamp);
  const maximum = slackTimestampUnits(watermark);
  return value !== null && maximum !== null && value <= maximum;
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
    role: 'human',
    rootTs: turn.threadTs,
  };
}

function parseSlackTs(ts: string): number {
  const parsed = Number(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function slackTimestampUnits(timestamp: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(timestamp);
  if (!match?.[1]) return null;
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
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
