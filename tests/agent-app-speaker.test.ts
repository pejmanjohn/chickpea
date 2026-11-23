import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentAppLifecycle, AgentSlackPresence } from '../src/config/types.ts';
import { type SlackPlace, speakerFor } from '../src/slack/speaker.ts';

const APP = { appId: 'A0AGENT1', clientId: '1.client' };
const LIVE: AgentAppLifecycle = {
  state: 'active', at: 1, app: APP, icon: 'agent_avatar', botUserId: 'UAGENTBOT', installedAt: 1, installedBy: 'U1',
};
const NOT_LIVE: Record<string, AgentAppLifecycle> = {
  creating: { state: 'creating', at: 1, startedBy: 'U1', manifestFingerprint: 'f' },
  awaiting_consent: {
    state: 'awaiting_consent', at: 1, startedBy: 'U1', app: APP, icon: 'agent_avatar', allowDm: { channelId: 'D1', ts: '1.1' },
  },
  removed: { state: 'needs_attention', at: 1, startedBy: 'U1', reason: 'app_removed', resume: 'icon_set', app: APP },
  uninstalling: { state: 'uninstalling', at: 1, startedBy: 'U1', app: APP, botUserId: 'UAGENTBOT', next: 'uninstall' },
};

function app(lifecycle: AgentAppLifecycle): AgentSlackPresence {
  return {
    kind: 'agent_app', requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
    avatar: { kind: 'generated', revision: 1, seed: 'support' }, app: lifecycle,
  };
}

const group: AgentSlackPresence = {
  requestedHandle: 'finance', normalizedHandle: 'finance', desiredState: 'active', health: 'healthy',
  avatar: { kind: 'generated', revision: 1, seed: 'finance' }, userGroupId: 'SFINANCE',
};

const notLive = Object.entries(NOT_LIVE).map(([name, lifecycle]) => [`an app ${name}`, app(lifecycle)] as const);
const everyPresence = [['a user group', group], ['no presence', undefined], ['a live app', app(LIVE)], ...notLive] as const;
const chickpeaCanPost: SlackPlace[] = [
  { kind: 'chickpea_dm' },
  { kind: 'group_dm', chickpeaBotIsMember: true },
  { kind: 'channel', appBotIsMember: false, chickpeaBotIsMember: true },
];

test("a user-group Agent, or one whose app is not live, answers through Chickpea as itself wherever Chickpea's bot is", () => {
  for (const [name, presence] of [['a user group', group], ['no presence', undefined], ...notLive] as const) {
    for (const place of [...chickpeaCanPost, { kind: 'channel', appBotIsMember: true, chickpeaBotIsMember: true } as const]) {
      assert.deepEqual(speakerFor(presence, place), { kind: 'chickpea_as_agent' }, `${name} in ${JSON.stringify(place)}`);
    }
  }
});

test('a live app Agent answers as its own bot in its own DM', () => {
  assert.deepEqual(speakerFor(app(LIVE), { kind: 'agent_dm' }), { kind: 'own_bot', botUserId: 'UAGENTBOT' });
});

test("a live app Agent answers as its own bot in a Channel its bot is in, whether or not Chickpea's is", () => {
  for (const chickpeaBotIsMember of [true, false]) {
    assert.deepEqual(
      speakerFor(app(LIVE), { kind: 'channel', appBotIsMember: true, chickpeaBotIsMember }),
      { kind: 'own_bot', botUserId: 'UAGENTBOT' },
    );
  }
});

test("a live app Agent answers through Chickpea as itself in a Channel its bot is not in and Chickpea's is", () => {
  assert.deepEqual(
    speakerFor(app(LIVE), { kind: 'channel', appBotIsMember: false, chickpeaBotIsMember: true }),
    { kind: 'chickpea_as_agent' },
  );
});

test("a live app Agent answers through Chickpea as itself in Chickpea's DM and in a group DM Chickpea's bot is in", () => {
  assert.deepEqual(speakerFor(app(LIVE), { kind: 'chickpea_dm' }), { kind: 'chickpea_as_agent' });
  assert.deepEqual(speakerFor(app(LIVE), { kind: 'group_dm', chickpeaBotIsMember: true }), { kind: 'chickpea_as_agent' });
});

test("an app that is not live has no speaker in its own DM: Chickpea's bot cannot post there", () => {
  for (const [name, presence] of notLive) {
    assert.deepEqual(speakerFor(presence, { kind: 'agent_dm' }), { kind: 'unavailable', reason: 'app_removed' }, name);
  }
});

test("no Agent answers in a group DM without Chickpea's bot: an app token is never used in a group DM", () => {
  for (const [name, presence] of everyPresence) {
    assert.deepEqual(
      speakerFor(presence, { kind: 'group_dm', chickpeaBotIsMember: false }),
      { kind: 'unavailable', reason: 'no_bot_can_post' },
      name,
    );
  }
});

test('no Agent answers in a Channel neither bot is in', () => {
  for (const [name, presence] of everyPresence) {
    assert.deepEqual(
      speakerFor(presence, { kind: 'channel', appBotIsMember: false, chickpeaBotIsMember: false }),
      { kind: 'unavailable', reason: 'no_bot_can_post' },
      name,
    );
  }
  for (const [name, presence] of notLive) {
    assert.deepEqual(
      speakerFor(presence, { kind: 'channel', appBotIsMember: true, chickpeaBotIsMember: false }),
      { kind: 'unavailable', reason: 'no_bot_can_post' },
      `${name}: a bot whose app is not live does not count`,
    );
  }
});
