import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentAppLifecycle, AgentSlackPresence } from '../src/config/types.ts';
import { admissionSpeaker } from '../src/slack/agent-apps/place.ts';
import { type SlackPlace, speakerFor } from '../src/slack/speaker.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

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
  { kind: 'group_dm', appBotIsMember: false, chickpeaBotIsMember: true },
  { kind: 'channel', appBotIsMember: false, chickpeaBotIsMember: true },
];

test("a user-group Agent, or one whose app is not live, answers through Chickpea as itself wherever Chickpea's bot is", () => {
  for (const [name, presence] of [['a user group', group], ['no presence', undefined], ...notLive] as const) {
    for (const place of [
      ...chickpeaCanPost,
      { kind: 'channel', appBotIsMember: true, chickpeaBotIsMember: true } as const,
      { kind: 'group_dm', appBotIsMember: true, chickpeaBotIsMember: true } as const,
    ]) {
      assert.deepEqual(speakerFor(presence, place), { kind: 'chickpea_as_agent' }, `${name} in ${JSON.stringify(place)}`);
    }
  }
});

test('a live app Agent answers as its own bot in its own DM', () => {
  assert.deepEqual(speakerFor(app(LIVE), { kind: 'agent_dm' }), { kind: 'own_bot', botUserId: 'UAGENTBOT' });
});

test("a live app Agent answers as its own bot in a Channel or group DM its bot is in, whether or not Chickpea's is", () => {
  for (const kind of ['channel', 'group_dm'] as const) {
    for (const chickpeaBotIsMember of [true, false]) {
      assert.deepEqual(
        speakerFor(app(LIVE), { kind, appBotIsMember: true, chickpeaBotIsMember }),
        { kind: 'own_bot', botUserId: 'UAGENTBOT' },
        `${kind}, Chickpea's bot ${chickpeaBotIsMember ? 'in' : 'out'}`,
      );
    }
  }
});

test("a live app Agent answers through Chickpea as itself in a Channel its bot is not in and Chickpea's is", () => {
  assert.deepEqual(
    speakerFor(app(LIVE), { kind: 'channel', appBotIsMember: false, chickpeaBotIsMember: true }),
    { kind: 'chickpea_as_agent' },
  );
});

test("a live app Agent answers through Chickpea as itself in Chickpea's DM and in a group DM its bot is not in and Chickpea's is", () => {
  assert.deepEqual(speakerFor(app(LIVE), { kind: 'chickpea_dm' }), { kind: 'chickpea_as_agent' });
  assert.deepEqual(
    speakerFor(app(LIVE), { kind: 'group_dm', appBotIsMember: false, chickpeaBotIsMember: true }),
    { kind: 'chickpea_as_agent' },
  );
});

test("an app that is not live has no speaker in its own DM: Chickpea's bot cannot post there", () => {
  for (const [name, presence] of notLive) {
    assert.deepEqual(speakerFor(presence, { kind: 'agent_dm' }), { kind: 'unavailable', reason: 'app_removed' }, name);
  }
});

test('no Agent answers in a Channel or group DM neither bot is in', () => {
  for (const kind of ['channel', 'group_dm'] as const) {
    for (const [name, presence] of everyPresence) {
      assert.deepEqual(
        speakerFor(presence, { kind, appBotIsMember: false, chickpeaBotIsMember: false }),
        { kind: 'unavailable', reason: 'no_bot_can_post' },
        `${name} in a ${kind}`,
      );
    }
    for (const [name, presence] of notLive) {
      assert.deepEqual(
        speakerFor(presence, { kind, appBotIsMember: true, chickpeaBotIsMember: false }),
        { kind: 'unavailable', reason: 'no_bot_can_post' },
        `${name} in a ${kind}: a bot whose app is not live does not count`,
      );
    }
  }
});

function heardTurn(channelType: 'im' | 'mpim', patch: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1', channelId: channelType === 'im' ? 'D1' : 'G1', channelType, eventId: 'Ev1', text: 'hello', userId: 'U1',
    messageTs: '1.1', threadTs: '1.1', source: channelType === 'im' ? 'dm_message' : 'app_mention', contextMode: 'thread', ...patch,
  };
}

const teammate = app({ ...LIVE, app: { appId: 'A0OTHER', clientId: '2.client' }, botUserId: 'UOTHERBOT' });
const heardBy = (botUserId: string) => ({ botUserId, agentApp: botUserId !== 'UBOT' });

test("an Agent's own DM is its own app's DM only: a DM marked with another Agent's bot gives this Agent no bot", async () => {
  const own = heardTurn('im');
  assert.deepEqual(
    await admissionSpeaker({ turn: own, agentId: 'agent_support', presence: app(LIVE), hearing: heardBy('UAGENTBOT'), env: undefined }),
    { kind: 'own_bot', botUserId: 'UAGENTBOT' },
  );
  assert.equal(own.dmBotUserId, 'UAGENTBOT');
  for (const [name, presence, hearing] of [
    ["a teammate with its own app, heard by the other app's bot", teammate, heardBy('UAGENTBOT')],
    ["a teammate with its own app, in a DM already marked with the other app's bot", teammate, heardBy('UBOT')],
    ["a user-group Agent, in a DM marked with an app's bot", group, heardBy('UBOT')],
  ] as const) {
    assert.deepEqual(
      await admissionSpeaker({ turn: heardTurn('im', { dmBotUserId: 'UAGENTBOT' }), agentId: 'agent_finance', presence, hearing, env: undefined }),
      { kind: 'unavailable', reason: 'no_bot_can_post' },
      name,
    );
  }
});

test("a group DM mention the app's own bot heard answers as that bot; one Chickpea's bot heard answers through Chickpea", async () => {
  assert.deepEqual(
    await admissionSpeaker({ turn: heardTurn('mpim'), agentId: 'agent_support', presence: app(LIVE), hearing: heardBy('UAGENTBOT'), env: undefined }),
    { kind: 'own_bot', botUserId: 'UAGENTBOT' },
  );
  for (const presence of [app(LIVE), group]) {
    assert.deepEqual(
      await admissionSpeaker({ turn: heardTurn('mpim'), agentId: 'agent_support', presence, hearing: heardBy('UBOT'), env: undefined }),
      { kind: 'chickpea_as_agent' },
    );
  }
  assert.deepEqual(
    await admissionSpeaker({ turn: heardTurn('mpim'), agentId: 'agent_support', presence: teammate, hearing: heardBy('UAGENTBOT'), env: undefined }),
    { kind: 'unavailable', reason: 'no_bot_can_post' },
    "another app's bot heard it: neither this Agent's bot nor Chickpea's is known to be there",
  );
  assert.deepEqual(
    await admissionSpeaker({
      turn: heardTurn('mpim'), agentId: 'agent_support', presence: app(NOT_LIVE.uninstalling!), hearing: heardBy('UAGENTBOT'), env: undefined,
    }),
    { kind: 'unavailable', reason: 'no_bot_can_post' },
    'an app that is no longer live does not answer even where its bot heard the mention',
  );
});
