import assert from 'node:assert/strict';
import test from 'node:test';

import { effectiveSlackInstructions } from '../src/config/effective-config.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';

const base: CustomAgentConfig = {
  id: 'agent_brief', kind: 'user', revision: 1, name: 'Brief',
  instructions: 'You write briefs.', enabled: true, lifecycle: 'active',
  editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [], repositories: [],
};

test('the runtime layer tells an Agent its own name, handle, and Slack user group', () => {
  const text = effectiveSlackInstructions({
    workspaceId: 'T1', channelId: 'D1',
    agent: {
      ...base,
      slackPresence: {
        requestedHandle: 'brief', normalizedHandle: 'brief', desiredState: 'active',
        health: 'healthy', userGroupId: 'S0C0KB3MSSU',
        avatar: { kind: 'generated', revision: 1, seed: 'brief' },
      },
    },
  });
  assert.match(text, /Your Agent ID is agent_brief and your name is Brief\./);
  assert.match(text, /Your Slack handle is @brief; Slack writes that mention as <!subteam\^S0C0KB3MSSU> or <!subteam\^S0C0KB3MSSU\|@brief>, and either form addresses you\./);
  assert.match(text, /answer them from your saved configuration/);
});

test('an Agent without Slack presence still learns its name and self-inspection rule', () => {
  const text = effectiveSlackInstructions({ workspaceId: 'T1', channelId: 'D1', agent: base });
  assert.match(text, /your name is Brief\./);
  assert.doesNotMatch(text, /Your Slack handle/);
  assert.match(text, /never from Slack subteam lookups/);
});
