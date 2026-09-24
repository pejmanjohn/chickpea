#!/usr/bin/env node
/**
 * Root test runner: `node --test` with a bounded retry for host flakes.
 *
 * The parallel pass runs every file under the usual concurrency. Files that
 * fail there are rerun once, alone and serially. A file that passes alone is
 * reported loudly as RETRIED IN ISOLATION so the log keeps the evidence; a
 * file that fails twice fails the run. When many files fail in the parallel
 * pass, nothing is retried: that is breakage, not a lost port or a killed
 * worker, and a rerun would only hide it for ten minutes.
 *
 * A file whose process ends without reporting a single test counts as failed.
 * node:test reports such a file as passing (its only event is a file-level
 * pass with no subtests), which is how a worker that dies quietly with exit 0
 * used to pass the gate.
 *
 * Files start longest first: node:test dequeues them in the given order, and a
 * slow file that starts late sets the tail of the whole pass. `--typecheck`
 * runs `tsc --noEmit` beside the pass instead of before it; a type error stops
 * the pass as soon as tsc reports it.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, resolve, relative } from 'node:path';
import { finished } from 'node:stream/promises';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const CONCURRENCY = 8;
const MAX_RETRIED_FILES = CONCURRENCY;
// Files measured at 5 s or more inside the 8-way pass, slowest first. Split
// parts (`name-2`) share their base name's position. A stale entry only costs
// scheduling time, never coverage.
const SLOW_FIRST = [
  'environment-registry', 'upgrade-cli', 'verification-record', 'node-installer-bootstrap',
  'flue-progressive-characterization', 'environment-preflight', 'deploy-with-epilogue',
  'live-contract-coordinator', 'environment-wait', 'images-openai-client-workerd', 'admin-visual-fixture',
];

const args = process.argv.slice(2);
const withTypecheck = args[0] === '--typecheck';
const files = (withTypecheck ? args.slice(1) : args).map((file) => resolve(file));
if (files.length === 0) {
  console.error('Usage: node scripts/run-tests.mjs [--typecheck] <test files...>');
  process.exitCode = 2;
} else {
  process.exitCode = await main(longestFirst(files));
}

function slowRank(file) {
  const name = basename(file).replace(/\.test\.ts$/, '').replace(/-\d+$/, '');
  const rank = SLOW_FIRST.indexOf(name);
  return rank === -1 ? SLOW_FIRST.length : rank;
}

function longestFirst(list) {
  return list.map((file, index) => ({ file, index }))
    .sort((a, b) => slowRank(a.file) - slowRank(b.file) || a.index - b.index)
    .map(({ file }) => file);
}

async function main(list) {
  const controller = new AbortController();
  const typecheck = withTypecheck ? startTypecheck(controller) : undefined;
  const failed = await runFiles(list, CONCURRENCY, controller.signal);
  if (typecheck && (await typecheck) !== 0) return 1;
  if (failed.length === 0) return 0;
  if (failed.length > MAX_RETRIED_FILES) {
    console.error(`\n[run-tests] ${failed.length} test files failed; not retrying.`);
    return 1;
  }
  console.log(`\n[run-tests] ${failed.length} file(s) failed under ${CONCURRENCY}-way concurrency; rerunning each alone once:\n${listing(failed)}`);
  const stillFailing = await runFiles(failed, 1);
  if (stillFailing.length > 0) {
    console.error(`\n[run-tests] still failing alone:\n${listing(stillFailing)}`);
    return 1;
  }
  console.log(`\n[run-tests] RETRIED IN ISOLATION: ${failed.length} file(s) failed under ${CONCURRENCY}-way concurrency and passed alone. Treat this as a host race unless it repeats:\n${listing(failed)}`);
  return 0;
}

/** Resolves to tsc's exit code; a failure prints tsc's output and aborts the pass. */
function startTypecheck(controller) {
  // The fixture override lets tests/run-tests.test.ts exercise a failing tsc.
  const tsc = process.env.RUN_TESTS_FIXTURE_TSC ?? createRequire(import.meta.url).resolve('typescript/bin/tsc');
  return new Promise((done) => execFile(process.execPath, [tsc, '--noEmit'], (error, stdout, stderr) => {
    if (error) {
      console.error(`\n[run-tests] typecheck failed; stopping the test pass:\n${stdout}${stderr}`);
      controller.abort(new Error('typecheck failed'));
    }
    done(error ? 1 : 0);
  }));
}

async function runFiles(list, concurrency, signal) {
  const failed = new Set();
  const reported = new Set();
  // A child spawned by node:test inherits this marker and would treat the
  // files here as already-running test children, reporting nothing. Clear it
  // so the runner also works when a test launches it.
  delete process.env.NODE_TEST_CONTEXT;
  const stream = run({ files: list, concurrency, execArgv: ['--import', 'tsx'], ...(signal ? { signal } : {}) });
  // Every failure event names its file, including a file whose process exited
  // non-zero before reporting (a killed worker or a crash at load).
  stream.on('test:fail', (event) => {
    if (event.file) failed.add(resolve(event.file));
  });
  // The file itself is reported as one pass/fail event whose name is its path;
  // anything else under that file is a real test that ran.
  for (const type of ['test:pass', 'test:fail']) {
    stream.on(type, (event) => {
      if (event.file && resolve(event.file) !== resolve(event.name)) reported.add(resolve(event.file));
    });
  }
  const report = stream.compose(spec);
  report.pipe(process.stdout, { end: false });
  await finished(report);
  const silent = list.filter((file) => !reported.has(file) && !failed.has(file));
  if (silent.length > 0) {
    console.error(`\n[run-tests] ${silent.length} file(s) ended without reporting any test; treating each as failed:\n${listing(silent)}`);
    for (const file of silent) failed.add(file);
  }
  return [...failed];
}

function listing(paths) {
  return paths.map((path) => `  ${relative(process.cwd(), path)}`).join('\n');
}
