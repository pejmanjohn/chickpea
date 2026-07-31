import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startWorkChecklistHeartbeat } from '../src/slack/work-checklist-heartbeat.ts';

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

test('work checklist heartbeat waits one minute, serializes updates, and stops cleanly', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let updates = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  let releaseUpdate: (() => void) | undefined;

  const heartbeat = startWorkChecklistHeartbeat({
    intervalMs: 60_000,
    async update() {
      updates += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      concurrent -= 1;
    },
  });

  t.mock.timers.tick(59_999);
  await Promise.resolve();
  assert.equal(updates, 0);

  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(updates, 1);

  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(updates, 1, 'a second heartbeat must wait for the first Slack update');
  assert.equal(maxConcurrent, 1);

  releaseUpdate?.();
  await flushMicrotasks();
  assert.equal(updates, 2);
  releaseUpdate?.();
  await heartbeat.stop();

  t.mock.timers.tick(120_000);
  await Promise.resolve();
  assert.equal(updates, 2, 'stop must cancel future checklist refreshes');
  assert.equal(maxConcurrent, 1);
});

test('work checklist heartbeat reports an update failure and keeps running', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let attempts = 0;
  const errors: unknown[] = [];
  const heartbeat = startWorkChecklistHeartbeat({
    intervalMs: 1_000,
    update() {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary Slack failure');
    },
    onError(error) {
      errors.push(error);
    },
  });

  t.mock.timers.tick(1_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(errors.length, 1);

  t.mock.timers.tick(1_000);
  await Promise.resolve();
  await heartbeat.stop();
  assert.equal(attempts, 2);
});

test('work checklist heartbeat bounds a never-settling drain', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let timedOut = 0;
  const heartbeat = startWorkChecklistHeartbeat({
    intervalMs: 1_000,
    drainTimeoutMs: 500,
    update: () => new Promise<void>(() => {}),
    onDrainTimeout() {
      timedOut += 1;
    },
  });

  t.mock.timers.tick(1_000);
  await Promise.resolve();
  const stopped = heartbeat.stop();
  t.mock.timers.tick(500);

  assert.equal(await stopped, false);
  assert.equal(timedOut, 1);
});

test('work checklist heartbeat can cancel failure cleanup without draining', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let updates = 0;
  const heartbeat = startWorkChecklistHeartbeat({
    intervalMs: 1_000,
    update() {
      updates += 1;
      return new Promise<void>(() => {});
    },
  });

  t.mock.timers.tick(1_000);
  await Promise.resolve();
  assert.equal(updates, 1);

  heartbeat.cancel();
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  assert.equal(updates, 1);
});
