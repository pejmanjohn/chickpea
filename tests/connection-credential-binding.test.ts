import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  boundApiCredentialRef,
  boundMcpCredentialRef,
  reconcileApiCredentialRefs,
  reconcileMcpCredentialRefs,
} from '../src/config/connection-credential-binding.ts';
import {
  AgentConnectionCredentialConflictError,
  AgentRevisionConflictError,
} from '../src/config/errors.ts';
import {
  mcpBearerEnvVar,
  mcpCredentialBindingEnvVar,
  resolveMcpSecrets,
} from '../src/config/mcp-secrets.ts';
import {
  connectorCredentialBindingEnvVar,
  connectorCredentialEnvVar,
  resolveConnectorCredential,
} from '../src/config/connector-secrets.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { ConfigStoreLogic } from '../src/config/store.ts';
import { MemoryStoreLogic } from '../src/memory/store.ts';
import type { ApiConnectionConfig, McpConnectionConfig } from '../src/config/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { StateDb } from '../src/state/state-db.ts';
import { withEnv } from './helpers/env.ts';

const MCP_REF = 'connection_11111111111111111111111111111111';
const API_REF = 'connection_22222222222222222222222222222222';

function mcp(overrides: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  return {
    id: 'linear-mcp',
    credentialRef: MCP_REF,
    displayName: 'Linear MCP',
    url: 'https://mcp.example.com/rpc',
    transport: 'streamable-http',
    authMode: 'bearer',
    headerNames: ['X-Workspace'],
    credentialHeaderName: 'X-Workspace',
    credentialValuePrefix: 'Token ',
    credentialOptional: false,
    enabled: true,
    lifecycleStatus: 'ready',
    statusText: '',
    discoveredTools: [{ name: 'search' }],
    allowedTools: ['search'],
    presetId: 'linear',
    ...overrides,
  };
}

function api(overrides: Partial<ApiConnectionConfig> = {}): ApiConnectionConfig {
  return {
    id: 'tasks-api',
    credentialRef: API_REF,
    displayName: 'Tasks API',
    allowedHosts: ['api.example.com'],
    pathPrefixes: ['/v1/tasks'],
    headerName: 'Authorization',
    headerValuePrefix: 'Bearer ',
    allowedMethods: ['GET'],
    enabled: true,
    authMode: 'credential',
    presetId: 'tasks',
    ...overrides,
  };
}

test('MCP credential refs rotate for every secret-delivery policy change', () => {
  const withoutCredentialHeader = mcp();
  delete withoutCredentialHeader.credentialHeaderName;
  const changes: McpConnectionConfig[] = [
    mcp({ url: 'https://other.example.com/rpc' }),
    mcp({ transport: 'sse' }),
    mcp({ authMode: 'none' }),
    mcp({ oauthScope: 'read write' }),
    mcp({ headerNames: ['X-Other'], credentialHeaderName: 'X-Other' }),
    withoutCredentialHeader,
    mcp({ credentialValuePrefix: 'ApiKey ' }),
    mcp({ credentialOptional: true }),
    mcp({ presetId: 'other-preset' }),
  ];
  for (const changed of changes) {
    assert.notEqual(
      reconcileMcpCredentialRefs([mcp()], [changed])[0]?.credentialRef,
      MCP_REF,
      JSON.stringify(changed),
    );
  }
});

test('API credential refs rotate for every egress and injection policy change', () => {
  const changes: ApiConnectionConfig[] = [
    api({ allowedHosts: ['other.example.com'] }),
    api({ pathPrefixes: ['/v2'] }),
    api({ headerName: 'X-Api-Key' }),
    api({ headerValuePrefix: 'Token ' }),
    api({ allowedMethods: ['GET', 'POST'] }),
    api({
      authMode: 'oauth',
      oauthProvider: 'google',
      oauthScopes: ['https://www.googleapis.com/auth/drive.readonly'],
      oauthAppType: 'external',
    }),
    api({ presetId: 'other-preset' }),
  ];
  for (const changed of changes) {
    assert.notEqual(
      reconcileApiCredentialRefs([api()], [changed])[0]?.credentialRef,
      API_REF,
      JSON.stringify(changed),
    );
  }
});

test('presentation and tool-selection edits retain the current credential refs', () => {
  const nextMcp = mcp({
    credentialRef: 'connection_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    displayName: 'Renamed',
    enabled: false,
    lifecycleStatus: 'failed',
    statusText: 'Try again',
    discoveredTools: [{ name: 'create' }],
    allowedTools: [],
    toolPolicies: {},
    lastCheckedAt: 123,
    identity: { accountName: 'Account' },
  });
  const nextApi = api({
    credentialRef: 'connection_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    displayName: 'Renamed',
    enabled: false,
    lifecycleStatus: 'failed',
    statusText: 'Try again',
    identity: { accountName: 'Account' },
  });
  assert.equal(reconcileMcpCredentialRefs([mcp()], [nextMcp])[0]?.credentialRef, MCP_REF);
  assert.equal(reconcileApiCredentialRefs([api()], [nextApi])[0]?.credentialRef, API_REF);
});

test('the config store owns refs and a reset or delete-readd creates a new incarnation', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, { agents: [] });
    const created = store.createAgent({
      id: 'agent_binding',
      name: 'Binding',
      instructions: 'Keep credentials on their reviewed targets.',
      enabled: true,
      skills: [],
      mcpServers: [mcp()],
      apiConnections: [api()],
      repositories: [],
    });
    const firstMcpRef = created.mcpServers[0]?.credentialRef;
    const firstApiRef = created.apiConnections[0]?.credentialRef;
    assert.match(firstMcpRef ?? '', /^connection_[0-9a-f]{32}$/);
    assert.match(firstApiRef ?? '', /^connection_[0-9a-f]{32}$/);
    assert.notEqual(firstMcpRef, MCP_REF, 'callers cannot choose an MCP credential ref');
    assert.notEqual(firstApiRef, API_REF, 'callers cannot choose an API credential ref');

    const reset = store.updateAgent(created.id, {
      mcpServers: [{ ...created.mcpServers[0]!, credentialRef: MCP_REF }],
      apiConnections: [{ ...created.apiConnections[0]!, credentialRef: API_REF }],
      credentialResets: { mcp: ['linear-mcp'], api: ['tasks-api'] },
    }, created.revision);
    assert.notEqual(reset.mcpServers[0]?.credentialRef, firstMcpRef);
    assert.notEqual(reset.apiConnections[0]?.credentialRef, firstApiRef);
    const resetMcpRef = reset.mcpServers[0]?.credentialRef;
    const resetApiRef = reset.apiConnections[0]?.credentialRef;
    assert.ok(resetMcpRef);
    assert.ok(resetApiRef);

    const removed = store.updateAgent(reset.id, {
      mcpServers: [],
      apiConnections: [],
    }, reset.revision);
    const readded = store.updateAgent(removed.id, {
      mcpServers: [{ ...mcp(), credentialRef: resetMcpRef }],
      apiConnections: [{ ...api(), credentialRef: resetApiRef }],
    }, removed.revision);
    assert.notEqual(readded.mcpServers[0]?.credentialRef, resetMcpRef);
    assert.notEqual(readded.apiConnections[0]?.credentialRef, resetApiRef);
  } finally {
    db.close();
  }
});

test('connection requirements reject a stale same-revision delete-recreate update', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, { agents: [] });
    const created = store.createAgent({
      id: 'agent_setup_fence',
      name: 'Setup fence',
      instructions: 'Fence setup writes to one connection incarnation.',
      enabled: true,
      skills: [],
      mcpServers: [mcp()],
      apiConnections: [api()],
      repositories: [],
    });
    const staleMcpRef = created.mcpServers[0]?.credentialRef;
    const staleApiRef = created.apiConnections[0]?.credentialRef;
    assert.ok(staleMcpRef);
    assert.ok(staleApiRef);
    assert.equal(store.deleteAgent(created.id, created.revision), true);
    const replacement = store.createAgent({
      id: created.id,
      name: 'Replacement',
      instructions: 'Do not accept an earlier setup operation.',
      enabled: true,
      skills: [],
      mcpServers: [mcp()],
      apiConnections: [api()],
      repositories: [],
    });
    assert.equal(replacement.revision, created.revision);
    assert.notEqual(replacement.mcpServers[0]?.credentialRef, staleMcpRef);
    assert.notEqual(replacement.apiConnections[0]?.credentialRef, staleApiRef);

    assert.throws(() => store.updateAgent(created.id, {
      mcpServers: created.mcpServers,
      credentialRequirements: { mcp: { 'linear-mcp': staleMcpRef } },
    }, created.revision), AgentConnectionCredentialConflictError);
    assert.throws(() => store.updateAgent(created.id, {
      apiConnections: created.apiConnections,
      credentialRequirements: { api: { 'tasks-api': staleApiRef } },
    }, created.revision), AgentConnectionCredentialConflictError);
    assert.deepEqual(store.getAgent(created.id), replacement);
  } finally {
    db.close();
  }
});

test('the update SQL CAS rejects an interposed same-revision replacement Agent', () => {
  const rawDb = openStateDb(':memory:');
  try {
    const baseStore = new ConfigStoreLogic(rawDb, { agents: [] });
    let interpose = false;
    let originalId = '';
    let originalRevision = 0;
    let originalIncarnation = '';
    let replacementIncarnation = '';
    const replacementInput = {
      id: 'agent_update_sql_fence',
      name: 'SQL replacement',
      instructions: 'Preserve the replacement when an older update reaches its write.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    };
    const db: StateDb = {
      run(sql, ...params) {
        if (interpose && sql.includes('UPDATE config_agents') &&
            sql.includes('credential_incarnation = ?')) {
          interpose = false;
          baseStore.deleteAgent(originalId, originalRevision, originalIncarnation);
          replacementIncarnation = baseStore.createAgent(replacementInput).credentialIncarnation!;
        }
        return rawDb.run(sql, ...params);
      },
      get: (sql, ...params) => rawDb.get(sql, ...params),
      all: (sql, ...params) => rawDb.all(sql, ...params),
      exec: (sql) => rawDb.exec(sql),
      transaction: (fn) => rawDb.transaction(fn),
    };
    const store = new ConfigStoreLogic(db, { agents: [] });
    const original = store.createAgent({ ...replacementInput, name: 'SQL original' });
    originalId = original.id;
    originalRevision = original.revision;
    originalIncarnation = original.credentialIncarnation!;
    interpose = true;

    assert.throws(
      () => store.updateAgent(original.id, { description: 'Stale write' }, original.revision),
      AgentRevisionConflictError,
    );
    const preserved = store.getAgent(original.id);
    assert.equal(preserved.credentialIncarnation, replacementIncarnation);
    assert.equal(preserved.name, replacementInput.name);
    assert.equal(preserved.description, undefined);
  } finally {
    rawDb.close();
  }
});

test('an Agent deletion receipt cannot replay against a replacement incarnation', () => {
  const db = openStateDb(':memory:');
  const memoryDb = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, { agents: [] });
    const memory = new MemoryStoreLogic(memoryDb);
    const input = {
      id: 'agent_delete_receipt',
      name: 'Deletion receipt',
      instructions: 'Bind delete retries to one Agent incarnation.',
      enabled: true,
      skills: [],
      mcpServers: [mcp()],
      apiConnections: [api()],
      repositories: [],
    };
    const created = store.createAgent(input);
    assert.equal(store.deleteAgentWithMemory(
      created.id,
      'delete-retry-key',
      created.revision,
      created.credentialIncarnation!,
      memory,
    ), true);
    const replacement = store.createAgent({ ...input, name: 'Replacement' });

    assert.throws(() => store.deleteAgentWithMemory(
      replacement.id,
      'delete-retry-key',
      replacement.revision,
      replacement.credentialIncarnation!,
      memory,
    ), AgentRevisionConflictError);
    assert.deepEqual(store.getAgent(replacement.id), replacement);
  } finally {
    db.close();
    memoryDb.close();
  }
});

test('Agent deletion removes memory atomically on the shared state database', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, { agents: [] });
    const memory = new MemoryStoreLogic(db);
    const created = store.createAgent({
      id: 'agent_shared_delete',
      name: 'Shared deletion',
      instructions: 'Delete Agent state in one database transaction.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    memory.putAgentMemory({
      agentId: created.id,
      body: 'Delete this private memory with the Agent.',
      expectedRevision: 0,
      idempotencyKey: 'memory-write-before-delete',
      idempotencyDigest: 'memory-write-before-delete-v1',
    });

    assert.equal(store.deleteAgentWithMemory(
      created.id,
      'shared-delete-key',
      created.revision,
      created.credentialIncarnation!,
      memory,
    ), true);
    assert.throws(() => store.getAgent(created.id));
    assert.deepEqual(memory.getAgentMemory(created.id), {
      agentId: created.id,
      body: '',
      revision: 0,
    });
  } finally {
    db.close();
  }
});

test('direct delete, archive, and restore fences reject same-revision replacement Agents', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, { agents: [] });
    const input = (id: string) => ({
      id,
      name: 'Lifecycle fence',
      instructions: 'Keep lifecycle writes on one Agent incarnation.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });

    const deleteOriginal = store.createAgent(input('agent_delete_fence'));
    assert.equal(store.deleteAgent(
      deleteOriginal.id,
      deleteOriginal.revision,
      deleteOriginal.credentialIncarnation,
    ), true);
    const deleteReplacement = store.createAgent(input(deleteOriginal.id));
    assert.equal(deleteReplacement.revision, deleteOriginal.revision);
    assert.throws(() => store.deleteAgent(
      deleteReplacement.id,
      deleteReplacement.revision,
      deleteOriginal.credentialIncarnation,
    ), AgentRevisionConflictError);
    assert.deepEqual(store.getAgent(deleteReplacement.id), deleteReplacement);

    const archiveOriginal = store.createAgent(input('agent_archive_fence'));
    assert.equal(store.deleteAgent(
      archiveOriginal.id,
      archiveOriginal.revision,
      archiveOriginal.credentialIncarnation,
    ), true);
    const archiveReplacement = store.createAgent(input(archiveOriginal.id));
    assert.throws(() => store.archiveAgent(archiveReplacement.id, {
      expectedRevision: archiveReplacement.revision,
      expectedCredentialIncarnation: archiveOriginal.credentialIncarnation!,
    }), AgentRevisionConflictError);
    assert.equal(store.getAgent(archiveReplacement.id).lifecycle, 'active');

    const restoreOriginal = store.createAgent(input('agent_restore_fence'));
    const archivedOriginal = store.archiveAgent(restoreOriginal.id, {
      expectedRevision: restoreOriginal.revision,
      expectedCredentialIncarnation: restoreOriginal.credentialIncarnation!,
    });
    assert.equal(store.deleteAgent(
      archivedOriginal.id,
      archivedOriginal.revision,
      archivedOriginal.credentialIncarnation,
    ), true);
    const restoreReplacement = store.createAgent(input(restoreOriginal.id));
    const archivedReplacement = store.archiveAgent(restoreReplacement.id, {
      expectedRevision: restoreReplacement.revision,
      expectedCredentialIncarnation: restoreReplacement.credentialIncarnation!,
    });
    assert.equal(archivedReplacement.revision, archivedOriginal.revision);
    assert.throws(() => store.restoreAgent(
      archivedReplacement.id,
      archivedReplacement.revision,
      archivedOriginal.credentialIncarnation,
    ), AgentRevisionConflictError);
    assert.equal(store.getAgent(archivedReplacement.id).lifecycle, 'archived');
  } finally {
    db.close();
  }
});

test('stale OAuth refresh failures cannot demote replacement credential generations', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, { agents: [] });
    const created = store.createAgent({
      id: 'agent_oauth_demotion_fence',
      name: 'OAuth demotion fence',
      instructions: 'Keep stale refresh failures on their retired generation.',
      enabled: true,
      skills: [],
      mcpServers: [mcp({ authMode: 'oauth', lifecycleStatus: 'ready' })],
      apiConnections: [api({
        authMode: 'oauth',
        oauthProvider: 'google',
        oauthScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        oauthAppType: 'external',
        lifecycleStatus: 'ready',
      })],
      repositories: [],
    });
    const oldMcp = boundMcpCredentialRef(created.id, created.mcpServers[0]!);
    const oldApi = boundApiCredentialRef(created.id, created.apiConnections[0]!);
    assert.equal(store.markOAuthReauthorizationRequired({
      lane: 'api',
      agentId: oldApi.agentId,
      connectionId: oldApi.connectionId,
      credentialRef: oldApi.credentialRef,
      provider: 'google',
      expectedRevision: created.revision + 1,
    }), false);
    assert.equal(store.getAgent(created.id).apiConnections[0]?.lifecycleStatus, 'ready');
    const replacement = store.updateAgent(created.id, {
      mcpServers: created.mcpServers,
      apiConnections: created.apiConnections,
      credentialResets: { mcp: [oldMcp.connectionId], api: [oldApi.connectionId] },
    }, created.revision);
    assert.notEqual(replacement.mcpServers[0]?.credentialRef, oldMcp.credentialRef);
    assert.notEqual(replacement.apiConnections[0]?.credentialRef, oldApi.credentialRef);

    assert.equal(store.markOAuthReauthorizationRequired({
      lane: 'mcp',
      agentId: oldMcp.agentId,
      connectionId: oldMcp.connectionId,
      credentialRef: oldMcp.credentialRef,
      serverUrl: created.mcpServers[0]!.url,
    }), false);
    assert.equal(store.markOAuthReauthorizationRequired({
      lane: 'api',
      agentId: oldApi.agentId,
      connectionId: oldApi.connectionId,
      credentialRef: oldApi.credentialRef,
      provider: 'google',
    }), false);
    const current = store.getAgent(created.id);
    assert.equal(current.mcpServers[0]?.lifecycleStatus, 'ready');
    assert.equal(current.apiConnections[0]?.lifecycleStatus, 'ready');
  } finally {
    db.close();
  }
});

test('a stored key marks only its own pending credential incarnation ready', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, { agents: [] });
    const created = store.createAgent({
      id: 'agent_key_ready_fence',
      name: 'Key ready fence',
      instructions: 'Mark a connection ready only for the key that was stored.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [
        api({ lifecycleStatus: 'pending', statusText: 'Setup required' }),
        api({
          id: 'calendar', displayName: 'Calendar', authMode: 'oauth', oauthProvider: 'google',
          oauthScopes: ['https://www.googleapis.com/auth/calendar.readonly'], oauthAppType: 'external',
          lifecycleStatus: 'pending', statusText: 'Not connected',
        }),
      ],
      repositories: [],
    });
    const [stale, oauth] = created.apiConnections.map((connection) => boundApiCredentialRef(created.id, connection));
    assert.equal(store.markApiCredentialReady(oauth!), false, 'an OAuth connection is ready only after sign-in');
    const repointed = store.updateAgent(created.id, {
      apiConnections: [{ ...created.apiConnections[0]!, allowedHosts: ['api.other.example'] }, created.apiConnections[1]!],
    }, created.revision);
    assert.equal(store.markApiCredentialReady(stale!), false, 'a key stored before a re-point readies nothing');
    assert.deepEqual(store.getAgent(created.id), repointed);

    const current = boundApiCredentialRef(created.id, repointed.apiConnections[0]!);
    assert.equal(store.markApiCredentialReady(current), true);
    const ready = store.getAgent(created.id);
    assert.equal(ready.revision, repointed.revision + 1);
    assert.deepEqual(
      [ready.apiConnections[0]?.lifecycleStatus, ready.apiConnections[0]?.statusText, ready.apiConnections[0]?.readyRevision],
      ['ready', 'Connected', ready.revision],
    );
    assert.equal(store.markApiCredentialReady(current), false, 'a ready connection is not marked again');
    assert.equal(store.getAgent(created.id).revision, ready.revision);
  } finally {
    db.close();
  }
});

test('same-policy replacement cannot revive an environment credential from the prior incarnation', async () => {
  const oldMcp = mcp({ credentialRef: 'connection_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  const newMcp = mcp({ credentialRef: 'connection_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  const oldApi = api({ credentialRef: 'connection_cccccccccccccccccccccccccccccccc' });
  const newApi = api({ credentialRef: 'connection_dddddddddddddddddddddddddddddddd' });
  const oldMcpRef = boundMcpCredentialRef('agent_binding', oldMcp);
  const newMcpRef = boundMcpCredentialRef('agent_binding', newMcp);
  const oldApiRef = boundApiCredentialRef('agent_binding', oldApi);
  const newApiRef = boundApiCredentialRef('agent_binding', newApi);
  const settings = new SqliteSettingsStore(':memory:');
  try {
    assert.notEqual(oldMcpRef.credentialBinding, newMcpRef.credentialBinding);
    assert.notEqual(oldApiRef.credentialBinding, newApiRef.credentialBinding);
    await withEnv({
      [mcpBearerEnvVar(oldMcpRef)]: 'old-mcp-environment-secret',
      [mcpCredentialBindingEnvVar(oldMcpRef)]: oldMcpRef.credentialBinding,
      [connectorCredentialEnvVar(oldApiRef)]: 'old-api-environment-secret',
      [connectorCredentialBindingEnvVar(oldApiRef)]: oldApiRef.credentialBinding,
    }, async () => {
      assert.equal(
        (await resolveMcpSecrets(oldMcpRef, [], undefined, settings)).bearer,
        'old-mcp-environment-secret',
      );
      assert.equal(
        await resolveConnectorCredential(oldApiRef, undefined, settings),
        'old-api-environment-secret',
      );
      assert.equal(
        (await resolveMcpSecrets(newMcpRef, [], undefined, settings)).bearer,
        undefined,
      );
      assert.equal(
        await resolveConnectorCredential(newApiRef, undefined, settings),
        undefined,
      );
    });
  } finally {
    settings.close();
  }
});
