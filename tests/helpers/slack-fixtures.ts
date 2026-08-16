import { readFileSync } from 'node:fs';

import type {
  SlackAppContextChangedEvent,
  SlackAppHomeOpenedEvent,
  SlackAppMentionEvent,
  SlackEventFixture,
  SlackMessageEvent,
} from '../../src/slack/types.ts';

export type AppMentionFixture = SlackEventFixture & { event: SlackAppMentionEvent };
export type MessageFixture = SlackEventFixture & { event: SlackMessageEvent };

export type AppMentionFixtureOverrides = Omit<Partial<SlackEventFixture>, 'event'> & {
  event?: Partial<SlackAppMentionEvent>;
};
export type MessageFixtureOverrides = Omit<Partial<SlackEventFixture>, 'event'> & {
  event?: Partial<SlackMessageEvent>;
};
export type MemberJoinedFixtureOverrides = Omit<Partial<SlackEventFixture>, 'event'> & {
  event?: Record<string, unknown>;
};

type MessageFixtureFile =
  | 'message-channel-thread-reply.json'
  | 'message-private-channel-thread-reply.json'
  | 'message-channel-top-level.json'
  | 'message-im.json';

const fixtureCache = new Map<string, SlackEventFixture>();

export function appMention(overrides: AppMentionFixtureOverrides = {}): AppMentionFixture {
  const base = slackFixture<AppMentionFixture>('app-mention.json');

  return {
    ...base,
    ...overrides,
    event: {
      ...base.event,
      ...overrides.event,
      type: 'app_mention',
    },
  };
}

export function channelThreadMessage(overrides: MessageFixtureOverrides = {}): MessageFixture {
  return messageFixture('message-channel-thread-reply.json', overrides);
}

export function privateChannelThreadMessage(
  overrides: MessageFixtureOverrides = {},
): MessageFixture {
  return messageFixture('message-private-channel-thread-reply.json', overrides);
}

export function topLevelChannelMessage(overrides: MessageFixtureOverrides = {}): MessageFixture {
  return messageFixture('message-channel-top-level.json', overrides);
}

export function dmMessage(overrides: MessageFixtureOverrides = {}): MessageFixture {
  return messageFixture('message-im.json', overrides);
}

export function appHomeOpened(): SlackEventFixture & { event: SlackAppHomeOpenedEvent } {
  return slackFixture<SlackEventFixture & { event: SlackAppHomeOpenedEvent }>(
    'app-home-opened.json',
  );
}

export function appContextChanged(): SlackEventFixture & { event: SlackAppContextChangedEvent } {
  return slackFixture<SlackEventFixture & { event: SlackAppContextChangedEvent }>(
    'app-context-changed.json',
  );
}

export function memberJoinedChannel(overrides: MemberJoinedFixtureOverrides = {}): SlackEventFixture {
  return {
    token: 'verification-token-not-a-secret',
    team_id: 'TDEMO',
    api_app_id: 'ADEMO',
    event_id: 'Ev_MEMBER_JOINED_CHANNEL',
    event_time: 1782771200,
    type: 'event_callback',
    ...overrides,
    event: {
      type: 'member_joined_channel',
      user: 'UBOT',
      channel: 'C_ENG',
      channel_type: 'C',
      team: 'TDEMO',
      event_ts: '1782771200.000100',
      ...overrides.event,
    },
  } as unknown as SlackEventFixture;
}

function messageFixture(
  fileName: MessageFixtureFile,
  overrides: MessageFixtureOverrides = {},
): MessageFixture {
  const base = slackFixture<MessageFixture>(fileName);

  return {
    ...base,
    ...overrides,
    event: {
      ...base.event,
      ...overrides.event,
      type: 'message',
    },
  };
}

function slackFixture<T extends SlackEventFixture>(fileName: string): T {
  let fixture = fixtureCache.get(fileName);
  if (!fixture) {
    fixture = JSON.parse(
      readFileSync(new URL(`../../fixtures/slack/${fileName}`, import.meta.url), 'utf8'),
    ) as SlackEventFixture;
    fixtureCache.set(fileName, fixture);
  }

  return structuredClone(fixture) as T;
}
