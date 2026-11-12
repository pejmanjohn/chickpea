/**
 * Every node:test run in this repository fails a single test after two
 * minutes, so a hung test cannot hold the host reservation for an hour. The
 * slowest test measured in a full pass takes about 42 s.
 *
 * A timeout alone does not end a file whose hung test keeps a server or timer
 * alive, so scripts/run-tests.mjs also exits each test process once its tests
 * (and their `after` hooks) have finished. The CLI package's tests and
 * verify:regression's focused test steps run through that runner too.
 *
 * Nothing in node:test bounds a file's process itself, so the runner also stops
 * a file that starts and finishes no test for FILE_STALL_MS
 * (scripts/lib/test-file-watchdog.mjs).
 */
import { fileURLToPath } from 'node:url';

export const PER_TEST_TIMEOUT_MS = 120_000;
/**
 * A minute past the per-test timeout, so a test or hook that node:test can
 * still time out never trips it. A test that sets a longer timeout of its own
 * is cut off here instead, and reruns alone like any failed file.
 */
export const FILE_STALL_MS = PER_TEST_TIMEOUT_MS + 60_000;

const RUNNER_FIXTURES = fileURLToPath(new URL('../../tests/fixtures/run-tests/', import.meta.url));

/**
 * A limit for one scripts/run-tests.mjs pass over `files` (absolute paths):
 * tests/run-tests.test.ts shortens it through `override` to fail a hung
 * fixture quickly. The override counts only when every file is one of the
 * runner's own fixtures, so it can never change a real run's limit.
 */
function fixtureLimitMs(files, override, limit) {
  const ms = Number(override);
  const fixturesOnly = files.length > 0 && files.every((file) => file.startsWith(RUNNER_FIXTURES));
  return fixturesOnly && Number.isSafeInteger(ms) && ms > 0 ? ms : limit;
}

/** The per-test timeout for a pass over `files`; RUN_TESTS_FIXTURE_TIMEOUT_MS shortens it for fixtures. */
export function runnerTestTimeoutMs(files, env = process.env) {
  return fixtureLimitMs(files, env.RUN_TESTS_FIXTURE_TIMEOUT_MS, PER_TEST_TIMEOUT_MS);
}

/** How long a file in a pass over `files` may go without progress; RUN_TESTS_FIXTURE_STALL_MS shortens it for fixtures. */
export function runnerFileStallMs(files, env = process.env) {
  return fixtureLimitMs(files, env.RUN_TESTS_FIXTURE_STALL_MS, FILE_STALL_MS);
}
