import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { runTail } from '../scripts/lib/lane-tail.mjs';
import { chmodSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function scratch(context: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'chickpea-lane-tail-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  return file;
}

test('the tail reattaches after each exit, keeps every event in one owner-only file, and stops at its deadline', async (context) => {
  const dir = scratch(context);
  const out = path.join(dir, 'tail.json');
  // A "tail" that prints one event and exits, as Wrangler does when a deploy replaces the version.
  const fake = script(dir, 'exits.mjs', "process.stdout.write(JSON.stringify({ event: 'turn', at: Date.now() }) + '\\n'); process.stderr.write('Connected\\n');\n");
  const counts = await runTail({ command: process.execPath, args: [fake], out, durationMs: 1_500, stallMs: 60_000, restartDelayMs: 100 }) as { attaches: number; exits: number; stallRestarts: number; bytes: number };
  assert.ok(counts.attaches >= 3, `reattached ${counts.attaches} times`);
  assert.ok(counts.exits >= counts.attaches - 1 && counts.exits <= counts.attaches, 'each exit before the deadline is counted once');
  assert.equal(counts.stallRestarts, 0);
  const lines = readFileSync(out, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 3, 'events from every attach land in the same file');
  assert.ok(lines.every((line) => JSON.parse(line).event === 'turn'));
  assert.match(readFileSync(`${out}.err`, 'utf8'), /Connected/);
  const events = readFileSync(`${out}.events`, 'utf8');
  assert.match(events, /attach 1\n/);
  assert.match(events, /exited 0; reattaching/);
  assert.match(events, /deadline reached\n$/);
  for (const file of [out, `${out}.err`, `${out}.events`]) assert.equal(statSync(file).mode & 0o077, 0, `${file} is owner-only`);
});

test('a silent tail is restarted after the stall window, and an abort stops it at once', async (context) => {
  const dir = scratch(context);
  const out = path.join(dir, 'tail.json');
  const silent = script(dir, 'silent.mjs', 'setTimeout(() => {}, 60_000);\n');
  const stalled = await runTail({ command: process.execPath, args: [silent], out, durationMs: 1_400, stallMs: 300, restartDelayMs: 50 }) as { stallRestarts: number };
  assert.ok(stalled.stallRestarts >= 2, `restarted ${stalled.stallRestarts} times after silence`);
  assert.match(readFileSync(`${out}.events`, 'utf8'), /no output for 0 s; restarting/);

  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 200);
  await runTail({ command: process.execPath, args: [silent], out: path.join(dir, 'aborted.json'), durationMs: 60_000, stallMs: 60_000, signal: controller.signal });
  assert.ok(Date.now() - started < 5_000, 'the abort ends the run well before its deadline');
  assert.match(readFileSync(path.join(dir, 'aborted.json.events'), 'utf8'), /stopped\n$/);
});

test('a child that ignores SIGTERM is killed at the deadline, and a tail that never attaches is fatal', async (context) => {
  const dir = scratch(context);
  // Ignores SIGTERM and keeps talking, so only the deadline plus SIGKILL can end it.
  const stubborn = script(dir, 'stubborn.mjs', "process.on('SIGTERM', () => {}); setInterval(() => process.stdout.write('{}\\n'), 50);\n");
  const started = Date.now();
  await runTail({ command: process.execPath, args: [stubborn], out: path.join(dir, 'stubborn.json'), durationMs: 600, stallMs: 60_000, killGraceMs: 300 });
  assert.ok(Date.now() - started < 4_000, 'the deadline holds even when SIGTERM is ignored');
  assert.match(readFileSync(path.join(dir, 'stubborn.json.events'), 'utf8'), /deadline reached\n$/);

  // Exits at once like Wrangler for a missing Worker or an expired token: an error on stderr and a bare newline on stdout.
  const dead = script(dir, 'dead.mjs', "process.stdout.write('\\n'); process.stderr.write('This Worker does not exist\\n'); process.exit(1);\n");
  await assert.rejects(
    runTail({ command: process.execPath, args: [dead], out: path.join(dir, 'dead.json'), durationMs: 60_000, stallMs: 60_000, restartDelayMs: 20 }),
    /TAIL_NOT_ATTACHING: 3 attaches in a row exited within 10 s with no output \(last exit 1\)/,
  );
  const missing = path.join(dir, 'not-executable');
  writeFileSync(missing, '');
  chmodSync(missing, 0o644);
  await assert.rejects(
    runTail({ command: missing, args: [], out: path.join(dir, 'missing.json'), durationMs: 60_000, stallMs: 60_000 }),
    /TAIL_NOT_ATTACHING: could not start .*EACCES/,
  );
  const aborted = new AbortController();
  aborted.abort();
  const none = await runTail({ command: process.execPath, args: [dead], out: path.join(dir, 'aborted-early.json'), durationMs: 60_000, stallMs: 60_000, signal: aborted.signal }) as { attaches: number };
  assert.equal(none.attaches, 0, 'an already-aborted run starts nothing');
});

test('the CLI validates its arguments and refuses an output inside the repository', () => {
  const run = (args: string[]) => spawnSync(process.execPath, ['scripts/lane-tail.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run([]).status, 2);
  assert.match(run(['teal', '--out', '/tmp/x.json']).stderr, /Choose a lane/);
  assert.match(run(['amber', '--worker', 'w', '--out', '/tmp/x.json']).stderr, /exactly one lane or --worker/);
  assert.match(run(['amber', '--out', 'relative.json']).stderr, /--out must be an absolute file path/);
  assert.match(run(['amber', '--out', '/tmp/x.json', '--minutes', '500']).stderr, /--minutes must be 1\.\.240/);
  const inside = run(['--worker', 'chickpea-amber-live', '--out', path.join(ROOT, 'tail.json'), '--minutes', '1']);
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /outside Git/);
});
