/**
 * What a scripts/run-tests.mjs pass tells its caller beyond an exit code: the
 * files it reran alone, and whether each then passed.
 *
 * A caller names a file in RUN_TESTS_RESULT_FILE, and every runner its command
 * starts appends one JSON line there (`npm test` starts two: the root suite and
 * the CLI package's tests). The runner takes the variable out of its own
 * environment, so a runner that a test starts never writes to the file.
 * verify:regression gives each step its own file and records the retries in
 * the step's receipt and the run summary.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export const RUN_RESULT_FILE_ENV = 'RUN_TESTS_RESULT_FILE';

/** `result`: `{ exitCode, retries: [{ file, alone: 'pass' | 'fail' }], failedOnRetry }`. */
export function appendRunResult(file, result) {
  appendFileSync(file, `${JSON.stringify(result)}\n`);
}

/**
 * Every pass recorded in `file`, or undefined when no runner wrote it. A line
 * cut short by a killed runner is skipped; that step fails on its signal.
 */
export function readRunResults(file) {
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try { return line ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

/** Whether the passes failed only because --fail-on-retry refused files that passed alone. */
export const failedOnlyOnRetry = (results) => results.some((result) => result.failedOnRetry)
  && results.every((result) => result.exitCode === 0 || result.failedOnRetry);
