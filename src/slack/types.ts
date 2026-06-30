export interface SlackAppMentionEvent {
  type: 'app_mention';
  user: string;
  text: string;
  ts: string;
  channel: string;
  event_ts: string;
  thread_ts?: string;
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

export type SlackEvent =
  | SlackAppMentionEvent
  | SlackAssistantThreadStartedEvent
  | SlackAssistantThreadContextChangedEvent;

export interface SlackEventFixture {
  token: string;
  team_id: string;
  api_app_id: string;
  event_id: string;
  event_time: number;
  type: 'event_callback';
  event: SlackEvent;
}

export interface NormalizedSlackMention {
  workspaceId: string;
  channelId: string;
  eventId: string;
  text: string;
  userId: string;
  messageTs: string;
  threadTs: string;
}

export function isSlackAppMentionEvent(event: SlackEvent): event is SlackAppMentionEvent {
  return event.type === 'app_mention';
}

export function isSlackAssistantEvent(
  event: SlackEvent,
): event is SlackAssistantThreadStartedEvent | SlackAssistantThreadContextChangedEvent {
  return (
    event.type === 'assistant_thread_started' ||
    event.type === 'assistant_thread_context_changed'
  );
}
