import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentAppLifecycle, AgentSlackPresence, CustomAgentConfig } from '../src/config/types.ts';
import { agentAppRouteSelection } from '../src/slack/agent-apps/index.ts';

const NOW = 1_800_000_000_000;
const APP = { appId: 'A0C8APP', clientId: '1.2' };

function agent(id: string, presence: AgentSlackPresence): CustomAgentConfig {
  return {
    id, kind: 'user', revision: 1, name: id, instructions: 'x', enabled: true, lifecycle: 'active',
    editPolicy: 'creator_and_admins', configurationGeneration: 1, slackPresence: presence,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

function appAgent(id: string, app: AgentAppLifecycle): CustomAgentConfig {
  return agent(id, {
    kind: 'agent_app', requestedHandle: id, normalizedHandle: id, desiredState: 'active', health: 'healthy',
    avatar: { kind: 'generated', revision: 1, seed: id }, app,
  });
}

const live = appAgent('support', {
  state: 'active', at: NOW, app: APP, icon: 'agent_avatar', botUserId: 'UBOTSUP', installedAt: NOW, installedBy: 'UOWNER',
});
const waiting = appAgent('billing', {
  state: 'awaiting_consent', at: NOW, startedBy: 'UOWNER', app: APP, icon: 'agent_avatar', allowDm: { channelId: 'D1', ts: '1.1' },
});
const grouped = agent('finance', {
  requestedHandle: 'finance', normalizedHandle: 'finance', desiredState: 'active', health: 'healthy',
  avatar: { kind: 'generated', revision: 1, seed: 'finance' }, userGroupId: 'S1',
});
const agents = [live, waiting, grouped];

/** The app can answer wherever it is live, unless a Channel fact says its bot is not there. */
const answersWhereLive = async (candidate: CustomAgentConfig) => candidate.slackPresence?.kind === 'agent_app' && candidate.slackPresence.app.state === 'active';
const answersNowhere = async () => false;

test("an Agent app's own delivery selects its Agent only for a mention of its own bot, in a Channel or group DM, or a message in its own DM", async () => {
  const own = { agentId: 'support' };
  assert.deepEqual(await agentAppRouteSelection({ text: 'hello', source: 'dm_message', channelType: 'im' }, agents, own, answersWhereLive),
    { kind: 'select', agentId: 'support' });
  assert.deepEqual(await agentAppRouteSelection({ text: '<@UBOTSUP> hi', source: 'app_mention' }, agents, own, answersWhereLive),
    { kind: 'select', agentId: 'support' });
  assert.deepEqual(await agentAppRouteSelection({ text: '<@UBOTSUP> hi', source: 'app_mention', channelType: 'im' }, agents, own, answersWhereLive),
    { kind: 'select', agentId: 'support' }, 'a message in its own DM that names its bot is still a message to it');
  for (const source of ['implicit_thread_reply', 'agent_mention', 'reaction_added'] as const) {
    assert.equal(await agentAppRouteSelection({ text: '<!subteam^S1|@finance> hi', source }, agents, own, answersWhereLive), undefined,
      `${source} routes as it would on Chickpea's delivery`);
  }
  assert.deepEqual(await agentAppRouteSelection({ text: '<@UBOTSUP> hi', source: 'app_mention', channelType: 'mpim' }, agents, own, answersWhereLive),
    { kind: 'select', agentId: 'support' }, 'a mention of its bot in a group DM its bot is in');
  assert.equal(await agentAppRouteSelection({ text: 'hello', source: 'dm_message', channelType: 'mpim' }, agents, own, answersWhereLive), undefined,
    'a plain group DM message is no DM of its own');
});

test("Chickpea's delivery ignores a Channel message naming an Agent-app bot only while that app can answer there, and routes every group DM one", async () => {
  const heard = (text: string) => ({ text, source: 'agent_mention' as const });
  const inGroupDm = (text: string) => ({ text, source: 'dm_message' as const, channelType: 'mpim' as const });
  assert.deepEqual(await agentAppRouteSelection(heard('hey <@UBOTSUP|support> can you look'), agents, undefined, answersWhereLive), { kind: 'ignore' });
  assert.equal(await agentAppRouteSelection(heard('hey <@UBOTSUP>'), agents, undefined, answersNowhere), undefined,
    'its bot is not in the Channel, or its token cannot be read: Chickpea routes it');
  assert.equal(await agentAppRouteSelection(inGroupDm('hey <@UBOTSUP>'), agents, undefined, answersWhereLive), undefined,
    "a group DM the app can answer in is routed by Chickpea, since the app's own delivery from it is never admitted");
  assert.equal(await agentAppRouteSelection(inGroupDm('hey <@UBOTSUP>'), agents, undefined, answersNowhere), undefined,
    'and a group DM it cannot answer in is routed by Chickpea');
  assert.equal(await agentAppRouteSelection({ text: 'hey <@UBOTSUP>', source: 'dm_message', channelType: 'im' }, agents, undefined, answersWhereLive), undefined,
    "the same text in Chickpea's DM is Chickpea's");
  assert.equal(await agentAppRouteSelection(heard('hey <@UBOTOTHER>'), agents, undefined, answersWhereLive), undefined, 'an unknown bot');
  assert.equal(await agentAppRouteSelection(heard('<!subteam^S1|@finance> hi'), agents, undefined, answersWhereLive), undefined, 'a user-group Agent routes as before');
  assert.equal(await agentAppRouteSelection(heard('UBOTSUP without brackets'), agents, undefined, answersWhereLive), undefined);
  assert.equal(await agentAppRouteSelection(heard('<@UBOTSUP>'), [grouped], undefined, answersWhereLive), undefined, 'no app in the workspace');
});

test('an app that is not live does not hold back a mention of its bot', async () => {
  const notLive = appAgent('billing', {
    state: 'needs_attention', at: NOW, startedBy: 'UOWNER', reason: 'app_removed', resume: 'icon_set', app: APP, botUserId: 'UBOTBILL',
  });
  assert.equal(await agentAppRouteSelection({ text: '<@UBOTBILL>', source: 'agent_mention' }, [notLive], undefined, answersWhereLive), undefined);
});
