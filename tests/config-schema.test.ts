import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONFIG_CHICKPEA_CUTOVER_MIGRATION,
  CONFIG_CHICKPEA_EXTENSION_MIGRATION,
  CONFIG_CHICKPEA_ROUTING_MIGRATION,
  CONFIG_SCHEMA_MARKER,
  CONFIG_SCHEMA_VERSION,
  ConfigStoreLogic,
} from '../src/config/store.ts';
import { WorkspaceModelDefaultRevisionConflictError } from '../src/config/errors.ts';
import { createDemoStarterAgent, createSeededAgents, seededWorkspaceModelDefault } from '../src/config/seed.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { StateDb } from '../src/state/state-db.ts';

function installSchema12Fixture(db: StateDb): void {
  db.exec(`
    CREATE TABLE config_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE config_agents (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      instructions TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      lifecycle TEXT NOT NULL,
      creator_membership_id TEXT,
      edit_policy TEXT NOT NULL,
      configuration_generation INTEGER NOT NULL,
      slack_presence_json TEXT NOT NULL,
      archived_at INTEGER,
      model TEXT,
      skills_json TEXT NOT NULL,
      mcp_servers_json TEXT NOT NULL,
      api_connections_json TEXT NOT NULL,
      repositories_json TEXT NOT NULL
    );
    CREATE TABLE config_workspace_installations (
      workspace_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      transport_mode TEXT NOT NULL,
      default_agent_id TEXT NOT NULL,
      team_id TEXT,
      app_id TEXT,
      bot_user_id TEXT,
      gateway_binding_id TEXT,
      health TEXT NOT NULL,
      health_detail TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (default_agent_id) REFERENCES config_agents(id)
    );
    CREATE TABLE config_agent_thread_routes (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_generation INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, channel_id, thread_ts),
      FOREIGN KEY (agent_id) REFERENCES config_agents(id)
    );
  `);
  for (const [key, value] of [
    ['schema_version', String(CONFIG_SCHEMA_VERSION)],
    ['schema_marker', CONFIG_SCHEMA_MARKER],
    ['config_seeded_v1', 'already-seeded'],
  ] satisfies Array<[string, string]>) {
    db.run('INSERT INTO config_meta (key, value) VALUES (?, ?)', key, value);
  }
  db.run(
    `INSERT INTO config_agents (
      id, revision, name, description, instructions, enabled, lifecycle,
      creator_membership_id, edit_policy, configuration_generation,
      slack_presence_json, archived_at, model, skills_json, mcp_servers_json,
      api_connections_json, repositories_json
    ) VALUES (?, 1, ?, NULL, ?, 1, 'active', NULL, 'creator_and_admins', 1,
      ?, NULL, ?, '[]', '[]', '[]', '[]')`,
    'agent_default',
    'Sprout',
    'Help with general questions.',
    JSON.stringify({
      requestedHandle: 'sprout',
      normalizedHandle: 'sprout',
      desiredState: 'unpublished',
      health: 'unpublished',
      avatar: { kind: 'generated', revision: 1, seed: 'agent_default' },
    }),
    'cloudflare/@cf/zai-org/glm-5.2',
  );
  db.run(
    `INSERT INTO config_workspace_installations (
      workspace_id, revision, transport_mode, default_agent_id, team_id,
      app_id, bot_user_id, gateway_binding_id, health, health_detail,
      created_at, updated_at
    ) VALUES ('TACME', 1, 'direct', 'agent_default', 'TACME', 'A1', 'U1', NULL,
      'healthy', NULL, 1, 1)`,
  );
  db.run(
    `INSERT INTO config_agent_thread_routes (
      workspace_id, channel_id, thread_ts, agent_id, agent_generation,
      revision, updated_at
    ) VALUES ('TACME', 'D1', '100.1', 'agent_default', 1, 1, 1)`,
  );
}

test('fresh config state installs the exact Agent-first schema marker atomically', () => {
  const db = openStateDb(':memory:');
  try {
    let failOnce = true;
    const interrupted: StateDb = {
      run: (sql, ...params) => db.run(sql, ...params),
      get: (sql, ...params) => db.get(sql, ...params),
      all: (sql, ...params) => db.all(sql, ...params),
      exec: (sql) => {
        if (failOnce && /CREATE TABLE IF NOT EXISTS config_agent_schedule_references/.test(sql)) {
          failOnce = false;
          throw new Error('simulated schema interruption');
        }
        db.exec(sql);
      },
      transaction: (fn) => db.transaction(fn),
    };

    assert.throws(
      () => new ConfigStoreLogic(interrupted, { agents: [] }),
      /simulated schema interruption/,
    );
    assert.deepEqual(
      db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'config_%'"),
      [],
    );

    new ConfigStoreLogic(interrupted, { agents: [] });
    assert.equal(
      db.get("SELECT value FROM config_meta WHERE key = 'schema_version'")?.value,
      String(CONFIG_SCHEMA_VERSION),
    );
    assert.equal(
      db.get("SELECT value FROM config_meta WHERE key = 'schema_marker'")?.value,
      CONFIG_SCHEMA_MARKER,
    );
    assert.ok(db.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'config_agent_archive_snapshots'",
    ));

    // A second target-neutral construction is a no-op and uses no PRAGMA-only
    // migration behavior, matching Durable Object SQLite's StateDb contract.
    new ConfigStoreLogic(interrupted, { agents: [] });
  } finally {
    db.close();
  }
});

test('legacy numeric config ledgers fail closed before Agent-first tables are installed', () => {
  const db = openStateDb(':memory:');
  try {
    db.exec('CREATE TABLE config_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.run("INSERT INTO config_meta (key, value) VALUES ('schema_version', '11')");

    assert.throws(
      () => new ConfigStoreLogic(db, { agents: [] }),
      /incompatible pre-Agent config state; use a fresh deployment/,
    );
    assert.equal(
      db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'config_agents'"),
      undefined,
    );
  } finally {
    db.close();
  }
});

test('an exact numeric version without the Agent-first marker is never accepted', () => {
  const db = openStateDb(':memory:');
  try {
    db.exec('CREATE TABLE config_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.run(
      'INSERT INTO config_meta (key, value) VALUES (?, ?)',
      'schema_version',
      String(CONFIG_SCHEMA_VERSION),
    );

    assert.throws(
      () => new ConfigStoreLogic(db, { agents: [] }),
      /incompatible pre-Agent config state; use a fresh deployment/,
    );
  } finally {
    db.close();
  }
});

test('prelaunch marked state with inert Channel behavior columns remains writable', () => {
  const db = openStateDb(':memory:');
  try {
    db.exec(`
      CREATE TABLE config_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE config_channels (
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        label TEXT,
        additional_instructions TEXT,
        participation_mode TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        PRIMARY KEY (workspace_id, channel_id)
      );
    `);
    db.run(
      'INSERT INTO config_meta (key, value) VALUES (?, ?)',
      'schema_version',
      String(CONFIG_SCHEMA_VERSION),
    );
    db.run(
      'INSERT INTO config_meta (key, value) VALUES (?, ?)',
      'schema_marker',
      CONFIG_SCHEMA_MARKER,
    );
    db.run(
      'INSERT INTO config_meta (key, value) VALUES (?, ?)',
      'config_seeded_v1',
      'already-seeded',
    );

    const store = new ConfigStoreLogic(db, { agents: [] });
    assert.deepEqual(store.putChannel({
      workspaceId: 'TACME',
      channelId: 'CNEW',
      label: 'new-channel',
      lifecycle: 'active',
    }, 0), {
      workspaceId: 'TACME',
      channelId: 'CNEW',
      revision: 1,
      label: 'new-channel',
      lifecycle: 'active',
    });
    assert.deepEqual(
      { ...db.get(
        `SELECT additional_instructions, participation_mode
         FROM config_channels WHERE workspace_id = ? AND channel_id = ?`,
        'TACME',
        'CNEW',
      ) },
      { additional_instructions: null, participation_mode: 'mention_only' },
    );
  } finally {
    db.close();
  }
});

test('schema 12 receives additive Chickpea contracts without changing its baseline marker', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    const store = new ConfigStoreLogic(db, { agents: [] });

    assert.equal(
      db.get('SELECT value FROM config_meta WHERE key = ?', 'schema_version')?.value,
      String(CONFIG_SCHEMA_VERSION),
    );
    assert.equal(
      db.get('SELECT value FROM config_meta WHERE key = ?', 'schema_marker')?.value,
      CONFIG_SCHEMA_MARKER,
    );
    assert.ok(db.get(
      'SELECT 1 AS present FROM config_migrations WHERE id = ?',
      CONFIG_CHICKPEA_EXTENSION_MIGRATION,
    ));
    assert.ok(db.get(
      'SELECT 1 AS present FROM config_migrations WHERE id = ?',
      CONFIG_CHICKPEA_ROUTING_MIGRATION,
    ));
    assert.ok(db.get(
      'SELECT 1 AS present FROM config_migrations WHERE id = ?',
      CONFIG_CHICKPEA_CUTOVER_MIGRATION,
    ));
    assert.deepEqual(store.listAgents().map(({ id, kind }) => ({ id, kind })), [
      { id: 'agent_default', kind: 'user' },
    ]);
    assert.equal(store.getWorkspaceInstallation('TACME')?.runtimeContract, 'legacy');
    assert.equal(store.getAgentThreadRoute('TACME', 'D1', '100.1')?.ownerIncarnation, 1);
    assert.deepEqual(store.getWorkspaceModelDefault('TACME'), {
      workspaceId: 'TACME',
      modelId: 'cloudflare/@cf/zai-org/glm-5.2',
      revision: 1,
      provenance: 'migrated_agent',
      createdAt: 1,
      updatedAt: 1,
    });
    assert.equal(db.get("SELECT 1 FROM config_agents WHERE id = 'agent_chickpea'"), undefined);
    assert.deepEqual(store.preflightChickpeaCutover('TACME'), {
      workspaceId: 'TACME',
      state: 'prepared',
      runtimeContract: 'legacy',
      installationRevision: 1,
      defaultModelId: 'cloudflare/@cf/zai-org/glm-5.2',
      defaultRevision: 1,
      defaultProvenance: 'migrated_agent',
      modelClassification: 'untouched_cloudflare_starter',
      systemPrincipalCount: 0,
      validChickpeaPrincipalCount: 0,
      routeCount: 1,
      routeBackfillCount: 0,
      pinnedAgentCount: 0,
      inheritingAgentCount: 1,
      starterPinClearCount: 1,
      uncertainStarterPinCount: 0,
      collisions: [],
      blockers: [],
    });

    const before = JSON.stringify({
      agents: store.listAgents(),
      modelDefault: store.getWorkspaceModelDefault('TACME'),
      route: store.getAgentThreadRoute('TACME', 'D1', '100.1'),
    });
    const reopened = new ConfigStoreLogic(db, { agents: [] });
    assert.equal(JSON.stringify({
      agents: reopened.listAgents(),
      modelDefault: reopened.getWorkspaceModelDefault('TACME'),
      route: reopened.getAgentThreadRoute('TACME', 'D1', '100.1'),
    }), before);
  } finally {
    db.close();
  }
});

test('Stage 2 materializes one immutable Chickpea principal outside user-Agent lists', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    const store = new ConfigStoreLogic(db, { agents: [] });

    const created = store.materializeChickpeaAgent();
    const repeated = store.materializeChickpeaAgent();

    assert.equal(created.id, 'agent_chickpea');
    assert.equal(created.kind, 'system');
    assert.equal(created.model, undefined);
    assert.equal(created.slackPresence, undefined);
    assert.deepEqual(repeated, created);
    assert.equal(
      db.get("SELECT COUNT(*) AS count FROM config_agents WHERE id = 'agent_chickpea'")?.count,
      1,
    );
    assert.deepEqual(store.listUserAgents().map(({ id }) => id), ['agent_default']);
    assert.throws(
      () => store.updateAgent('agent_chickpea', { name: 'Changed' }, created.revision),
      /system Agent is product-owned/,
    );
    assert.throws(
      () => store.putAgentChannelGrant({
        workspaceId: 'TACME',
        channelId: 'C1',
        agentId: 'agent_chickpea',
        status: 'active',
        createdByMembershipId: 'membership_owner',
      }),
      /cannot receive user-configured capabilities/,
    );
  } finally {
    db.close();
  }
});

test('cutover activation is atomic, preserves route owners, and supports compatibility rollback', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    const store = new ConfigStoreLogic(db, { agents: [] });

    const activated = store.activateChickpeaCutover({
      workspaceId: 'TACME',
      expectedInstallationRevision: 1,
      expectedDefaultRevision: 1,
      defaultReady: true,
    });

    assert.equal(activated.runtimeContract, 'chickpea-v1');
    assert.equal(activated.installationRevision, 2);
    assert.equal(activated.defaultRevision, 1);
    assert.equal(activated.routeCount, 1);
    assert.equal(activated.routeBackfillCount, 0);
    assert.equal(activated.starterPinCleared, true);
    assert.equal(store.getAgent('agent_default').model, undefined);
    assert.equal(store.getAgent('agent_chickpea').kind, 'system');
    assert.deepEqual(
      store.getAgentThreadRoute('TACME', 'D1', '100.1'),
      {
        workspaceId: 'TACME',
        channelId: 'D1',
        threadTs: '100.1',
        agentId: 'agent_default',
        agentGeneration: 1,
        ownerIncarnation: 1,
        revision: 1,
        updatedAt: 1,
      },
    );
    assert.deepEqual(
      store.activateChickpeaCutover({
        workspaceId: 'TACME',
        expectedInstallationRevision: 1,
        expectedDefaultRevision: 1,
        defaultReady: true,
      }),
      activated,
    );

    const rolledBack = store.rollbackChickpeaCutover({
      workspaceId: 'TACME',
      expectedInstallationRevision: 2,
    });
    assert.equal(rolledBack.runtimeContract, 'legacy');
    assert.equal(rolledBack.state, 'rolled_back');
    assert.equal(rolledBack.systemPrincipalCount, 1);
    assert.equal(rolledBack.starterPinClearCount, 1);
    assert.equal(store.getAgent('agent_default').model, 'cloudflare/@cf/zai-org/glm-4.7-flash');

    const reactivated = store.activateChickpeaCutover({
      workspaceId: 'TACME',
      expectedInstallationRevision: 3,
      expectedDefaultRevision: 1,
      defaultReady: true,
    });
    assert.equal(reactivated.installationRevision, 4);
    assert.equal(reactivated.starterPinCleared, true);
    assert.equal(store.getAgent('agent_default').model, undefined);
  } finally {
    db.close();
  }
});

test('cutover preserves uncertain and known explicit Agent pins', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    db.run(
      'UPDATE config_agents SET configuration_generation = 2 WHERE id = ?',
      'agent_default',
    );
    const store = new ConfigStoreLogic(db, { agents: [] });
    const preflight = store.preflightChickpeaCutover('TACME');

    assert.equal(preflight.modelClassification, 'explicit_agent_pin');
    assert.equal(preflight.pinnedAgentCount, 1);
    assert.equal(preflight.starterPinClearCount, 0);
    assert.equal(preflight.uncertainStarterPinCount, 1);

    const activated = store.activateChickpeaCutover({
      workspaceId: 'TACME',
      expectedInstallationRevision: 1,
      expectedDefaultRevision: 1,
      defaultReady: true,
    });
    assert.equal(activated.starterPinCleared, false);
    assert.equal(activated.starterPinPreserved, false);
    assert.equal(store.getAgent('agent_default').model, 'cloudflare/@cf/zai-org/glm-5.2');
  } finally {
    db.close();
  }
});

test('Stage 1 captures an environment-only default exactly once', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    db.run('UPDATE config_agents SET model = NULL WHERE id = ?', 'agent_default');
    const store = new ConfigStoreLogic(db, { agents: [] });

    assert.equal(store.preflightChickpeaCutover('TACME').modelClassification, 'model_missing');
    const prepared = store.prepareChickpeaCutover({
      workspaceId: 'TACME',
      legacyEnvironmentModel: 'openai/gpt-5.6-sol',
    });
    assert.equal(prepared.modelClassification, 'environment_default');
    assert.equal(prepared.defaultModelId, 'openai/gpt-5.6-sol');
    assert.equal(prepared.defaultRevision, 2);
    assert.equal(prepared.defaultProvenance, 'migrated_environment');
    assert.equal(store.getAgent('agent_default').model, undefined);

    const repeated = store.prepareChickpeaCutover({
      workspaceId: 'TACME',
      legacyEnvironmentModel: 'anthropic/claude-sonnet-5',
    });
    assert.equal(repeated.defaultModelId, 'openai/gpt-5.6-sol');
    assert.equal(repeated.defaultRevision, 2);
  } finally {
    db.close();
  }
});

test('activation fails closed for a missing default or reserved identity collision', () => {
  const missingDb = openStateDb(':memory:');
  try {
    installSchema12Fixture(missingDb);
    missingDb.run('UPDATE config_agents SET model = NULL WHERE id = ?', 'agent_default');
    const missingStore = new ConfigStoreLogic(missingDb, { agents: [] });
    assert.throws(
      () => missingStore.activateChickpeaCutover({
        workspaceId: 'TACME',
        expectedInstallationRevision: 1,
        expectedDefaultRevision: 1,
        defaultReady: false,
      }),
      /workspace_default_missing|workspace_default_not_ready/,
    );
    assert.equal(missingStore.getWorkspaceInstallation('TACME')?.runtimeContract, 'legacy');
    assert.equal(dbHasChickpea(missingDb), false);
  } finally {
    missingDb.close();
  }

  const collisionDb = openStateDb(':memory:');
  try {
    installSchema12Fixture(collisionDb);
    collisionDb.run('UPDATE config_agents SET name = ? WHERE id = ?', 'Chick pea', 'agent_default');
    const collisionStore = new ConfigStoreLogic(collisionDb, { agents: [] });
    assert.deepEqual(collisionStore.preflightChickpeaCutover('TACME').collisions, [{
      agentId: 'agent_default',
      field: 'name',
    }]);
    assert.throws(
      () => collisionStore.activateChickpeaCutover({
        workspaceId: 'TACME',
        expectedInstallationRevision: 1,
        expectedDefaultRevision: 1,
        defaultReady: true,
      }),
      /reserved_identity_collision/,
    );
    assert.equal(collisionStore.getWorkspaceInstallation('TACME')?.runtimeContract, 'legacy');
    assert.equal(dbHasChickpea(collisionDb), false);
  } finally {
    collisionDb.close();
  }
});

test('a fresh installation creates Chickpea as its default and the keyless Workspace default atomically', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, { agents: createSeededAgents() });
    assert.deepEqual(store.listUserAgents(), []);
    const installation = store.ensureWorkspaceInstallation({
      workspaceId: 'TNEW',
      transportMode: 'gateway',
    });

    assert.equal(installation.runtimeContract, 'chickpea-v1');
    assert.equal(installation.defaultAgentId, 'agent_chickpea');
    assert.equal(store.getAgent('agent_chickpea').kind, 'system');
    assert.deepEqual(store.listUserAgents(), []);
    assert.equal(store.preflightChickpeaCutover('TNEW').state, 'activated');
    assert.equal(
      store.getWorkspaceModelDefault('TNEW')?.modelId,
      seededWorkspaceModelDefault(),
    );
    assert.equal(
      store.getWorkspaceModelDefault('TNEW')?.provenance,
      seededWorkspaceModelDefault() ? 'installation_bootstrap' : 'migration_pending',
    );
    assert.equal(
      seededWorkspaceModelDefault({ target: 'cloudflare' }),
      'cloudflare/@cf/zai-org/glm-4.7-flash',
    );
    assert.equal(seededWorkspaceModelDefault({ target: 'node' }), undefined);
  } finally {
    db.close();
  }
});

function dbHasChickpea(db: StateDb): boolean {
  return Boolean(db.get("SELECT 1 AS present FROM config_agents WHERE id = 'agent_chickpea'"));
}

test('Workspace default writes use optimistic revisions', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    const store = new ConfigStoreLogic(db, { agents: [] });

    const updated = store.putWorkspaceModelDefault({
      workspaceId: 'TACME',
      modelId: 'openai/gpt-5.6',
      provenance: 'admin_selected',
      lastChangedByMembershipId: 'membership_owner',
    }, 1);
    assert.equal(updated.revision, 2);
    assert.equal(updated.modelId, 'openai/gpt-5.6');
    assert.throws(
      () => store.putWorkspaceModelDefault({
        workspaceId: 'TACME',
        modelId: 'anthropic/claude-opus-4-1',
        provenance: 'admin_selected',
        lastChangedByMembershipId: 'membership_owner',
      }, 1),
      WorkspaceModelDefaultRevisionConflictError,
    );
    assert.equal(store.getWorkspaceModelDefault('TACME')?.modelId, 'openai/gpt-5.6');
  } finally {
    db.close();
  }
});

test('removing an Agent thread route also removes its private public-context rows', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, { agents: [createDemoStarterAgent()] });
    store.putAgentThreadRoute({
      workspaceId: 'T1', channelId: 'D1', threadTs: '100.1',
      agentId: 'agent_default', agentGeneration: 1,
    });
    store.putSlackPublicContext({
      workspaceId: 'T1', channelId: 'D1', rootTs: '100.1', messageTs: '100.1',
      role: 'human', text: 'Visible message',
    });

    assert.equal(store.deleteAgentThreadRoute('T1', 'D1', '100.1'), true);
    assert.equal(store.getAgentThreadRoute('T1', 'D1', '100.1'), undefined);
    assert.deepEqual(store.listSlackPublicContext('T1', 'D1', '100.1'), []);
  } finally {
    db.close();
  }
});

test('the private public-context ledger prunes old rows per Slack root', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db);
    for (let index = 0; index < 205; index += 1) {
      store.putSlackPublicContext({
        workspaceId: 'T1', channelId: 'D1', rootTs: '100.1',
        messageTs: `${1000 + index}.000001`, role: 'human', text: `message ${index}`,
      });
    }
    const retained = store.listSlackPublicContext('T1', 'D1', '100.1');
    assert.equal(retained.length, 200);
    assert.equal(retained[0]?.text, 'message 5');
    assert.equal(retained.at(-1)?.text, 'message 204');
  } finally {
    db.close();
  }
});

test('the private public-context ledger expires inactive roots after 30 days', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db);
    store.putSlackPublicContext({
      workspaceId: 'T1', channelId: 'D1', rootTs: 'stale', messageTs: '100.1',
      role: 'human', text: 'Expired context',
    });
    db.run(
      `UPDATE config_slack_public_context SET updated_at = 0
       WHERE workspace_id = 'T1' AND channel_id = 'D1' AND root_ts = 'stale'`,
    );

    store.putSlackPublicContext({
      workspaceId: 'T1', channelId: 'D1', rootTs: 'active', messageTs: '200.1',
      role: 'human', text: 'Older active-root context',
    });
    db.run(
      `UPDATE config_slack_public_context SET updated_at = 0
       WHERE workspace_id = 'T1' AND channel_id = 'D1' AND root_ts = 'active'`,
    );
    store.putSlackPublicContext({
      workspaceId: 'T1', channelId: 'D1', rootTs: 'active', messageTs: '200.2',
      role: 'human', text: 'Recent root activity',
    });

    assert.deepEqual(store.listSlackPublicContext('T1', 'D1', 'stale'), []);
    assert.deepEqual(
      store.listSlackPublicContext('T1', 'D1', 'active').map(({ text }) => text),
      ['Older active-root context', 'Recent root activity'],
    );
  } finally {
    db.close();
  }
});

test('a private draft may hold only a pending publication grant until activation', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, { agents: [] });
    const draft = store.createAgent({
      id: 'agent_draft',
      name: 'Draft',
      instructions: 'Draft safely.',
      enabled: false,
      lifecycle: 'draft',
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const pending = store.putAgentChannelGrant({
      workspaceId: 'T1',
      channelId: 'C1',
      agentId: draft.id,
      status: 'pending',
      createdByMembershipId: 'membership_1',
    }, 0);
    assert.throws(
      () => store.putAgentChannelGrant({ ...pending, status: 'active' }, pending.revision),
      /not active/,
    );
    const active = store.updateAgent(
      draft.id,
      { enabled: true, lifecycle: 'active' },
      draft.revision,
    );
    assert.equal(active.enabled, true);
    assert.equal(
      store.putAgentChannelGrant({ ...pending, status: 'active' }, pending.revision).status,
      'active',
    );
  } finally {
    db.close();
  }
});
