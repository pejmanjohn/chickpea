import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMemoryCommand } from '../src/memory/commands.ts';
import { MemoryStoreLogic, SqliteMemoryStateStore } from '../src/memory/store.ts';
import { MemoryStateError } from '../src/memory/types.ts';
import { renderMemoryContent } from '../src/memory/validation.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

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
  assert.equal(parseMemoryCommand('What do you remember?'), undefined);
  assert.equal(parseMemoryCommand('Remember that Acme renews in October.'), undefined);
  assert.equal(parseMemoryCommand('Please update the memory to say Acme renews in October.'), undefined);
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
  assert.deepEqual(parseMemoryCommand('<@U_CHICKPEA>: !memory list'), { kind: 'candidate' });
  assert.deepEqual(parseMemoryCommand('<@U_CHICKPEA>: !memory list', 'U_CHICKPEA', ''), {
    kind: 'list',
  });
  assert.equal(parseMemoryCommand('<@U_TEAMMATE>: !memory list', 'U_CHICKPEA', ''), undefined);
  assert.deepEqual(
    parseMemoryCommand('<!subteam^S012345|@sprout>: !memory list', '', 'S012345'),
    { kind: 'list' },
  );
  assert.equal(
    parseMemoryCommand('<!subteam^S999999|@oncall>: !memory list', '', 'S012345'),
    undefined,
  );
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
