export interface SlackAppMentionEvent {
  type: 'app_mention';
  user: string;
  text: string;
  ts: string;
  channel: string;
  event_ts: string;
  thread_ts?: string;
}

export interface SlackEventFixture {
  token: string;
  team_id: string;
  api_app_id: string;
  event_id: string;
  event_time: number;
  type: 'event_callback';
  event: SlackAppMentionEvent;
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
