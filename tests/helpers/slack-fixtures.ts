import { readFileSync } from 'node:fs';

import type {
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

type MessageFixtureFile =
  | 'message-channel-thread-reply.json'
  | 'message-channel-top-level.json'
  | 'message-im.json'
  | 'message-app-home.json';

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

export function topLevelChannelMessage(overrides: MessageFixtureOverrides = {}): MessageFixture {
  return messageFixture('message-channel-top-level.json', overrides);
}

export function dmMessage(overrides: MessageFixtureOverrides = {}): MessageFixture {
  return messageFixture('message-im.json', overrides);
}

export function appHomeMessage(overrides: MessageFixtureOverrides = {}): MessageFixture {
  return messageFixture('message-app-home.json', overrides);
}

export function assistantThreadStarted(): SlackEventFixture {
  return slackFixture<SlackEventFixture>('assistant-thread-started.json');
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
