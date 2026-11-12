import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error Executable helpers are JavaScript, shared with the runners.
import { recordFileReports } from '../scripts/lib/test-file-reports.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the runners.
import { readRunResults } from '../scripts/lib/test-run-results.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the runners.
import { FILE_STALL_MS, PER_TEST_TIMEOUT_MS, runnerFileStallMs, runnerTestTimeoutMs } from '../scripts/lib/test-timeout.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the runners.
import { testStepArgs } from '../scripts/verify-regression.mjs';

const RUNNER = new URL('../scripts/run-tests.mjs', import.meta.url).pathname;
const REPORT_PIPE = new URL('../scripts/lib/test-report-pipe.mjs', import.meta.url).href;
const FIXTURES = new URL('./fixtures/run-tests/', import.meta.url).pathname;

function runRunner(fixtures: string[], env: Record<string, string> = {}, options: string[] = []) {
  const result = spawnSync(process.execPath, [RUNNER, ...options, ...fixtures.map((name) => join(FIXTURES, name))], {
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

const fixture = (name: string) => `tests/fixtures/run-tests/${name}`;
const byFile = (retries: { file: string }[]) => [...retries].sort((a, b) => a.file.localeCompare(b.file));

test('files that lose a race in the parallel pass are rerun alone once, reported, and recorded for the caller', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-run-tests-'));
  try {
    const results = join(directory, 'results.jsonl');
    const result = runRunner(['pass.test.ts', 'flaky.test.ts', 'crash.test.ts'], {
      RUN_TESTS_FIXTURE_FLAKY_MARKER: join(directory, 'flaky'),
      RUN_TESTS_FIXTURE_CRASH_MARKER: join(directory, 'crash'),
      RUN_TESTS_RESULT_FILE: results,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const [, retryPass = ''] = result.stdout.split('rerunning each alone once:');
    const [rerunListing = '', verdict = ''] = retryPass.split('RETRIED IN ISOLATION');
    assert.match(rerunListing, /flaky\.test\.ts/);
    assert.match(rerunListing, /crash\.test\.ts/);
    assert.doesNotMatch(rerunListing.split('\n').slice(0, 3).join('\n'), /pass\.test\.ts/);
    assert.match(verdict, /2 file\(s\) failed under 8-way concurrency and passed alone/);
    assert.match(verdict, /flaky\.test\.ts[\s\S]*crash\.test\.ts|crash\.test\.ts[\s\S]*flaky\.test\.ts/);
    const [run, ...more] = readRunResults(results);
    assert.deepEqual(more, [], 'one line per pass');
    assert.deepEqual({ ...run, retries: byFile(run.retries) }, { exitCode: 0, failedOnRetry: false, retries: [
      { file: fixture('crash.test.ts'), alone: 'pass' }, { file: fixture('flaky.test.ts'), alone: 'pass' },
    ] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('--fail-on-retry still reruns each failed file alone, then fails the run even when every rerun passes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-run-tests-'));
  try {
    const results = join(directory, 'results.jsonl');
    const result = runRunner(['pass.test.ts', 'flaky.test.ts'], {
      RUN_TESTS_FIXTURE_FLAKY_MARKER: join(directory, 'flaky'), RUN_TESTS_RESULT_FILE: results,
    }, ['--fail-on-retry']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /rerunning each alone once:\n {2}\S*flaky\.test\.ts\n/);
    assert.match(result.stderr, /PASSED ONLY ON RETRY: 1 file\(s\) failed under 8-way concurrency and passed alone; --fail-on-retry fails the run on any retry:\n {2}\S*flaky\.test\.ts/);
    assert.doesNotMatch(result.stdout, /RETRIED IN ISOLATION/);
    assert.deepEqual(readRunResults(results), [{ exitCode: 1, failedOnRetry: true, retries: [{ file: fixture('flaky.test.ts'), alone: 'pass' }] }]);

    // A file that fails alone as well is a plain failure, recorded as such.
    const broken = runRunner(['flaky.test.ts', 'fail.test.ts'], {
      RUN_TESTS_FIXTURE_FLAKY_MARKER: join(directory, 'flaky-2'), RUN_TESTS_RESULT_FILE: results,
    }, ['--fail-on-retry']);
    assert.equal(broken.status, 1, broken.stdout + broken.stderr);
    assert.match(broken.stderr, /still failing alone:\n {2}\S*fail\.test\.ts\n/);
    assert.doesNotMatch(broken.stderr, /PASSED ONLY ON RETRY/);
    const [, second] = readRunResults(results);
    assert.deepEqual({ ...second, retries: byFile(second.retries) }, { exitCode: 1, failedOnRetry: false, retries: [
      { file: fixture('fail.test.ts'), alone: 'fail' }, { file: fixture('flaky.test.ts'), alone: 'pass' },
    ] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a clean --fail-on-retry pass exits 0, and a test process never sees the result file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-run-tests-'));
  try {
    const results = join(directory, 'results.jsonl');
    const result = runRunner(['pass.test.ts', 'result-file.test.ts'], { RUN_TESTS_RESULT_FILE: results }, ['--fail-on-retry']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(readRunResults(results), [{ exitCode: 0, failedOnRetry: false, retries: [] }]);
    assert.equal(readRunResults(join(directory, 'never-written.jsonl')), undefined, 'no runner, no results');
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

// node:test passes each of these files (its process exits 0) with one of its
// tests reported; the runner must fail the run instead, after a rerun alone.
for (const { fixture, why, shortfall } of [
  { fixture: 'exits-midway.test.ts', why: 'a process that exits partway', shortfall: "1 test(s) reported, then its process ended without the file's summary" },
  { fixture: 'force-exit-drops.test.ts', why: 'a forced exit that discards queued reports', shortfall: "1 test(s) reported, then its process ended without the file's summary" },
  { fixture: 'lost-reports.test.ts', why: 'reports lost before an intact summary', shortfall: 'its summary counts 4 test(s), but only 1 reported' },
]) {
  test(`a file that ends before all of its tests report fails the run: ${why}`, () => {
    const result = runRunner(['pass.test.ts', fixture]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const escape = (text: string) => text.replace(/[.()]/g, '\\$&');
    const notice = new RegExp(`1 file\\(s\\) ended before all of their tests reported; treating each as failed:\\n {2}\\S*${escape(fixture)}: ${escape(shortfall)}\\n`, 'g');
    assert.equal(result.stderr.match(notice)?.length, 2, `once in the parallel pass and once alone:\n${result.stderr}`);
    assert.match(result.stderr, new RegExp(`still failing alone:\\n {2}\\S*${escape(fixture)}`));
    assert.doesNotMatch(result.stderr, /pass\.test\.ts/);
    assert.doesNotMatch(result.stdout, /RETRIED IN ISOLATION/);
  });
}

test('a file counts as complete only when its own summary arrived and matches the tests that reported', () => {
  const stream = new EventEmitter();
  const reports = recordFileReports(stream);
  const complete = '/repo/tests/a.test.ts';
  const unsummarized = '/repo/tests/b.test.ts';
  const short = '/repo/tests/c.test.ts';
  const fewerSuites = '/repo/tests/d.test.ts';
  const failing = '/repo/tests/e.test.ts';
  const report = (type: string, entryFile: string, suite = false) =>
    stream.emit(type, { entryFile, file: '/repo/tests/shared-helper.ts', name: 'a test', ...(suite ? { details: { type: 'suite' } } : {}) });
  const summary = (entryFile: string, tests: number, suites = 0) => stream.emit('test:summary', { entryFile, file: entryFile, counts: { tests, suites } });

  // Tests a shared helper declares count for the file whose process ran them.
  report('test:pass', complete); report('test:pass', complete, true); summary(complete, 1, 1);
  report('test:pass', unsummarized);
  report('test:pass', short); summary(short, 3);
  report('test:pass', fewerSuites); summary(fewerSuites, 1, 1);
  report('test:pass', failing); report('test:fail', failing); summary(failing, 2);
  // The runner's own events for a file, and its final summary, carry no entryFile.
  stream.emit('test:pass', { name: short, file: short });
  stream.emit('test:summary', { counts: { tests: 99, suites: 0 } });

  assert.equal(reports.reported(complete), 2);
  assert.equal(reports.shortfall(complete), undefined);
  assert.equal(reports.shortfall(failing), undefined);
  assert.equal(reports.shortfall(unsummarized), "1 test(s) reported, then its process ended without the file's summary");
  assert.equal(reports.shortfall(short), 'its summary counts 3 test(s), but only 1 reported');
  assert.equal(reports.shortfall(fewerSuites), 'its summary counts 2 test(s), but only 1 reported');
  assert.equal(reports.reported('/repo/tests/never-ran.test.ts'), 0);
  assert.equal(reports.shortfall('/repo/tests/never-ran.test.ts'), "0 test(s) reported, then its process ended without the file's summary");
});

test('every test file\'s process starts with the report-pipe preload', () => {
  const result = runRunner(['report-pipe.test.ts']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('with the preload a report write blocks until the runner takes it, so an immediate exit loses nothing', async () => {
  // Far more than a pipe holds, written just before process.exit(), as
  // --test-force-exit does. No pipe drains that much before the exit, so the
  // same write without the preload loses its queued tail: this tells them apart.
  const bytes = 2 * 1024 * 1024;
  const received = async (preload: string[]) => {
    const child = spawn(process.execPath, [...preload, '-e', `process.stdout.write(Buffer.alloc(${bytes}, 120)); process.exit(0);`], {
      env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let count = 0;
    child.stdout.on('data', (chunk: Buffer) => { count += chunk.length; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    return count;
  };
  assert.equal(await received(['--import', REPORT_PIPE]), bytes);
  const unprotected = await received([]);
  assert.ok(unprotected < bytes, `without the preload ${unprotected} of ${bytes} bytes should arrive`);
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

test('each file runs without the V8 background compilers that can deadlock its exit', () => {
  const result = runRunner(['v8-flags.test.ts']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// The stall window for fixtures: long enough for a fixture to load on a busy host.
const STALL = { RUN_TESTS_FIXTURE_STALL_MS: '6000' };

test('a file whose process never ends after its tests pass is named within the stall window, stopped, and rerun alone', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-run-tests-'));
  try {
    const started = Date.now();
    const result = runRunner(['exit-hang.test.ts'], { ...STALL, RUN_TESTS_FIXTURE_EXIT_HANG_MARKER: join(directory, 'exit-hang') });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /HUNG: \S*exit-hang\.test\.ts started and finished no test for \d+ s \(limit 6 s\)\. No test was running: the last test it finished was "passes before its process hangs at exit"/);
    assert.match(result.stderr, /Its processes \(pid, state, elapsed, CPU, command\):\n {4}\d+ \S+ [\d:.-]+ [\d:.]+ node … \S*exit-hang\.test\.ts\n[\s\S]*Stopping them; the file fails/);
    assert.match(result.stdout, /RETRIED IN ISOLATION: 1 file\(s\)[\s\S]*exit-hang\.test\.ts/);
    assert.ok(Date.now() - started < 60_000, 'named and stopped within seconds of the window');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a file that blocks its event loop is named with the test it was running, and fails when it blocks alone too', () => {
  const result = runRunner(['blocked.test.ts'], STALL);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /HUNG: \S*blocked\.test\.ts started and finished no test for \d+ s \(limit 6 s\)\. It was running "blocks its event loop" \(started \d+ s ago\); the last test it finished was "finishes first"\./);
  assert.equal(result.stderr.match(/HUNG: /g)?.length, 2, 'once in the pass and once alone');
  assert.match(result.stderr, /still failing alone:\n {2}\S*blocked\.test\.ts/);
});

test('a file held open by a process outside its own stops the pass, named, instead of holding it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-run-tests-'));
  const pidFile = join(directory, 'orphan.pid');
  try {
    const started = Date.now();
    const result = runRunner(['orphan.test.ts'], { ...STALL, RUN_TESTS_FIXTURE_ORPHAN_PID_FILE: pidFile });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /HUNG: \S*orphan\.test\.ts [\s\S]*none found\n {2}None to stop; the file fails, and the pass stops if it has not ended in 6 s\./);
    assert.match(result.stderr, /\S*orphan\.test\.ts has still not ended after its processes were stopped: something outside them holds its output\. Stopping the pass\./);
    assert.doesNotMatch(result.stdout, /rerunning each alone/);
    assert.ok(Date.now() - started < 60_000, 'the pass stops within seconds of the window');
  } finally {
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a file held open by a process outside its own in the rerun alone ends the runner too, instead of leaving it waiting on that process', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-run-tests-'));
  const pidFile = join(directory, 'orphan.pid');
  try {
    const started = Date.now();
    const result = runRunner(['orphan.test.ts'], { ...STALL, RUN_TESTS_FIXTURE_ORPHAN_PID_FILE: pidFile, RUN_TESTS_FIXTURE_ORPHAN_FAIL_FIRST_MARKER: join(directory, 'failed-first') });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /rerunning each alone once:\n {2}\S*orphan\.test\.ts/);
    assert.match(result.stderr, /\S*orphan\.test\.ts has still not ended after its processes were stopped: something outside them holds its output\. Stopping the pass\./);
    assert.match(result.stderr, /still failing alone:\n {2}\S*orphan\.test\.ts/);
    // The process left behind lives for a minute; the runner must not wait for it.
    assert.ok(Date.now() - started < 45_000, 'the runner exits within seconds of the window');
  } finally {
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
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
  // The stall window has the same guard, and runs a minute past the per-test timeout.
  assert.equal(runnerFileStallMs([hang], { RUN_TESTS_FIXTURE_STALL_MS: '1000' }), 1000);
  assert.equal(runnerFileStallMs([hang, real], { RUN_TESTS_FIXTURE_STALL_MS: '1000' }), FILE_STALL_MS);
  assert.equal(runnerFileStallMs([hang], short), FILE_STALL_MS, 'the timeout override leaves the window alone');
  assert.equal(FILE_STALL_MS, PER_TEST_TIMEOUT_MS + 60_000);
});

test('every test run goes through the runner, with its two-minute per-test timeout and its report checks', () => {
  assert.equal(PER_TEST_TIMEOUT_MS, 120_000);
  const script = (manifest: string) => JSON.parse(readFileSync(new URL(manifest, import.meta.url), 'utf8')).scripts.test as string;
  assert.match(script('../package.json'), /node scripts\/run-tests\.mjs --typecheck tests\/\*\.test\.ts/);
  assert.match(script('../packages/cli/package.json'), /node \.\.\/\.\.\/scripts\/run-tests\.mjs tests\/\*\.test\.ts/);
  assert.deepEqual(testStepArgs(['tests/a.test.ts']), [RUNNER, '--fail-on-retry', 'tests/a.test.ts']);
  // No script, helper or fixture under scripts/ starts node's own test runner,
  // which passes a file that ends early.
  const scripts = new URL('../scripts/', import.meta.url).pathname;
  const scanned = readdirSync(scripts, { recursive: true }).map(String)
    .filter((name) => name !== 'run-tests.mjs' && statSync(join(scripts, name)).isFile());
  for (const name of ['verify-regression.mjs', 'lib/test-timeout.mjs', 'fixtures/cloudflare-ai-binding-smoke.mjs']) {
    assert.ok(scanned.includes(name), `the scan covers ${name}`);
  }
  const direct = scanned.filter((name) => /(?:['"`]|\bnode\s+)--test(?![\w-])/.test(readFileSync(join(scripts, name), 'utf8')));
  assert.deepEqual(direct, []);
  assert.doesNotMatch(script('../packages/cli/package.json'), /--test\b/);
});
