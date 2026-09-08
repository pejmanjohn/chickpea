import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HostUiMutex } from '../qa/live/safety/ui-mutex.ts';

function fixture(context: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chickpea-ui-mutex-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, mutex: new HostUiMutex(root) };
}

test('two targets serialize only their interaction windows', (context) => {
  const { root, mutex } = fixture(context);
  const amber = mutex.acquire('amber-run', 'chrome-lanes');
  assert.throws(() => mutex.acquire('cobalt-run', 'chrome-lanes'), /UI_BUSY/u);
  assert.equal(lstatSync(join(root, 'interaction.lock')).mode & 0o777, 0o600);
  amber.release();
  const cobalt = mutex.acquire('cobalt-run', 'chrome-lanes');
  cobalt.release();
  assert.equal(existsSync(join(root, 'interaction.lock')), false);
});

test('a paused human gate reserves its browser without blocking another browser', (context) => {
  const { root, mutex } = fixture(context);
  mutex.acquire('amber-run', 'chrome-lanes').pause();
  const reservation = join(root, readdirSync(root).find(name => name.startsWith('browser-'))!);
  const owner = JSON.parse(readFileSync(reservation, 'utf8'));
  writeFileSync(reservation, JSON.stringify({ ...owner, host: 'previous-network-hostname' }));
  assert.throws(() => mutex.clearStoppedOwner('amber-run', 'chrome-lanes'), /UI_BUSY/u);
  assert.throws(() => mutex.acquire('cobalt-run', 'chrome-lanes'), /BROWSER_RESERVED/u);
  mutex.acquire('cobalt-run', 'another-browser').release();
  const resumed = mutex.acquire('amber-run', 'chrome-lanes');
  resumed.finishReservation();
  resumed.release();
  mutex.acquire('cobalt-run', 'chrome-lanes').release();
});

test('a changed or stale owner is never silently stolen or removed', (context) => {
  const { root, mutex } = fixture(context);
  const lease = mutex.acquire('amber-run', 'chrome-lanes');
  const path = join(root, 'interaction.lock');
  const owner = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...owner, pid: 2147483647 }), { mode: 0o600 });
  assert.throws(() => mutex.acquire('cobalt-run', 'chrome-lanes'), /UI_BUSY/u);
  assert.throws(() => lease.release(), /UI_OWNER_CHANGED/u);
  assert.equal(existsSync(path), true);
});

test('mutex rejects symlink roots and malformed aliases before acquisition', (context) => {
  const { root, mutex } = fixture(context);
  const linked = join(root, 'linked');
  symlinkSync(root, linked);
  assert.throws(() => new HostUiMutex(linked), /UNSAFE_UI_LOCK/u);
  assert.throws(() => mutex.acquire('../run', 'chrome'), /UNSAFE_UI_LOCK/u);
  assert.equal(existsSync(join(root, 'interaction.lock')), false);
});

test('explicit recovery releases a dead browser reservation without touching a live UI owner', (context) => {
  const { root, mutex } = fixture(context);
  const moduleUrl = new URL('../qa/live/safety/ui-mutex.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { HostUiMutex } from ${JSON.stringify(moduleUrl)}; new HostUiMutex(${JSON.stringify(root)}).acquire('stopped-run', 'paused-browser').pause();`],
  { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const reservation = join(root, readdirSync(root).find(name => name.startsWith('browser-'))!);
  const owner = JSON.parse(readFileSync(reservation, 'utf8'));
  writeFileSync(reservation, JSON.stringify({ ...owner, host: 'previous-network-hostname' }));
  const live = mutex.acquire('active-run', 'another-browser');
  assert.throws(() => mutex.clearStoppedOwner('wrong-run', 'paused-browser'), /UI_OWNER_CHANGED/u);
  mutex.clearStoppedOwner('stopped-run', 'paused-browser');
  live.assertOwned();
  live.release();
  mutex.acquire('next-run', 'paused-browser').release();
});

test('explicit recovery refuses a live paused gate and clears a dead interaction owner', (context) => {
  const { root, mutex } = fixture(context);
  mutex.acquire('active-run', 'paused-browser').pause();
  assert.throws(() => mutex.clearStoppedOwner('active-run', 'paused-browser'), /UI_BUSY/u);
  const moduleUrl = new URL('../qa/live/safety/ui-mutex.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { HostUiMutex } from ${JSON.stringify(moduleUrl)}; new HostUiMutex(${JSON.stringify(root)}).acquire('stopped-run', 'other-browser');`],
  { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  mutex.clearStoppedOwner('stopped-run', 'other-browser');
  assert.throws(() => mutex.acquire('next-run', 'paused-browser'), /BROWSER_RESERVED/u);
  const live = mutex.acquire('active-run', 'paused-browser');
  live.finishReservation();
  live.release();
});
