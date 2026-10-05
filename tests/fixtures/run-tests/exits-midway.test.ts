import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

// Reports one test, then exits 0 partway through the file, as a stray
// process.exit() in code under test would. node:test passes the file.
test('reports before the exit', () => {});

test('exits the process partway through the file', async () => {
  await delay(200); // The first report reaches the runner first.
  process.exit(0);
});

test('never runs', () => {});
