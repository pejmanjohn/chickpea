import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  parseMonthlySessionCap,
  RECOMMENDED_SANDBOX_MONTHLY_SESSION_CAP,
  reserveMonthlySandboxSession,
} from '../src/sandbox/session-cap.ts';

test('monthly session cap allows and increments under cap, then declines without incrementing', async () => {
  const store = new SqliteSettingsStore(':memory:');
  const now = new Date('2026-07-23T12:00:00Z');
  try {
    const first = await reserveMonthlySandboxSession({
      store,
      cap: 2,
      reservationId: 'turn-1',
      now,
    });
    const second = await reserveMonthlySandboxSession({
      store,
      cap: 2,
      reservationId: 'turn-2',
      now,
    });
    const declined = await reserveMonthlySandboxSession({
      store,
      cap: 2,
      reservationId: 'turn-3',
      now,
    });

    assert.deepEqual(
      [first.allowed, first.count, second.allowed, second.count],
      [true, 1, true, 2],
    );
    assert.deepEqual(
      [declined.allowed, declined.count, declined.cap, declined.month],
      [false, 2, 2, '2026-07'],
    );
  } finally {
    store.close();
  }
});

test('monthly session reservation is idempotent for a relay retry', async () => {
  const store = new SqliteSettingsStore(':memory:');
  const now = new Date('2026-07-23T12:00:00Z');
  try {
    const first = await reserveMonthlySandboxSession({
      store,
      cap: 1,
      reservationId: 'msg:C1:1',
      now,
    });
    const retry = await reserveMonthlySandboxSession({
      store,
      cap: 1,
      reservationId: 'msg:C1:1',
      now,
    });
    assert.equal(first.count, 1);
    assert.equal(retry.allowed, true);
    assert.equal(retry.count, 1);
    assert.equal(retry.alreadyReserved, true);
  } finally {
    store.close();
  }
});

test('zero or unset disables refusal and invalid configured caps use the recommendation', () => {
  assert.equal(parseMonthlySessionCap('0'), 0);
  assert.equal(parseMonthlySessionCap(undefined), 0);
  assert.equal(parseMonthlySessionCap('-1'), RECOMMENDED_SANDBOX_MONTHLY_SESSION_CAP);
  assert.equal(
    parseMonthlySessionCap('not-a-number'),
    RECOMMENDED_SANDBOX_MONTHLY_SESSION_CAP,
  );
});
