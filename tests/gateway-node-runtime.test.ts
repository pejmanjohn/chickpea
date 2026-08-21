import assert from 'node:assert/strict';
import test from 'node:test';

import {
  startNodeGatewaySession,
  stopNodeGatewaySession,
} from '../src/slack/gateway/node-runtime.ts';

test('Node gateway startup retries after an initial state read failure', async () => {
  stopNodeGatewaySession();
  let reads = 0;
  let starts = 0;
  let stopped = 0;
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const dependencies = {
    isCloudflare: () => false,
    readBinding: async () => {
      reads += 1;
      if (reads === 1) throw new Error('state temporarily unavailable');
      return '{"bindingId":"binding_test"}';
    },
    createRunner: () => ({
      start: async () => {
        starts += 1;
        return true;
      },
      stop: () => { stopped += 1; },
    }),
    setTimer: ((callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
    onError: () => {},
  };
  try {
    startNodeGatewaySession(undefined, dependencies);
    await spin();
    assert.equal(reads, 1);
    assert.equal(timers[0]?.delay, 5_000);
    timers[0]!.callback();
    await spin();
    assert.equal(reads, 2);
    assert.equal(starts, 1);
  } finally {
    stopNodeGatewaySession();
  }
  assert.equal(stopped, 1);
});

async function spin(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
