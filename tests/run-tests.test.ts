import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error Executable helpers are JavaScript, shared with the runners.
import { NODE_TEST_TIMEOUT_ARGS, PER_TEST_TIMEOUT_MS, runnerTestTimeoutMs } from '../scripts/lib/test-timeout.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the runners.
import { testStepArgs } from '../scripts/verify-regression.mjs';

const RUNNER = new URL('../scripts/run-tests.mjs', import.meta.url).pathname;
const FIXTURES = new URL('./fixtures/run-tests/', import.meta.url).pathname;

function runRunner(fixtures: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [RUNNER, ...fixtures.map((name) => join(FIXTURES, name))], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DO_NOT_TRACK: '1', ...env },
  });
  assert.ifError(result.error);
  return result;
}

test('a clean parallel pass exits 0 without a retry notice', () => {
  const result = runRunner(['pass.test.ts']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /RETRIED IN ISOLATION|rerunning each alone/);
});

test('files that lose a race in the parallel pass are rerun alone once and reported', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-run-tests-'));
  try {
    const result = runRunner(['pass.test.ts', 'flaky.test.ts', 'crash.test.ts'], {
      RUN_TESTS_FIXTURE_FLAKY_MARKER: join(directory, 'flaky'),
      RUN_TESTS_FIXTURE_CRASH_MARKER: join(directory, 'crash'),
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const [, retryPass = ''] = result.stdout.split('rerunning each alone once:');
    const [rerunListing = '', verdict = ''] = retryPass.split('RETRIED IN ISOLATION');
    assert.match(rerunListing, /flaky\.test\.ts/);
    assert.match(rerunListing, /crash\.test\.ts/);
    assert.doesNotMatch(rerunListing.split('\n').slice(0, 3).join('\n'), /pass\.test\.ts/);
    assert.match(verdict, /2 file\(s\) failed under 8-way concurrency and passed alone/);
    assert.match(verdict, /flaky\.test\.ts[\s\S]*crash\.test\.ts|crash\.test\.ts[\s\S]*flaky\.test\.ts/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a file that ends without reporting any test is treated as failed, retried alone, and reported', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-run-tests-'));
  try {
    const result = runRunner(['pass.test.ts', 'silent.test.ts'], {
      RUN_TESTS_FIXTURE_SILENT_MARKER: join(directory, 'silent'),
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /1 file\(s\) ended without reporting any test; treating each as failed:[\s\S]*silent\.test\.ts/);
    assert.match(result.stdout, /rerunning each alone once:[\s\S]*silent\.test\.ts/);
    assert.match(result.stdout, /RETRIED IN ISOLATION: 1 file\(s\)[\s\S]*silent\.test\.ts/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a file that never reports a test fails the run instead of passing silently', () => {
  const result = runRunner(['pass.test.ts', 'always-silent.test.ts']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /ended without reporting any test[\s\S]*always-silent\.test\.ts/);
  assert.match(result.stderr, /still failing alone:[\s\S]*always-silent\.test\.ts/);
  assert.doesNotMatch(result.stdout, /RETRIED IN ISOLATION/);
});

test('a file that fails alone as well fails the run', () => {
  const result = runRunner(['pass.test.ts', 'fail.test.ts']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /rerunning each alone once:[\s\S]*fail\.test\.ts/);
  assert.match(result.stderr, /still failing alone:[\s\S]*fail\.test\.ts/);
  assert.doesNotMatch(result.stdout, /RETRIED IN ISOLATION/);
});

test('the runner refuses to start without files', () => {
  const result = runRunner([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage/);
});

function runWithTypecheck(fixtures: string[], tsc: string) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [RUNNER, '--typecheck', ...fixtures.map((name) => join(FIXTURES, name))], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DO_NOT_TRACK: '1', RUN_TESTS_FIXTURE_TSC: join(FIXTURES, tsc) },
  });
  assert.ifError(result.error);
  return { ...result, elapsedMs: Date.now() - startedAt };
}

test('a concurrent typecheck failure stops the test pass and fails the run', () => {
  const result = runWithTypecheck(['slow.test.ts'], 'tsc-fail.mjs');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /typecheck failed; stopping the test pass[\s\S]*TS2322/);
  assert.ok(result.elapsedMs < 4_500, `the 5 s fixture should have been stopped, took ${result.elapsedMs} ms`);
  assert.doesNotMatch(result.stdout, /rerunning each alone/);
});

test('a clean concurrent typecheck leaves the pass result unchanged', () => {
  assert.equal(runWithTypecheck(['pass.test.ts'], 'tsc-pass.mjs').status, 0);
  assert.equal(runWithTypecheck(['fail.test.ts'], 'tsc-pass.mjs').status, 1);
});

test('a hung test that holds a live handle fails at the per-test timeout instead of holding the run', () => {
  const started = Date.now();
  const result = runRunner(['pass.test.ts', 'hang.test.ts'], { RUN_TESTS_FIXTURE_TIMEOUT_MS: '1000' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /test timed out after 1000ms/);
  assert.match(result.stderr, /still failing alone:[\s\S]*hang\.test\.ts/);
  assert.ok(Date.now() - started < 60_000, 'both passes end within seconds of the timeout');
});

test('the fixture timeout override shortens only a pass over the runner\'s own fixtures', () => {
  const hang = join(FIXTURES, 'hang.test.ts');
  const real = resolve(FIXTURES, '../../run-tests.test.ts');
  const short = { RUN_TESTS_FIXTURE_TIMEOUT_MS: '1000' };
  assert.equal(runnerTestTimeoutMs([hang], short), 1000);
  assert.equal(runnerTestTimeoutMs([hang, real], short), PER_TEST_TIMEOUT_MS, 'one real file keeps the real limit for the pass');
  assert.equal(runnerTestTimeoutMs([real], short), PER_TEST_TIMEOUT_MS);
  assert.equal(runnerTestTimeoutMs([real], { RUN_TESTS_FIXTURE_TIMEOUT_MS: '999999999' }), PER_TEST_TIMEOUT_MS, 'nor can it lengthen a real run');
  assert.equal(runnerTestTimeoutMs([resolve(FIXTURES, '../run-tests-elsewhere/hang.test.ts')], short), PER_TEST_TIMEOUT_MS);
  assert.equal(runnerTestTimeoutMs([hang], {}), PER_TEST_TIMEOUT_MS);
  for (const value of ['-1', '0', '1.5', 'soon']) assert.equal(runnerTestTimeoutMs([hang], { RUN_TESTS_FIXTURE_TIMEOUT_MS: value }), PER_TEST_TIMEOUT_MS, value);
  assert.equal(runnerTestTimeoutMs([], short), PER_TEST_TIMEOUT_MS);
});

test('every test runner shares the two-minute per-test timeout and exits after its tests', () => {
  assert.equal(PER_TEST_TIMEOUT_MS, 120_000);
  assert.deepEqual(NODE_TEST_TIMEOUT_ARGS, ['--test-timeout=120000', '--test-force-exit']);
  const cli = JSON.parse(readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8')).scripts.test.split(' ');
  for (const arg of NODE_TEST_TIMEOUT_ARGS) assert.ok(cli.includes(arg), `packages/cli test passes ${arg}`);
  assert.deepEqual(testStepArgs(['tests/a.test.ts']), ['--test', ...NODE_TEST_TIMEOUT_ARGS, '--import', 'tsx', 'tests/a.test.ts']);
});
