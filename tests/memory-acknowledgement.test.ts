import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryUpdateAcknowledgementText } from '../src/memory/acknowledgement.ts';

const summary = 'I updated my memory to use human-friendly dates and times going forward.';
const memory = (body: string, revision: number) => ({ agentId: 'a', body, revision });

test('a confirmed addition describes the change without releasing the full memory', () => {
  assert.equal(memoryUpdateAcknowledgementText(memory('', 0), memory('Use readable dates.', 1), summary), summary);
  assert.equal(memoryUpdateAcknowledgementText(memory('Use short replies.\nKeep links.', 4),
    memory('Use short replies.\nUse readable dates.\nKeep links.', 5), summary), summary);
  assert.equal(memoryUpdateAcknowledgementText(memory('', 0), memory('Use readable dates.', 1)), 'I updated my memory.');
});

test('forgetting, rewriting, no-ops and intervening revisions cannot disclose a model summary', () => {
  const before = memory('Private canary: BLUEBIRD.\nKeep links.', 4);
  for (const after of [memory('Keep links.', 5), memory('Private canary: GREENBIRD.\nKeep links.', 5),
    memory(before.body, 5), memory(`${before.body}\nUse dates.`, 6), memory(`${before.body}\nUse dates.`, 4)]) {
    assert.equal(memoryUpdateAcknowledgementText(before, after, 'I forgot BLUEBIRD.'), 'I updated my memory.');
  }
  assert.equal(memoryUpdateAcknowledgementText(before, memory('', 5), 'I forgot BLUEBIRD.'), 'I cleared my saved memory.');
  assert.equal(memoryUpdateAcknowledgementText(before, memory(' \n', 5), 'I forgot BLUEBIRD.'), 'I cleared my saved memory.');
});
