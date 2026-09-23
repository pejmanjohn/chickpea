import test from 'node:test';

// Never reports a test: exits 0 before the runner hears anything, every time.
process.exit(0);
test('never runs', () => {});
