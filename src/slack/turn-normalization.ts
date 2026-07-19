import {
  isSlackAppMentionEvent,
  isSlackMessageEvent,
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
}

export function normalizeSlackTurn(
  payload: SlackEventFixture,
  options: SlackTurnNormalizationOptions = {},
): SlackTurnNormalization {
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
    return { status: 'ignored', reason: 'top_level_channel_message' };
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
  };

  return { status: 'runnable', turn };
}

function isDirectConversation(event: SlackMessageEvent): boolean {
  return (
    event.channel_type === 'im' ||
    event.channel_type === 'app_home' ||
    (event.channel.startsWith('D') && !event.channel_type)
  );
}

function isChannelConversation(event: SlackMessageEvent): boolean {
  return event.channel_type === 'channel' || event.channel_type === 'group';
}

function isAppAuthoredMessage(event: SlackMessageEvent): boolean {
  return Boolean(event.bot_id || event.app_id || event.bot_profile?.app_id);
}
