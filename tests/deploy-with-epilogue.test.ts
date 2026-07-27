import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
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

function writeRoutineArtifact(
  harness: ReturnType<typeof createHarness>,
  options: { cron?: boolean; workflow?: boolean; guarded?: boolean } = {},
) {
  const builtDir = path.join(harness.root, 'dist-cf', 'chickpea');
  const redirectDir = path.join(harness.root, '.wrangler', 'deploy');
  mkdirSync(builtDir, { recursive: true });
  mkdirSync(redirectDir, { recursive: true });
  writeFileSync(path.join(redirectDir, 'config.json'), JSON.stringify({
    configPath: '../../dist-cf/chickpea/wrangler.json',
  }));
  writeFileSync(path.join(builtDir, 'wrangler.json'), JSON.stringify({
    name: 'chickpea',
    main: 'index.js',
    vars: { TAG_ROUTINES_ENABLED: '1' },
    triggers: { crons: options.cron === false ? [] : ['* * * * *'] },
    durable_objects: { bindings: [
      { name: 'TAG_STATE', class_name: 'TagStateStore' },
      ...(options.workflow === false ? [] : [{ name: 'FLUE_ROUTINE_WORKFLOW', class_name: 'FlueRoutineWorkflow' }]),
    ] },
  }));
  writeFileSync(
    path.join(builtDir, 'index.js'),
    options.guarded === false
      ? 'scheduled(controller) {}'
      : 'scheduled(controller) {} routine-intent slack-thread x-flue-internal-token error: "unauthorized"',
  );
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

test('enabled routines require Cron, state, Workflow, scheduled handler, and internal route guards', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeRoutineArtifact(harness);

  const result = runHarness(harness, ['--skip-build', '--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(commands(harness.logPath), ['wrangler:["deploy","--dry-run"]']);
});

test('deploy refuses an enabled routines artifact with a missing heartbeat', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeRoutineArtifact(harness, { cron: false });

  const result = runHarness(harness, ['--skip-build', '--dry-run']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /TAG_ROUTINES_ENABLED=1 is unsafe/);
  assert.match(result.stderr, /heartbeat Cron Trigger/);
  assert.equal(existsSync(harness.logPath), false);
});
