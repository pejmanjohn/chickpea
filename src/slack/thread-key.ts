import type { NormalizedSlackMention, SlackEventFixture } from './types.ts';

export function normalizeAppMention(payload: SlackEventFixture): NormalizedSlackMention {
  if (payload.type !== 'event_callback' || payload.event.type !== 'app_mention') {
    throw new Error('Expected Slack app_mention event_callback payload');
  }

  return {
    workspaceId: payload.team_id,
    channelId: payload.event.channel,
    eventId: payload.event_id,
    text: payload.event.text,
    userId: payload.event.user,
    messageTs: payload.event.ts,
    threadTs: payload.event.thread_ts ?? payload.event.ts,
  };
}

export function slackThreadKey(mention: NormalizedSlackMention): string {
  return `${mention.workspaceId}:${mention.channelId}:${mention.threadTs}`;
}
