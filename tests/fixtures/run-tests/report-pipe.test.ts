import assert from 'node:assert/strict';
import test from 'node:test';

// The runner preloads blocking report writes into every test file's process.
test('this process was started with the report-pipe preload', () => {
  const preload = new URL('../../../scripts/lib/test-report-pipe.mjs', import.meta.url).href;
  assert.ok(process.execArgv.includes(preload), process.execArgv.join(' '));
});
