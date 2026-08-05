import {
  isSlackAppMentionEvent,
  isSlackMessageEvent,
  isSlackReactionAddedEvent,
  type NormalizedSlackTurn,
  type SlackContextMode,
  type SlackEventFixture,
  type SlackMessageEvent,
  type SlackTurnNormalization,
  type SlackTurnSource,
} from './types.ts';

export interface SlackTurnNormalizationOptions {
  botUserId?: string;
}

interface RunnableTurnInput {
  payload: SlackEventFixture;
  channelId: string;
  text: string;
  userId: string;
  messageTs: string;
  threadTs: string;
  sessionThreadTs?: string;
  source: SlackTurnSource;
  channelType?: string;
  contextMode: SlackContextMode;
  reaction?: string;
  reactionTargetTs?: string;
}

export function normalizeSlackTurn(
  payload: SlackEventFixture,
  options: SlackTurnNormalizationOptions = {},
): SlackTurnNormalization {
  payload = stripSlackMessageAppContext(payload);
  if (payload.type !== 'event_callback') {
    return { status: 'ignored', reason: 'non_event_callback' };
  }

  if (isSlackAppMentionEvent(payload.event)) {
    if (options.botUserId && payload.event.user === options.botUserId) {
      return { status: 'ignored', reason: 'self_message' };
    }

    return runnableTurn({
      payload,
      channelId: payload.event.channel,
      text: payload.event.text,
      userId: payload.event.user,
      messageTs: payload.event.ts,
      threadTs: payload.event.thread_ts ?? payload.event.ts,
      source: 'app_mention',
      contextMode: payload.event.thread_ts ? 'thread' : 'channel_history',
    });
  }

  if (isSlackReactionAddedEvent(payload.event)) {
    const event = payload.event;
    if (options.botUserId && event.user === options.botUserId) {
      return { status: 'ignored', reason: 'self_message' };
    }
    if (event.item.type !== 'message' || !event.item.channel || !event.item.ts) {
      return { status: 'ignored', reason: 'unsupported_reaction_item' };
    }
    if (!event.user || !event.reaction || !event.event_ts) {
      return { status: 'ignored', reason: 'missing_thread_metadata' };
    }
    return runnableTurn({
      payload,
      channelId: event.item.channel,
      text: `Reacted :${event.reaction}: to the Slack message at ${event.item.ts}.`,
      userId: event.user,
      messageTs: event.event_ts,
      threadTs: event.item.ts,
      source: 'reaction_added',
      contextMode: 'thread',
      reaction: event.reaction,
      reactionTargetTs: event.item.ts,
    });
  }

  if (!isSlackMessageEvent(payload.event)) {
    return { status: 'ignored', reason: 'unsupported_event_type' };
  }

  const event = payload.event;
  if (event.subtype) {
    return { status: 'ignored', reason: 'message_subtype' };
  }
  if (isAppAuthoredMessage(event)) {
    return { status: 'ignored', reason: 'bot_message' };
  }
  if (!event.user) {
    return { status: 'ignored', reason: 'missing_user' };
  }
  if (options.botUserId && event.user === options.botUserId) {
    return { status: 'ignored', reason: 'self_message' };
  }
  if (!event.text || !event.text.trim()) {
    return { status: 'ignored', reason: 'empty_text' };
  }
  if (!event.channel || !event.ts) {
    return { status: 'ignored', reason: 'missing_thread_metadata' };
  }

  if (options.botUserId && event.text.includes(`<@${options.botUserId}>`)) {
    return runnableTurn({
      payload,
      channelId: event.channel,
      text: event.text,
      userId: event.user,
      messageTs: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      source: 'app_mention',
      ...(event.channel_type ? { channelType: event.channel_type } : {}),
      contextMode: event.thread_ts ? 'thread' : 'channel_history',
    });
  }

  if (isDirectConversation(event)) {
    if (!options.botUserId) {
      return { status: 'ignored', reason: 'missing_bot_user_id' };
    }

    return runnableTurn({
      payload,
      channelId: event.channel,
      text: event.text,
      userId: event.user,
      messageTs: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      sessionThreadTs: 'dm',
      source: 'dm_message',
      ...(event.channel_type ? { channelType: event.channel_type } : {}),
      contextMode: event.thread_ts ? 'thread' : 'dm_history',
    });
  }

  if (!isChannelConversation(event)) {
    return { status: 'ignored', reason: 'unsupported_channel_type' };
  }
  if (!event.thread_ts) {
    return runnableTurn({
      payload,
      channelId: event.channel,
      text: event.text,
      userId: event.user,
      messageTs: event.ts,
      threadTs: event.ts,
      source: 'ambient_channel_message',
      ...(event.channel_type ? { channelType: event.channel_type } : {}),
      contextMode: 'channel_history',
    });
  }
  if (!options.botUserId) {
    return { status: 'ignored', reason: 'missing_bot_user_id' };
  }

  return runnableTurn({
    payload,
    channelId: event.channel,
    text: event.text,
    userId: event.user,
    messageTs: event.ts,
    threadTs: event.thread_ts,
    source: 'implicit_thread_reply',
    ...(event.channel_type ? { channelType: event.channel_type } : {}),
    contextMode: 'thread',
  });
}

function runnableTurn(input: RunnableTurnInput): SlackTurnNormalization {
  const turn: NormalizedSlackTurn = {
    workspaceId: input.payload.team_id,
    channelId: input.channelId,
    eventId: input.payload.event_id,
    text: input.text,
    userId: input.userId,
    messageTs: input.messageTs,
    threadTs: input.threadTs,
    ...(input.sessionThreadTs ? { sessionThreadTs: input.sessionThreadTs } : {}),
    source: input.source,
    ...(input.channelType ? { channelType: input.channelType } : {}),
    contextMode: input.contextMode,
    ...(input.reaction ? { reaction: input.reaction } : {}),
    ...(input.reactionTargetTs ? { reactionTargetTs: input.reactionTargetTs } : {}),
  };

  return { status: 'runnable', turn };
}

function isDirectConversation(event: SlackMessageEvent): boolean {
  return (
    event.channel_type === 'im' ||
    (event.channel.startsWith('D') && !event.channel_type)
  );
}

/**
 * Remove Agent View's active-context attachment before any turn classifier,
 * dedupe coordinate, prompt, or durable state can observe it. Active context
 * is intentionally deferred until it has its own authorization contract.
 */
export function stripSlackMessageAppContext(payload: SlackEventFixture): SlackEventFixture {
  if (
    payload.event.type !== 'message' ||
    !Object.hasOwn(payload.event, 'app_context')
  ) {
    return payload;
  }
  const { app_context: _discarded, ...event } = payload.event;
  return { ...payload, event };
}

function isChannelConversation(event: SlackMessageEvent): boolean {
  return event.channel_type === 'channel' || event.channel_type === 'group';
}

function isAppAuthoredMessage(event: SlackMessageEvent): boolean {
  return Boolean(event.bot_id || event.app_id || event.bot_profile?.app_id);
}
