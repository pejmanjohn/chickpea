/**
 * Preloaded into every test file's process by scripts/run-tests.mjs.
 *
 * A test process sends its reports to the runner over a pipe, and on POSIX a
 * pipe write that does not fit is queued inside the process. The runner's
 * --test-force-exit ends the process with process.exit() once its last test
 * finishes, and process.exit() discards that queue, so a file whose runner was
 * busy could end partway with exit code 0. Blocking writes keep every report:
 * each write returns once the pipe has taken it.
 * scripts/lib/test-file-reports.mjs still fails any file whose reports come up
 * short.
 *
 * The cost: while the runner stops reading, this process stops with it, and
 * that stall counts against the running test's 120 s budget
 * (scripts/lib/test-timeout.mjs).
 */
if (process.env.NODE_TEST_CONTEXT === 'child-v8') process.stdout._handle?.setBlocking?.(true);
