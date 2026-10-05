import { createServer } from 'node:net';
import test from 'node:test';

// Never settles and keeps a server listening, like the measured hour-long
// hang. The runner's per-test timeout must fail it and let the file end.
test('never settles while holding a live handle', () => new Promise(() => {
  createServer().listen(0, '127.0.0.1');
}));
