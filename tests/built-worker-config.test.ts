import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
// @ts-expect-error Deployment tooling JavaScript helper.
import { builtWorkerConfigPath, staleBuildReason } from '../scripts/lib/built-worker-config.mjs';

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
  for (const name of ['built-worker-config.mjs', 'build-identity.mjs']) {
    cpSync(`scripts/lib/${name}`, path.join(root, 'scripts/lib', name));
  }
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

test('a build is checked only when its stamped commit is this checkout\'s', (t) => {
  const { root, redirect } = fixture(t);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  git('add', 'package.json');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  const build = (commit: string) => {
    mkdirSync(path.join(root, 'dist-cf/chickpea'), { recursive: true });
    writeFileSync(path.join(root, 'dist-cf/chickpea/wrangler.json'),
      JSON.stringify({ name: 'chickpea', vars: { CHICKPEA_APP_VERSION: '1.2.3', CHICKPEA_SOURCE_COMMIT: commit } }));
    redirect('../../dist-cf/chickpea/wrangler.json');
  };

  assert.match(staleBuildReason(root), /Run the build first/);
  build(head);
  assert.equal(staleBuildReason(root), undefined);
  // A lane deploy built another commit and left dist-cf behind.
  build('b'.repeat(40));
  assert.equal(staleBuildReason(root),
    `dist-cf was built from bbbbbbbbb, not this checkout's ${head.slice(0, 9)}. Run npm run build to check a build of this source.`);
  build('unknown');
  assert.match(staleBuildReason(root), /^dist-cf was built from unknown, not this checkout's /);

  // A source export has no .git; its release-source.json names the commit.
  rmSync(path.join(root, '.git'), { recursive: true, force: true });
  build(head);
  assert.match(staleBuildReason(root), /no source commit/);
  writeFileSync(path.join(root, 'release-source.json'), JSON.stringify({ commit: head }));
  assert.equal(staleBuildReason(root), undefined);
});
