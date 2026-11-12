import test from 'node:test';

// Blocks its event loop partway through a test, so no timer, and so no
// per-test timeout, can ever fire in its process.
test('finishes first', () => {});

test('blocks its event loop', async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
