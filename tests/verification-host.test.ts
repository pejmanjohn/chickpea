import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
// @ts-expect-error Shared executable JavaScript helper.
import { acquireHostChecks } from '../scripts/lib/verification-host.mjs';

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
