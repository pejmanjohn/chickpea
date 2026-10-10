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

test("an Agent app's own ingress selects its Agent whatever the text says", () => {
  assert.deepEqual(agentAppRouteSelection({ text: 'hello' }, 'direct', agents, { agentId: 'support' }), { kind: 'select', agentId: 'support' });
  assert.deepEqual(agentAppRouteSelection({ text: '<@UBOTSUP> hi' }, 'channel', agents, { agentId: 'support' }), { kind: 'select', agentId: 'support' });
});

test("Chickpea's ingress ignores a Channel message mentioning a live Agent-app bot, and nothing else", () => {
  assert.deepEqual(agentAppRouteSelection({ text: 'hey <@UBOTSUP|support> can you look' }, 'channel', agents, undefined), { kind: 'ignore' });
  assert.deepEqual(agentAppRouteSelection({ text: 'hey <@UBOTSUP>' }, 'channel', agents, undefined), { kind: 'ignore' });
  assert.equal(agentAppRouteSelection({ text: 'hey <@UBOTSUP>' }, 'direct', agents, undefined), undefined, "the same text in Chickpea's DM is Chickpea's");
  assert.equal(agentAppRouteSelection({ text: 'hey <@UBOTOTHER>' }, 'channel', agents, undefined), undefined, 'an unknown bot');
  assert.equal(agentAppRouteSelection({ text: '<!subteam^S1|@finance> hi' }, 'channel', agents, undefined), undefined, 'a user-group Agent routes as before');
  assert.equal(agentAppRouteSelection({ text: 'UBOTSUP without brackets' }, 'channel', agents, undefined), undefined);
  assert.equal(agentAppRouteSelection({ text: '<@UBOTSUP>' }, 'channel', [grouped], undefined), undefined, 'no live app in the workspace');
});

test('an app that is not yet live does not claim mentions of a bot it has no user for', () => {
  const notLive = appAgent('billing', {
    state: 'needs_attention', at: NOW, startedBy: 'UOWNER', reason: 'app_removed', resume: 'icon_set', app: APP, botUserId: 'UBOTBILL',
  });
  assert.equal(agentAppRouteSelection({ text: '<@UBOTBILL>' }, 'channel', [notLive], undefined), undefined);
});
