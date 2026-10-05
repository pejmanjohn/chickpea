# Expensive checks on one host

This workflow applies to development and QA, including release verification
and deployment builds. Customer installs and updates from published releases,
with only local installation settings changed, follow the
[install guide](../../../INSTALL_CHICKPEA_CLOUDFLARE.md) or
[update guide](../../../UPDATE_CHICKPEA_CLOUDFLARE.md) without contributor host
reservations, process inspection, or test suites.

## What takes the reservation

The reservation, `~/.chickpea/verification-host/owner.json`, is for work that
competes for this host's ports, processes, build output or CPU long enough to
time out another task's fixtures:

- builds, including the build inside a guarded deploy;
- workerd smokes and boot checks;
- any suite or test file that starts workerd or a server, binds a port, or
  starts a test Postgres database. This repository's full `npm test` does all
  of these, so it stays reserved.

Typecheck, plain unit tests and mutation passes that start none of those do
not take it. Run them directly, before or while waiting for the reservation.
When unsure whether a test file starts a fixture, read it or reserve it; a
fixture that binds a port keeps taking its port from the shared port lock
either way.

Use `verify:regression` for normal check groups. It runs `verify:hygiene` and,
when the plan has a separate one, `typecheck` first without the reservation,
then reserves the host for the rest of the serial group, including export
children. A plan that consists only of `verify:hygiene` never reserves. The
reservation is shared across this user's worktrees and does not depend on a
checkout's temporary directory. For standalone commands:

```sh
npm run verify:host -- npm test
npm run verify:host -- npm run build
npm run verify:host -- npm run verify:cf-smoke
npm run verify:host -- --wait-ms 300000 npm run build
npm run verify:regression -- --area verification --wait-ms 300000
```

For a deliberate multi-command group, pass a shell explicitly and set isolated
database variables as in CONTRIBUTING. Nested commands inherit the owner's
reservation. A competing process exits before running checks and reports the
owner PID, checkout and exact file. Continue source review, typechecking, plain
unit tests and mutation passes. Retry the reservation after the owner finishes;
do not kill, suspend or change that task's processes.

The wrapper does not discover older unwrapped tests. Before the first group in
a session, inspect known active test/build processes and coordinate with their
owner. All operators must use the same wrapper for expensive standalone groups.
This is one local reservation, not a fair queue or a general scheduler. The
default remains fail-fast. `--wait-ms` adds bounded caller-side polling, at most
two hours; `verify:host` also accepts `--poll-ms` (10..30000). Only a live owner's
ordinary contention retries. Status prints when the owner changes, not every
poll. On normal release the pending command acquires and continues automatically.
Exit 3 is timeout and 130 is cancellation; neither runs the pending command nor
changes the owner. Invalid, stopped, or inaccessible owners require reconciliation.
The regression runner also refuses source changes made during its wait.

## Long holds

A reservation held for more than 15 minutes is reported, never taken. The
busy refusal and the first wait status name the hold's age, and a waiter gets
one `HOST_CHECKS_HELD_LONG` warning per owner; the kickoff doctor shows it as a
warning. A full regression executes in about four minutes, so a longer hold is
usually a long build group, a hung test, or a stopped owner. Ask the owner, or
the maintainer once, and keep waiting or working on unreserved checks
meanwhile. The warning never authorizes removing, stopping or reclaiming the
reservation; a stopped owner still needs the reconciliation below.

Every test run here fails a single test after two minutes and then lets its
file's process exit, so one hung test fails the run in minutes instead of
holding the reservation. The slowest test in a full pass takes about 9 s.
Treat a timed-out test as a failure to diagnose; do not raise the limit to get
a pass.

After interruption, the reservation stays in place. Inspect its PID, descendants,
checkout and partial logs. Only after proving that its entire group has stopped
may its owner remove that exact file. A dead parent alone is insufficient. Do not
copy locks between hosts. Reconcile any open offline attempt using records.md.
Normal completion releases the reservation even when a check fails; its failed
receipt stays intact. Time spent waiting belongs to the existing run's wall time;
executed checks keep their existing per-command durations and logs.

A fixture startup timeout under host contention is an infrastructure observation.
Preserve the first log before the isolated retry. Use injected clocks and explicit
synchronization for logical timeout tests. Keep real watchdogs for process startup,
network/workerd readiness and observation windows. Do not inflate every timeout
or remove watchdogs to obtain a pass.
