import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRoutineScheduledHandler,
  requireRoutineScheduling,
  resolveRoutineCapability,
} from '../src/routines/scheduler-adapter.ts';
import { RoutineStateError } from '../src/routines/types.ts';

test('routine scheduling is Cloudflare-only and operator-disabled by default', () => {
  assert.deepEqual(resolveRoutineCapability({ cloudflare: true }), {
    target: 'cloudflare', available: true, enabled: false, reason: 'operator_disabled',
  });
  assert.deepEqual(resolveRoutineCapability({ cloudflare: false, enabledFlag: '1' }), {
    target: 'node', available: false, enabled: false, reason: 'unsupported_target',
  });
  assert.doesNotThrow(() => requireRoutineScheduling(
    resolveRoutineCapability({ cloudflare: true, enabledFlag: '1' }),
  ));
  assert.throws(
    () => requireRoutineScheduling(resolveRoutineCapability({ cloudflare: false })),
    (error: unknown) =>
      error instanceof RoutineStateError && error.code === 'routines_unavailable_on_target',
  );
});

test('Cloudflare scheduled handler returns before heartbeat work while default-off', async () => {
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
  assert.equal(calls, 0);
  assert.equal(waited.length, 0);

  handler.scheduled(
    { scheduledTime: Date.UTC(2026, 6, 27, 12, 1) },
    { TAG_ROUTINES_ENABLED: '1' },
    { waitUntil: (promise) => waited.push(promise) },
  );
  await Promise.all(waited);
  assert.equal(calls, 1);
});
