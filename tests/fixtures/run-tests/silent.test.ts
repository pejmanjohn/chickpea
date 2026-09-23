import { existsSync, writeFileSync } from 'node:fs';
import test from 'node:test';

// Exits 0 before any test reports on the first run, like a worker that died
// quietly; node:test would report the file as passing. Behaves on the next run.
const marker = process.env.RUN_TESTS_FIXTURE_SILENT_MARKER;
if (!marker) throw new Error('RUN_TESTS_FIXTURE_SILENT_MARKER is required');
if (!existsSync(marker)) {
  writeFileSync(marker, '');
  process.exit(0);
}

test('reports normally once the process survives', () => {});
