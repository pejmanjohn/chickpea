import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
// @ts-expect-error Deployment tooling JavaScript helper.
import { builtWorkerConfigPath } from '../scripts/lib/built-worker-config.mjs';

function fixture(t: any) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'chickpea-worker-artifact-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const redirectDir = path.join(root, '.wrangler/deploy');
  mkdirSync(redirectDir, { recursive: true });
  const redirect = (configPath: unknown) => writeFileSync(path.join(redirectDir, 'config.json'), JSON.stringify({ configPath }));
  return { root, redirect };
}

test('size verification measures the redirected customer Worker and excludes stale default artifacts', (t) => {
  const { root, redirect } = fixture(t);
  for (const name of ['customer_test_worker', 'chickpea']) {
    mkdirSync(path.join(root, 'dist-cf', name), { recursive: true });
  }
  const configPath = path.join(root, 'dist-cf/customer_test_worker/wrangler.json');
  writeFileSync(configPath, JSON.stringify({ name: 'customer-test-worker', main: 'index.js' }));
  writeFileSync(path.join(root, 'dist-cf/customer_test_worker/index.js'), 'export default {};');
  writeFileSync(path.join(root, 'dist-cf/chickpea/stale.js'), 'unrelated old artifact');
  redirect('../../dist-cf/customer_test_worker/wrangler.json');
  assert.equal(builtWorkerConfigPath(root), configPath);
  mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  cpSync('scripts/lib/built-worker-config.mjs', path.join(root, 'scripts/lib/built-worker-config.mjs'));
  cpSync('scripts/verify-worker-size.mjs', path.join(root, 'scripts/verify-worker-size.mjs'));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/verify-worker-size.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Worker upload: 1 modules/);
  assert.match(result.stdout, /index\.js/);
  assert.doesNotMatch(result.stdout, /stale\.js/);
});

test('artifact discovery refuses missing, malformed, dangling and escaping redirects', (t) => {
  const { root, redirect } = fixture(t);
  assert.throws(() => builtWorkerConfigPath(root), /Run the build first/);
  redirect(null);
  assert.throws(() => builtWorkerConfigPath(root), /no configPath/);
  redirect('../../dist-cf/missing/wrangler.json');
  assert.throws(() => builtWorkerConfigPath(root), /config is missing/);
  redirect('../../wrangler.jsonc');
  assert.throws(() => builtWorkerConfigPath(root), /escaped dist-cf/);
});
