import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

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
    assert.match(verdict, /2 file\(s\) failed under 4-way concurrency and passed alone/);
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
