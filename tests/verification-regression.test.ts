import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { lockfileDrift } from '../scripts/lib/installed-dependencies.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { createRegressionPlan } from '../scripts/lib/regression-plan.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { isHygieneStep, parseRegressionArgs, regressionEnvironment, runRegressionSteps } from '../scripts/verify-regression.mjs';

const testFiles = readdirSync(new URL('.', import.meta.url), { recursive: true })
  .map(String).filter((file) => file.endsWith('.test.ts')).map((file) => `tests/${file.replaceAll('\\', '/')}`);

test('changed verification includes each affected area and direct test changes', () => {
  const plan = createRegressionPlan({
    areas: ['delivery'], files: ['src/routines/scheduler.ts', 'src/auth/principal.ts', 'tests/agent-names.test.ts'], testFiles,
  });
  assert.deepEqual(plan.areas, ['auth', 'delivery', 'routines']);
  const tests = plan.steps.find((step: { kind: string }) => step.kind === 'tests').files;
  assert.ok(tests.includes('tests/agent-names.test.ts'));
  assert.ok(tests.includes('tests/routine-scheduler.test.ts'));
  assert.ok(tests.includes('tests/gateway-session-runner.test.ts'));
  assert.ok(plan.steps.some((step: { script?: string }) => step.script === 'verify:cf-smoke'));
  assert.ok(plan.steps.some((step: { script?: string }) =>
    step.script === 'verify:node-scheduler-offline'));
  assert.ok(plan.steps.some((step: { script?: string }) =>
    step.script === 'verify:node-scheduler-capability'));
});

test('unknown runtime changes and deleted tests broaden verification instead of yielding a false pass', () => {
  for (const file of ['src/new-runtime.ts', 'src/admin/routes.ts', 'package-lock.json', 'tests/deleted.test.ts', 'tests/helpers/new-fixture.ts', 'src/new-prompt.md', 'tests/fixtures/prompt.txt']) {
    const plan = createRegressionPlan({ files: [file], testFiles });
    assert.equal(plan.fullTests, true, file);
    assert.ok(plan.steps.some((step: { script?: string }) => step.script === 'test'));
    assert.ok(plan.steps.some((step: { script?: string }) => step.script === 'verify:cf-smoke'));
  }
});

test('the Node scheduler proof runs for routines, Node runtime, and dependency changes only', () => {
  const scheduler = (plan: { steps: { script?: string }[] }) =>
    plan.steps.some((step) => step.script === 'verify:node-scheduler-offline');
  for (const file of ['src/new-runtime.ts', 'src/admin/routes.ts', 'scripts/run-tests.mjs', 'src/slack/thread.ts']) {
    const plan = createRegressionPlan({ files: [file], testFiles });
    assert.equal(scheduler(plan), false, file);
    if (plan.fullTests) assert.ok(plan.steps.some((step: { script?: string }) => step.script === 'test'), file);
  }
  for (const file of ['src/routines/scheduler.ts', 'src/db.node.ts', 'src/node-background.ts', 'scripts/start-node.mjs',
    'vite.node.config.ts', 'scripts/lib/offline-harness.mjs', 'package-lock.json', '.nvmrc']) {
    assert.equal(scheduler(createRegressionPlan({ files: [file], testFiles })), true, file);
  }
  assert.equal(scheduler(createRegressionPlan({ areas: ['routines'], testFiles })), true);
  assert.equal(scheduler(createRegressionPlan({ testFiles })), true);
  assert.equal(scheduler(createRegressionPlan({ mode: 'regression', testFiles })), true);
  assert.equal(scheduler(createRegressionPlan({ mode: 'release', testFiles })), true);
  // Only the release checkpoint waits out Flue's own 30 s submission lease.
  const schedulerArgs = (plan: { steps: { script?: string, args?: string[] }[] }) =>
    plan.steps.find((step) => step.script === 'verify:node-scheduler-offline')?.args;
  assert.equal(schedulerArgs(createRegressionPlan({ mode: 'release', testFiles })), undefined);
  assert.deepEqual(schedulerArgs(createRegressionPlan({ mode: 'regression', testFiles })), ['--expire-lease']);
});

test('documentation changes run only source hygiene while an unspecified scope runs core regression', () => {
  assert.deepEqual(createRegressionPlan({ files: ['README.md'], testFiles }).steps,
    [{ kind: 'npm', script: 'verify:hygiene', args: ['--working-tree'] }]);
  assert.ok(createRegressionPlan({ testFiles }).steps.length > 1);
  assert.ok(createRegressionPlan({ files: ['qa/live/operator/SKILL.md'], testFiles }).areas.includes('verification'));
});

test('both skill hosts and shared operator helpers select workflow checks without broadening product scope', () => {
  for (const file of [
    '.agents/skills/chickpea-live-verification/SKILL.md', '.claude/skills/chickpea-live-verification/SKILL.md',
    'qa/live/coordinator.ts', 'scripts/verification-fixtures.mjs', 'scripts/verify-qa-candidate.mjs',
    'scripts/lib/verification-record-family.mjs', 'scripts/lib/verification-host-wait.mjs',
    'scripts/lib/environment-wait.mjs', 'scripts/lib/local-worker-inspection.mjs', 'scripts/lib/qa-candidate.mjs',
  ]) {
    const plan = createRegressionPlan({ files: [file], testFiles });
    assert.deepEqual(plan.areas, ['verification'], file);
    assert.equal(plan.fullTests, false, file);
    const selected = plan.steps.find((step: { kind: string }) => step.kind === 'tests').files;
    for (const required of ['qa-candidate', 'live-contract-coordinator', 'live-contract-lock', 'verification-fixtures', 'oss-export']) {
      assert.ok(selected.includes(`tests/${required}.test.ts`), `${file}: ${required}`);
    }
  }
});

test('regression and release preserve distinct inventories and reject stale selection', () => {
  const regression = createRegressionPlan({ mode: 'regression', testFiles });
  const release = createRegressionPlan({ mode: 'release', testFiles });
  assert.equal(regression.fullTests, false);
  assert.equal(release.fullTests, true);
  assert.equal(regression.steps.some((step: { script?: string }) => step.script === 'verify:oss-export'), false);
  assert.equal(release.steps.at(-1).script, 'verify:oss-export');
  for (const script of ['test', 'verify:durability', 'verify:providers']) assert.equal(release.steps.some((step: any) => step.script === script), false);
  assert.equal(release.steps.some((step: any) => step.file === 'scripts/verify-flue-offline-turn.mjs'), false);
  for (const script of ['build', 'verify:admin-ui', 'verify:cf-smoke', 'evaluate:agent-authoring', 'verify:node-scheduler-offline']) assert.ok(release.steps.some((step: any) => step.script === script));
  // Hygiene (manifest policy, leak scan, release manifest, lockfile) replaces
  // the separate verify:release and verify:lockfile-integrity steps.
  for (const script of ['verify:release', 'verify:lockfile-integrity']) assert.equal(release.steps.some((step: any) => step.script === script), false);
  assert.throws(() => createRegressionPlan({ areas: ['routines'], testFiles: [] }), /inventory is stale/);
  assert.throws(() => createRegressionPlan({ mode: 'typo', testFiles }), /mode must/);
  assert.throws(() => createRegressionPlan({ areas: ['typo'], testFiles }), /Unknown area/);
});

test('offline execution clears live build selectors and overrides operator state paths', () => {
  const env = regressionEnvironment({
    PATH: '/test/bin', CHICKPEA_DEPLOY_TARGET: 'amber', CHICKPEA_DEPLOY_AUTH_DB_ID: 'registered',
    CHICKPEA_LOCAL_STATE_PATH: '/private/state', CHICKPEA_ENV_TARGET: 'cobalt',
    WRANGLER_CI_OVERRIDE_NAME: 'live-worker', WORKERS_CI: '1', CLOUDFLARE_ENV: 'production',
    TAG_DB_PATH: '/operator/db', SLACK_STATE_DB_PATH: '/operator/slack', CHICKPEA_AUTH_DB_PATH: '/operator/auth',
    NODE_OPTIONS: '--test-reporter=tap', NODE_PATH: '/operator/node-modules',
  });
  assert.ok(env.PATH.endsWith('/test/bin'));
  assert.equal(env.FLUE_NODE_BIN, process.execPath);
  for (const key of ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH']) assert.equal(env[key], ':memory:');
  for (const key of ['CHICKPEA_DEPLOY_TARGET', 'CHICKPEA_DEPLOY_AUTH_DB_ID', 'CHICKPEA_LOCAL_STATE_PATH', 'CHICKPEA_ENV_TARGET', 'WRANGLER_CI_OVERRIDE_NAME', 'WORKERS_CI', 'CLOUDFLARE_ENV', 'NODE_OPTIONS', 'NODE_PATH']) assert.equal(env[key], undefined);
  assert.equal(env.TAG_REQUIRE_LOOPBACK, '1');
});

test('every plan starts with source hygiene and orders the rest cheapest first', () => {
  const release = createRegressionPlan({ mode: 'release', testFiles });
  assert.deepEqual(release.steps[0], { kind: 'npm', script: 'verify:hygiene' });
  const order = release.steps.map((step: { script?: string }) => step.script);
  assert.ok(order.indexOf('build') < order.indexOf('verify:admin-ui'));
  assert.ok(order.indexOf('verify:admin-ui') < order.indexOf('verify:node-scheduler-offline'));
  assert.ok(order.indexOf('verify:node-scheduler-offline') < order.indexOf('verify:cf-smoke'));
  assert.ok(order.indexOf('verify:cf-smoke') < order.indexOf('verify:oss-export'));
  for (const plan of [createRegressionPlan({ mode: 'regression', testFiles }), createRegressionPlan({ files: ['src/routines/scheduler.ts'], testFiles })]) {
    assert.deepEqual(plan.steps[0], { kind: 'npm', script: 'verify:hygiene', args: ['--working-tree'] });
    assert.equal(plan.steps.filter((step: { script?: string }) => step.script === 'verify:hygiene').length, 1);
  }
  assert.equal(isHygieneStep({ kind: 'npm', script: 'verify:hygiene' }), true);
  assert.equal(isHygieneStep({ kind: 'npm', script: 'build' }), false);
});

test('checks run in plan order and preserve the first failure without replay', async () => {
  const calls: string[] = [];
  const results = await runRegressionSteps([{ script: 'build' }, { script: 'test' }, { script: 'later' }], async (step: { script: string }) => {
    calls.push(step.script);
    return step.script === 'test' ? 1 : 0;
  });
  assert.deepEqual(calls, ['build', 'test']);
  assert.deepEqual(results.map((result: { status: number }) => result.status), [0, 1]);
});

test('a group runs together, every member finishes, and a failure stops later steps', async () => {
  let running = 0, peak = 0;
  const calls: string[] = [];
  const results = await runRegressionSteps([
    { script: 'test' }, { script: 'a', group: 'proofs' }, { script: 'b', group: 'proofs' }, { script: 'c', group: 'proofs' }, { script: 'export' },
  ], async (step: { script: string }, concurrent: boolean) => {
    calls.push(`${step.script}:${concurrent}`);
    running += 1; peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, step.script === 'a' ? 5 : 30));
    running -= 1;
    return step.script === 'a' ? 1 : 0;
  });
  assert.deepEqual(calls, ['test:false', 'a:true', 'b:true', 'c:true']);
  assert.equal(peak, 3);
  assert.deepEqual(results.map((result: { script: string, status: number }) => `${result.script}=${result.status}`), ['test=0', 'a=1', 'b=0', 'c=0']);
});

test('proofs after the suite form one group behind a single Node build; the export stays last and alone', () => {
  const full = createRegressionPlan({ files: ['src/new-runtime.ts'], testFiles });
  const scripts = full.steps.map((step: { script?: string, file?: string }) => step.script ?? step.file ?? 'tests');
  assert.deepEqual(scripts.slice(0, 4), ['verify:hygiene', 'build', 'test', 'flue:build']);
  for (const step of full.steps.slice(4)) assert.equal(step.group, 'proofs');
  for (const step of full.steps.slice(0, 4)) assert.equal(step.group, undefined);
  const release = createRegressionPlan({ mode: 'release', testFiles });
  assert.equal(release.steps.at(-1).script, 'verify:oss-export');
  assert.equal(release.steps.at(-1).group, undefined);
  const admin = createRegressionPlan({ files: ['assets/admin-ui/app.js'], testFiles });
  assert.equal(admin.steps.some((step: { script?: string }) => step.script === 'flue:build'), false);
});

test('argument parsing rejects missing values and supports explicit repeated areas', () => {
  const options = parseRegressionArgs(['--mode', 'changed', '--area', 'routines', '--area', 'delivery', '--plan']);
  assert.deepEqual(options.areas, ['routines', 'delivery']);
  assert.equal(options.planOnly, true);
  assert.throws(() => parseRegressionArgs(['--base', '--plan']), /requires a value/);
  assert.throws(() => parseRegressionArgs(['--allow-production']), /Unknown argument/);
  assert.throws(() => parseRegressionArgs(['--reuse']), /Unknown argument/);
  assert.throws(() => parseRegressionArgs(['--timeout-ms', '0']), /1000/);
});

test('stale node_modules are reported against package-lock.json before any check runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-lockfile-drift-'));
  try {
    const lock = (packages: Record<string, object>) => JSON.stringify({ lockfileVersion: 3, packages });
    writeFileSync(join(root, 'package-lock.json'), lock({
      '': { name: 'fixture' },
      'node_modules/@flue/runtime': { version: '2.1.0' },
      'node_modules/fsevents': { version: '2.3.3', optional: true },
      'node_modules/dev-only': { version: '1.0.0', devOptional: true },
      'node_modules/dev-present': { version: '1.0.0', devOptional: true },
    }));
    assert.deepEqual(lockfileDrift(root), [{ name: 'node_modules/.package-lock.json', locked: 'present', installed: 'missing' }]);
    mkdirSync(join(root, 'node_modules'));
    // An installed optional package is platform-dependent and never compared;
    // an installed devOptional package is.
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), lock({
      'node_modules/@flue/runtime': { version: '2.0.7' },
      'node_modules/fsevents': { version: '9.9.9' },
      'node_modules/dev-present': { version: '0.9.0' },
    }));
    assert.deepEqual(lockfileDrift(root), [
      { name: '@flue/runtime', locked: '2.1.0', installed: '2.0.7' },
      { name: 'dev-present', locked: '1.0.0', installed: '0.9.0' },
    ]);
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), lock({
      'node_modules/@flue/runtime': { version: '2.1.0' }, 'node_modules/dev-present': { version: '1.0.0' },
    }));
    assert.deepEqual(lockfileDrift(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
