import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CustomAgentConfig } from '../src/config/types.ts';
import {
  agentAppHomeStarterMessage,
  agentDirectoryAppHome,
  parseAgentAppHomeSelection,
  START_AGENT_ACTION_ID,
} from '../src/slack/app-home.ts';

function agent(id: string, name: string): CustomAgentConfig {
  return {
    id, revision: 1, name, description: `${name} description`, instructions: 'Help.', enabled: true,
    lifecycle: 'active', configurationGeneration: 1, skills: [], mcpServers: [],
    apiConnections: [], repositories: [],
    slackPresence: {
      requestedHandle: id, normalizedHandle: id, desiredState: 'active', health: 'healthy',
      userGroupId: `S${id.toUpperCase()}`,
      avatar: { kind: 'generated', revision: 1, seed: id, url: `https://example.com/${id}.svg` },
    },
  };
}

test('App Home is a sparse directory with one private-message action per visible Agent', () => {
  const view = agentDirectoryAppHome([agent('support', 'Support'), agent('finance', 'Finance')]);
  assert.equal(view.type, 'home');
  const json = JSON.stringify(view);
  assert.match(json, /Your Agents/);
  assert.match(json, /Support/);
  assert.match(json, /Finance/);
  assert.equal((view.blocks ?? []).filter((block) =>
    JSON.stringify(block).includes(START_AGENT_ACTION_ID)).length, 2);
});

test('only the exact App Home Agent action produces a trusted selection', () => {
  const payload: Record<string, any> = {
    type: 'block_actions',
    team: { id: 'T1' },
    user: { id: 'U1' },
    api_app_id: 'A1',
    container: {},
    actions: [{ type: 'button', action_id: START_AGENT_ACTION_ID, value: 'agent_support' }],
  };
  assert.deepEqual(parseAgentAppHomeSelection(payload as never), {
    workspaceId: 'T1', userId: 'U1', agentId: 'agent_support',
  });
  assert.equal(parseAgentAppHomeSelection({
    ...payload,
    actions: [{ type: 'button', action_id: START_AGENT_ACTION_ID, value: '../support' }],
  } as never), undefined);
});

test('App Home starts a base-app thread that separates the handle from the Agent name', () => {
  assert.equal(
    agentAppHomeStarterMessage('Sprout', 'sprout'),
    'Start a thread with @sprout. Reply in this thread to work with Sprout.',
  );
});
