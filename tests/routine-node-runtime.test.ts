import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  acquireNodeStateOwnership,
  NodeRoutineScheduler,
  NodeRoutineSchedulerLifecycle,
} from '../src/routines/node-runtime.ts';

test('Node routine scheduler wakes at startup, coalesces overlapping minute ticks, and stops', async () => {
  const ticks: Array<() => void> = [];
  const releases: Array<() => void> = [];
  const calls: Array<{ at: number; owner: string }> = [];
  let now = 1_000;
  const scheduler = new NodeRoutineScheduler({
    now: () => now,
    pid: 42,
    runHeartbeat: async (at, owner) => {
      calls.push({ at, owner });
      await new Promise<void>((resolve) => releases.push(resolve));
    },
    setInterval: ((callback: () => void, delay: number) => {
      assert.equal(delay, 60_000);
      ticks.push(callback);
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  await scheduler.start();
  assert.equal(calls.length, 1, 'startup must wake immediately');
  now = 61_000;
  ticks[0]!();
  ticks[0]!();
  assert.equal(calls.length, 1, 'overlapping ticks join the active heartbeat');
  releases.shift()!();
  await spin();
  assert.equal(calls.length, 2, 'overlapping ticks coalesce to one successor heartbeat');
  assert.deepEqual(calls.map((call) => call.at), [1_000, 61_000]);
  assert.match(calls[0]!.owner, /^node:42:1000:/);

  const stopped = scheduler.stop();
  releases.shift()!();
  await stopped;
  ticks[0]!();
  await spin();
  assert.equal(calls.length, 2);
});

test('Node routine scheduler reports bounded redacted failures and continues', async () => {
  const ticks: Array<() => void> = [];
  const errors: string[] = [];
  let calls = 0;
  const scheduler = new NodeRoutineScheduler({
    runHeartbeat: async () => {
      calls += 1;
      if (calls === 1) throw new Error(`provider failed ${'secret'.repeat(20)}`);
    },
    setInterval: ((callback: () => void) => {
      ticks.push(callback);
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
    onError: (detail) => errors.push(detail),
  });

  await scheduler.start();
  await spin();
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  assert.ok(errors[0]!.length <= 240);
  assert.doesNotMatch(errors[0]!, /secretsecret/);
  ticks[0]!();
  await spin();
  assert.equal(calls, 2);
  await scheduler.stop();
});

test('Node state ownership excludes a second process and replaces a dead owner atomically', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-owner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'state.sqlite');
  const first = acquireNodeStateOwnership({ statePath, pid: 101, processAlive: () => true });
  assert.throws(
    () => acquireNodeStateOwnership({ statePath, pid: 202, processAlive: () => true }),
    /Another Chickpea Node process is already using the configured state database/,
  );
  const replacement = acquireNodeStateOwnership({ statePath, pid: 303, processAlive: () => false });
  first.release();
  assert.throws(
    () => acquireNodeStateOwnership({ statePath, pid: 404, processAlive: () => true }),
    /Another Chickpea Node process is already using the configured state database/,
    'a stale owner must not delete its successor',
  );
  replacement.release();
});

test('Node scheduler lifecycle publishes readiness before first wake and serializes start and stop', async () => {
  const availability: boolean[] = [];
  const starts: Array<() => void> = [];
  let created = 0;
  let stopped = 0;
  const lifecycle = new NodeRoutineSchedulerLifecycle({
    setAvailable: (available) => availability.push(available),
    create: () => {
      created += 1;
      return {
        start: async () => {
          assert.equal(availability.at(-1), true);
          await new Promise<void>((resolve) => starts.push(resolve));
        },
        stop: async () => { stopped += 1; },
      };
    },
  });

  const first = lifecycle.start();
  const duplicate = lifecycle.start();
  const stop = lifecycle.stop();
  await spin();
  assert.equal(created, 1);
  starts.shift()!();
  await Promise.all([first, duplicate, stop]);
  assert.equal(created, 1);
  assert.equal(stopped, 1);
  assert.deepEqual(availability, [true, false]);

  const restart = lifecycle.start();
  await spin();
  assert.equal(created, 2, 'restart waits for the old scheduler to drain');
  starts.shift()!();
  await restart;
  await lifecycle.stop();
});

async function spin(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
