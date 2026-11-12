import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConversationOrder } from '../src/state/conversation-order.ts';

// Defects caught: an entry of a key admitted before an earlier one of the
// same key releases, another key held behind it, a release that lets two
// later entries in at once, and keys kept after their last entry.
test("one key's entries go one at a time in arrival order; other keys do not wait", async () => {
  const order = new ConversationOrder();
  const entered: string[] = [];
  const enter = async (key: string, name: string) => {
    const release = await order.enter(key);
    entered.push(name);
    return release;
  };
  const first = await enter('C1:1', 'first');
  const second = enter('C1:1', 'second');
  const third = enter('C1:1', 'third');
  const other = await enter('C1:2', 'other');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, ['first', 'other'], 'the same key waits; another key does not');

  first();
  first();
  const releaseSecond = await second;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, ['first', 'other', 'second'], 'a release lets the next entry in, and only it');

  releaseSecond();
  (await third)();
  other();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(order.size, 0, 'no key is kept once its entries released');
});
