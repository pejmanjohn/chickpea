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
 */
import { resolve, relative } from 'node:path';
import { finished } from 'node:stream/promises';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const CONCURRENCY = 4;
const MAX_RETRIED_FILES = 5;

const files = process.argv.slice(2).map((file) => resolve(file));
if (files.length === 0) {
  console.error('Usage: node scripts/run-tests.mjs <test files...>');
  process.exitCode = 2;
} else {
  process.exitCode = await main(files);
}

async function main(list) {
  const failed = await runFiles(list, CONCURRENCY);
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

async function runFiles(list, concurrency) {
  const failed = new Set();
  const reported = new Set();
  // A child spawned by node:test inherits this marker and would treat the
  // files here as already-running test children, reporting nothing. Clear it
  // so the runner also works when a test launches it.
  delete process.env.NODE_TEST_CONTEXT;
  const stream = run({ files: list, concurrency, execArgv: ['--import', 'tsx'] });
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
