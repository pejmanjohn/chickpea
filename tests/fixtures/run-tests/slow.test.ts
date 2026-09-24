import test from 'node:test';

// Long enough that the runner's typecheck failure arrives mid-file.
test('slow fixture', async () => {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
});
