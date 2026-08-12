import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteMemoryStateStore } from '../src/memory/store.ts';
import { MemoryStoreLogic } from '../src/memory/store.ts';
import { ConfigStoreLogic } from '../src/config/store.ts';
import { AgentStillReferencedError, UnknownAgentError } from '../src/config/errors.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

test('sealed Channel owner rejects runtime writes and remains inspectable', async () => {
  const state = new SqliteMemoryStateStore(':memory:', () => 100);
  try {
    const owner = await state.ensureOwner({
      workspaceId: 'T_TEST', ownerKind: 'channel', ownerId: 'C_ARCHIVED',
    });
    const sealed = await state.sealOwner(owner, {
      reason: 'channel_archived', actorId: 'admin', idempotencyKey: 'seal:C_ARCHIVED',
    });
    assert.equal(sealed.lifecycle, 'sealed');
    assert.deepEqual(await state.listOwnerEntries(sealed), []);
    await assert.rejects(
      () => state.createOwnerEntry({
        entryId: 'mem_sealed', storeId: sealed.storeId, workspaceId: 'T_TEST',
        slug: 'sealed', description: 'No.', type: 'fact', body: 'No.',
        actorId: 'U_MEMBER', actorClass: 'member',
        writeOrigin: { kind: 'slack_channel', channelId: 'C_ARCHIVED' },
        idempotencyKey: 'sealed-write',
      }),
      /sealed/,
    );
  } finally {
    state.close();
  }
});

test('composite Agent delete rechecks blockers, deletes config and Agent memory atomically, and retains Channel memory', () => {
  const db = openStateDb(':memory:');
  const config = new ConfigStoreLogic(db, { agents: [], assignments: [] });
  const memory = new MemoryStoreLogic(db, () => 100);
  const agent = {
    id: 'agent_ops', name: 'Ops', instructions: 'Help.', enabled: true,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
  config.createAgent(agent);
  config.putAssignment({ workspaceId: 'T_TEST', channelId: 'C_ONE', agentId: agent.id });
  const agentOwner = memory.ensureOwner({ workspaceId: 'T_TEST', ownerKind: 'agent', ownerId: agent.id });
  const agentOwnerSecondWorkspace = memory.ensureOwner({
    workspaceId: 'T_OTHER', ownerKind: 'agent', ownerId: agent.id,
  });
  const channelOwner = memory.ensureOwner({ workspaceId: 'T_TEST', ownerKind: 'channel', ownerId: 'C_ONE' });
  memory.createOwnerEntry({
    entryId: 'mem_agent', storeId: agentOwner.storeId, workspaceId: 'T_TEST', slug: 'agent',
    description: 'Agent.', type: 'fact', body: 'Agent memory.', actorId: 'admin',
    actorClass: 'operator', idempotencyKey: 'create-agent-memory',
  });
  memory.createOwnerEntry({
    entryId: 'mem_agent_other', storeId: agentOwnerSecondWorkspace.storeId,
    workspaceId: 'T_OTHER', slug: 'agent-other', description: 'Agent elsewhere.',
    type: 'fact', body: 'Same Agent in another workspace.', actorId: 'admin',
    actorClass: 'operator', idempotencyKey: 'create-agent-memory-other',
  });
  memory.createOwnerEntry({
    entryId: 'mem_channel', storeId: channelOwner.storeId, workspaceId: 'T_TEST', slug: 'channel',
    description: 'Channel.', type: 'fact', body: 'Channel memory.', actorId: 'admin',
    actorClass: 'operator', idempotencyKey: 'create-channel-memory',
  });

  assert.throws(
    () => config.deleteAgentWithMemory(agent.id, 'delete:agent_ops', memory),
    AgentStillReferencedError,
  );
  assert.equal(config.getAgent(agent.id).id, agent.id);
  assert.equal(memory.listOwnerEntries(agentOwner).length, 1);

  config.deleteAssignment('T_TEST', 'C_ONE');
  assert.equal(config.deleteAgentWithMemory(agent.id, 'delete:agent_ops', memory), true);
  assert.throws(() => config.getAgent(agent.id), UnknownAgentError);
  assert.equal(memory.getOwner(agentOwner.storeId), undefined);
  assert.equal(memory.getOwner(agentOwnerSecondWorkspace.storeId), undefined);
  assert.equal(memory.listOwnerEntries(channelOwner).length, 1);
  assert.equal(config.deleteAgentWithMemory(agent.id, 'delete:agent_ops', memory), true);
  db.close();
});

test('composite Agent delete rolls config back when memory deletion fails', () => {
  const db = openStateDb(':memory:');
  const config = new ConfigStoreLogic(db, { agents: [], assignments: [] });
  const memory = new MemoryStoreLogic(db, () => 100);
  config.createAgent({
    id: 'agent_atomic', name: 'Atomic', instructions: 'Help.', enabled: true,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  memory.ensureOwner({ workspaceId: 'T_TEST', ownerKind: 'agent', ownerId: 'agent_atomic' });
  db.exec(
    `CREATE TRIGGER reject_agent_memory_delete BEFORE DELETE ON memory_owners
     BEGIN SELECT RAISE(ABORT, 'memory delete unavailable'); END`,
  );
  assert.throws(
    () => config.deleteAgentWithMemory('agent_atomic', 'delete:atomic', memory),
    /memory delete unavailable/,
  );
  assert.equal(config.getAgent('agent_atomic').id, 'agent_atomic');
  db.close();
});

test('private to public seals private memory and creates a visibility barrier', async () => {
  let now = 100;
  const state = new SqliteMemoryStateStore(':memory:', () => now);
  try {
    const privateState = await state.observeChannelScope({
      workspaceId: 'T_TEST',
      channelId: 'C_CHANNEL',
      privacy: 'private',
      displayName: 'secret-project',
      observedAt: now,
    });
    assert.equal(privateState.privateGeneration, 1);
    assert.ok(privateState.privateStoreId);

    now = 200;
    const publicState = await state.observeChannelScope({
      workspaceId: 'T_TEST',
      channelId: 'C_CHANNEL',
      privacy: 'public',
      displayName: 'launched-project',
      observedAt: now,
    });
    assert.equal(publicState.privacy, 'public');
    assert.equal(publicState.visibilityBarrierAt, 200);
    assert.equal(publicState.privateStoreId, null);
    assert.equal((await state.getStore(privateState.privateStoreId ?? ''))?.lifecycle, 'sealed');
  } finally {
    state.close();
  }
});

test('public to private preserves the frozen public label and starts a new generation', async () => {
  let now = 100;
  const state = new SqliteMemoryStateStore(':memory:', () => now);
  try {
    await state.observeChannelScope({
      workspaceId: 'T_TEST',
      channelId: 'C_CHANNEL',
      privacy: 'public',
      displayName: 'product',
      observedAt: now,
    });
    now = 200;
    const privateState = await state.observeChannelScope({
      workspaceId: 'T_TEST',
      channelId: 'C_CHANNEL',
      privacy: 'private',
      displayName: 'renamed-private',
      observedAt: now,
    });
    assert.equal(privateState.privateGeneration, 1);
    assert.equal(privateState.lastPublicDisplayName, 'product');

    now = 300;
    await state.observeChannelScope({
      workspaceId: 'T_TEST',
      channelId: 'C_CHANNEL',
      privacy: 'public',
      displayName: 'public-again',
      observedAt: now,
    });
    now = 400;
    const secondPrivate = await state.observeChannelScope({
      workspaceId: 'T_TEST',
      channelId: 'C_CHANNEL',
      privacy: 'private',
      displayName: 'private-again',
      observedAt: now,
    });
    assert.equal(secondPrivate.privateGeneration, 2);
    assert.notEqual(secondPrivate.privateStoreId, privateState.privateStoreId);
  } finally {
    state.close();
  }
});

test('retaining a private channel is idempotent, seals its store, audits safely, and reactivation rotates generation', async () => {
  let now = 100;
  const state = new SqliteMemoryStateStore(':memory:', () => now);
  try {
    const active = await state.observeChannelScope({
      workspaceId: 'T_TEST', channelId: 'C_PRIVATE', privacy: 'private',
      displayName: 'secret-project', observedAt: now,
    });
    const oldStoreId = active.privateStoreId;
    assert.ok(oldStoreId);

    now = 200;
    const retained = await state.retainChannelScope({
      workspaceId: 'T_TEST', channelId: 'C_PRIVATE', reason: 'archived', observedAt: now,
    });
    const replay = await state.retainChannelScope({
      workspaceId: 'T_TEST', channelId: 'C_PRIVATE', reason: 'archived', observedAt: now + 1,
    });
    assert.equal(retained.lifecycle, 'retained');
    assert.equal(retained.transitionVersion, 2);
    assert.equal(replay.transitionVersion, 2);
    assert.equal((await state.getStore(oldStoreId))?.lifecycle, 'sealed');
    assert.equal((await state.getStore(oldStoreId))?.sealedReason, 'channel_archived');
    const events = await state.listAuditEvents({ eventType: 'memory.channel_scope_retained' });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.actorId, null);
    assert.equal(events[0]?.reasonCode, 'channel_archived');
    assert.equal(events[0]?.metadataJson, '{}');

    now = 300;
    const reactivated = await state.observeChannelScope({
      workspaceId: 'T_TEST', channelId: 'C_PRIVATE', privacy: 'private',
      displayName: 'secret-project-returned', observedAt: now,
    });
    assert.equal(reactivated.lifecycle, 'active');
    assert.equal(reactivated.transitionVersion, 3);
    assert.equal(reactivated.privateGeneration, 2);
    assert.notEqual(reactivated.privateStoreId, oldStoreId);
    assert.equal((await state.getStore(reactivated.privateStoreId ?? ''))?.lifecycle, 'active');
  } finally {
    state.close();
  }
});
