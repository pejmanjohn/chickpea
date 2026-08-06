import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRoutineScheduledHandler,
  requireRoutineScheduling,
  resolveRoutineCapability,
} from '../src/routines/scheduler-adapter.ts';
import { RoutineStateError } from '../src/routines/types.ts';

test('routine scheduling is permanently enabled on Cloudflare and unavailable on Node', () => {
  assert.deepEqual(resolveRoutineCapability({ cloudflare: true }), {
    target: 'cloudflare', available: true, enabled: true, reason: 'enabled',
  });
  assert.deepEqual(resolveRoutineCapability({ cloudflare: false }), {
    target: 'node', available: false, enabled: false, reason: 'unsupported_target',
  });
  assert.doesNotThrow(() => requireRoutineScheduling(
    resolveRoutineCapability({ cloudflare: true }),
  ));
  assert.throws(
    () => requireRoutineScheduling(resolveRoutineCapability({ cloudflare: false })),
    (error: unknown) =>
      error instanceof RoutineStateError && error.code === 'routines_unavailable_on_target',
  );
});

test('Cloudflare scheduled handler always runs routine heartbeat work', async () => {
  let calls = 0;
  const waited: Promise<unknown>[] = [];
  const handler = createRoutineScheduledHandler({
    heartbeat: async () => {
      calls += 1;
    },
  });
  handler.scheduled(
    { scheduledTime: Date.UTC(2026, 6, 27, 12) },
    {},
    { waitUntil: (promise) => waited.push(promise) },
  );
  await Promise.all(waited);
  assert.equal(calls, 1);
  assert.equal(waited.length, 1);
});

test('Cloudflare scheduled handler composes routine heartbeat with generic Work maintenance', async () => {
  let routineCalls = 0;
  let maintenanceCalls = 0;
  const waited: Promise<unknown>[] = [];
  const handler = createRoutineScheduledHandler({
    heartbeat: async () => {
      routineCalls += 1;
    },
    maintenance: async () => {
      maintenanceCalls += 1;
    },
  });
  handler.scheduled(
    { scheduledTime: Date.UTC(2026, 6, 27, 12) },
    {},
    { waitUntil: (promise) => waited.push(promise) },
  );
  await Promise.all(waited);
  assert.equal(maintenanceCalls, 1);
  assert.equal(routineCalls, 1);
});
