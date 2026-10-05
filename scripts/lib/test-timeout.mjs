/**
 * Every node:test run in this repository fails a single test after two
 * minutes, so a hung test cannot hold the host reservation for an hour. The
 * slowest test measured in a full pass takes about 9 s.
 *
 * A timeout alone does not end a file whose hung test keeps a server or timer
 * alive, so the runner also exits each test process once its tests (and their
 * `after` hooks) have finished. packages/cli/package.json passes the same flags.
 */
import { fileURLToPath } from 'node:url';

export const PER_TEST_TIMEOUT_MS = 120_000;
export const NODE_TEST_TIMEOUT_ARGS = Object.freeze([`--test-timeout=${PER_TEST_TIMEOUT_MS}`, '--test-force-exit']);

const RUNNER_FIXTURES = fileURLToPath(new URL('../../tests/fixtures/run-tests/', import.meta.url));

/**
 * The per-test timeout for one scripts/run-tests.mjs pass over `files`
 * (absolute paths). tests/run-tests.test.ts shortens it with
 * RUN_TESTS_FIXTURE_TIMEOUT_MS to fail a hung fixture quickly. The override
 * counts only when every file is one of the runner's own fixtures, so it can
 * never change a real run's limit.
 */
export function runnerTestTimeoutMs(files, env = process.env) {
  const override = Number(env.RUN_TESTS_FIXTURE_TIMEOUT_MS);
  const fixturesOnly = files.length > 0 && files.every((file) => file.startsWith(RUNNER_FIXTURES));
  return fixturesOnly && Number.isSafeInteger(override) && override > 0 ? override : PER_TEST_TIMEOUT_MS;
}
