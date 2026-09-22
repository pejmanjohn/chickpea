import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryUpdateAcknowledgementText, memoryUpdatePreservesContext } from '../src/memory/acknowledgement.ts';

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

test('preserved context means the next revision keeps every previous line verbatim', () => {
  const before = memory('Private canary: BLUEBIRD.\nKeep links.', 4);
  assert.equal(memoryUpdatePreservesContext(before, memory(`${before.body}\nUse dates.`, 5)), true);
  assert.equal(memoryUpdatePreservesContext(before, memory(`Use dates.\n${before.body}`, 5)), true);
  assert.equal(memoryUpdatePreservesContext(memory('', 0), memory('Use dates.', 1)), true);
  // The store advances the revision even when the body is written back unchanged.
  assert.equal(memoryUpdatePreservesContext(before, memory(before.body, 5)), true);
  assert.equal(memoryUpdateAcknowledgementText(before, memory(before.body, 5), 'I kept it.'), 'I updated my memory.',
    'an unchanged body stays context-safe but earns no model summary');
  for (const after of [memory('Keep links.', 5), memory('Private canary: GREENBIRD.\nKeep links.', 5),
    memory('Keep links.\nPrivate canary: BLUEBIRD.', 5), memory(before.body, 6), memory(before.body, 4), memory('', 5),
    memory(`${before.body}\nUse dates.`, 6), memory(`${before.body}\nUse dates.`, 4)]) {
    assert.equal(memoryUpdatePreservesContext(before, after), false, `${after.body}@${after.revision}`);
  }
});
