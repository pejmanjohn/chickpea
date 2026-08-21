import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  autonomousMemoryInstruction,
  createAutonomousAgentMemoryTool,
  saveAutonomousMemory,
} from '../src/memory/autonomous.ts';
import { parseMemoryCommand } from '../src/memory/commands.ts';
import { MemoryStoreLogic, SqliteMemoryStateStore } from '../src/memory/store.ts';
import { MemoryStateError } from '../src/memory/types.ts';
import { renderMemoryContent } from '../src/memory/validation.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const coordinates = {
  surface: 'channel_thread' as const,
  workspaceId: 'T_MEMORY',
  channelId: 'C_ONE',
  threadTs: '1800000000.000100',
  messageTs: '1800000000.000200',
  agentId: 'agent_support',
  slackUserId: 'U_MEMBER',
};

test('one Agent memory body is shared independently of Slack conversation coordinates', async () => {
  const store = new SqliteMemoryStateStore(':memory:');
  try {
    assert.deepEqual(await store.getAgentMemory('agent_support'), {
      agentId: 'agent_support',
      body: '',
      revision: 0,
    });
    const first = await store.putAgentMemory({
      agentId: 'agent_support',
      body: 'Escalate billing refunds to Pejman.',
      expectedRevision: 0,
    });
    assert.equal(first.revision, 1);
    assert.equal(
      (await store.getAgentMemory('agent_support')).body,
      'Escalate billing refunds to Pejman.',
    );
    assert.equal((await store.getAgentMemory('agent_other')).body, '');
  } finally {
    store.close();
  }
});

test('Slack commands expose exactly one Agent memory and reject obsolete multi-memory operations', () => {
  assert.deepEqual(parseMemoryCommand('!memory'), { kind: 'list' });
  assert.deepEqual(parseMemoryCommand('what do you remember?'), { kind: 'list' });
  assert.deepEqual(parseMemoryCommand('!memory show memory'), { kind: 'show', target: 'memory' });
  assert.deepEqual(parseMemoryCommand('!forget memory'), { kind: 'clear_request' });
  assert.deepEqual(parseMemoryCommand('!memory merge one two as three — old model'), {
    kind: 'invalid',
    hint: 'Use `!memory help` to see the exact memory commands.',
  });
  assert.deepEqual(parseMemoryCommand('!memory report memory stale'), {
    kind: 'invalid',
    hint: 'Use `!memory help` to see the exact memory commands.',
  });
});

test('single-memory rendering preserves a distinct description and avoids duplicate one-line content', () => {
  assert.equal(renderMemoryContent({
    description: 'Use the release checklist.',
    body: 'Run focused tests before release.',
  }), 'Use the release checklist.\n\nRun focused tests before release.');
  assert.equal(renderMemoryContent({
    description: 'Use concise replies.',
    body: 'Use concise replies.',
  }), 'Use concise replies.');
});

test('Agent memory uses optimistic concurrency and a bounded current body', async () => {
  const store = new SqliteMemoryStateStore(':memory:');
  try {
    await store.putAgentMemory({ agentId: 'agent_support', body: 'One', expectedRevision: 0 });
    await assert.rejects(
      store.putAgentMemory({ agentId: 'agent_support', body: 'Stale', expectedRevision: 0 }),
      (error: unknown) => error instanceof MemoryStateError &&
        error.code === 'memory_version_conflict',
    );
    await assert.rejects(
      store.putAgentMemory({
        agentId: 'agent_support',
        body: 'x'.repeat(64 * 1_024 + 1),
        expectedRevision: 1,
      }),
      (error: unknown) => error instanceof MemoryStateError &&
        error.code === 'memory_entry_too_large',
    );
  } finally {
    store.close();
  }
});

test('Agent memory retries are idempotent and reject key reuse for another write', async () => {
  const store = new SqliteMemoryStateStore(':memory:');
  try {
    const input = {
      agentId: 'agent_support',
      body: 'Remember the Acme escalation policy.',
      expectedRevision: 0,
      idempotencyKey: 'slack-memory:Ev123',
      idempotencyDigest: 'digest-one',
    };
    assert.equal((await store.putAgentMemory(input)).revision, 1);
    assert.deepEqual(await store.putAgentMemory(input), {
      agentId: 'agent_support',
      body: input.body,
      revision: 1,
    });
    await assert.rejects(
      store.putAgentMemory({
        ...input,
        body: 'A different mutation',
        idempotencyDigest: 'digest-two',
      }),
      (error: unknown) => error instanceof MemoryStateError &&
        error.code === 'memory_idempotency_conflict',
    );
  } finally {
    store.close();
  }
});

test('Agent memory bounds retained idempotency receipts per Agent', () => {
  const db = openStateDb(':memory:');
  const store = new MemoryStoreLogic(db);
  try {
    for (let revision = 0; revision < 1_030; revision += 1) {
      store.putAgentMemory({
        agentId: 'agent_support',
        body: `Revision ${revision + 1}`,
        expectedRevision: revision,
        idempotencyKey: `slack-memory:Ev${revision}`,
        idempotencyDigest: `digest-${revision}`,
      });
    }
    assert.equal(Number(db.get(
      'SELECT COUNT(*) AS count FROM agent_memory_mutation_receipts WHERE agent_id = ?',
      'agent_support',
    )?.count), 1_024);
  } finally {
    db.close();
  }
});

test('authorized autonomous writes append durable context to the same Agent body', async () => {
  const store = new SqliteMemoryStateStore(':memory:');
  try {
    const first = await saveAutonomousMemory(coordinates, {
      name: 'Support voice',
      description: 'Use concise replies.',
      type: 'preference',
      body: 'Use concise replies.',
    }, { state: store, authorize: async () => true });
    const second = await saveAutonomousMemory({
      ...coordinates,
      channelId: 'D_MEMBER',
      surface: 'direct_message',
    }, {
      name: 'Escalation rule',
      description: 'Escalate refunds.',
      type: 'decision',
      body: 'Escalate refunds over $100.',
    }, { state: store, authorize: async () => true });

    assert.equal(first.entry.version, 1);
    assert.equal(second.entry.version, 2);
    const memory = await store.getAgentMemory('agent_support');
    assert.match(memory.body, /## Support voice/);
    assert.match(memory.body, /## Escalation rule/);
    assert.doesNotMatch(memory.body, /C_ONE|D_MEMBER|U_MEMBER|timestamp|source/i);
  } finally {
    store.close();
  }
});

test('an autonomous memory retry produces one durable revision', async () => {
  const store = new SqliteMemoryStateStore(':memory:');
  const memory = {
    name: 'Support voice',
    description: 'Use concise replies.',
    type: 'preference' as const,
    body: 'Use concise replies.',
  };
  try {
    await saveAutonomousMemory(coordinates, memory, {
      state: store,
      authorize: async () => true,
    });
    const retried = await saveAutonomousMemory(coordinates, memory, {
      state: store,
      authorize: async () => true,
    });
    assert.equal(retried.entry.version, 1);
    assert.equal((await store.getAgentMemory('agent_support')).revision, 1);
  } finally {
    store.close();
  }
});

test('autonomous memory fails closed when the actor is not authorized', async () => {
  const store = new SqliteMemoryStateStore(':memory:');
  try {
    await assert.rejects(
      saveAutonomousMemory(coordinates, {
        name: 'Denied',
        description: 'Should not save.',
        type: 'fact',
        body: 'Should not save.',
      }, { state: store, authorize: async () => false }),
      (error: unknown) => error instanceof MemoryStateError &&
        error.code === 'memory_actor_forbidden',
    );
    assert.equal((await store.getAgentMemory('agent_support')).revision, 0);
  } finally {
    store.close();
  }
});

test('the model-facing memory tool explains silent durable writes without expanding authority', async () => {
  const instruction = autonomousMemoryInstruction();
  assert.match(instruction, /follows this Agent wherever it works/i);
  assert.match(instruction, /never save secrets/i);
  assert.match(instruction, /only save claims the current user directly states or approves/i);
  const tool = createAutonomousAgentMemoryTool(async () => ({
    slug: 'memory',
    version: 3,
  }));
  assert.deepEqual(await tool.run({
    data: {
      name: 'Preference',
      description: 'Use bullets.',
      type: 'preference',
      body: 'Use bullets.',
    },
  }), { output: 'Saved Agent memory `memory` (v3).' });
});
