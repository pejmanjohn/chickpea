import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error Shared executable JavaScript helper.
import { assertNodeVersion, isSupportedNodeVersion, NODE_BASELINE, NODE_ENGINE } from '../scripts/lib/node-version.mjs';
// @ts-expect-error Shared executable JavaScript helper.
import { assertReleaseEnvironment } from '../scripts/verify-regression.mjs';

test('Node policy accepts the pinned baseline and future 24 updates, rejecting other majors and older releases', () => {
  assert.equal(assertNodeVersion(`v${NODE_BASELINE}`, { baseline: true }), `v${NODE_BASELINE}`);
  for (const version of ['24.20.1', 'v24.21.0']) assert.equal(isSupportedNodeVersion(version), true);
  for (const version of ['v22.19.0', 'v24.19.0', 'v25.0.0', 'v26.0.0', 'v24.21.0-rc.1', '24', 'invalid']) {
    assert.equal(isSupportedNodeVersion(version), false, version);
    assert.throws(() => assertNodeVersion(version), /requires Node 24.x/);
  }
  assert.throws(() => assertNodeVersion('v24.20.1', { baseline: true }), /nvm install && nvm use/);
});

test('package and publish policy share the single baseline without changing dependency engine declarations', () => {
  const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
  const lock = JSON.parse(read('package-lock.json'));
  for (const pkg of [JSON.parse(read('package.json')), JSON.parse(read('packages/cli/package.json')), lock.packages[''], lock.packages['packages/cli']]) {
    assert.equal(pkg.engines.node, NODE_ENGINE);
  }
  assert.match(read('.github/workflows/publish-cli.yml'), /node-version-file: '\.nvmrc'/);
});

test('release rejects ignored environment overrides so checkout and archive checks have the same configuration', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-release-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.env.example'), '');
  assert.doesNotThrow(() => assertReleaseEnvironment(root));
  for (const name of ['.env', '.env.production.local', '.dev.vars', '.dev.vars.sandbox']) {
    writeFileSync(join(root, name), '');
    assert.throws(() => assertReleaseEnvironment(root), /without private environment files/);
    rmSync(join(root, name));
  }
});
