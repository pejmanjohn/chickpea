import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'deploy-with-epilogue.mjs');

function createHarness() {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-deploy-wrapper-'));
  const scriptsDir = path.join(root, 'scripts');
  const wranglerDir = path.join(root, 'node_modules', 'wrangler', 'bin');
  const logPath = path.join(root, 'commands.log');
  const npmStub = path.join(root, 'fake-npm.mjs');
  const wranglerStub = path.join(wranglerDir, 'wrangler.js');

  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(wranglerDir, { recursive: true });
  copyFileSync(DEPLOY_SCRIPT, path.join(scriptsDir, 'deploy-with-epilogue.mjs'));

  const commandLogger = (label: string) => `
    import { appendFileSync } from 'node:fs';
    appendFileSync(
      process.env.DEPLOY_TEST_LOG,
      ${JSON.stringify(label)} + ':' + JSON.stringify(process.argv.slice(2)) + '\\n',
    );
  `;
  writeFileSync(npmStub, commandLogger('npm'));
  writeFileSync(wranglerStub, commandLogger('wrangler'));

  return {
    root,
    logPath,
    npmStub,
    script: path.join(scriptsDir, 'deploy-with-epilogue.mjs'),
  };
}

function runHarness(
  harness: ReturnType<typeof createHarness>,
  args: string[],
) {
  return spawnSync(process.execPath, [harness.script, ...args], {
    cwd: harness.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DEPLOY_TEST_LOG: harness.logPath,
      npm_execpath: harness.npmStub,
    },
  });
}

function commands(logPath: string): string[] {
  return readFileSync(logPath, 'utf8').trim().split('\n');
}

test('deploy builds by default before forwarding dry-run to Wrangler', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Building the Cloudflare artifact from current source/);
  assert.deepEqual(commands(harness.logPath), [
    'npm:["run","build"]',
    'wrangler:["deploy","--dry-run"]',
  ]);
});

test('deploy skip-build flag stays private while dry-run still reaches Wrangler', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build', '--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Building the Cloudflare artifact from current source/);
  assert.deepEqual(commands(harness.logPath), ['wrangler:["deploy","--dry-run"]']);
});
