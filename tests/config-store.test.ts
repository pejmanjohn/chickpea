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
import { AgentSlackIdentityConflictError } from '../src/config/errors.ts';
import {
  WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  type ChannelAssignment,
  type CustomAgentConfig,
  type SlackIdentity,
} from '../src/config/types.ts';
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
    apiConnections: [],
    repositories: [],
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

function slackIdentity(overrides: Partial<SlackIdentity> = {}): SlackIdentity {
  return {
    id: 'slack_identity_finance',
    ingressKey: 'ingress_finance_0123456789abcdef',
    kind: 'dedicated',
    lifecycle: 'connected',
    teamId: 'T_TEST',
    appId: 'A_FINANCE',
    botUserId: 'U_FINANCE_BOT',
    dmState: 'off',
    credentialProvenance: 'stored',
    connectionRevision: 1,
    health: 'healthy',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
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

test('fresh stores backfill one workspace-default Slack identity and preserve profile inheritance', async () => {
  const store = new SqliteConfigStore(':memory:');

  const identities = await store.listSlackIdentities();
  assert.equal(identities.length, 1);
  assert.deepEqual(
    {
      id: identities[0]?.id,
      kind: identities[0]?.kind,
      lifecycle: identities[0]?.lifecycle,
      dmState: identities[0]?.dmState,
      dmAgentId: identities[0]?.dmAgentId,
      credentialProvenance: identities[0]?.credentialProvenance,
    },
    {
      id: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      kind: 'workspace_default',
      lifecycle: 'setup_incomplete',
      dmState: 'on',
      dmAgentId: 'agent_default',
      credentialProvenance: 'workspace_default',
    },
  );
  assert.match(identities[0]?.ingressKey ?? '', /^[A-Za-z0-9_-]{22,}$/);
  assert.equal(
    (await store.resolveSlackIdentityForAgent('agent_default')).id,
    WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  );
  assert.deepEqual(
    (await store.listAgentsForSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID)).map(
      ({ id }) => id,
    ),
    ['agent_default'],
  );
  assert.equal((await store.getAgent('agent_default')).slackIdentityId, undefined);

  store.close();
});

test('legacy direct-message assignment writes stay synchronized with the default identity', async () => {
  const store = new SqliteConfigStore(':memory:');
  await store.createAgent(agent({ id: 'agent_dm', name: 'DM Profile' }));

  await store.putAssignment(assignment({
    workspaceId: '*',
    channelId: '*',
    agentId: 'agent_dm',
  }));
  let identity = await store.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
  assert.equal(identity.dmState, 'on');
  assert.equal(identity.dmAgentId, 'agent_dm');

  await store.putAssignment(assignment({
    workspaceId: '*',
    channelId: '*',
    agentId: 'agent_dm',
    enabled: false,
  }));
  identity = await store.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
  assert.equal(identity.dmState, 'off');
  assert.equal(identity.dmAgentId, 'agent_dm');

  await store.deleteAssignment('*', '*');
  identity = await store.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
  assert.equal(identity.dmState, 'needs_setup');
  assert.equal(identity.dmAgentId, undefined);
  store.close();
});

test('default identity DM binding writes through to the legacy wildcard row', async () => {
  const store = new SqliteConfigStore(':memory:');
  await store.createAgent(agent({ id: 'agent_dm', name: 'DM Profile' }));
  let identity = await store.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);

  identity = await store.setSlackIdentityDmBinding(
    identity.id,
    identity.connectionRevision,
    'off',
    'agent_dm',
  );
  assert.deepEqual(await store.getAssignment('*', '*'), {
    workspaceId: '*',
    channelId: '*',
    agentId: 'agent_dm',
    enabled: false,
  });

  identity = await store.setSlackIdentityDmBinding(
    identity.id,
    identity.connectionRevision,
    'needs_setup',
  );
  assert.equal(await store.getAssignment('*', '*'), undefined);

  await store.setSlackIdentityDmBinding(
    identity.id,
    identity.connectionRevision,
    'on',
    'agent_dm',
  );
  assert.deepEqual(await store.getAssignment('*', '*'), {
    workspaceId: '*',
    channelId: '*',
    agentId: 'agent_dm',
    enabled: true,
  });
  store.close();
});

test('identity setup attaches a Profile in the same metadata transaction', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_finance', name: 'Finance' })],
    assignments: [],
  });
  try {
    const pending = await store.createSlackIdentity(slackIdentity({
      lifecycle: 'credentials_pending',
      dmState: 'on',
      dmAgentId: 'agent_finance',
    }));
    const connected = await store.completeSlackIdentitySetup(
      pending.id,
      pending.connectionRevision,
      'agent_finance',
      null,
    );
    assert.equal(connected.lifecycle, 'connected');
    assert.equal((await store.getAgent('agent_finance')).slackIdentityId, pending.id);
  } finally {
    store.close();
  }
});

test('identity attachment is stale-write fenced by the Profile current selection', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [agent({ id: 'agent_finance', name: 'Finance' })],
    assignments: [],
  });
  try {
    const finance = await store.createSlackIdentity(slackIdentity());
    const legal = await store.createSlackIdentity(slackIdentity({
      id: 'slack_identity_legal',
      ingressKey: 'ingress_legal_0123456789abcdef',
      appId: 'A_LEGAL',
      botUserId: 'U_LEGAL_BOT',
    }));
    await store.attachAgentToSlackIdentity(
      'agent_finance',
      finance.id,
      finance.connectionRevision,
      null,
    );

    await assert.rejects(
      () => store.attachAgentToSlackIdentity(
        'agent_finance',
        legal.id,
        legal.connectionRevision,
        null,
      ),
      (error: unknown) =>
        error instanceof AgentSlackIdentityConflictError &&
        error.actualIdentityId === finance.id,
    );
    assert.equal((await store.getAgent('agent_finance')).slackIdentityId, finance.id);
  } finally {
    store.close();
  }
});

test('several Profiles may share one connected Slack identity without changing its DM handler', async () => {
  const store = new SqliteConfigStore(':memory:');
  await store.createAgent(agent({ id: 'agent_finance', name: 'Finance' }));
  await store.createSlackIdentity(
    slackIdentity({ dmState: 'on', dmAgentId: 'agent_default' }),
  );

  await store.updateAgent('agent_default', { slackIdentityId: 'slack_identity_finance' });
  await store.updateAgent('agent_finance', { slackIdentityId: 'slack_identity_finance' });

  assert.deepEqual(
    (await store.listAgentsForSlackIdentity('slack_identity_finance')).map(({ id }) => id),
    ['agent_default', 'agent_finance'],
  );
  assert.equal(
    (await store.resolveSlackIdentityForAgent('agent_finance')).id,
    'slack_identity_finance',
  );
  assert.equal(
    (await store.getSlackIdentity('slack_identity_finance')).dmAgentId,
    'agent_default',
  );

  store.close();
});

test('Slack identity references protect DM Profiles and dedicated identity retirement', async () => {
  const store = new SqliteConfigStore(':memory:');
  await store.createAgent(agent({ id: 'agent_finance', name: 'Finance' }));
  await store.createSlackIdentity(
    slackIdentity({ dmState: 'on', dmAgentId: 'agent_finance' }),
  );
  await store.updateAgent('agent_default', { slackIdentityId: 'slack_identity_finance' });

  await assert.rejects(
    () => store.updateAgent('agent_finance', { enabled: false }),
    (error: unknown) =>
      error instanceof Error && error.name === 'AgentStillSlackDmHandlerError',
  );
  await assert.rejects(
    () => store.deleteAgent('agent_finance'),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'AgentStillSlackDmHandlerError' &&
      /slack_identity_finance/.test(error.message),
  );
  await assert.rejects(
    () => store.retireSlackIdentity('slack_identity_finance', 1),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'SlackIdentityStillReferencedError' &&
      /agent_default/.test(error.message),
  );

  store.close();
});

test('retiring an off identity clears its remembered DM Profile so the tombstone can purge', async () => {
  const store = new SqliteConfigStore(':memory:');
  const identity = await store.createSlackIdentity(
    slackIdentity({ dmState: 'off', dmAgentId: 'agent_default' }),
  );

  const retired = await store.retireSlackIdentity(
    identity.id,
    identity.connectionRevision,
  );
  assert.equal(retired.lifecycle, 'retired');
  assert.equal(retired.dmAgentId, undefined);
  assert.equal(
    await store.purgeRetiredSlackIdentity(
      retired.id,
      retired.connectionRevision,
      true,
    ),
    true,
  );

  store.close();
});

test('channel participation defaults to ambient and persists mention-only narrowing', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  await store.createAgent(agent());
  const ambient = await store.putAssignment(assignment());
  assert.equal(ambient.participationMode ?? 'ambient', 'ambient');
  const narrowed = await store.putAssignment(assignment({ participationMode: 'mention_only' }));
  assert.equal(narrowed.participationMode, 'mention_only');
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

test('SqliteConfigStore marks only the matching OAuth connection for reconnection', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const notion = {
    id: 'notion',
    displayName: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    transport: 'streamable-http' as const,
    authMode: 'oauth' as const,
    headerNames: [],
    enabled: true,
    lifecycleStatus: 'ready' as const,
    statusText: 'Connected · 20 tools',
    discoveredTools: [{ name: 'search' }],
    allowedTools: ['search'],
    identity: { workspaceName: 'Product' },
  };
  const linear = {
    ...notion,
    id: 'linear',
    displayName: 'Linear',
    url: 'https://mcp.linear.app/mcp',
  };
  const google = {
    id: 'google-workspace',
    displayName: 'Google Workspace',
    allowedHosts: ['gmail.googleapis.com'],
    pathPrefixes: ['/gmail/v1/'],
    headerName: 'Authorization',
    headerValuePrefix: 'Bearer ',
    allowedMethods: ['GET'],
    enabled: true,
    authMode: 'oauth' as const,
    oauthProvider: 'google' as const,
    oauthScopes: ['openid'],
    lifecycleStatus: 'ready' as const,
    statusText: 'Connected',
    identity: { accountName: 'operator@example.com' },
  };

  try {
    await store.createAgent(agent({ mcpServers: [notion, linear], apiConnections: [google] }));

    assert.equal(await store.markOAuthReauthorizationRequired({
      lane: 'mcp',
      agentId: 'agent_test',
      connectionId: 'notion',
      serverUrl: notion.url,
    }), true);
    assert.equal(await store.markOAuthReauthorizationRequired({
      lane: 'api',
      agentId: 'agent_test',
      connectionId: 'google-workspace',
      provider: 'google',
    }), true);

    const updated = await store.getAgent('agent_test');
    const { identity: _notionIdentity, ...notionWithoutIdentity } = notion;
    const { identity: _googleIdentity, ...googleWithoutIdentity } = google;
    assert.deepEqual(updated.mcpServers, [
      {
        ...notionWithoutIdentity,
        lifecycleStatus: 'pending',
        statusText: 'Reconnect required',
      },
      linear,
    ]);
    assert.deepEqual(updated.apiConnections, [{
      ...googleWithoutIdentity,
      lifecycleStatus: 'pending',
      statusText: 'Reconnect required',
    }]);

    assert.equal(await store.markOAuthReauthorizationRequired({
      lane: 'mcp',
      agentId: 'agent_test',
      connectionId: 'linear',
      serverUrl: 'https://stale.example.test/mcp',
    }), false);
    assert.deepEqual((await store.getAgent('agent_test')).mcpServers[1], linear);
  } finally {
    store.close();
  }
});

test('SqliteConfigStore round-trips repository grants through create and update', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const withRepositories = agent({
    repositories: [
      {
        id: 'repo-acme-main',
        installationId: 42,
        accountLogin: 'acme',
        fullName: 'acme/main-app',
        enabled: true,
      },
      {
        id: 'repo-personal-all',
        installationId: 84,
        accountLogin: 'pejman',
        fullName: '',
        allRepos: true,
        enabled: false,
      },
    ],
  });

  await store.createAgent(withRepositories);
  assert.deepEqual(
    (await store.getAgent(withRepositories.id)).repositories,
    withRepositories.repositories,
  );

  const nextRepositories = [
    {
      id: 'repo-acme-api',
      installationId: 42,
      accountLogin: 'acme',
      fullName: 'acme/api',
      enabled: true,
    },
  ];
  const updated = await store.updateAgent(withRepositories.id, {
    repositories: nextRepositories,
  });
  assert.deepEqual(updated.repositories, nextRepositories);
  assert.deepEqual((await store.getAgent(withRepositories.id)).repositories, nextRepositories);

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
    legacyDb
      .prepare(
        `INSERT INTO config_agents (
          id, name, instructions, enabled, model,
          default_models_json, skills_json, mcp_servers_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'agent_legacy_openai',
        'Legacy OpenAI',
        'Legacy OpenAI instructions.',
        1,
        'openai/gpt-4.1',
        '[]',
        '[]',
        '[]',
      );
    legacyDb.close();

    const store = new SqliteConfigStore(path, { agents: [], assignments: [] });
    assert.deepEqual(await store.getAgent(legacyAgent.id), legacyAgent);
    assert.equal((await store.getAgent('agent_legacy_openai')).model, 'openai/gpt-4.1');
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

    assert.equal(version.value, '7');
    assert.equal(
      agentColumns.some(({ name }) => name === 'default_models_json'),
      false,
    );
    assert.deepEqual(
      persistedAgentIds.map(({ id }) => id),
      ['agent_created_after_v2', 'agent_legacy', 'agent_legacy_openai'],
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
    const identityColumns = db
      .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
      .all('config_slack_identities') as Array<{ name: string }>;
    db.close();

    assert.equal(version.value, '7');
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
        'api_connections_json',
        'repositories_json',
        'slack_identity_id',
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
        'participation_mode',
      ],
    );
    assert.deepEqual(
      identityColumns.map(({ name }) => name),
      [
        'id',
        'ingress_key',
        'kind',
        'lifecycle',
        'team_id',
        'app_id',
        'bot_user_id',
        'dm_state',
        'dm_agent_id',
        'credential_provenance',
        'connection_revision',
        'observed_display_name',
        'observed_avatar_url',
        'observed_at',
        'health',
        'health_detail',
        'created_at',
        'updated_at',
        'retired_at',
        'setup_intent_json',
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v6 migration backfills a custom direct-message Profile exactly once', async () => {
  const { dir, path } = tempDbPath();
  try {
    createV6Fixture(path, {
      agents: [agent({ id: 'agent_custom', name: 'Custom DM Profile' })],
      directAgentId: 'agent_custom',
    });

    const first = new SqliteConfigStore(path, { agents: [], assignments: [] });
    const identity = await first.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
    assert.equal(identity.dmState, 'on');
    assert.equal(identity.dmAgentId, 'agent_custom');
    const ingressKey = identity.ingressKey;
    const updatedAt = identity.updatedAt;
    first.close();

    const second = new SqliteConfigStore(path, { agents: [], assignments: [] });
    assert.equal((await second.listSlackIdentities()).length, 1);
    assert.equal(
      (await second.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID)).ingressKey,
      ingressKey,
    );
    assert.equal(
      (await second.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID)).updatedAt,
      updatedAt,
    );
    assert.equal((await second.getAgent('agent_custom')).slackIdentityId, undefined);
    assert.deepEqual(await second.getAssignment('*', '*'), {
      workspaceId: '*',
      channelId: '*',
      agentId: 'agent_custom',
      enabled: true,
    });
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const fixture of [
  { name: 'missing wildcard', directAgentId: undefined },
  { name: 'disabled wildcard', directAgentId: 'agent_custom', directEnabled: false },
  { name: 'missing Profile', directAgentId: 'agent_missing' },
] as const) {
  test(`v6 migration opens with needs_setup for a ${fixture.name}`, async () => {
    const { dir, path } = tempDbPath();
    try {
      createV6Fixture(path, {
        agents: [agent({ id: 'agent_custom', name: 'Custom DM Profile' })],
        ...(fixture.directAgentId ? { directAgentId: fixture.directAgentId } : {}),
        ...(fixture.directEnabled === undefined
          ? {}
          : { directEnabled: fixture.directEnabled }),
      });
      const store = new SqliteConfigStore(path, { agents: [], assignments: [] });
      const identity = await store.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
      assert.equal(identity.dmState, 'needs_setup');
      assert.equal(identity.dmAgentId, undefined);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function createV6Fixture(
  path: string,
  options: {
    agents: CustomAgentConfig[];
    directAgentId?: string;
    directEnabled?: boolean;
  },
): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE config_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE config_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    model TEXT,
    skills_json TEXT NOT NULL DEFAULT '[]',
    mcp_servers_json TEXT NOT NULL DEFAULT '[]',
    api_connections_json TEXT NOT NULL DEFAULT '[]',
    repositories_json TEXT NOT NULL DEFAULT '[]'
  )`);
  db.exec(`CREATE TABLE config_assignments (
    workspace_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    channel_label TEXT,
    channel_prompt_addendum TEXT,
    participation_mode TEXT NOT NULL DEFAULT 'ambient',
    PRIMARY KEY (workspace_id, channel_id)
  )`);
  db.prepare('INSERT INTO config_meta (key, value) VALUES (?, ?)').run('schema_version', '6');
  db.prepare('INSERT INTO config_meta (key, value) VALUES (?, ?)').run(
    'config_seeded_v1',
    'legacy',
  );
  for (const item of options.agents) {
    db.prepare(
      `INSERT INTO config_agents (
        id, name, instructions, enabled, model, skills_json, mcp_servers_json,
        api_connections_json, repositories_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      item.id,
      item.name,
      item.instructions,
      item.enabled ? 1 : 0,
      item.model ?? null,
      JSON.stringify(item.skills),
      JSON.stringify(item.mcpServers),
      JSON.stringify(item.apiConnections),
      JSON.stringify(item.repositories),
    );
  }
  if (options.directAgentId) {
    db.prepare(
      `INSERT INTO config_assignments (
        workspace_id, channel_id, agent_id, enabled, channel_label,
        channel_prompt_addendum, participation_mode
      ) VALUES ('*', '*', ?, ?, NULL, NULL, 'ambient')`,
    ).run(options.directAgentId, options.directEnabled === false ? 0 : 1);
  }
  db.close();
}

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

    const { legacySlackThreadAgent: slackThreadAgent } = await import('../src/agents/slack-thread.ts');
    const config = await slackThreadAgent.initialize({
      id: 'T_CACHE:C_CACHE:1782770400.000100',
      env: {},
    });

    assert.match(String(config.instructions), /Cached store instructions\./);
  });

  rmSync(dir, { recursive: true, force: true });
});

test('surfaceForChannelId classifies DM and the wildcard key as direct, channels as fail-closed', () => {
  // 1:1 DM ids ('D…') and the '*' wildcard key are direct.
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
        apiConnections: [],
        repositories: [],
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
