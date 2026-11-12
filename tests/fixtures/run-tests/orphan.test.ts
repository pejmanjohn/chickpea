import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import test from 'node:test';

// Leaves a process holding this file's output pipe and ends: node:test waits
// for the pipe to close, and the process holding it is no longer under the
// file's own, so the runner cannot find it to stop. Its pid goes to the
// marker file so the caller can stop it. With
// RUN_TESTS_FIXTURE_ORPHAN_FAIL_FIRST_MARKER, the first run only fails, so
// the process is left behind in the rerun alone.
test('starts a process that outlives its own', () => {
  const marker = process.env.RUN_TESTS_FIXTURE_ORPHAN_PID_FILE;
  if (!marker) throw new Error('RUN_TESTS_FIXTURE_ORPHAN_PID_FILE is required');
  const failFirst = process.env.RUN_TESTS_FIXTURE_ORPHAN_FAIL_FIRST_MARKER;
  if (failFirst && !existsSync(failFirst)) {
    writeFileSync(failFirst, '');
    throw new Error('fails before it leaves a process behind');
  }
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: ['ignore', 'inherit', 'ignore'] });
  writeFileSync(marker, String(orphan.pid));
  orphan.unref();
});
