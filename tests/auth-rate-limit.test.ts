import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthRateLimitError, AuthRateLimiter } from '../src/auth/rate-limit.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

test('auth limiter persists per-key and global windows without storing raw identifiers', async () => {
  let now = 1_786_200_000_000;
  const identity = new SqliteIdentityStore(':memory:', { now: () => now });
  const limiter = new AuthRateLimiter(identity, {
    now: () => now, pepper: 'rate-limit-pepper-at-least-thirty-two-chars', perKeyLimit: 2, globalLimit: 3,
  });
  await limiter.recordFailure('setup', 'owner@example.com');
  await limiter.recordFailure('setup', 'owner@example.com');
  await assert.rejects(() => limiter.assertAllowed('setup', 'owner@example.com'), AuthRateLimitError);
  assert.equal(JSON.stringify(await identity.exportSummary()).includes('owner@example.com'), false);

  await limiter.recordFailure('setup', 'other@example.com');
  await assert.rejects(() => limiter.assertAllowed('setup', 'third@example.com'), AuthRateLimitError);
  now += 15 * 60_000 + 1;
  await assert.doesNotReject(() => limiter.assertAllowed('setup', 'owner@example.com'));
  identity.close();
});
