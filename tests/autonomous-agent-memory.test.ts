import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUTONOMOUS_MEMORY_RESULT_DATA_NAME,
  AutonomousMemoryResultSchema,
  autonomousMemoryInstruction,
  autonomousMemoryResultText,
  createAutonomousAgentMemoryTool,
  saveAutonomousMemory,
  type AutonomousMemoryInput,
} from '../src/memory/autonomous.ts';
import { SqliteMemoryStateStore } from '../src/memory/store.ts';
import { MemoryStateError } from '../src/memory/types.ts';

const coordinates = {
  surface: 'direct_message' as const,
  workspaceId: 'T_AUTO',
  channelId: 'D_AUTO',
  threadTs: '1783000000.000100',
  messageTs: '1783000000.000200',
  agentId: 'agent_default',
  slackUserId: 'U_OWNER',
};

const durableFact = {
  name: 'Release approval convention',
  description: 'Pejman approves production releases.',
  type: 'preference' as const,
  body: 'Wait for Pejman to explicitly approve every production release.',
};

test('the autonomous memory tool saves one durable Agent memory and acknowledges it', async () => {
  const saved: AutonomousMemoryInput[] = [];
  const tool = createAutonomousAgentMemoryTool('agent', async (input) => {
    saved.push(input);
    return { slug: 'release-approval-convention', version: 1 };
  });

  const result = await tool.run({ data: durableFact });
  assert.equal(tool.name, 'remember_memory');
  assert.deepEqual(saved, [durableFact]);
  assert.deepEqual(result, {
    output: 'Saved Agent memory `release-approval-convention` (v1).',
  });
  const instruction = autonomousMemoryInstruction('agent');
  assert.match(instruction, /durable, reusable context/i);
  assert.match(instruction, /explicitly asks[^.]*any wording/i);
  assert.match(instruction, /infer the intent semantically/i);
  assert.match(instruction, /never save secrets/i);
  assert.match(instruction, /claim something was remembered only when.*begins with "Saved"/i);
  assert.match(instruction, /"Memory was not saved".*do not claim/i);
  assert.match(instruction, /at most once for the current request/i);
});

test('the autonomous memory tool reports an expected denied write without claiming success', async () => {
  const terminal: unknown[] = [];
  const tool = createAutonomousAgentMemoryTool('agent', async () => {
    throw new MemoryStateError(
      'memory_actor_forbidden',
      'Only an active workspace member currently permitted to use this Agent can change its memory.',
    );
  }, {
    finishDenied: (result) => terminal.push(result),
  });

  assert.deepEqual(await tool.run({ data: durableFact }), {
    output: 'Memory was not saved: Only an active workspace member currently permitted to use this Agent can change its memory.',
    terminate: true,
  });
  assert.equal(AUTONOMOUS_MEMORY_RESULT_DATA_NAME, 'autonomousMemoryResult');
  assert.deepEqual(terminal, [{
    outcome: 'not_saved',
    text: 'Memory was not saved: Only an active workspace member currently permitted to use this Agent can change its memory.',
  }]);
  assert.equal(
    autonomousMemoryResultText(terminal),
    'Memory was not saved: Only an active workspace member currently permitted to use this Agent can change its memory.',
  );
  assert.equal(autonomousMemoryResultText([{ outcome: 'saved', text: 'false claim' }]), undefined);
  assert.ok(AutonomousMemoryResultSchema);
});

test('the autonomous memory tool preserves unexpected memory and infrastructure failures', async () => {
  const domainFailure = createAutonomousAgentMemoryTool('agent', async () => {
    throw new MemoryStateError('memory_rate_limited', 'Too many memory changes; try again later.');
  });
  const infrastructureFailure = createAutonomousAgentMemoryTool('agent', async () => {
    throw new Error('state backend unavailable');
  });

  await assert.rejects(domainFailure.run({ data: durableFact }), /Too many memory changes/);
  await assert.rejects(infrastructureFailure.run({ data: durableFact }), /state backend unavailable/);
});

test('the autonomous memory tool reports a real authorization denial without creating state', async () => {
  const memory = new SqliteMemoryStateStore(':memory:');
  try {
    const tool = createAutonomousAgentMemoryTool('agent', async (input) => {
      const { entry } = await saveAutonomousMemory(coordinates, input, {
        state: memory,
        authorize: async () => false,
      });
      return { slug: entry.slug, version: entry.version };
    });

    assert.deepEqual(await tool.run({ data: durableFact }), {
      output: 'Memory was not saved: Only an active workspace member currently permitted to use this Agent can change its memory.',
    });
    assert.deepEqual(await memory.listOwners(coordinates.workspaceId), []);
  } finally {
    memory.close();
  }
});

test('semantic retry identity is request-bound rather than model-wording-bound', async () => {
  const memory = new SqliteMemoryStateStore(':memory:', () => 1_783_000_000_000);
  let nextId = 0;
  try {
    const dependencies = {
      state: memory,
      authorize: async () => true,
      id: () => `mem_request_${++nextId}`,
    };
    await saveAutonomousMemory(coordinates, durableFact, dependencies);
    await assert.rejects(
      saveAutonomousMemory(coordinates, {
        ...durableFact,
        description: 'A retry paraphrased the same request.',
      }, dependencies),
      /idempotency key was already used for different memory content/i,
    );
    const later = await saveAutonomousMemory({
      ...coordinates,
      messageTs: '1783000001.000100',
    }, durableFact, dependencies);

    assert.equal(later.entry.entryId, 'mem_request_3');
  } finally {
    memory.close();
  }
});

test('autonomous Agent memory is owner-authorized, durable, and idempotent', async () => {
  const memory = new SqliteMemoryStateStore(':memory:', () => 1_783_000_000_000);
  try {
    const dependencies = {
      state: memory,
      authorize: async () => true,
      id: () => 'mem_autonomous',
    };
    const first = await saveAutonomousMemory(coordinates, durableFact, dependencies);
    const replay = await saveAutonomousMemory(coordinates, durableFact, dependencies);
    const owner = await memory.ensureOwner({
      workspaceId: coordinates.workspaceId,
      ownerKind: 'agent',
      ownerId: coordinates.agentId,
    });
    const entries = await memory.listOwnerEntries(owner);

    assert.equal(first.entry.entryId, 'mem_autonomous');
    assert.equal(replay.entry.entryId, first.entry.entryId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.actorClass, 'system');
    assert.deepEqual(entries[0]?.writeOrigin, { kind: 'slack_dm', channelId: 'dm' });
  } finally {
    memory.close();
  }
});

test('semantic channel memory writes to the same Agent memory used in DMs', async () => {
  const memory = new SqliteMemoryStateStore(':memory:', () => 1_783_000_000_000);
  const channelCoordinates = {
    ...coordinates,
    surface: 'channel_thread' as const,
    channelId: 'C_AUTO',
  };
  try {
    const saved = await saveAutonomousMemory(channelCoordinates, durableFact, {
      state: memory,
      authorize: async () => true,
      id: () => 'mem_channel_autonomous',
    });
    const channelOwner = await memory.ensureOwner({
      workspaceId: coordinates.workspaceId,
      ownerKind: 'channel',
      ownerId: channelCoordinates.channelId,
    });
    const agentOwner = await memory.ensureOwner({
      workspaceId: coordinates.workspaceId,
      ownerKind: 'agent',
      ownerId: coordinates.agentId,
    });

    assert.equal(saved.entry.ownerKind, 'agent');
    assert.equal((await memory.listOwnerEntries(channelOwner)).length, 0);
    assert.equal((await memory.listOwnerEntries(agentOwner)).length, 1);
    assert.deepEqual(saved.entry.writeOrigin, { kind: 'admin' });
    assert.match(autonomousMemoryInstruction('channel'), /Agent memory/i);
  } finally {
    memory.close();
  }
});

test('autonomous Agent memory rejects a DM actor who is not an active permitted member', async () => {
  const memory = new SqliteMemoryStateStore(':memory:');
  try {
    await assert.rejects(
      saveAutonomousMemory(coordinates, durableFact, {
        state: memory,
        authorize: async () => false,
      }),
      /Only an active workspace member currently permitted to use this Agent can change its memory/,
    );
    assert.deepEqual(await memory.listOwners(coordinates.workspaceId), []);
  } finally {
    memory.close();
  }
});
