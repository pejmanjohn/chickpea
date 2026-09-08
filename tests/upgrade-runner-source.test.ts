import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
// @ts-expect-error Release tooling JavaScript helper.
import { migrationDigests } from '../scripts/lib/release-manifest.mjs';
// @ts-expect-error Release tooling JavaScript helper.
import { verifyRetainedBuildRoot } from '../scripts/lib/upgrade-source.mjs';

function retainedSource(t: any) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'chickpea-runner-source-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceRoot = path.join(directory, 'previous');
  mkdirSync(sourceRoot, { mode: 0o700 });
  const put = (file: string, value: unknown) => {
    const target = path.join(sourceRoot, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  put('package.json', { version: '0.1.0' });
  put('package-lock.json', { version: '0.1.0', packages: { '': { version: '0.1.0' } } });
  put('wrangler.jsonc', '{}');
  put('migrations/better-auth/0001.sql', 'CREATE TABLE owners (id TEXT PRIMARY KEY);');
  for (const name of ['src/identity/migrations.ts', 'src/config/store.ts', 'src/work/migrations.ts']) put(name, '// retained fixture');
  put('release.json', { formatVersion: 1, version: '0.1.0', storageGeneration: 1, supportedOrigins: [], recovery: 'previous-code-only', migrations: migrationDigests(sourceRoot) });
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Upgrade Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: sourceRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet'); git('add', '.'); git('commit', '--quiet', '-m', 'retained source');
  const context = { schema: 1, sourceRoot, source: { tag: 'v0.1.0', version: '0.1.0', commit: git('rev-parse', 'HEAD') } };
  return { directory, sourceRoot, context, contextPath: path.join(directory, 'context.json') };
}

test('current runner accepts only its clean, exact retained release source', (t) => {
  const f = retainedSource(t);
  assert.equal(verifyRetainedBuildRoot(f.contextPath, f.context), f.sourceRoot);
  assert.throws(() => verifyRetainedBuildRoot(f.contextPath, { ...f.context, source: { ...f.context.source, commit: 'a'.repeat(40) } }), /identity or clean-checkout/);
  assert.throws(() => verifyRetainedBuildRoot(f.contextPath, { ...f.context, source: { ...f.context.source, tag: 'v0.1.1' } }), /identity is invalid/);
  writeFileSync(path.join(f.sourceRoot, 'package.json'), '{"version":"0.1.0","changed":true}');
  assert.throws(() => verifyRetainedBuildRoot(f.contextPath, f.context), /identity or clean-checkout/);
});

test('current runner refuses another receipt, arbitrary directories, and symlinked source', (t) => {
  const f = retainedSource(t);
  assert.throws(() => verifyRetainedBuildRoot(path.join(f.directory, 'other/context.json'), f.context));
  assert.throws(() => verifyRetainedBuildRoot(f.contextPath, { ...f.context, sourceRoot: f.directory }), /retained checkout/);
  const link = path.join(f.directory, 'destination');
  symlinkSync(f.sourceRoot, link, 'dir');
  assert.throws(() => verifyRetainedBuildRoot(f.contextPath, { ...f.context, sourceRoot: link }), /owner-controlled/);
});
