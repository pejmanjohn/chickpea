import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';

// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { createRegressionPlan } from '../scripts/lib/regression-plan.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { parseRegressionArgs, regressionEnvironment, runRegressionSteps } from '../scripts/verify-regression.mjs';

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
});

test('unknown runtime changes and deleted tests broaden verification instead of yielding a false pass', () => {
  for (const file of ['src/new-runtime.ts', 'src/admin/routes.ts', 'package-lock.json', 'tests/deleted.test.ts', 'tests/helpers/new-fixture.ts', 'src/new-prompt.md', 'tests/fixtures/prompt.txt']) {
    const plan = createRegressionPlan({ files: [file], testFiles });
    assert.equal(plan.fullTests, true, file);
    assert.ok(plan.steps.some((step: { script?: string }) => step.script === 'test'));
    assert.ok(plan.steps.some((step: { script?: string }) => step.script === 'verify:cf-smoke'));
  }
});

test('documentation changes skip runtime checks while an unspecified scope runs core regression', () => {
  assert.deepEqual(createRegressionPlan({ files: ['README.md'], testFiles }).steps, []);
  assert.ok(createRegressionPlan({ testFiles }).steps.length > 0);
  assert.ok(createRegressionPlan({ files: ['qa/live/operator/SKILL.md'], testFiles }).areas.includes('verification'));
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
  for (const script of ['build', 'verify:admin-ui', 'verify:cf-smoke', 'evaluate:agent-authoring', 'verify:lockfile-integrity']) assert.ok(release.steps.some((step: any) => step.script === script));
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
  });
  assert.ok(env.PATH.endsWith('/test/bin'));
  assert.equal(env.FLUE_NODE_BIN, process.execPath);
  for (const key of ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH']) assert.equal(env[key], ':memory:');
  for (const key of ['CHICKPEA_DEPLOY_TARGET', 'CHICKPEA_DEPLOY_AUTH_DB_ID', 'CHICKPEA_LOCAL_STATE_PATH', 'CHICKPEA_ENV_TARGET', 'WRANGLER_CI_OVERRIDE_NAME', 'WORKERS_CI', 'CLOUDFLARE_ENV']) assert.equal(env[key], undefined);
  assert.equal(env.TAG_REQUIRE_LOOPBACK, '1');
});

test('checks run serially and preserve the first failure without replay', () => {
  const calls: string[] = [];
  const results = runRegressionSteps([{ script: 'build' }, { script: 'test' }, { script: 'later' }], (step: { script: string }) => {
    calls.push(step.script);
    return step.script === 'test' ? 1 : 0;
  });
  assert.deepEqual(calls, ['build', 'test']);
  assert.deepEqual(results.map((result: { status: number }) => result.status), [0, 1]);
});

test('argument parsing rejects missing values and supports explicit repeated areas', () => {
  const options = parseRegressionArgs(['--mode', 'changed', '--area', 'routines', '--area', 'delivery', '--plan']);
  assert.deepEqual(options.areas, ['routines', 'delivery']);
  assert.equal(options.planOnly, true);
  assert.throws(() => parseRegressionArgs(['--base', '--plan']), /requires a value/);
  assert.throws(() => parseRegressionArgs(['--allow-production']), /Unknown argument/);
  assert.throws(() => parseRegressionArgs(['--reuse']), /needs --record/);
  assert.throws(() => parseRegressionArgs(['--record', '/private/run.json', '--mode', 'release', '--reuse']), /full release checkpoint/);
  assert.throws(() => parseRegressionArgs(['--timeout-ms', '0']), /1000/);
});
