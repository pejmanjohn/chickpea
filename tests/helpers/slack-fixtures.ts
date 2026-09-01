import { readFileSync } from 'node:fs';

import type {
  SlackAppMentionEvent,
  SlackEventFixture,
  SlackMessageEvent,
} from '../../src/slack/types.ts';

type AppMentionFixture = SlackEventFixture & { event: SlackAppMentionEvent };
type MessageFixture = SlackEventFixture & { event: SlackMessageEvent };

type AppMentionFixtureOverrides = Omit<Partial<SlackEventFixture>, 'event'> & {
  event?: Partial<SlackAppMentionEvent>;
};
type MessageFixtureOverrides = Omit<Partial<SlackEventFixture>, 'event'> & {
  event?: Partial<SlackMessageEvent>;
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
