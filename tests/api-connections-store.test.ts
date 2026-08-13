import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import type { ApiConnectionConfig, CustomAgentConfig } from '../src/config/types.ts';

function connection(overrides: Partial<ApiConnectionConfig> = {}): ApiConnectionConfig {
  return {
    id: 'linear-api',
    displayName: 'Linear API',
    allowedHosts: ['api.linear.app', '*.example.com'],
    pathPrefixes: ['/v1'],
    headerName: 'Authorization',
    headerValuePrefix: 'Bearer ',
    allowedMethods: ['GET', 'POST'],
    enabled: true,
    presetId: 'linear-api',
    ...overrides,
  };
}

function agent(apiConnections: ApiConnectionConfig[]): CustomAgentConfig {
  return {
    id: 'agent_api_connections',
    revision: 1,
    name: 'API Connections',
    instructions: 'Exercise API connection persistence.',
    enabled: true,
    model: 'local-stub/api-connections',
    skills: [],
    mcpServers: [],
    apiConnections,
    repositories: [],
  };
}

test('SqliteConfigStore round-trips every apiConnection field through create and update', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  try {
    const createdConnection = connection();
    const created = agent([createdConnection]);

    assert.deepEqual(await store.createAgent(created), created);
    assert.deepEqual((await store.getAgent(created.id)).apiConnections, [createdConnection]);

    const patchedConnections = [
      connection({
        displayName: 'Linear API v2',
        allowedHosts: ['api.linear.app'],
        pathPrefixes: ['/v2/issues'],
        headerName: 'X-Api-Key',
        headerValuePrefix: 'token ',
        allowedMethods: ['HEAD', 'PUT', 'PATCH', 'DELETE'],
        enabled: false,
        presetId: 'linear-api-v2',
      }),
    ];
    const updated = await store.updateAgent(created.id, { apiConnections: patchedConnections });

    assert.deepEqual(updated.apiConnections, patchedConnections);
    assert.deepEqual((await store.getAgent(created.id)).apiConnections, patchedConnections);
  } finally {
    store.close();
  }
});

test('SqliteConfigStore defaults invalid api_connections_json to an empty list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-api-connections-'));
  const path = join(dir, 'state.db');
  try {
    const first = new SqliteConfigStore(path, { agents: [], assignments: [] });
    const created = agent([connection()]);
    await first.createAgent(created);
    first.close();

    const db = new DatabaseSync(path);
    db.prepare('UPDATE config_agents SET api_connections_json = ? WHERE id = ?').run(
      '{invalid-json',
      created.id,
    );
    db.close();

    const second = new SqliteConfigStore(path, { agents: [], assignments: [] });
    assert.deepEqual((await second.getAgent(created.id)).apiConnections, []);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
