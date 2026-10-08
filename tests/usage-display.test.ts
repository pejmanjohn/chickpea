import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatPriceCents,
  formatUsageDollars,
  usagePercent,
  type UsageMicros,
} from '../src/usage/usage-display.ts';

const micros = (value: number) => value as UsageMicros;

test('usage renders in dollars, rounded half up to the cent and cents dropped when whole', () => {
  for (const [value, expected] of [
    [305_000, '$0.31'],
    [304_999, '$0.30'],
    [5_000, '$0.01'],
    [4_999, '$0'],
    [128_000_000, '$128'],
    [1_234_567_890, '$1,234.57'],
    [0, '$0'],
    [-305_000, '-$0.31'],
    [-1, '$0'],
  ] as const) {
    assert.equal(formatUsageDollars(micros(value)), expected, String(value));
  }
});

test('a price in cents renders with thousands separators and two-digit cents only when present', () => {
  assert.equal(formatPriceCents(20_000), '$200');
  assert.equal(formatPriceCents(2_550), '$25.50');
  assert.equal(formatPriceCents(205), '$2.05');
  assert.equal(formatPriceCents(123_456_700), '$1,234,567');
  assert.equal(formatPriceCents(-2_550), '-$25.50');
});

test('the usage percent is floored, so a threshold is never read before it is reached', () => {
  const included = micros(240_000_000);
  assert.equal(usagePercent(micros(128_000_000), included), 53);
  assert.equal(usagePercent(micros(239_999_999), included), 99);
  assert.equal(usagePercent(micros(180_000_000), included), 75);
  assert.equal(usagePercent(micros(179_999_999), included), 74);
  assert.equal(usagePercent(micros(252_000_000), included), 105);
  assert.equal(usagePercent(micros(128_000_000), micros(0)), 0);
});
