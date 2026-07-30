import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ResolvedAssignment } from '../src/config/types.ts';
import {
  LEDGER_CANARY_CHANNELS_KEY,
  selectSlackExecutionAuthority,
} from '../src/work/authority.ts';

test('the scoped selector defaults legacy and matches only an exact workspace/channel pair', () => {
  const input = {
    workspaceId: 'T_acme',
    channelId: 'C_canary',
    assignment: assignment(),
  };
  assert.deepEqual(selectSlackExecutionAuthority(input), {
    authority: 'legacy', coordinatorKind: 'interactive', authorityEpoch: 1,
  });
  assert.deepEqual(selectSlackExecutionAuthority({
    ...input,
    env: { [LEDGER_CANARY_CHANNELS_KEY]: 'T_other/C_canary,T_acme/C_canary' },
  }), {
    authority: 'ledger', coordinatorKind: 'interactive', authorityEpoch: 1,
  });
  assert.equal(selectSlackExecutionAuthority({
    ...input,
    workspaceId: 'T_other',
    env: { [LEDGER_CANARY_CHANNELS_KEY]: 'T_acme/C_canary' },
  }).authority, 'legacy');
  assert.equal(selectSlackExecutionAuthority({
    ...input,
    env: { [LEDGER_CANARY_CHANNELS_KEY]: '*' },
  }).authority, 'legacy');
});

test('tool-capable profiles stay on legacy until paired action receipts are enforced', () => {
  const selected = { [LEDGER_CANARY_CHANNELS_KEY]: 'T_acme/C_canary' };
  const base = {
    workspaceId: 'T_acme', channelId: 'C_canary', env: selected,
  };
  assert.equal(selectSlackExecutionAuthority({ ...base, assignment: assignment() }).authority, 'ledger');
  assert.equal(
    selectSlackExecutionAuthority({
      ...base,
      assignment: assignment(),
      legacyOnlyTurn: true,
    }).authority,
    'legacy',
    'explicit Memory/Routine controls retain their established coordinator',
  );
  assert.equal(selectSlackExecutionAuthority({
    ...base,
    assignment: {
      ...assignment(),
      agent: {
        ...assignment().agent,
        mcpServers: [{
          id: 'linear', displayName: 'Linear', url: 'https://mcp.linear.app/mcp',
          transport: 'streamable-http', authMode: 'oauth', headerNames: [], enabled: true,
          lifecycleStatus: 'ready', statusText: 'Connected', discoveredTools: [],
          allowedTools: ['create_issue'],
        }],
      },
    },
  }).authority, 'legacy');
});

test('selector rollback changes only future admission decisions', () => {
  const input = { workspaceId: 'T_acme', channelId: 'C_canary', assignment: assignment() };
  const enabled = selectSlackExecutionAuthority({
    ...input,
    env: { [LEDGER_CANARY_CHANNELS_KEY]: 'T_acme/C_canary' },
  });
  const rolledBack = selectSlackExecutionAuthority(input);
  assert.equal(enabled.authority, 'ledger');
  assert.equal(rolledBack.authority, 'legacy');
  assert.equal(enabled.authorityEpoch, rolledBack.authorityEpoch);
});

function assignment(): ResolvedAssignment {
  return {
    workspaceId: 'T_acme', channelId: 'C_canary', agentId: 'agent_default',
    model: 'local-stub/canary',
    agent: {
      id: 'agent_default', name: 'Default', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
}
