export interface SlackAppMentionEvent {
  type: 'app_mention';
  user: string;
  text: string;
  ts: string;
  channel: string;
  event_ts: string;
  thread_ts?: string;
}

export interface SlackMessageEvent {
  type: 'message';
  channel: string;
  ts: string;
  event_ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  channel_type?: string;
  subtype?: string;
  bot_id?: string;
  app_id?: string;
  bot_profile?: {
    app_id?: string;
    id?: string;
  };
}

export interface SlackAssistantThreadStartedEvent {
  type: 'assistant_thread_started';
  event_ts: string;
  assistant_thread?: {
    channel_id?: string;
    thread_ts?: string;
  };
  channel?: string;
  thread_ts?: string;
  user?: string;
}

export interface SlackAssistantThreadContextChangedEvent {
  type: 'assistant_thread_context_changed';
  event_ts: string;
  assistant_thread?: {
    channel_id?: string;
    thread_ts?: string;
  };
  channel?: string;
  thread_ts?: string;
  user?: string;
}

export interface SlackMemberJoinedChannelEvent {
  type: 'member_joined_channel';
  user: string;
  channel: string;
  channel_type?: string;
  team?: string;
  inviter?: string;
  event_ts: string;
}

export type SlackEvent =
  | SlackAppMentionEvent
  | SlackMessageEvent
  | SlackAssistantThreadStartedEvent
  | SlackAssistantThreadContextChangedEvent
  | SlackMemberJoinedChannelEvent;

export interface SlackEventFixture {
  token: string;
  team_id: string;
  api_app_id: string;
  event_id: string;
  event_time: number;
  type: 'event_callback';
  event: SlackEvent;
}

export type SlackTurnSource = 'app_mention' | 'implicit_thread_reply' | 'dm_message';
export type SlackContextMode = 'thread' | 'channel_history' | 'dm_history';
export type SlackTurnIgnoreReason =
  | 'non_event_callback'
  | 'self_message'
  | 'missing_bot_user_id'
  | 'unsupported_event_type'
  | 'message_subtype'
  | 'bot_message'
  | 'missing_user'
  | 'empty_text'
  | 'missing_thread_metadata'
  | 'unsupported_channel_type'
  | 'top_level_channel_message';

export interface NormalizedSlackTurn {
  workspaceId: string;
  channelId: string;
  eventId: string;
  text: string;
  userId: string;
  messageTs: string;
  threadTs: string;
  sessionThreadTs?: string;
  source: SlackTurnSource;
  channelType?: string;
  contextMode: SlackContextMode;
}

export interface IgnoredSlackTurn {
  status: 'ignored';
  reason: SlackTurnIgnoreReason;
}

export interface RunnableSlackTurn {
  status: 'runnable';
  turn: NormalizedSlackTurn;
}

export type SlackTurnNormalization = RunnableSlackTurn | IgnoredSlackTurn;

export function isSlackAppMentionEvent(event: SlackEvent): event is SlackAppMentionEvent {
  return event.type === 'app_mention';
}

export function isSlackMessageEvent(event: SlackEvent): event is SlackMessageEvent {
  return event.type === 'message';
}

export function isSlackMemberJoinedChannelEvent(
  event: SlackEvent,
): event is SlackMemberJoinedChannelEvent {
  return event.type === 'member_joined_channel';
}
