import { existsSync, writeFileSync } from 'node:fs';
import test from 'node:test';

// Exits before any test reports on the first run, like a killed worker or a
// process that never got going; behaves on the next run.
const marker = process.env.RUN_TESTS_FIXTURE_CRASH_MARKER;
if (!marker) throw new Error('RUN_TESTS_FIXTURE_CRASH_MARKER is required');
if (!existsSync(marker)) {
  writeFileSync(marker, '');
  process.exit(3);
}

test('reports normally once the process survives', () => {});
