import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { resolveAssignment } from '../src/config/resolver.ts';
import { getConfigStore, SqliteConfigStore } from '../src/config/store.ts';
import type { ChannelAssignment, CustomAgentConfig } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'slack-flue-config-store-'));
  return { dir, path: join(dir, 'state.db') };
}

function agent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: 'agent_test',
    name: 'Test Agent',
    description: 'A test agent',
    instructions: 'Answer from the test fixture.',
    enabled: true,
    defaultModels: {
      claude: 'anthropic/test-claude',
      'workers-ai': '@cf/test/model',
    },
    allowedTools: ['lookup_channel_brief'],
    ...overrides,
  };
}

function assignment(overrides: Partial<ChannelAssignment> = {}): ChannelAssignment {
  return {
    workspaceId: 'T_TEST',
    channelId: 'C_TEST',
    agentId: 'agent_test',
    enabled: true,
    ...overrides,
  };
}

test('SqliteConfigStore round-trips agent and assignment CRUD', () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const created = agent({ model: 'local-stub/agent-created' });

  store.createAgent(created);
  assert.deepEqual(store.getAgent(created.id), created);

  const updated = store.updateAgent(created.id, {
    instructions: 'Use the updated runtime instructions.',
    model: 'local-stub/agent-updated',
  });
  assert.equal(updated.instructions, 'Use the updated runtime instructions.');
  assert.equal(updated.model, 'local-stub/agent-updated');

  const createdAssignment = assignment({
    channelPromptAddendum: 'Prefer channel-local launch context.',
  });
  store.putAssignment(createdAssignment);
  assert.deepEqual(store.find('T_TEST', 'C_TEST'), createdAssignment);

  assert.equal(store.deleteAssignment('T_TEST', 'C_TEST'), true);
  assert.equal(store.find('T_TEST', 'C_TEST'), undefined);
  assert.equal(store.deleteAgent(created.id), true);
  assert.throws(() => store.getAgent(created.id), /Unknown agent agent_test/);

  store.close();
});

test('SqliteConfigStore blocks deleting agents that still have assignments', () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  store.createAgent(agent());
  store.putAssignment(assignment());

  assert.throws(() => store.deleteAgent('agent_test'), /still assigned/);
  assert.deepEqual(store.getAgent('agent_test'), agent());

  store.close();
});

test('SqliteConfigStore seeds an empty file database exactly once', () => {
  const { dir, path } = tempDbPath();
  const seedAgent = agent({ id: 'agent_seed' });
  const seedAssignment = assignment({ agentId: 'agent_seed' });

  try {
    const first = new SqliteConfigStore(path, {
      agents: [seedAgent],
      assignments: [seedAssignment],
    });
    assert.deepEqual(first.getAgent('agent_seed'), seedAgent);
    assert.deepEqual(first.find('T_TEST', 'C_TEST'), seedAssignment);
    assert.equal(first.deleteAssignment('T_TEST', 'C_TEST'), true);
    assert.equal(first.deleteAgent('agent_seed'), true);
    first.close();

    const second = new SqliteConfigStore(path, {
      agents: [seedAgent],
      assignments: [seedAssignment],
    });
    assert.deepEqual(second.listAgents(), []);
    assert.deepEqual(second.listAssignments(), []);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteConfigStore survives restart on a file database', () => {
  const { dir, path } = tempDbPath();
  const created = agent({ id: 'agent_persisted', model: 'local-stub/persisted' });

  try {
    const first = new SqliteConfigStore(path, { agents: [], assignments: [] });
    first.createAgent(created);
    first.putAssignment(
      assignment({
        workspaceId: 'T_FILE',
        channelId: 'C_FILE',
        agentId: created.id,
        channelPromptAddendum: 'Persist this channel rule.',
      }),
    );
    first.close();

    const second = new SqliteConfigStore(path, { agents: [], assignments: [] });
    assert.deepEqual(second.getAgent(created.id), created);
    assert.deepEqual(second.find('T_FILE', 'C_FILE'), {
      workspaceId: 'T_FILE',
      channelId: 'C_FILE',
      agentId: created.id,
      enabled: true,
      channelPromptAddendum: 'Persist this channel rule.',
    });
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(':memory: config stores are isolated by connection', () => {
  const first = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const second = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });

  first.createAgent(agent({ id: 'agent_memory_only' }));

  assert.equal(first.listAgents().some((item) => item.id === 'agent_memory_only'), true);
  assert.equal(second.listAgents().some((item) => item.id === 'agent_memory_only'), false);

  first.close();
  second.close();
});

test('resolveAssignment accepts SqliteConfigStore and preserves channel addendum', () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  store.createAgent(agent());
  store.putAssignment(assignment({ channelPromptAddendum: 'Use the runtime channel rule.' }));

  const resolved = resolveAssignment('T_TEST', 'C_TEST', {
    agents: store,
    assignments: store,
  });

  assert.equal(resolved.agent.id, 'agent_test');
  assert.equal(resolved.channelPromptAddendum, 'Use the runtime channel rule.');

  store.close();
});

test('assignment lookup precedence is exact, workspace wildcard, channel wildcard, then global', () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  for (const id of ['agent_exact', 'agent_workspace', 'agent_channel', 'agent_global']) {
    store.createAgent(agent({ id }));
  }

  store.putAssignment(assignment({ workspaceId: '*', channelId: '*', agentId: 'agent_global' }));
  store.putAssignment(
    assignment({ workspaceId: 'T_TEST', channelId: '*', agentId: 'agent_workspace' }),
  );
  store.putAssignment(
    assignment({ workspaceId: '*', channelId: 'C_MATCH', agentId: 'agent_channel' }),
  );
  store.putAssignment(
    assignment({ workspaceId: 'T_TEST', channelId: 'C_MATCH', agentId: 'agent_exact' }),
  );

  assert.equal(store.find('T_TEST', 'C_MATCH')?.agentId, 'agent_exact');
  assert.equal(store.find('T_TEST', 'C_OTHER')?.agentId, 'agent_workspace');
  assert.equal(store.find('T_OTHER', 'C_MATCH')?.agentId, 'agent_channel');
  assert.equal(store.find('T_OTHER', 'C_OTHER')?.agentId, 'agent_global');

  store.close();
});

test('getConfigStore writes are visible to later slack-thread initializations in the same process', async () => {
  const { dir, path } = tempDbPath();

  await withEnv({ SLACK_STATE_DB_PATH: path, SLACK_FLUE_MODEL: 'local-stub/cache-test' }, async () => {
    const store = getConfigStore();
    store.createAgent(agent({ id: 'agent_cached', instructions: 'Cached store instructions.' }));
    store.putAssignment(
      assignment({ workspaceId: 'T_CACHE', channelId: 'C_CACHE', agentId: 'agent_cached' }),
    );

    const { default: slackThreadAgent } = await import('../src/agents/slack-thread.ts');
    const config = await slackThreadAgent.initialize({
      id: 'T_CACHE:C_CACHE:1782770400.000100',
      env: {},
    });

    assert.match(String(config.instructions), /Cached store instructions\./);
  });

  rmSync(dir, { recursive: true, force: true });
});
