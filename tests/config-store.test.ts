import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { resolveEffectiveSlackConfig } from '../src/config/effective-config.ts';
import { resolveAssignment, surfaceForChannelId } from '../src/config/resolver.ts';
import {
  SEED_CLOUDFLARE_MODEL_PIN,
  createSeededAgents,
  seededAgents,
  seededAssignments,
} from '../src/config/seed.ts';
import { getConfigStore } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ChannelAssignment, CustomAgentConfig } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-config-store-'));
  return { dir, path: join(dir, 'state.db') };
}

function agent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: 'agent_test',
    name: 'Test Agent',
    instructions: 'Answer from the test fixture.',
    enabled: true,
    skills: [],
    mcpServers: [],
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

test('SqliteConfigStore round-trips agent and assignment CRUD', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const created = agent({ model: 'local-stub/agent-created' });

  await store.createAgent(created);
  assert.deepEqual(await store.getAgent(created.id), created);

  const updated = await store.updateAgent(created.id, {
    instructions: 'Use the updated runtime instructions.',
    model: 'local-stub/agent-updated',
  });
  assert.equal(updated.instructions, 'Use the updated runtime instructions.');
  assert.equal(updated.model, 'local-stub/agent-updated');

  const createdAssignment = assignment({
    channelLabel: 'eng-releases',
    channelPromptAddendum: 'Prefer channel-local launch context.',
  });
  await store.putAssignment(createdAssignment);
  assert.deepEqual(await store.find('T_TEST', 'C_TEST'), createdAssignment);

  assert.equal(await store.deleteAssignment('T_TEST', 'C_TEST'), true);
  assert.equal(await store.find('T_TEST', 'C_TEST'), undefined);
  assert.equal(await store.deleteAgent(created.id), true);
  await assert.rejects(() => store.getAgent(created.id), /Unknown agent agent_test/);

  store.close();
});

test('SqliteConfigStore round-trips non-empty skills through create and update', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const withSkills = agent({
    skills: [
      {
        name: 'incident-scribe',
        description: 'Build a structured incident timeline.',
        instructions: '# Incident Scribe\n\nDo the thing.',
        enabled: true,
      },
      {
        name: 'pr-explainer',
        description: 'Explain a PR in plain language.',
        instructions: '# PR Explainer',
        enabled: false,
      },
    ],
  });

  await store.createAgent(withSkills);
  assert.deepEqual((await store.getAgent(withSkills.id)).skills, withSkills.skills);

  const nextSkills = [
    { name: 'triage', description: 'Triage issues.', instructions: '# Triage', enabled: true },
  ];
  const updated = await store.updateAgent(withSkills.id, { skills: nextSkills });
  assert.deepEqual(updated.skills, nextSkills);
  assert.deepEqual((await store.getAgent(withSkills.id)).skills, nextSkills);

  store.close();
});

test('SqliteConfigStore round-trips non-empty mcpServers through create and update', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const withServers = agent({
    mcpServers: [
      {
        id: 'linear-mcp',
        displayName: 'Linear',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'bearer',
        headerNames: ['X-Api-Key'],
        enabled: true,
        lifecycleStatus: 'ready',
        statusText: 'Connected · 3 tools',
        discoveredTools: [
          { name: 'create_issue', title: 'Create Issue', description: 'Open a new issue.' },
          { name: 'search_issues' },
        ],
        allowedTools: ['create_issue'],
        lastCheckedAt: 1_700_000_000_000,
      },
    ],
  });

  await store.createAgent(withServers);
  assert.deepEqual((await store.getAgent(withServers.id)).mcpServers, withServers.mcpServers);

  const nextServers = [
    {
      id: 'deepwiki',
      displayName: 'DeepWiki',
      url: 'https://mcp.deepwiki.com/mcp',
      transport: 'sse' as const,
      authMode: 'none' as const,
      headerNames: [],
      enabled: false,
      lifecycleStatus: 'pending' as const,
      statusText: '',
      discoveredTools: [],
      allowedTools: [],
    },
  ];
  const updated = await store.updateAgent(withServers.id, { mcpServers: nextServers });
  assert.deepEqual(updated.mcpServers, nextServers);
  assert.deepEqual((await store.getAgent(withServers.id)).mcpServers, nextServers);

  store.close();
});

test('SqliteConfigStore blocks deleting agents that still have assignments', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  await store.createAgent(agent());
  await store.putAssignment(assignment());

  await assert.rejects(() => store.deleteAgent('agent_test'), /still assigned/);
  assert.deepEqual(await store.getAgent('agent_test'), agent());

  store.close();
});

test('SqliteConfigStore seeds an empty file database exactly once', async () => {
  const { dir, path } = tempDbPath();
  const seedAgent = agent({ id: 'agent_seed' });
  const seedAssignment = assignment({ agentId: 'agent_seed' });

  try {
    const first = new SqliteConfigStore(path, {
      agents: [seedAgent],
      assignments: [seedAssignment],
    });
    assert.deepEqual(await first.getAgent('agent_seed'), seedAgent);
    assert.deepEqual(await first.find('T_TEST', 'C_TEST'), seedAssignment);
    assert.equal(await first.deleteAssignment('T_TEST', 'C_TEST'), true);
    assert.equal(await first.deleteAgent('agent_seed'), true);
    first.close();

    const second = new SqliteConfigStore(path, {
      agents: [seedAgent],
      assignments: [seedAssignment],
    });
    assert.deepEqual(await second.listAgents(), []);
    assert.deepEqual(await second.listAssignments(), []);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default seed ships a single Default profile plus the direct-message wildcard only', async () => {
  const store = new SqliteConfigStore(':memory:');

  const agents = await store.listAgents();
  assert.equal(agents.length, 1);
  assert.deepEqual(
    agents.map((item) => item.name),
    ['Default'],
  );

  const [defaultProfile] = agents;
  assert.ok(defaultProfile);
  assert.equal(defaultProfile.id, 'agent_default');
  assert.equal(defaultProfile.model, undefined);
  assert.match(defaultProfile.instructions, /general-purpose Slack assistant/i);
  assert.match(defaultProfile.instructions, /never invent facts/i);

  assert.equal(await store.getAssignment('T_DEMO', 'C_ENG'), undefined);
  assert.equal(await store.getAssignment('T_DEMO', 'C_EXEC'), undefined);
  assert.deepEqual(await store.listAssignments(), [
    {
      workspaceId: '*',
      channelId: '*',
      agentId: defaultProfile.id,
      enabled: true,
    },
  ]);
  assert.equal((await store.find('T_OTHER', 'D_DM'))?.agentId, defaultProfile.id);
  assert.equal(await store.find('T_OTHER', 'C_OTHER', { surface: 'channel' }), undefined);

  assert.equal(seededAgents.length, 1);
  assert.equal(seededAssignments.length, 1);
  store.close();
});

test('Cloudflare first-boot seed pins Default to the keyless Workers AI binding model', () => {
  const [defaultProfile] = createSeededAgents({ target: 'cloudflare' });

  assert.ok(defaultProfile);
  assert.equal(defaultProfile.id, 'agent_default');
  assert.equal(defaultProfile.model, SEED_CLOUDFLARE_MODEL_PIN);
});

test('SqliteConfigStore survives restart on a file database', async () => {
  const { dir, path } = tempDbPath();
  const created = agent({ id: 'agent_persisted', model: 'local-stub/persisted' });

  try {
    const first = new SqliteConfigStore(path, { agents: [], assignments: [] });
    await first.createAgent(created);
    await first.putAssignment(
      assignment({
        workspaceId: 'T_FILE',
        channelId: 'C_FILE',
        agentId: created.id,
        channelPromptAddendum: 'Persist this channel rule.',
      }),
    );
    first.close();

    const second = new SqliteConfigStore(path, { agents: [], assignments: [] });
    assert.deepEqual(await second.getAgent(created.id), created);
    assert.deepEqual(await second.find('T_FILE', 'C_FILE'), {
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

test('SqliteConfigStore migrates the legacy v1 default-models column without losing agents', async () => {
  const { dir, path } = tempDbPath();
  const legacyAgent = agent({ id: 'agent_legacy', name: 'Legacy Agent' });
  const createdAgent = agent({ id: 'agent_created_after_v2' });

  try {
    const legacyDb = new DatabaseSync(path);
    legacyDb.exec(`CREATE TABLE config_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    legacyDb.exec(`CREATE TABLE config_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      instructions TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      model TEXT,
      default_models_json TEXT NOT NULL,
      skills_json TEXT NOT NULL DEFAULT '[]',
      mcp_servers_json TEXT NOT NULL DEFAULT '[]'
    )`);
    legacyDb.exec(`CREATE TABLE config_assignments (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      channel_label TEXT,
      channel_prompt_addendum TEXT,
      PRIMARY KEY (workspace_id, channel_id)
    )`);
    legacyDb
      .prepare('INSERT INTO config_meta (key, value) VALUES (?, ?)')
      .run('schema_version', '1');
    legacyDb
      .prepare(
        `INSERT INTO config_agents (
          id, name, instructions, enabled, model,
          default_models_json, skills_json, mcp_servers_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacyAgent.id,
        legacyAgent.name,
        legacyAgent.instructions,
        1,
        null,
        '["anthropic/legacy-fallback"]',
        '[]',
        '[]',
      );
    legacyDb.close();

    const store = new SqliteConfigStore(path, { agents: [], assignments: [] });
    assert.deepEqual(await store.getAgent(legacyAgent.id), legacyAgent);
    assert.deepEqual(await store.createAgent(createdAgent), createdAgent);
    store.close();

    const migratedDb = new DatabaseSync(path);
    const version = migratedDb
      .prepare('SELECT value FROM config_meta WHERE key = ?')
      .get('schema_version') as { value: string };
    const agentColumns = migratedDb
      .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
      .all('config_agents') as Array<{ name: string }>;
    const persistedAgentIds = migratedDb
      .prepare('SELECT id FROM config_agents ORDER BY id')
      .all() as Array<{ id: string }>;
    migratedDb.close();

    assert.equal(version.value, '2');
    assert.equal(
      agentColumns.some(({ name }) => name === 'default_models_json'),
      false,
    );
    assert.deepEqual(
      persistedAgentIds.map(({ id }) => id),
      ['agent_created_after_v2', 'agent_legacy'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh databases start at the clean current config schema', () => {
  const { dir, path } = tempDbPath();

  try {
    const store = new SqliteConfigStore(path, { agents: [], assignments: [] });
    store.close();

    const db = new DatabaseSync(path);
    const version = db
      .prepare('SELECT value FROM config_meta WHERE key = ?')
      .get('schema_version') as { value: string };
    const agentColumns = db
      .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
      .all('config_agents') as Array<{ name: string }>;
    const assignmentColumns = db
      .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
      .all('config_assignments') as Array<{ name: string }>;
    db.close();

    assert.equal(version.value, '2');
    assert.deepEqual(
      agentColumns.map(({ name }) => name),
      [
        'id',
        'name',
        'instructions',
        'enabled',
        'model',
        'skills_json',
        'mcp_servers_json',
      ],
    );
    assert.deepEqual(
      assignmentColumns.map(({ name }) => name),
      [
        'workspace_id',
        'channel_id',
        'agent_id',
        'enabled',
        'channel_label',
        'channel_prompt_addendum',
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(':memory: config stores are isolated by connection', async () => {
  const first = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const second = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });

  await first.createAgent(agent({ id: 'agent_memory_only' }));

  assert.equal((await first.listAgents()).some((item) => item.id === 'agent_memory_only'), true);
  assert.equal((await second.listAgents()).some((item) => item.id === 'agent_memory_only'), false);

  first.close();
  second.close();
});

test('resolveAssignment accepts SqliteConfigStore and preserves channel addendum', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  await store.createAgent(agent());
  await store.putAssignment(assignment({ channelPromptAddendum: 'Use the runtime channel rule.' }));

  const resolved = await resolveAssignment('T_TEST', 'C_TEST', {
    agents: store,
    assignments: store,
  });

  assert.equal(resolved.agent.id, 'agent_test');
  assert.equal(resolved.channelPromptAddendum, 'Use the runtime channel rule.');

  store.close();
});

test('assignment lookup precedence is exact, workspace wildcard, channel wildcard, then global', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  for (const id of ['agent_exact', 'agent_workspace', 'agent_channel', 'agent_global']) {
    await store.createAgent(agent({ id }));
  }

  await store.putAssignment(
    assignment({ workspaceId: '*', channelId: '*', agentId: 'agent_global' }),
  );
  await store.putAssignment(
    assignment({ workspaceId: 'T_TEST', channelId: '*', agentId: 'agent_workspace' }),
  );
  await store.putAssignment(
    assignment({ workspaceId: '*', channelId: 'C_MATCH', agentId: 'agent_channel' }),
  );
  await store.putAssignment(
    assignment({ workspaceId: 'T_TEST', channelId: 'C_MATCH', agentId: 'agent_exact' }),
  );

  assert.equal((await store.find('T_TEST', 'C_MATCH'))?.agentId, 'agent_exact');
  assert.equal((await store.find('T_TEST', 'C_OTHER'))?.agentId, 'agent_workspace');
  assert.equal((await store.find('T_OTHER', 'C_MATCH'))?.agentId, 'agent_channel');
  assert.equal((await store.find('T_OTHER', 'C_OTHER'))?.agentId, 'agent_global');

  // Channel surface (fail-closed): the global '*,*' wildcard does NOT apply, but
  // workspace- and channel-scoped assignments still do. Direct surface keeps the
  // global wildcard as the default.
  assert.equal(await store.find('T_OTHER', 'C_OTHER', { surface: 'channel' }), undefined);
  assert.equal(
    (await store.find('T_OTHER', 'C_OTHER', { surface: 'direct' }))?.agentId,
    'agent_global',
  );
  assert.equal(
    (await store.find('T_TEST', 'C_OTHER', { surface: 'channel' }))?.agentId,
    'agent_workspace',
  );
  assert.equal(
    (await store.find('T_OTHER', 'C_MATCH', { surface: 'channel' }))?.agentId,
    'agent_channel',
  );
  assert.equal(
    (await store.find('T_TEST', 'C_MATCH', { surface: 'channel' }))?.agentId,
    'agent_exact',
  );

  store.close();
});

test('getConfigStore writes are visible to later slack-thread initializations in the same process', async () => {
  const { dir, path } = tempDbPath();

  await withEnv({ SLACK_STATE_DB_PATH: path, SLACK_TAG_MODEL: undefined }, async () => {
    const store = getConfigStore();
    await store.createAgent(
      agent({
        id: 'agent_cached',
        instructions: 'Cached store instructions.',
        model: 'local-stub/cache-test',
      }),
    );
    await store.putAssignment(
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

test('the direct-message default (the seeded "*,*" row) is resolvable — admin can preview it', async () => {
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
    const effective = await resolveEffectiveSlackConfig(
      '*',
      '*',
      { agents: store, assignments: store },
      { SLACK_TAG_MODEL: 'local-stub/parity-stub-1' } as NodeJS.ProcessEnv,
    );
    assert.equal(effective.agentId, 'agent_default');
  } finally {
    store.close();
  }
});

test('a disabled assignment at the winning specificity turns the channel off instead of falling back to the wildcard', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [
      {
        id: 'agent_default',
        name: 'Default',
        instructions: 'Default instructions.',
        enabled: true,
        skills: [],
        mcpServers: [],
      },
    ],
    assignments: [
      { workspaceId: '*', channelId: '*', agentId: 'agent_default', enabled: true },
      { workspaceId: 'T_OFF', channelId: 'C_OFF', agentId: 'agent_default', enabled: false },
    ],
  });
  try {
    // Explicitly disabled exact row: no fall-through to the enabled catch-all.
    assert.equal(await store.find('T_OFF', 'C_OFF'), undefined);
    // Other channels still resolve through the wildcard.
    assert.equal((await store.find('T_OFF', 'C_ELSEWHERE'))?.agentId, 'agent_default');
  } finally {
    store.close();
  }
});
