import assert from 'node:assert/strict';
import test from 'node:test';

// Each file's process runs without V8's background code compilers, whose
// compiles can deadlock Node 24's process.exit() (scripts/run-tests.mjs).
test('runs without Maglev and concurrent Sparkplug', () => {
  assert.ok(process.execArgv.includes('--no-maglev'), process.execArgv.join(' '));
  assert.ok(process.execArgv.includes('--no-concurrent-sparkplug'), process.execArgv.join(' '));
});
