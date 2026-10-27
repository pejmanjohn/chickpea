import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONFIG_CHICKPEA_CUTOVER_MIGRATION,
  CONFIG_CHICKPEA_EXTENSION_MIGRATION,
  CONFIG_CHICKPEA_ROUTING_MIGRATION,
  CONFIG_CONNECTION_CREDENTIAL_BINDING_MIGRATION,
  CONFIG_MODEL_ROLE_MIGRATION,
  CONFIG_SCHEMA_MARKER,
  CONFIG_SCHEMA_VERSION,
  ConfigStoreLogic,
} from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import {
  ModelRoleRevisionConflictError,
  WorkspaceModelDefaultRevisionConflictError,
} from '../src/config/errors.ts';
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
      () => new ConfigStoreLogic(interrupted, agentRoutineDeletion, { agents: [] }),
      /simulated schema interruption/,
    );
    assert.deepEqual(
      db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'config_%'"),
      [],
    );

    new ConfigStoreLogic(interrupted, agentRoutineDeletion, { agents: [] });
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
    new ConfigStoreLogic(interrupted, agentRoutineDeletion, { agents: [] });
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
      () => new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] }),
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
      () => new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] }),
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

    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
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
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });

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
    const reopened = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    assert.equal(JSON.stringify({
      agents: reopened.listAgents(),
      modelDefault: reopened.getWorkspaceModelDefault('TACME'),
      route: reopened.getAgentThreadRoute('TACME', 'D1', '100.1'),
    }), before);
  } finally {
    db.close();
  }
});

test('the credential-binding migration replaces every preexisting internal ref', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    const suppliedMcpRef = 'connection_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const suppliedApiRef = 'connection_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    db.run(
      'UPDATE config_agents SET mcp_servers_json = ?, api_connections_json = ? WHERE id = ?',
      JSON.stringify([{
        id: 'legacy-mcp', credentialRef: suppliedMcpRef, displayName: 'Legacy MCP',
        url: 'https://mcp.example.com/rpc', transport: 'streamable-http', authMode: 'bearer',
        headerNames: ['X-Api-Key'], enabled: true, lifecycleStatus: 'ready', statusText: '',
        discoveredTools: [], allowedTools: [],
      }]),
      JSON.stringify([{
        id: 'legacy-api', credentialRef: suppliedApiRef, displayName: 'Legacy API',
        allowedHosts: ['api.example.com'], pathPrefixes: ['/v1'],
        headerName: 'Authorization', allowedMethods: ['GET'], enabled: true,
        authMode: 'credential',
      }]),
      'agent_default',
    );
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    for (const key of [
      'mcp.agent_default.legacy-mcp.bearer',
      'mcp.agent_default.legacy-mcp.header.X-Api-Key',
      'mcp.agent_default.legacy-mcp.oauth.tokens',
      'mcp.agent_default.orphan-mcp.bearer',
      'connector.agent_default.legacy-api.credential',
      'connector.agent_default.legacy-api.oauth.tokens',
      'connector.agent_default.orphan-api.credential',
      'connector.agent_default.orphan-api.oauth.tokens',
      `mcp.agent_default.credential.${suppliedMcpRef}.bearer`,
      'provider.openai.apiKey',
    ]) {
      db.run(
        'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
        key,
        'synthetic-secret',
        1,
      );
    }

    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    const migrated = store.getAgent('agent_default');
    const mcpRef = migrated.mcpServers[0]?.credentialRef;
    const apiRef = migrated.apiConnections[0]?.credentialRef;
    assert.match(mcpRef ?? '', /^connection_[0-9a-f]{32}$/);
    assert.match(apiRef ?? '', /^connection_[0-9a-f]{32}$/);
    assert.notEqual(mcpRef, suppliedMcpRef);
    assert.notEqual(apiRef, suppliedApiRef);
    assert.equal(db.get(
      "SELECT 1 AS present FROM app_settings WHERE key = 'mcp.agent_default.legacy-mcp.bearer'",
    ), undefined);
    assert.equal(db.get(
      "SELECT 1 AS present FROM app_settings WHERE key = 'mcp.agent_default.legacy-mcp.header.X-Api-Key'",
    ), undefined);
    assert.equal(db.get(
      "SELECT 1 AS present FROM app_settings WHERE key = 'connector.agent_default.legacy-api.credential'",
    ), undefined);
    for (const retiredKey of [
      'mcp.agent_default.legacy-mcp.oauth.tokens',
      'mcp.agent_default.orphan-mcp.bearer',
      'connector.agent_default.orphan-api.credential',
      'connector.agent_default.legacy-api.oauth.tokens',
      'connector.agent_default.orphan-api.oauth.tokens',
    ]) {
      assert.equal(
        db.get('SELECT 1 AS present FROM app_settings WHERE key = ?', retiredKey),
        undefined,
        retiredKey,
      );
    }
    assert.ok(db.get(
      'SELECT 1 AS present FROM app_settings WHERE key = ?',
      `mcp.agent_default.credential.${suppliedMcpRef}.bearer`,
    ));
    assert.ok(db.get(
      "SELECT 1 AS present FROM app_settings WHERE key = 'provider.openai.apiKey'",
    ));
    assert.ok(db.get(
      'SELECT 1 AS present FROM config_migrations WHERE id = ?',
      CONFIG_CONNECTION_CREDENTIAL_BINDING_MIGRATION,
    ));

    const reopened = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] }).getAgent('agent_default');
    assert.equal(reopened.mcpServers[0]?.credentialRef, mcpRef);
    assert.equal(reopened.apiConnections[0]?.credentialRef, apiRef);
  } finally {
    db.close();
  }
});

test('credential migration preserves connection-account OAuth keys when an Agent id collides', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    const collisionId = 'connection_collision';
    db.run(
      `INSERT INTO config_agents (
        id, revision, name, description, instructions, enabled, lifecycle,
        creator_membership_id, edit_policy, configuration_generation,
        slack_presence_json, archived_at, model, skills_json, mcp_servers_json,
        api_connections_json, repositories_json
      ) SELECT ?, revision, 'Collision', description, instructions, enabled, lifecycle,
        creator_membership_id, edit_policy, configuration_generation,
        slack_presence_json, archived_at, model, skills_json, mcp_servers_json,
        api_connections_json, repositories_json
      FROM config_agents WHERE id = 'agent_default'`,
      collisionId,
    );
    db.run(
      'UPDATE config_agents SET api_connections_json = ? WHERE id = ?',
      JSON.stringify([{
        id: 'account',
        displayName: 'Colliding Agent connection',
        allowedHosts: ['gmail.googleapis.com'],
        pathPrefixes: ['/gmail/v1/users/me'],
        headerName: 'Authorization',
        headerValuePrefix: 'Bearer ',
        allowedMethods: ['GET', 'HEAD'],
        enabled: true,
        authMode: 'oauth',
        oauthProvider: 'google',
        oauthScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        oauthAppType: 'external',
        lifecycleStatus: 'ready',
        statusText: 'Connected',
      }]),
      collisionId,
    );
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const protectedKeys = [
      `mcp.${collisionId}.account.oauth.tokens`,
      `connector.${collisionId}.account.oauth.tokens`,
    ];
    const retiredKey = `connector.${collisionId}.legacy-api.oauth.tokens`;
    for (const key of [...protectedKeys, retiredKey]) {
      db.run(
        'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
        key,
        'synthetic-secret',
        1,
      );
    }

    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    assert.equal(store.getAgent(collisionId).id, collisionId);
    for (const key of protectedKeys) {
      assert.ok(db.get('SELECT 1 AS present FROM app_settings WHERE key = ?', key), key);
    }
    assert.equal(
      db.get('SELECT 1 AS present FROM app_settings WHERE key = ?', retiredKey),
      undefined,
    );
  } finally {
    db.close();
  }
});

const CURRENT_MCP_REF = 'connection_cccccccccccccccccccccccccccccccc';
const CURRENT_API_REF = 'connection_dddddddddddddddddddddddddddddddd';
// Legacy Agent-level secrets of a live Agent and of one deleted before the update.
const LEGACY_AGENT_SECRET_KEYS = [
  'mcp.agent_default.docs.bearer',
  'mcp.agent_default.docs.header.X-Api-Key',
  'mcp.agent_default.docs.oauth.tokens',
  'connector.agent_default.billing.credential',
  'connector.agent_default.billing.oauth.refresh-lease',
  'mcp.agent_gone.m1.bearer',
  'mcp.agent_gone.m1.header.x-team',
  'mcp.agent_gone.m1.oauth.client',
  'mcp.agent_gone.m1.oauth.registration-lease',
  'connector.agent_gone.a1.credential',
  'connector.agent_gone.a1.oauth.pending',
  'connector.agent_gone.a1.oauth.tokens',
  // Connection IDs and header names saved through the management API may contain dots.
  'mcp.agent_default.team.docs.bearer',
  'mcp.agent_default.docs.header.X.Trace',
  'connector.agent_gone.v1.api.credential',
];
const NON_LEGACY_SECRET_KEYS = [
  'mcp.connection_0f1e.account.oauth.tokens',
  'connector.connection_0f1e.account.oauth.client',
  'connection-account.secret_team.credential',
  'connection-account.secret_member.credential',
  `mcp.agent_default.credential.${CURRENT_MCP_REF}.bearer`,
  `mcp.agent_default.credential.${CURRENT_MCP_REF}.header.x-api-key`,
  `mcp.agent_default.credential.${CURRENT_MCP_REF}.oauth.tokens`,
  `connector.agent_default.credential.${CURRENT_API_REF}.credential`,
  `connector.agent_default.credential.${CURRENT_API_REF}.oauth.tokens`,
  'mcp.oauth-client.meta-ads',
  'mcp-secret-cleanup.agent_gone',
  'provider.openai.apiKey',
];

function seedAppSettings(db: StateDb, keys: readonly string[]): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  );
  for (const key of keys) {
    db.run('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, 1)', key, 'synthetic-secret');
  }
}

function settingKeys(db: StateDb): string[] {
  return db.all('SELECT key FROM app_settings ORDER BY key').map((row) => String(row.key));
}

function appliedMigrations(db: StateDb): Array<Record<string, unknown>> {
  return db.all('SELECT id, applied_at FROM config_migrations ORDER BY id');
}

test('the first start removes every legacy Agent secret, including those of deleted Agents', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    seedAppSettings(db, [...LEGACY_AGENT_SECRET_KEYS, ...NON_LEGACY_SECRET_KEYS]);

    new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    assert.deepEqual(settingKeys(db), [...NON_LEGACY_SECRET_KEYS].sort());
    assert.ok(appliedMigrations(db).some(({ id }) => id === CONFIG_CONNECTION_CREDENTIAL_BINDING_MIGRATION));

    const before = JSON.stringify({ keys: settingKeys(db), migrations: appliedMigrations(db) });
    new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    assert.equal(JSON.stringify({ keys: settingKeys(db), migrations: appliedMigrations(db) }), before);
  } finally {
    db.close();
  }
});

// v0.1.33's createAgent statement, which predates credential_incarnation and
// connection credential references.
function insertV0133Agent(db: StateDb, id: string): void {
  db.run(
    `INSERT INTO config_agents (
      id, agent_kind, revision, name, description, instructions, enabled, lifecycle,
      creator_membership_id, edit_policy, configuration_generation,
      slack_presence_json, archived_at, model,
      skills_json, mcp_servers_json, api_connections_json, repositories_json,
      website_logins_json
    ) VALUES (?, 'user', 1, ?, NULL, 'Help.', 1, 'active', NULL, 'creator_and_admins', 1,
      ?, NULL, NULL, '[]', ?, ?, '[]', '[]')`,
    id,
    id,
    JSON.stringify({
      requestedHandle: id,
      normalizedHandle: id,
      desiredState: 'unpublished',
      health: 'unpublished',
      avatar: { kind: 'generated', revision: 1, seed: id },
    }),
    JSON.stringify([{
      id: 'docs', displayName: 'Docs', url: 'https://mcp.example.com/rpc',
      transport: 'streamable-http', authMode: 'bearer', headerNames: [], enabled: true,
      lifecycleStatus: 'ready', statusText: '', discoveredTools: [], allowedTools: [],
    }]),
    JSON.stringify([{
      id: 'billing', displayName: 'Billing', allowedHosts: ['api.example.com'],
      pathPrefixes: ['/v1'], headerName: 'Authorization', allowedMethods: ['GET'],
      enabled: true, authMode: 'credential',
    }]),
  );
}

test('every start removes the legacy Agent secrets an earlier release saved after a rollback', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    seedAppSettings(db, NON_LEGACY_SECRET_KEYS);
    new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    // Release-candidate builds recorded the removal as a one-time step.
    db.run(
      'INSERT OR IGNORE INTO config_migrations (id, applied_at) VALUES (?, 1)',
      '2026-10-24-legacy-agent-connection-secret-sweep-v1',
    );
    const bindingApplied = db.get(
      'SELECT applied_at FROM config_migrations WHERE id = ?',
      CONFIG_CONNECTION_CREDENTIAL_BINDING_MIGRATION,
    );

    // Rolled back to v0.1.33: it saves an Agent's secrets under the Agent's
    // ID, and deleting the Agent from Slack writes no receipt and keeps them.
    insertV0133Agent(db, 'agent_reused');
    const savedOnRollback = [
      'mcp.agent_reused.docs.bearer',
      'mcp.agent_reused.docs.header.X-Api-Key',
      'mcp.agent_reused.docs.oauth.tokens',
      'connector.agent_reused.billing.credential',
      'connector.agent_reused.billing.oauth.tokens',
    ];
    seedAppSettings(db, savedOnRollback);
    db.run('DELETE FROM config_agents WHERE id = ?', 'agent_reused');

    // Forward again. Rolling back once more and creating an Agent with the
    // same ID would otherwise show it these secrets as already saved.
    new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    assert.deepEqual(settingKeys(db), [...NON_LEGACY_SECRET_KEYS].sort());
    assert.deepEqual(db.get(
      'SELECT applied_at FROM config_migrations WHERE id = ?',
      CONFIG_CONNECTION_CREDENTIAL_BINDING_MIGRATION,
    ), bindingApplied);
  } finally {
    db.close();
  }
});

test('a fresh installation accepts v0.1.33 Agent writes, and the next start binds them', () => {
  const db = openStateDb(':memory:');
  try {
    new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    insertV0133Agent(db, 'agent_rolled_back');
    insertV0133Agent(db, 'agent_deleted_in_admin');
    // v0.1.33's Admin deleteAgentWithMemory, whose receipt predates
    // credential_incarnation.
    db.run('DELETE FROM config_agents WHERE id = ?', 'agent_deleted_in_admin');
    db.run(
      `INSERT INTO config_agent_deletion_receipts (
        idempotency_key, workspace_id, agent_id, deleted_at
       ) VALUES (?, ?, ?, ?)`,
      'delete-in-admin', '*', 'agent_deleted_in_admin', 1,
    );

    const agent = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] }).getAgent('agent_rolled_back');
    assert.match(agent.credentialIncarnation ?? '', /^agent_[0-9a-f]{32}$/);
    assert.match(agent.mcpServers[0]?.credentialRef ?? '', /^connection_[0-9a-f]{32}$/);
    assert.match(agent.apiConnections[0]?.credentialRef ?? '', /^connection_[0-9a-f]{32}$/);
    const reopened = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] }).getAgent('agent_rolled_back');
    assert.deepEqual(reopened, agent);
  } finally {
    db.close();
  }
});

test('Stage 2 materializes one immutable Chickpea principal outside user-Agent lists', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });

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
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });

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
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
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
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });

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
    const missingStore = new ConfigStoreLogic(missingDb, agentRoutineDeletion, { agents: [] });
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
    const collisionStore = new ConfigStoreLogic(collisionDb, agentRoutineDeletion, { agents: [] });
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
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: createSeededAgents() });
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
    assert.equal(
      seededWorkspaceModelDefault({ target: 'cloudflare', env: { CHICKPEA_TENANCY: 'installation' } }),
      undefined,
      'a deployment serving many installations has no Workers AI to seed',
    );
  } finally {
    db.close();
  }
});

test('an installation whose deployment cannot run the keyless model starts with no Workspace default', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  const db = openStateDb(':memory:');
  const seededDb = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: createSeededAgents() });
    store.ensureWorkspaceInstallation({ workspaceId: 'TKEYLESS', transportMode: 'direct', keylessModelDefault: false });
    const keyless = store.getWorkspaceModelDefault('TKEYLESS');
    assert.deepEqual(
      { modelId: keyless?.modelId, provenance: keyless?.provenance },
      { modelId: undefined, provenance: 'migration_pending' },
    );
    const seeded = new ConfigStoreLogic(seededDb, agentRoutineDeletion, { agents: createSeededAgents() });
    seeded.ensureWorkspaceInstallation({ workspaceId: 'TSEEDED', transportMode: 'direct' });
    assert.equal(seeded.getWorkspaceModelDefault('TSEEDED')?.modelId, 'cloudflare/@cf/zai-org/glm-4.7-flash',
      'standalone Cloudflare keeps its keyless first run');
  } finally {
    db.close();
    seededDb.close();
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

function dbHasChickpea(db: StateDb): boolean {
  return Boolean(db.get("SELECT 1 AS present FROM config_agents WHERE id = 'agent_chickpea'"));
}

test('Workspace default writes use optimistic revisions', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });

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
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [createDemoStarterAgent()] });
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
    const store = new ConfigStoreLogic(db, agentRoutineDeletion);
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
    const store = new ConfigStoreLogic(db, agentRoutineDeletion);
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

test('Agent replies from an expired thread are not imported across roots before the sweep', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    store.createAgent({ id: 'agent_dm', name: 'DM', instructions: '', enabled: true, lifecycle: 'active',
      creatorMembershipId: 'owner', editPolicy: 'creator_and_admins', skills: [], mcpServers: [],
      apiConnections: [], repositories: [] });
    for (const rootTs of ['100.1', '200.1']) {
      store.putSlackPublicContext({ workspaceId: 'T1', channelId: 'D1', rootTs, messageTs: rootTs,
        role: 'agent', agentId: 'agent_dm', text: `reply ${rootTs}` });
    }
    // The sweep just ran, so only the read-side cutoff can hide the stale root.
    db.run(`UPDATE config_slack_public_context SET updated_at = 0 WHERE root_ts = '100.1'`);
    const recent = store.listRecentSlackPublicContext({
      workspaceId: 'T1', channelId: 'D1', agentId: 'agent_dm', beforeMessageTs: '300.1', limit: 10,
    });
    assert.deepEqual(recent.map(({ text }) => text), ['reply 200.1']);
  } finally {
    db.close();
  }
});

test('a private draft may hold only a pending publication grant until activation', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
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

test('model role tables install additively on a fresh store and on schema 12', () => {
  const fresh = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(fresh, agentRoutineDeletion, { agents: createSeededAgents() });
    store.ensureWorkspaceInstallation({ workspaceId: 'TROLE', transportMode: 'gateway' });

    assert.equal(
      fresh.get('SELECT value FROM config_meta WHERE key = ?', 'schema_version')?.value,
      String(CONFIG_SCHEMA_VERSION),
    );
    assert.ok(fresh.get(
      'SELECT 1 AS present FROM config_migrations WHERE id = ?',
      CONFIG_MODEL_ROLE_MIGRATION,
    ));
    // Nothing is seeded: the image role starts empty by decision.
    assert.equal(store.getWorkspaceModelRole('TROLE', 'image'), undefined);
    assert.equal(store.getAgentModelRole('agent_chickpea', 'image'), undefined);
  } finally {
    fresh.close();
  }

  const legacy = openStateDb(':memory:');
  try {
    installSchema12Fixture(legacy);
    const store = new ConfigStoreLogic(legacy, agentRoutineDeletion, { agents: [] });

    assert.equal(
      legacy.get('SELECT value FROM config_meta WHERE key = ?', 'schema_version')?.value,
      String(CONFIG_SCHEMA_VERSION),
      'the role tables are additive and must not bump the config schema version',
    );
    assert.equal(
      legacy.get('SELECT value FROM config_meta WHERE key = ?', 'schema_marker')?.value,
      CONFIG_SCHEMA_MARKER,
    );
    assert.ok(legacy.get(
      'SELECT 1 AS present FROM config_migrations WHERE id = ?',
      CONFIG_MODEL_ROLE_MIGRATION,
    ));
    const saved = store.putWorkspaceModelRole({
      workspaceId: 'TACME',
      role: 'image',
      modelId: 'openai/gpt-image-2.5-flare',
      lastChangedByMembershipId: 'membership_owner',
    });
    assert.deepEqual(saved, {
      workspaceId: 'TACME',
      role: 'image',
      modelId: 'openai/gpt-image-2.5-flare',
      revision: 1,
      lastChangedByMembershipId: 'membership_owner',
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    });
    // Reopening runs the installer again; CREATE TABLE IF NOT EXISTS keeps the row.
    const reopened = new ConfigStoreLogic(legacy, agentRoutineDeletion, { agents: [] });
    assert.deepEqual(reopened.getWorkspaceModelRole('TACME', 'image'), saved);
  } finally {
    legacy.close();
  }
});

test('model role writes carry their own revision and reject a stale one', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });

    const first = store.putWorkspaceModelRole({
      workspaceId: 'TACME',
      role: 'image',
      modelId: 'openai/gpt-image-2.5-flare',
    }, 0);
    assert.equal(first.revision, 1);
    const second = store.putWorkspaceModelRole({
      workspaceId: 'TACME',
      role: 'image',
      modelId: 'openai/gpt-image-2.5-sunburst',
    }, 1);
    assert.equal(second.revision, 2);
    assert.throws(
      () => store.putWorkspaceModelRole({
        workspaceId: 'TACME',
        role: 'image',
        modelId: 'openai/gpt-image-2.5-flare',
      }, 1),
      (error: unknown) =>
        error instanceof ModelRoleRevisionConflictError &&
        error.scope === 'workspace' &&
        error.role === 'image' &&
        error.expectedRevision === 1 &&
        error.actualRevision === 2,
    );
    assert.equal(
      store.getWorkspaceModelRole('TACME', 'image')?.modelId,
      'openai/gpt-image-2.5-sunburst',
    );
    // The chat default keeps its own revision line; role rows never touch it.
    assert.equal(store.getWorkspaceModelDefault('TACME')?.revision, 1);
  } finally {
    db.close();
  }
});

test('clearing a workspace model role keeps the revision monotonic and reads back unset', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });

    const set = store.putWorkspaceModelRole({
      workspaceId: 'TACME',
      role: 'image',
      modelId: 'openai/gpt-image-2.5-flare',
    }, 0);
    assert.equal(set.revision, 1);

    // Omitting `modelId` clears the row: the role reads back unset, and the
    // revision still climbs so the next write from the cleared state is guarded.
    const cleared = store.putWorkspaceModelRole({ workspaceId: 'TACME', role: 'image' }, 1);
    assert.equal(cleared.modelId, undefined);
    assert.equal(cleared.revision, 2);
    const readback = store.getWorkspaceModelRole('TACME', 'image');
    assert.equal(readback?.modelId, undefined);
    assert.equal(readback?.revision, 2);

    // The cleared row is a real row, so the pre-clear revision is now stale.
    assert.throws(
      () => store.putWorkspaceModelRole({
        workspaceId: 'TACME',
        role: 'image',
        modelId: 'openai/gpt-image-2.5-sunburst',
      }, 1),
      (error: unknown) =>
        error instanceof ModelRoleRevisionConflictError &&
        error.expectedRevision === 1 &&
        error.actualRevision === 2,
    );
    const reset = store.putWorkspaceModelRole({
      workspaceId: 'TACME',
      role: 'image',
      modelId: 'openai/gpt-image-2.5-sunburst',
    }, 2);
    assert.equal(reset.modelId, 'openai/gpt-image-2.5-sunburst');
    assert.equal(reset.revision, 3);
  } finally {
    db.close();
  }
});

test('an Agent PATCH that fails on its role row leaves config_agents unchanged', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    const agent = store.getAgent('agent_default');

    assert.throws(
      () => store.updateAgentWithModelRoles(
        agent.id,
        { name: 'Renamed' },
        // 'chat' is not a role-table role: the role write throws after the
        // Agent row was already written inside the same transaction.
        [{ role: 'chat' as never, modelId: 'openai/gpt-image-2.5-flare' }],
        agent.revision,
      ),
      /Unsupported model role chat/,
    );
    const after = store.getAgent(agent.id);
    assert.equal(after.name, agent.name);
    assert.equal(after.revision, agent.revision);
    assert.equal(store.getAgentModelRole(agent.id, 'image'), undefined);

    const updated = store.updateAgentWithModelRoles(
      agent.id,
      { name: 'Renamed' },
      [{ role: 'image', modelId: 'openai/gpt-image-2.5-sunburst' }],
      agent.revision,
    );
    assert.equal(updated.name, 'Renamed');
    assert.equal(
      store.getAgentModelRole(agent.id, 'image')?.modelId,
      'openai/gpt-image-2.5-sunburst',
    );

    // Clearing the override keeps the row and advances only its own revision.
    store.updateAgentWithModelRoles(
      agent.id,
      {},
      [{ role: 'image', modelId: null }],
      updated.revision,
    );
    const cleared = store.getAgentModelRole(agent.id, 'image');
    assert.equal(cleared?.modelId, undefined);
    assert.equal(cleared?.revision, 2);
  } finally {
    db.close();
  }
});

test('effort columns install additively and an effort lives and dies with its model', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    for (const [table, column] of [
      ['config_agents', 'model_effort'],
      ['config_workspace_model_defaults', 'effort'],
      ['config_workspace_model_roles', 'effort'],
    ]) {
      assert.ok(db.all(`PRAGMA table_info(${table})`).some(({ name }) => name === column), `${table}.${column}`);
    }
    const legacy = store.getAgent('agent_default');
    assert.equal(legacy.modelEffort, undefined, 'pre-column Agents read as unset');

    const pinned = store.updateAgent(legacy.id, { model: 'anthropic/claude-opus-5-5', modelEffort: 'max' }, legacy.revision);
    assert.equal(pinned.modelEffort, 'max');
    const renamed = store.updateAgent(legacy.id, { name: 'Renamed' }, pinned.revision);
    assert.equal(renamed.modelEffort, 'max', 'an unrelated edit keeps the effort');
    const sameModel = store.updateAgent(legacy.id, { model: 'anthropic/claude-opus-5-5' }, renamed.revision);
    assert.equal(sameModel.modelEffort, 'max', 'resending the same model keeps the effort');
    const switched = store.updateAgent(legacy.id, { model: 'anthropic/claude-haiku-4-5' }, sameModel.revision);
    assert.equal(switched.model, 'anthropic/claude-haiku-4-5');
    assert.equal(switched.modelEffort, undefined, 'a new model without an effort clears it');
    const medium = store.updateAgent(legacy.id, { modelEffort: 'medium' }, switched.revision);
    assert.equal(medium.modelEffort, 'medium', 'medium is stored, not folded into unset');
    const unpinned = store.updateAgent(legacy.id, { model: null }, medium.revision);
    assert.equal(unpinned.modelEffort, undefined, 'an Agent without a model has no effort');
    db.run(
      "UPDATE config_agents SET model = 'anthropic/claude-opus-5-5', model_effort = 'ultra' WHERE id = ?",
      legacy.id,
    );
    assert.equal(store.getAgent(legacy.id).modelEffort, undefined, 'an unknown stored effort reads as unset');

    const chosen = store.putWorkspaceModelDefault({
      workspaceId: 'TACME', modelId: 'openai/gpt-5.5', effort: 'xhigh', provenance: 'admin_selected',
    });
    assert.equal(chosen.effort, 'xhigh');
    const replaced = store.putWorkspaceModelDefault({
      workspaceId: 'TACME', modelId: 'openai/gpt-5.5', provenance: 'admin_selected',
    }, chosen.revision);
    assert.equal(replaced.effort, undefined, 'a default saved without an effort stores none');

    const coding = store.putWorkspaceModelRole({
      workspaceId: 'TACME', role: 'coding', modelId: 'openai/gpt-5.5', effort: 'high',
    });
    assert.equal(coding.effort, 'high');
    const image = store.putWorkspaceModelRole({
      workspaceId: 'TACME', role: 'image', modelId: 'openai/gpt-image-2.5-flare', effort: 'high',
    });
    assert.equal(image.effort, undefined, 'the image role carries no effort');
    const cleared = store.putWorkspaceModelRole({ workspaceId: 'TACME', role: 'coding', effort: 'high' }, coding.revision);
    assert.equal(cleared.effort, undefined, 'an unset coding role carries no effort');
  } finally {
    db.close();
  }
});

test('website login grants install additively and pre-column Agents read as no grants', () => {
  const db = openStateDb(':memory:');
  try {
    installSchema12Fixture(db);
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    assert.ok(db.all('PRAGMA table_info(config_agents)')
      .some((column) => column.name === 'website_logins_json'));
    assert.equal(
      db.get('SELECT value FROM config_meta WHERE key = ?', 'schema_version')?.value,
      String(CONFIG_SCHEMA_VERSION),
    );
    const legacy = store.getAgent('agent_default');
    assert.deepEqual(legacy.websiteLogins, []);

    const grants = [{ loginId: `wl_${'a'.repeat(32)}`, level: 'act' as const, enabled: true }];
    const updated = store.updateAgent('agent_default', { websiteLogins: grants }, legacy.revision);
    assert.deepEqual(updated.websiteLogins, grants);
    // Other edits leave the grants untouched.
    const renamed = store.updateAgent('agent_default', { instructions: 'Still help.' }, updated.revision);
    assert.deepEqual(renamed.websiteLogins, grants);

    // Reopening an already-migrated store is a no-op.
    const reopened = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    assert.deepEqual(reopened.getAgent('agent_default').websiteLogins, grants);
  } finally {
    db.close();
  }
});
