/**
 * Every node:test run in this repository fails a single test after two
 * minutes, so a hung test cannot hold the host reservation for an hour. The
 * slowest test measured in a full pass takes about 9 s.
 *
 * A timeout alone does not end a file whose hung test keeps a server or timer
 * alive, so the runner also exits each test process once its tests (and their
 * `after` hooks) have finished. packages/cli/package.json passes the same flags.
 */
export const PER_TEST_TIMEOUT_MS = 120_000;
export const NODE_TEST_TIMEOUT_ARGS = Object.freeze([`--test-timeout=${PER_TEST_TIMEOUT_MS}`, '--test-force-exit']);
