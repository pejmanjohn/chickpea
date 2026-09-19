import test from 'node:test';

test('always fails', () => {
  throw new Error('deterministic failure');
});
