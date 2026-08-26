import assert from 'node:assert/strict';
import test from 'node:test';

import { promiseBackedStatePort } from '../src/config/local-state-port.ts';

test('promise-backed state ports preserve receiver binding and return promises', async () => {
  const port = promiseBackedStatePort({
    prefix: 'state',
    read(this: { prefix: string }, suffix: string) {
      return `${this.prefix}:${suffix}`;
    },
  });

  const pending = port.read('ok');
  assert.equal(typeof (pending as unknown as Promise<string>).then, 'function');
  assert.equal(await pending, 'state:ok');
});

test('promise-backed state ports turn synchronous failures into rejections', async () => {
  const port = promiseBackedStatePort({
    fail() {
      throw new Error('state failure');
    },
  });

  const pending = port.fail();
  await assert.rejects(pending as unknown as Promise<never>, /state failure/);
});
