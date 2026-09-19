import { existsSync, writeFileSync } from 'node:fs';
import test from 'node:test';

// Fails on the first run and passes on the next: the marker file records that
// a run already happened. Simulates a test that loses a host race.
test('passes only on the second run', () => {
  const marker = process.env.RUN_TESTS_FIXTURE_FLAKY_MARKER;
  if (!marker) throw new Error('RUN_TESTS_FIXTURE_FLAKY_MARKER is required');
  if (existsSync(marker)) return;
  writeFileSync(marker, '');
  throw new Error('first run loses a race');
});
