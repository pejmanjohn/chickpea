import assert from 'node:assert/strict';
import test from 'node:test';

// The runner takes its result file out of the environment before any test
// process starts, so a runner that a test starts cannot write into it.
test('this process cannot see the runner\'s result file', () => {
  assert.equal(process.env.RUN_TESTS_RESULT_FILE, undefined);
});
