import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { resolveEffectiveSlackConfig } from '../src/config/effective-config.ts';
import { resolveAssignment, surfaceForChannelId } from '../src/config/resolver.ts';
import { seededAgents, seededAssignments } from '../src/config/seed.ts';
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
    channelLabel: 'eng-releases',
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

test('default seed ships starter profiles plus the direct-message wildcard only', () => {
  const store = new SqliteConfigStore(':memory:');

  const agents = store.listAgents();
  assert.equal(agents.length, 2);
  assert.deepEqual(
    agents.map((item) => item.name).sort(),
    ['Exec Brief', 'Release Scribe'],
  );

  const releaseScribe = agents.find((item) => item.name === 'Release Scribe');
  assert.ok(releaseScribe);
  assert.match(releaseScribe.instructions, /summary table/i);
  assert.match(releaseScribe.instructions, /fenced code/i);

  const execBrief = agents.find((item) => item.name === 'Exec Brief');
  assert.ok(execBrief);
  assert.match(execBrief.instructions, /bold-led bullets/i);
  assert.match(execBrief.instructions, /no code/i);

  assert.equal(store.getAssignment('T_DEMO', 'C_ENG'), undefined);
  assert.equal(store.getAssignment('T_DEMO', 'C_EXEC'), undefined);
  assert.deepEqual(store.listAssignments(), [
    {
      workspaceId: '*',
      channelId: '*',
      agentId: execBrief.id,
      enabled: true,
    },
  ]);
  assert.equal(store.find('T_OTHER', 'D_DM')?.agentId, execBrief.id);
  assert.equal(store.find('T_OTHER', 'C_OTHER', { surface: 'channel' }), undefined);

  assert.equal(seededAgents.length, 2);
  assert.equal(seededAssignments.length, 1);
  store.close();
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

test('SqliteConfigStore migrates pre-existing assignment tables to support channel labels', () => {
  const { dir, path } = tempDbPath();
  const createdAgent = agent({ id: 'agent_legacy' });

  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE config_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE config_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        model TEXT,
        default_models_json TEXT NOT NULL,
        allowed_tools_json TEXT NOT NULL
      );
      CREATE TABLE config_assignments (
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        channel_prompt_addendum TEXT,
        PRIMARY KEY (workspace_id, channel_id)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO config_agents (
          id, name, description, instructions, enabled, model,
          default_models_json, allowed_tools_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createdAgent.id,
        createdAgent.name,
        createdAgent.description,
        createdAgent.instructions,
        1,
        null,
        JSON.stringify(createdAgent.defaultModels),
        JSON.stringify(createdAgent.allowedTools),
      );
    legacy
      .prepare(
        `INSERT INTO config_assignments (
          workspace_id, channel_id, agent_id, enabled, channel_prompt_addendum
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run('T_LEGACY', 'C_LEGACY', createdAgent.id, 1, 'Legacy channel addendum.');
    legacy.close();

    const store = new SqliteConfigStore(path, { agents: [], assignments: [] });
    assert.deepEqual(store.getAssignment('T_LEGACY', 'C_LEGACY'), {
      workspaceId: 'T_LEGACY',
      channelId: 'C_LEGACY',
      agentId: createdAgent.id,
      enabled: true,
      channelPromptAddendum: 'Legacy channel addendum.',
    });

    const labeled = store.putAssignment({
      workspaceId: 'T_LEGACY',
      channelId: 'C_LEGACY',
      agentId: createdAgent.id,
      enabled: true,
      channelLabel: 'eng-releases',
      channelPromptAddendum: 'Legacy channel addendum.',
    });
    assert.equal(labeled.channelLabel, 'eng-releases');
    assert.equal(store.getAssignment('T_LEGACY', 'C_LEGACY')?.channelLabel, 'eng-releases');
    store.close();
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

  // Channel surface (fail-closed): the global '*,*' wildcard does NOT apply, but
  // workspace- and channel-scoped assignments still do. Direct surface keeps the
  // global wildcard as the default.
  assert.equal(store.find('T_OTHER', 'C_OTHER', { surface: 'channel' }), undefined);
  assert.equal(store.find('T_OTHER', 'C_OTHER', { surface: 'direct' })?.agentId, 'agent_global');
  assert.equal(store.find('T_TEST', 'C_OTHER', { surface: 'channel' })?.agentId, 'agent_workspace');
  assert.equal(store.find('T_OTHER', 'C_MATCH', { surface: 'channel' })?.agentId, 'agent_channel');
  assert.equal(store.find('T_TEST', 'C_MATCH', { surface: 'channel' })?.agentId, 'agent_exact');

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

test('surfaceForChannelId classifies DM/App Home and the wildcard key as direct, channels as fail-closed', () => {
  // 1:1 DM and App Home ids ('D…') and the '*' wildcard key are direct.
  assert.equal(surfaceForChannelId('D_DEMO_DM'), 'direct');
  assert.equal(surfaceForChannelId('D_DEMO_APP_HOME'), 'direct');
  assert.equal(surfaceForChannelId('*'), 'direct');
  // Public ('C…') and ambiguous group/private ('G…') ids are treated as
  // channels (fail-closed) — a 'G…' id could be a legacy private channel.
  assert.equal(surfaceForChannelId('C_PUBLIC'), 'channel');
  assert.equal(surfaceForChannelId('G_PRIVATE_OR_MPIM'), 'channel');
});

test('the direct-message default (the seeded "*,*" row) is resolvable — admin can preview it', () => {
  // Regression: surfaceForChannelId('*') must be 'direct' so resolving the
  // effective config of the '*/*' DM-default key does not 404 (it is the profile
  // that answers DMs, so the admin must be able to preview/configure it). Uses
  // the SQLite store — the one the admin actually queries, whose channel-surface
  // WHERE clause excludes the '*,*' row (the in-memory store's exact-match branch
  // would mask this).
  const store = new SqliteConfigStore(':memory:', {
    agents: seededAgents,
    assignments: seededAssignments,
  });
  try {
    const effective = resolveEffectiveSlackConfig(
      '*',
      '*',
      { agents: store, assignments: store },
      { SLACK_FLUE_MODEL: 'local-stub/parity-stub-1' } as NodeJS.ProcessEnv,
    );
    assert.equal(effective.agentId, 'agent_exec_brief');
  } finally {
    store.close();
  }
});

test('a disabled assignment at the winning specificity turns the channel off instead of falling back to the wildcard', () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [
      {
        id: 'agent_default',
        name: 'Default',
        description: '',
        instructions: 'Default instructions.',
        enabled: true,
        defaultModels: { claude: 'anthropic/x', 'workers-ai': '@cf/x' },
        allowedTools: [],
      },
    ],
    assignments: [
      { workspaceId: '*', channelId: '*', agentId: 'agent_default', enabled: true },
      { workspaceId: 'T_OFF', channelId: 'C_OFF', agentId: 'agent_default', enabled: false },
    ],
  });
  try {
    // Explicitly disabled exact row: no fall-through to the enabled catch-all.
    assert.equal(store.find('T_OFF', 'C_OFF'), undefined);
    // Other channels still resolve through the wildcard.
    assert.equal(store.find('T_OFF', 'C_ELSEWHERE')?.agentId, 'agent_default');
  } finally {
    store.close();
  }
});
