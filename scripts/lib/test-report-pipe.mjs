/**
 * Preloaded into every test file's process by scripts/run-tests.mjs.
 *
 * A test process sends its reports to the runner over a pipe, and on POSIX a
 * pipe write that does not fit is queued inside the process. The runner's
 * --test-force-exit ends the process with process.exit() once its last test
 * finishes, and process.exit() discards that queue. When the runner was busy,
 * a file then stopped partway with exit code 0 and passed:
 * tests/slack-reply-continuations.test.ts once delivered 49 of its 62 tests.
 * Blocking writes keep every report: each write returns once the pipe has
 * taken it. scripts/lib/test-file-reports.mjs still fails any file whose
 * reports come up short.
 */
if (process.env.NODE_TEST_CONTEXT === 'child-v8') process.stdout._handle?.setBlocking?.(true);
