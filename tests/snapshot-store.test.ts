import assert from 'node:assert/strict';
import test from 'node:test';

import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import {
  getOrReplaceSnapshotForRoute,
  snapshotFromEffectiveConfig,
  SqliteAgentSnapshotStore,
} from '../src/config/snapshot-store.ts';
import type { AgentModelAttribution, AgentSnapshotV2 } from '../src/config/types.ts';

function config(model: string, modelAttribution: AgentModelAttribution): EffectiveSlackConfig {
  return {
    workspaceId: 'T_SNAPSHOT',
    channelId: 'D_SNAPSHOT',
    agentId: 'agent_support',
    agent: {
      id: 'agent_support',
      kind: 'user',
      revision: 3,
      configurationGeneration: 3,
      name: 'Support',
      instructions: 'Help.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    },
    model,
    provider: modelAttribution.providerId,
    modelAttribution,
    instructions: 'Help.',
    instructionLayers: [],
  };
}

test('a Workspace-default change replaces the next route snapshot but keeps same-revision retries', async () => {
  const store = new SqliteAgentSnapshotStore(':memory:');
  try {
    const firstAttribution: AgentModelAttribution = {
      source: 'workspace_default',
      providerId: 'openai',
      workspaceDefaultRevision: 4,
    };
    const first = await getOrReplaceSnapshotForRoute(
      store,
      'T_SNAPSHOT:D_SNAPSHOT:dm',
      { agentId: 'agent_support', agentGeneration: 3, modelAttribution: firstAttribution },
      () => config('openai/gpt-5.6', firstAttribution),
      () => 100,
    );
    const retry = await getOrReplaceSnapshotForRoute(
      store,
      'T_SNAPSHOT:D_SNAPSHOT:dm',
      { agentId: 'agent_support', agentGeneration: 3, modelAttribution: firstAttribution },
      () => { throw new Error('same admitted policy must reuse its snapshot'); },
      () => 101,
    );
    assert.equal(retry.snapshotHash, first.snapshotHash);

    const changedAttribution: AgentModelAttribution = {
      source: 'workspace_default',
      providerId: 'anthropic',
      workspaceDefaultRevision: 5,
    };
    const changed = await getOrReplaceSnapshotForRoute(
      store,
      'T_SNAPSHOT:D_SNAPSHOT:dm',
      { agentId: 'agent_support', agentGeneration: 3, modelAttribution: changedAttribution },
      () => config('anthropic/claude-sonnet-4-6', changedAttribution),
      () => 102,
    );
    assert.equal(changed.schemaVersion, 3);
    assert.equal(changed.model, 'anthropic/claude-sonnet-4-6');
    assert.equal(changed.modelAttribution?.workspaceDefaultRevision, 5);
    assert.notEqual(changed.snapshotHash, first.snapshotHash);
  } finally {
    store.close();
  }
});

test('a pinned Agent snapshot does not rotate with unrelated Workspace-default changes', async () => {
  const store = new SqliteAgentSnapshotStore(':memory:');
  try {
    const pinned: AgentModelAttribution = { source: 'pinned', providerId: 'anthropic' };
    const first = await getOrReplaceSnapshotForRoute(
      store,
      'T_SNAPSHOT:D_SNAPSHOT:pinned',
      { agentId: 'agent_support', agentGeneration: 3, modelAttribution: pinned },
      () => config('anthropic/claude-sonnet-4-6', pinned),
    );
    const afterDefaultChange = await getOrReplaceSnapshotForRoute(
      store,
      'T_SNAPSHOT:D_SNAPSHOT:pinned',
      { agentId: 'agent_support', agentGeneration: 3, modelAttribution: pinned },
      () => { throw new Error('pinned policy did not change'); },
    );
    assert.equal(afterDefaultChange.snapshotHash, first.snapshotHash);
  } finally {
    store.close();
  }
});

test('V2 snapshots remain readable and upgrade when model attribution is next resolved', async () => {
  const store = new SqliteAgentSnapshotStore(':memory:');
  try {
    const pinned: AgentModelAttribution = { source: 'pinned', providerId: 'openai' };
    const current = snapshotFromEffectiveConfig(config('openai/gpt-5.6', pinned), 100);
    const { modelAttribution: _attribution, ...legacyFields } = current;
    const legacy = { ...legacyFields, schemaVersion: 2 as const } as AgentSnapshotV2;
    await store.putIfAbsent('T_SNAPSHOT:D_SNAPSHOT:legacy', legacy);
    assert.equal((await store.get('T_SNAPSHOT:D_SNAPSHOT:legacy'))?.schemaVersion, 2);

    const upgraded = await getOrReplaceSnapshotForRoute(
      store,
      'T_SNAPSHOT:D_SNAPSHOT:legacy',
      { agentId: 'agent_support', agentGeneration: 3, modelAttribution: pinned },
      () => config('openai/gpt-5.6', pinned),
      () => 101,
    );
    assert.equal(upgraded.schemaVersion, 3);
    assert.deepEqual(upgraded.modelAttribution, pinned);
  } finally {
    store.close();
  }
});
