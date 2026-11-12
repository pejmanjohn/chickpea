import { existsSync, writeFileSync } from 'node:fs';
import test from 'node:test';

// Passes, then never ends on the first run: its exit blocks, as Node 24's
// process.exit() can when a V8 background compile waits on the exiting main
// thread for a garbage collection (nodejs/node#64274). Ends normally on the
// next run; the marker file records that a run already happened.
const marker = process.env.RUN_TESTS_FIXTURE_EXIT_HANG_MARKER;
if (!marker) throw new Error('RUN_TESTS_FIXTURE_EXIT_HANG_MARKER is required');
if (!existsSync(marker)) {
  writeFileSync(marker, '');
  process.on('exit', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));
}

test('passes before its process hangs at exit', () => {});
