import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
// @ts-expect-error Shared executable JavaScript helper.
import { acquireHostChecks } from '../scripts/lib/verification-host.mjs';
// @ts-expect-error Shared executable JavaScript helper.
import { waitForHostChecks } from '../scripts/lib/verification-host-wait.mjs';

test('bounded host wait acquires only after release and reports contention once', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-host-wait-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'owner.json');
  const owner = acquireHostChecks({ file, env: {}, cwd: 'first' });
  const statuses: unknown[] = [];
  const timer = setTimeout(() => owner.release(), 50);
  t.after(() => clearTimeout(timer));
  const next = await waitForHostChecks({ file, env: {}, cwd: 'second', waitMs: 2000, pollMs: 10,
    onWait: (status: unknown) => statuses.push(status) });
  assert.equal(statuses.length, 1);
  assert.ok(next.waitedMs >= 40);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).cwd, 'second');
  next.release();
});

test('timeout, cancellation and stopped owners retain the exact host reservation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-host-wait-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'owner.json');
  const owner = acquireHostChecks({ file, env: {}, cwd: 'first' });
  const original = readFileSync(file, 'utf8');
  await assert.rejects(waitForHostChecks({ file, env: {}, waitMs: 25, pollMs: 10 }), { code: 'HOST_CHECKS_TIMEOUT' });
  assert.equal(readFileSync(file, 'utf8'), original);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15);
  t.after(() => clearTimeout(timer));
  await assert.rejects(waitForHostChecks({ file, env: {}, waitMs: 2000, pollMs: 100,
    signal: controller.signal }), { code: 'HOST_CHECKS_CANCELLED' });
  assert.equal(readFileSync(file, 'utf8'), original);
  owner.release();
  const childPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  writeFileSync(file, JSON.stringify({ pid: childPid, token: 'stopped', cwd: 'old' }));
  const stopped = readFileSync(file, 'utf8');
  await assert.rejects(waitForHostChecks({ file, env: {}, waitMs: 2000 }), { code: 'HOST_CHECKS_OWNER_STOPPED' });
  assert.equal(readFileSync(file, 'utf8'), stopped);
});

test('host slot rejects a second worktree process, permits inherited child and preserves the owner', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-host-lock-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'owner.json');
  const lease = acquireHostChecks({ file, env: {}, cwd: 'synthetic-first-checkout' });
  const original = readFileSync(file, 'utf8');
  const module = resolve('scripts/lib/verification-host.mjs');
  const script = `import { acquireHostChecks } from ${JSON.stringify(module)}; const lease = acquireHostChecks({file: ${JSON.stringify(file)}, cwd: 'second-checkout'}); lease.release();`;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH }, stdio: 'pipe' }), /reserved/);
  assert.equal(readFileSync(file, 'utf8'), original);
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...lease.env } });
  assert.equal(readFileSync(file, 'utf8'), original, 'Nested child cannot release parent reservation');
  lease.release();
  acquireHostChecks({ file, env: {}, cwd: 'second-checkout' }).release();
});
