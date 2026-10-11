import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { validConnectionCredentialRef } from '../src/config/connection-credential-binding.ts';
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
    kind: 'user',
    revision: 1,
    name: 'API Connections',
    instructions: 'Exercise API connection persistence.',
    enabled: true,
    lifecycle: 'active',
    editPolicy: 'creator_and_admins',
    configurationGeneration: 1,
    slackPresence: {
      requestedHandle: 'api-connections',
      normalizedHandle: 'api-connections',
      desiredState: 'unpublished',
      health: 'unpublished',
      avatar: { kind: 'generated', revision: 1, seed: 'chickpea-avatar-v1:12:agent_api_connections' },
    },
    model: 'local-stub/api-connections',
    skills: [],
    mcpServers: [],
    apiConnections,
    repositories: [],
    websiteLogins: [],
  };
}

function publicConnection(connection: ApiConnectionConfig): Omit<ApiConnectionConfig, 'credentialRef'> {
  const { credentialRef: _credentialRef, ...fields } = connection;
  return fields;
}

test('SqliteConfigStore round-trips every apiConnection field through create and update', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    const createdConnection = connection();
    const created = agent([createdConnection]);

    const createdStored = await store.createAgent(created);
    const initialConnection = createdStored.apiConnections[0]!;
    assert.equal(validConnectionCredentialRef(initialConnection.credentialRef), true);
    assert.deepEqual(publicConnection(initialConnection), createdConnection);
    assert.deepEqual((await store.getAgent(created.id)).apiConnections, [initialConnection]);

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

    const updatedConnection = updated.apiConnections[0]!;
    assert.equal(validConnectionCredentialRef(updatedConnection.credentialRef), true);
    assert.notEqual(updatedConnection.credentialRef, initialConnection.credentialRef);
    assert.deepEqual(publicConnection(updatedConnection), patchedConnections[0]);
    assert.deepEqual((await store.getAgent(created.id)).apiConnections, [updatedConnection]);
  } finally {
    store.close();
  }
});

test('SqliteConfigStore defaults invalid api_connections_json to an empty list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-api-connections-'));
  const path = join(dir, 'state.db');
  try {
    const first = new SqliteConfigStore(path, { agents: [] });
    const created = agent([connection()]);
    await first.createAgent(created);
    first.close();

    const db = new DatabaseSync(path);
    db.prepare('UPDATE config_agents SET api_connections_json = ? WHERE id = ?').run(
      '{invalid-json',
      created.id,
    );
    db.close();

    const second = new SqliteConfigStore(path, { agents: [] });
    assert.deepEqual((await second.getAgent(created.id)).apiConnections, []);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
