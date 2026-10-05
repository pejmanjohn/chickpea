import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

// Drops the reports of the middle tests on their way to the runner, then lets
// the rest through: the file's own summary arrives and counts four tests, but
// only the first test's report arrived with it.
type Write = (chunk: unknown, encoding: BufferEncoding, done: (error?: Error | null) => void) => void;
const stdout = process.stdout as unknown as { _write: Write; _writev: unknown };
const write = stdout._write.bind(process.stdout);
let dropping = false;
Object.assign(process.stdout, {
  _write: ((chunk, encoding, done) => (dropping ? done() : write(chunk, encoding, done))) satisfies Write,
  _writev: null,
});

test('reports normally', () => {});

test('starts dropping reports', async () => {
  await delay(200); // The first report reaches the runner first.
  dropping = true;
});

test('dropped one', () => {});

test('dropped two', () => {});

after(async () => {
  await delay(200); // Every test's report has been dropped by now.
  dropping = false;
});
