import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import test from 'node:test';

// Leaves a process holding this file's output pipe and ends: node:test waits
// for the pipe to close, and the process holding it is no longer under the
// file's own, so the runner cannot find it to stop. Its pid goes to the
// marker file so the caller can stop it.
test('starts a process that outlives its own', () => {
  const marker = process.env.RUN_TESTS_FIXTURE_ORPHAN_PID_FILE;
  if (!marker) throw new Error('RUN_TESTS_FIXTURE_ORPHAN_PID_FILE is required');
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: ['ignore', 'inherit', 'ignore'] });
  writeFileSync(marker, String(orphan.pid));
  orphan.unref();
});
