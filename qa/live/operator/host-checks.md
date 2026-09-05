# Expensive checks on one host

Use `verify:regression` for normal check groups. It reserves
`~/.chickpea/verification-host/owner.json` for the whole serial group, including
export children. The reservation is shared across this user's worktrees and
does not depend on a checkout's temporary directory. For standalone commands:

```sh
npm run verify:host -- npm test
npm run verify:host -- npm run build
npm run verify:host -- npm run verify:cf-smoke
```

For a deliberate multi-command group, pass a shell explicitly and set isolated
database variables as in CONTRIBUTING. Nested commands inherit the owner's
reservation. A competing process exits before running checks and reports the
owner PID, checkout and exact file. Continue source review, typechecking or
small unit checks that do not start heavy fixtures. Retry the reservation after
the owner finishes; do not kill, suspend or change that task's processes.

The wrapper does not discover older unwrapped tests. Before the first group in
a session, inspect known active test/build processes and coordinate with their
owner. All operators must use the same wrapper for expensive standalone groups.
This is one local reservation, not a queue or a general scheduler.

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
