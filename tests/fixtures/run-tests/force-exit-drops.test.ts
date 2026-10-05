import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

// Every test passes, but the reports after the first stay queued in this
// process, as they do when the pipe to a busy runner is full. The runner's
// --test-force-exit then ends the process with process.exit(), which discards
// the queue: the runner hears one test and an exit code of 0.
test('reports before the pipe fills', () => {});

test('the pipe to the runner stops draining', async () => {
  await delay(200); // The first report reaches the runner first.
  // A write that never completes keeps every later write queued in the stream.
  const held = () => {};
  Object.assign(process.stdout, { _write: held, _writev: null });
});

test('runs, but its report never leaves the process', () => {});
