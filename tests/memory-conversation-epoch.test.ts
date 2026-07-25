import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteMemoryStateStore } from '../src/memory/store.ts';
import { assembleSlackPrompt } from '../src/slack/web-client-context.ts';
import { sandboxThreadKey } from '../src/sandbox/thread-key.ts';
import {
  baseSlackThreadKey,
  memoryEpochThreadKey,
  parseSlackThreadKey,
} from '../src/slack/thread-key.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

test('selection changes rotate agent transcripts while operational parsing stays on the base thread', async () => {
  const store = new SqliteMemoryStateStore(':memory:', () => 1_000);
  try {
    const first = await store.resolveConversationContext({
      baseConversationKey: 'T:C:100.1', scopeSignature: 'public',
      selectionFingerprint: 'one', selected: [{ entryId: 'mem_1', version: 1 }],
      expiresAt: 2_000,
    });
    const unchanged = await store.resolveConversationContext({
      baseConversationKey: 'T:C:100.1', scopeSignature: 'public',
      selectionFingerprint: 'one', selected: [{ entryId: 'mem_1', version: 1 }],
      expiresAt: 2_000,
    });
    const rotated = await store.resolveConversationContext({
      baseConversationKey: 'T:C:100.1', scopeSignature: 'public',
      selectionFingerprint: 'two', selected: [{ entryId: 'mem_1', version: 2 }],
      expiresAt: 2_000,
    });
    assert.equal(first.inject, true);
    assert.equal(unchanged.inject, false);
    assert.equal(rotated.inject, true);
    assert.equal(memoryEpochThreadKey('T:C:100.1', first.epoch), 'T:C:100.1:memory-e1');
    assert.equal(memoryEpochThreadKey('T:C:100.1', rotated.epoch), 'T:C:100.1:memory-e2');
    assert.equal(baseSlackThreadKey('T:C:100.1:memory-e2'), 'T:C:100.1');
    assert.equal(
      baseSlackThreadKey('T:C:100.1:memory-e2'),
      baseSlackThreadKey('T:C:100.1:memory-e1'),
      'memory transcript epochs must share the frozen profile snapshot key',
    );
    assert.equal(
      sandboxThreadKey('T:C:100.1:memory-e2'),
      'T:C:100.1',
      'memory transcript epochs must share the prepared base-thread sandbox',
    );
    assert.deepEqual(parseSlackThreadKey('T:C:100.1:memory-e2'), {
      workspaceId: 'T', channelId: 'C', threadTs: '100.1',
    });
  } finally {
    store.close();
  }
});

test('prompt assembly omits the trigger from history and places advisory memory before the current request', () => {
  const turn: NormalizedSlackTurn = {
    workspaceId: 'T', channelId: 'C', eventId: 'E', text: 'Current question', userId: 'U',
    messageTs: '2.0', threadTs: '1.0', source: 'implicit_thread_reply', contextMode: 'thread',
  };
  const prompt = assembleSlackPrompt(
    turn,
    {
      mode: 'thread', truncated: false, degradations: [],
      messages: [
        { userId: 'U2', text: 'Earlier context', ts: '1.5', isTrigger: false },
        { userId: 'U', text: 'Current question', ts: '2.0', isTrigger: true },
      ],
    },
    { memoryBlock: 'ADVISORY MEMORY' },
  );
  assert.equal(prompt.match(/Current question/g)?.length, 1);
  assert.ok(prompt.indexOf('Earlier context') < prompt.indexOf('ADVISORY MEMORY'));
  assert.ok(prompt.indexOf('ADVISORY MEMORY') < prompt.indexOf('Current Slack request'));
  assert.ok(prompt.endsWith('Current question'));
});
