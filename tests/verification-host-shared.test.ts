import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
// @ts-expect-error Shared executable JavaScript helper.
import { acquireHostChecks } from '../scripts/lib/verification-host.mjs';
// @ts-expect-error Shared executable JavaScript helper.
import { acquireSharedSlot, sharedSlotCount, waitForSharedSlot } from '../scripts/lib/verification-host-shared.mjs';

const VERIFY_HOST = resolve('scripts/verify-host.mjs');
const RUNNER = resolve('scripts/run-tests.mjs');
const FIXTURES = resolve('tests/fixtures/run-tests');

function slotDirs(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-shared-slots-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { dir: join(root, 'shared'), exclusive: [join(root, 'owner-2.json'), join(root, 'owner.json')] };
}

/** A HOME of its own, and an environment with none of this run's own slot, reservation or stall settings. */
function isolatedHome(t: TestContext, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'chickpea-shared-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const clean: NodeJS.ProcessEnv = { ...process.env, HOME: home, DO_NOT_TRACK: '1' };
  for (const key of ['CHICKPEA_CHECK_OWNER', 'CHICKPEA_SHARED_CHECK_OWNER', 'CHICKPEA_VERIFY_HOST_PID', 'CHICKPEA_STALL_MS', 'CHICKPEA_SHARED_SLOTS']) delete clean[key];
  Object.assign(clean, env);
  const host = join(home, '.chickpea', 'verification-host');
  return { home, env: clean, shared: join(host, 'shared'), exclusive: [join(host, 'owner-2.json'), join(host, 'owner.json')] };
}

const stoppedPid = () => Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
const claims = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

test('the slot count is one per six cores, at least one, unless CHICKPEA_SHARED_SLOTS sets it', () => {
  assert.equal(sharedSlotCount({}, 18), 3);
  assert.equal(sharedSlotCount({}, 4), 1);
  assert.equal(sharedSlotCount({ CHICKPEA_SHARED_SLOTS: '5' }, 18), 5);
  for (const value of ['0', '-1', '1.5', 'many', '65']) {
    assert.throws(() => sharedSlotCount({ CHICKPEA_SHARED_SLOTS: value }, 18), { code: 'HOST_CHECKS_SHARED_INVALID' }, value);
  }
});

test('slots are counted, refused when all are taken, and free again on release', (t) => {
  const { dir, exclusive } = slotDirs(t);
  const take = (cwd: string) => acquireSharedSlot({ dir, exclusive, slots: 2, env: {}, cwd, command: `check in ${cwd}` });
  const first = take('first');
  const second = take('second');
  assert.deepEqual([first.file, second.file], [join(dir, 'slot-0.json'), join(dir, 'slot-1.json')]);
  assert.notEqual(first.env.CHICKPEA_SHARED_CHECK_OWNER, second.env.CHICKPEA_SHARED_CHECK_OWNER);
  assert.throws(() => take('third'), (error: any) => error.code === 'HOST_CHECKS_SHARED_BUSY'
    && error.slots === 2 && error.owners.map((owner: any) => [owner.kind, owner.cwd, owner.command]).join() === 'shared,first,check in first,shared,second,check in second');
  first.release();
  const third = take('third');
  assert.equal(third.file, join(dir, 'slot-0.json'), 'the released slot is taken again');
  third.release(); second.release();
  assert.deepEqual(claims(dir), [], 'every release removes its own claim');
});

test('a slot whose PID has exited is reclaimed and reported; a live holder keeps its slot', (t) => {
  const { dir, exclusive } = slotDirs(t);
  mkdirSync(dir, { recursive: true });
  const dead = stoppedPid();
  writeFileSync(join(dir, 'slot-0.json'), JSON.stringify({ pid: dead, cwd: 'crashed', command: 'mutation pass', token: 'gone' }));
  writeFileSync(join(dir, 'slot-1.json'), JSON.stringify({ pid: process.pid, cwd: 'live', token: 'live' }));
  const lease = acquireSharedSlot({ dir, exclusive, slots: 2, env: {}, cwd: 'next' });
  assert.equal(lease.file, join(dir, 'slot-0.json'));
  assert.deepEqual(lease.reclaimed.map(({ pid, cwd, command }: any) => ({ pid, cwd, command })), [{ pid: dead, cwd: 'crashed', command: 'mutation pass' }]);
  assert.equal(JSON.parse(readFileSync(join(dir, 'slot-0.json'), 'utf8')).cwd, 'next');
  assert.equal(JSON.parse(readFileSync(join(dir, 'slot-1.json'), 'utf8')).cwd, 'live', 'a live holder keeps its slot');
  lease.release();
});

test('a live exclusive owner counts as one slot; commands nested under it or under a shared slot take none', (t) => {
  const { dir, exclusive } = slotDirs(t);
  const reservation = acquireHostChecks({ files: exclusive, env: {}, cwd: 'full-suite' });
  const shared = acquireSharedSlot({ dir, exclusive, slots: 2, env: {}, cwd: 'typecheck' });
  assert.throws(() => acquireSharedSlot({ dir, exclusive, slots: 2, env: {}, cwd: 'third' }),
    (error: any) => error.code === 'HOST_CHECKS_SHARED_BUSY' && error.owners.map((owner: any) => owner.kind).join() === 'exclusive,shared');
  const before = claims(dir);

  const underReservation = acquireSharedSlot({ dir, exclusive, slots: 2, env: reservation.env, cwd: 'nested-test-pass' });
  assert.equal(underReservation.inherited, reservation.file);
  assert.deepEqual(underReservation.env, {});
  const underShared = acquireSharedSlot({ dir, exclusive, slots: 2, env: shared.env, cwd: 'nested-runner' });
  assert.equal(underShared.inherited, shared.file);
  assert.deepEqual(underShared.env, shared.env);
  underReservation.release(); underShared.release();
  assert.deepEqual(claims(dir), before, 'nesting takes and releases nothing');

  reservation.release();
  const stale = acquireSharedSlot({ dir, exclusive, slots: 2, env: reservation.env, cwd: 'after-the-suite' });
  assert.equal(stale.inherited, undefined, 'a token whose reservation has ended is not a reservation');
  stale.release(); shared.release();
});

test('a waiter prints one status while every slot is taken, then takes the slot as it frees', async (t) => {
  const { dir, exclusive } = slotDirs(t);
  const holder = acquireSharedSlot({ dir, exclusive, slots: 1, env: {}, cwd: 'harness' });
  const events: any[] = [];
  const timer = setTimeout(() => holder.release(), 80);
  t.after(() => clearTimeout(timer));
  const lease = await waitForSharedSlot({ dir, exclusive, slots: 1, env: {}, cwd: 'waiter', pollMs: 10, waitMs: 5000, onWait: (event: unknown) => events.push(event) });
  assert.deepEqual(events.map((event) => event.status), ['waiting', 'acquired'], 'one status across many polls');
  assert.deepEqual(events[0].owners.map(({ kind, cwd }: any) => ({ kind, cwd })), [{ kind: 'shared', cwd: 'harness' }]);
  assert.ok(lease.waitedMs >= 40);
  lease.release();

  const busy = acquireSharedSlot({ dir, exclusive, slots: 1, env: {}, cwd: 'harness' });
  await assert.rejects(waitForSharedSlot({ dir, exclusive, slots: 1, env: {}, pollMs: 10, waitMs: 30 }), { code: 'HOST_CHECKS_TIMEOUT' });
  await assert.rejects(waitForSharedSlot({ dir, exclusive, slots: 1, env: {}, waitMs: 0 }), { code: 'HOST_CHECKS_SHARED_BUSY' });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(waitForSharedSlot({ dir, exclusive, slots: 1, env: {}, pollMs: 100, signal: controller.signal }), { code: 'HOST_CHECKS_CANCELLED' });
  busy.release();
});

test('run-tests.mjs waits for a shared slot, saying so, and runs once one frees', async (t) => {
  const { env, shared } = isolatedHome(t, { CHICKPEA_SHARED_SLOTS: '1' });
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, 'slot-0.json'), JSON.stringify({ pid: process.pid, cwd: 'another-agent', command: 'npm run typecheck', token: 'other' }));
  const child = spawn(process.execPath, [RUNNER, join(FIXTURES, 'pass.test.ts')], { env });
  let stderr = '';
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.includes('"status":"waiting"')) rmSync(join(shared, 'slot-0.json'), { force: true });
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stdout + stderr);
  assert.match(stderr, /"status":"waiting","slot":"shared","slots":1,"owners":\[\{"kind":"shared".*"cwd":"another-agent","command":"npm run typecheck"/);
  assert.match(stderr, /"status":"acquired","slot":"shared"/);
  assert.match(stdout, /pass/);
  assert.deepEqual(claims(shared), [], 'the pass released its slot');
});

test('nested runs never wait on their own parent: under the exclusive reservation, under a shared slot, and run-tests under a reservation it did not start', (t) => {
  const { env, shared, exclusive } = isolatedHome(t, { CHICKPEA_SHARED_SLOTS: '1' });
  const run = (...args: string[]) => spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60_000 });
  const report = `process.stdout.write(require('node:fs').readdirSync(${JSON.stringify(shared)}, { withFileTypes: false }).join() + '|')`;
  // With one slot, a live exclusive owner already fills the count, so a nested caller that did not inherit would wait.
  const exclusiveNest = run(VERIFY_HOST, '--', process.execPath, VERIFY_HOST, '--shared', '--', process.execPath, '-e', `require('node:fs').mkdirSync(${JSON.stringify(shared)}, { recursive: true }); ${report}`);
  assert.ifError(exclusiveNest.error);
  assert.equal(exclusiveNest.status, 0, exclusiveNest.stderr);
  assert.equal(exclusiveNest.stdout, '|', 'the nested shared command took no slot');
  assert.doesNotMatch(exclusiveNest.stderr, /waiting/);

  const sharedNest = run(VERIFY_HOST, '--shared', '--', process.execPath, VERIFY_HOST, '--shared', '--', process.execPath, '-e', report);
  assert.ifError(sharedNest.error);
  assert.equal(sharedNest.status, 0, sharedNest.stderr);
  assert.equal(sharedNest.stdout, 'slot-0.json|', 'only the outer command holds a slot');

  // verify:regression holds the reservation itself and starts run-tests.mjs without verify:host's marker.
  const lease = acquireHostChecks({ files: exclusive, env: {}, cwd: 'verify-regression' });
  t.after(() => { if (existsSync(lease.file)) lease.release(); });
  const tests = spawnSync(process.execPath, [RUNNER, join(FIXTURES, 'pass.test.ts')], { env: { ...env, ...lease.env }, encoding: 'utf8', timeout: 60_000 });
  assert.ifError(tests.error);
  assert.equal(tests.status, 0, tests.stdout + tests.stderr);
  assert.doesNotMatch(tests.stderr, /waiting/);
  assert.deepEqual(claims(shared), []);
});

async function ended(pid: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { process.kill(pid, 0); } catch (error: any) { if (error.code === 'ESRCH') return true; }
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

test('a command silent for the stall window is stopped with its whole group, exits 124, names itself and its last line, and releases its slot', async (t) => {
  const { env, home, shared, exclusive } = isolatedHome(t);
  const pidFile = join(home, 'grandchild.pid');
  const silent = `const { spawn } = require('node:child_process'); const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid)); console.log('first'); console.error('last words'); setInterval(() => {}, 1e6);`;
  for (const mode of [[], ['--shared']]) {
    rmSync(pidFile, { force: true });
    const started = Date.now();
    const run = spawnSync(process.execPath, [VERIFY_HOST, ...mode, '--stall-ms', '3000', '--', process.execPath, '-e', silent], { env, encoding: 'utf8', timeout: 60_000 });
    assert.ifError(run.error);
    assert.equal(run.status, 124, run.stderr);
    const lines = run.stderr.split('\n').filter((line) => line.includes('Stalled'));
    assert.equal(lines.length, 1, run.stderr);
    assert.match(lines[0] ?? '', /^\[verify:host\] Stalled: no output for 3 s from `.*node -e const \{ spawn \}.*`, so its process group was stopped \(exit 124\)\. Last output: last words$/);
    assert.ok(Date.now() - started < 30_000);
    assert.ok(await ended(Number(readFileSync(pidFile, 'utf8'))), 'the grandchild in its group was stopped too');
    assert.deepEqual([...exclusive.map(existsSync), claims(shared).length], [false, false, 0], `${mode.join() || 'exclusive'}: the slot is released the normal way`);
  }
});

test('a reserved command is watched only on request; a shared one always is', (t) => {
  const marker = [process.execPath, '-e', 'process.stdout.write(String(process.env.CHICKPEA_VERIFY_HOST_PID))'];
  const { env } = isolatedHome(t);
  const run = (extra: Record<string, string>, ...args: string[]) => {
    const result = spawnSync(process.execPath, [VERIFY_HOST, ...args, '--', ...marker], { env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { watcher: result.stdout, pid: String(result.pid) };
  };
  const reserved = run({});
  assert.equal(reserved.watcher, 'undefined', 'a build or lane deploy keeps its old process model, unwatched');
  for (const [why, extra, args] of [['--shared', {}, ['--shared']], ['--stall-ms', {}, ['--stall-ms', '60000']], ['CHICKPEA_STALL_MS', { CHICKPEA_STALL_MS: '60000' }, []]] as const) {
    const watched = run(extra, ...args);
    assert.equal(watched.watcher, watched.pid, `${why}: watched by verify:host itself`);
  }
  assert.equal(run({}, '--stall-ms', '0').watcher, 'undefined', '0 leaves a reserved command unwatched');
  // run-tests.mjs restarts itself under --shared until it sees this marker, so a shared command carries it with the stop off too.
  for (const [extra, args] of [[{}, ['--shared', '--stall-ms', '0']], [{ CHICKPEA_STALL_MS: '0' }, ['--shared']]] as const) {
    const off = run(extra, ...args);
    assert.equal(off.watcher, off.pid, '0 turns only the stall stop off for a shared command');
  }
});

test('a watched command that cannot start releases its reservation', (t) => {
  const { env, home, exclusive } = isolatedHome(t);
  writeFileSync(join(home, 'file'), '');
  // spawn() throws ENOTDIR and emits ENOENT.
  for (const command of [join(home, 'file', 'command'), join(home, 'missing')]) {
    const run = spawnSync(process.execPath, [VERIFY_HOST, '--stall-ms', '60000', '--', command], { env, encoding: 'utf8' });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /Command could not start: .* \(ENO(TDIR|ENT)\)\. It holds no host reservation\./);
    assert.deepEqual(exclusive.map(existsSync), [false, false]);
  }
});

test('a watched reserved command ended by a signal keeps its reservation, as an unwatched one does', (t) => {
  const { env, exclusive } = isolatedHome(t);
  const run = spawnSync(process.execPath, [VERIFY_HOST, '--stall-ms', '60000', '--', process.execPath, '-e', "process.kill(process.pid, 'SIGKILL')"], { env, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /Interrupted command: host reservation retained\./);
  assert.equal(exclusive.filter(existsSync).length, 1);
});

test('a command nested under a watching verify:host stays in its group, so the outer stop and window reach it', async (t) => {
  const { env, home, shared } = isolatedHome(t);
  const pidFile = join(home, 'nested.pid');
  const stubborn = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log('nested'); setInterval(() => {}, 1e6);`;
  const run = spawnSync(process.execPath, [VERIFY_HOST, '--shared', '--stall-ms', '3000', '--', process.execPath, VERIFY_HOST, '--shared', '--stall-ms', '1800000', '--', process.execPath, '-e', stubborn], { env, encoding: 'utf8', timeout: 60_000 });
  t.after(() => { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} });
  assert.ifError(run.error);
  assert.equal(run.status, 124, run.stderr);
  assert.match(run.stderr, /^\[verify:host\] --stall-ms ignored: this command runs inside verify:host PID \d+, whose stall window applies\.$/m);
  assert.match(run.stderr, /Stalled: no output for 3 s/, 'the outer 3 s window, not the nested 30 minutes, stopped it');
  assert.ok(await ended(Number(readFileSync(pidFile, 'utf8'))), 'a nested command that ignores SIGTERM still ends with the outer group');
  assert.deepEqual(claims(shared), []);
});

test('a watched command stops with its group when its caller is killed, and frees the slot', async (t) => {
  const { env, home, shared } = isolatedHome(t);
  const pidFile = join(home, 'orphan.pid');
  const stderrFile = join(home, 'wrapper.stderr');
  const quiet = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1e6);`;
  const caller = spawn(process.execPath, ['-e', `const fs = require('node:fs'); require('node:child_process').spawn(process.execPath, [${JSON.stringify(VERIFY_HOST)}, '--shared', '--', process.execPath, '-e', ${JSON.stringify(quiet)}], { stdio: ['ignore', 'ignore', fs.openSync(${JSON.stringify(stderrFile)}, 'w')] }); setInterval(() => {}, 1e6);`], { env, stdio: 'ignore' });
  t.after(() => caller.kill('SIGKILL'));
  let wrapper = 0;
  for (let attempt = 0; attempt < 200 && !(wrapper && existsSync(pidFile)); attempt += 1) {
    await new Promise((done) => setTimeout(done, 50));
    const [slot] = claims(shared);
    if (slot) wrapper = JSON.parse(readFileSync(join(shared, slot), 'utf8')).pid;
  }
  assert.ok(wrapper && existsSync(pidFile), 'the wrapped command started under a shared slot');
  caller.kill('SIGKILL');
  assert.ok(await ended(Number(readFileSync(pidFile, 'utf8'))), 'the command did not run on as an orphan');
  assert.ok(await ended(wrapper), 'verify:host exited');
  assert.deepEqual(claims(shared), [], 'its slot was released');
  assert.match(readFileSync(stderrFile, 'utf8'), /^\[verify:host\] Its caller exited, so the process group of `.*node -e .*` was stopped\.$/m);
  assert.doesNotMatch(readFileSync(stderrFile, 'utf8'), /Stalled/);
});

test('a reader that goes away neither blocks the command nor strands its reservation', async (t) => {
  const { env, exclusive } = isolatedHome(t);
  const chatty = 'for (let i = 0; i < 20000; i += 1) console.log(`line ${i}`); setTimeout(() => {}, 300);';
  const child = spawn(process.execPath, [VERIFY_HOST, '--stall-ms', '20000', '--', process.execPath, '-e', chatty], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.once('data', () => child.stdout.destroy());
  const [code] = await once(child, 'close');
  assert.equal(code, 0, 'the command ran to its end, as `| head` lets it');
  assert.deepEqual(exclusive.map(existsSync), [false, false]);
});

test('run-tests.mjs stops a pass that goes silent, by default and with CHICKPEA_STALL_MS shortening the window', (t) => {
  const { env, shared } = isolatedHome(t, { CHICKPEA_STALL_MS: '3000' });
  const started = Date.now();
  const run = spawnSync(process.execPath, [RUNNER, join(FIXTURES, 'hang.test.ts')], { env, encoding: 'utf8', timeout: 60_000 });
  assert.ifError(run.error);
  assert.equal(run.status, 124, run.stdout + run.stderr);
  assert.match(run.stderr, /\[verify:host\] Stalled: no output for 3 s from `\S*node \S*run-tests\.mjs [^`]+`, so its process group was stopped \(exit 124\)\. Last output: \(none\)/);
  assert.ok(Date.now() - started < 30_000, 'stopped long before the two-minute per-test timeout');
  assert.deepEqual(claims(shared), []);
});
