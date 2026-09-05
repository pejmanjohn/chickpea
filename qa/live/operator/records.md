# Private attended run records

The record helper supports the current skill without adding another live runner.
It writes one private JSON record atomically, preserving ordered events and first
outcomes. Reports and current status are derived from it. Evidence files remain
beside it and are hashed when referenced. The legacy coordinator journal and
infrastructure resource ledger keep their existing schemas and safety rules.
Do not import, rewrite, or migrate an active run to this format.
Run this notebook from the operator's Git checkout; input fingerprinting requires
Git. An exported installation artifact is a test fixture, not the record's checkout.

## Preflight and selected scope

Create a private directory outside every checkout. Use absolute paths throughout.
This example uses a shell variable for that directory, not a target alias.

```sh
run_dir=$(mktemp -d /private/tmp/chickpea-verification.XXXXXX)
npm run verify:regression -- --area routines --plan
npm run verify:live:record -- template --mode changed --area routines --output "$run_dir/spec.json"
# Read/edit spec.json using observed target, actor, capability and fixture evidence.
npm run verify:live:record -- init --spec "$run_dir/spec.json" --run "$run_dir/run.json"
npm run verify:live:record -- preflight --run "$run_dir/run.json"
```

The template starts unresolved. It never claims that a browser, actor, fixture,
or disposable target exists. `release` includes fresh installation prerequisites
on a separate target, fresh OAuth, distinct actors, private-channel and connector
fixtures. Review it against the advertised release matrix and add missing variants,
hosting paths, upgrade journeys, and relevant permission/failure cases. For a
documentation/workflow-only task, `cases: []` with empty contexts/capabilities
records offline checks without implying live coverage.

Each context records `grade`, exact `target`, `servingVersion`, actual `model`,
actor identity, fixture revision/digest, lane `state`, and relevant `config` digest.
Never put credentials in it. Each case declares source `areas`, prerequisite
capability names in `requires`, required readback surfaces in `proof`, and bounded
attempt/observation limits. Duplicate a case with a distinct ID/context to grade
Local, deployed, or model-only evidence separately. Do not share evidence across
those grades.

For each available capability, save a private readback and set `available: true`,
`observedAt`, `expiresAt`, and `evidence: ["/private/path/readback.json"]`. Actors
also need actual `identity`, `role`, and optionally `registered`. An observed
signed-in test actor with `registered: false` yields a registry warning. An absent
actor or expired readback blocks dependent cases. A distinct-member test needs
its own observed member, not an Owner described as a Member. Inspect the target
account and grant using the skill's authority rules before marking it available.
Preserve the template's `expectedRole`; preflight checks it against the observed
role and rejects duplicate identities for distinct required actors.

Preflight returns `runnable` IDs plus per-case blockers and warnings. Exit 1 means
some selected scope is blocked; independent cases can still run. Exit 2 means
invalid input. Selection stays visible through refresh; it cannot silently shrink.
Legacy doctor diagnostics remain strict for the legacy coordinator. Its
`missing_actor` result is a registry hint for this attended preflight, and is not
enough to mark an actual actor absent or present. Use fresh signed-in UI evidence.

## Attempts, interruption, and a fix

```sh
npm run verify:regression -- --area routines --record "$run_dir/run.json"
npm run verify:live:record -- begin --case channel-schedule --run "$run_dir/run.json"
# Record the returned attempt ID before acting. Perform the authorized journey once.
npm run verify:live:record -- record --event "$run_dir/outcome.json" --run "$run_dir/run.json"
# After interruption, inspect the same record. Do not create a replacement.
npm run verify:live:record -- status --run "$run_dir/run.json"
# Refresh observed contexts/capabilities after a fix, restart, actor or browser change.
npm run verify:live:record -- refresh --spec "$run_dir/spec.json" --reason "Local candidate updated after diagnosis" --run "$run_dir/run.json"
npm run verify:regression -- --area routines --record "$run_dir/run.json" --reuse
npm run verify:live:record -- begin --case channel-schedule --reason "Fixed persisted destination; new conversation and due occurrence" --run "$run_dir/run.json"
```

A finish event looks like this. Paths refer to files you actually saved. Required
proof surfaces each reference their own readbacks, which may be in the same file.
The helper verifies receipt presence/integrity, not the assertions inside them.

```json
{
  "type": "finish",
  "attemptId": "ID_FROM_BEGIN",
  "result": "pass",
  "summary": "Expected the exact saved destination; observed it in Admin and the due Slack message, with no duplicate in the declared window.",
  "evidence": ["/private/path/attempt.json"],
  "proof": {"slack": ["/private/path/slack.json"], "admin": ["/private/path/admin.json"]},
  "timing": {"browserMs": 12000, "modelMs": 19000, "humanWaitMs": 0, "observationMs": 30000},
  "costUsd": null
}
```

Non-passes require `category: product|model|tool|infrastructure|unknown`. Keep the
expected/observed difference in `summary`. `ambiguous` prevents a new attempt
until an event with `type: reconcile`, `attemptId`, `outcome: not_applied`, summary,
and evidence proves absence. `outcome: applied` instead permits a `resolve` event
with the same fields as finish to grade the original action. `unknown` permits
neither replay nor a pass. See [recovery.md](recovery.md).
Timing and cost on `resolve` are cumulative for that attempt; the report uses
the latest receipt once. Missing timing categories stay explicitly unmeasured.

Case status becomes stale when its declared source areas, contract, context, or
evidence changes. Unknown/shared runtime paths invalidate all areas. Workflow-only
edits do not invalidate product areas. The mapping is conservative, and operators
must declare indirect dependencies. Changes during an attempt prevent a pass.
Capability observations expire independently; refresh them before new actions.

## Exact cleanup and schedule limits

Register resources immediately after reading their exact returned ID. Preserve
before-values before modifying a reusable fixture. This event registers an owned
schedule with a stop condition. Use an actual future UTC deadline within two hours.

```json
{
  "type": "resource", "caseId": "channel-schedule", "target": "RESOLVED_TARGET",
  "provider": "chickpea", "kind": "schedule", "immutableId": "EXACT_RETURNED_ID",
  "ownership": "owned", "expected": {"present": false},
  "evidence": ["/private/path/saved-schedule.json"],
  "stopAt": "2026-10-01T12:30:00Z", "maxOccurrences": 2
}
```

The event returns a registration `id`. Record actual occurrences with
`type: occurrence`, `resourceId`, `occurrenceId`, and `evidence`. Duplicate receipt
IDs count once. When the limit, deadline, or a case failure is reached, `status`
shows `stopDue` and blocks new attempts until exact cleanup is verified. The helper
does not poll or stop remote schedules. Arrange an independent stop before leaving
an intentional reliability run unattended. `purpose: reliability` permits up to
100 attempts/occurrences and a 24-hour schedule deadline; it does not start them.

After product cleanup, record `type: cleanup`, `resourceId`, `outcome: verified`,
`observed: {"present": false}`, and fresh `evidence`. A mismatch cannot verify
cleanup. `outcome: failed` preserves the attempt; a later verified readback resolves
current cleanup without erasing that failure. Re-registering the same immutable ID
after cleanup creates a new registration and new cleanup obligation.

For reusable fixtures use `ownership: restore`, with identical `before` and
`expected` objects containing the exact values. For attributed Slack output or
archived residue use `ownership: retain` and the recorded exact retained state.
Never infer ownership from names or clean a baseline credential/connection.

## Evidence reuse and the final checkpoint

The offline runner records each step's start, finish, private log, exit/signal,
duration, Node version, source identity, and effective configuration digest. An
interrupted process leaves an open attempt. Inspect its PID/process and log before
resuming; the helper never steals a record lock or retries a command by itself.
`--timeout-ms` bounds each process, defaulting to 20 minutes. A killed child may
leave child processes; reconcile those before starting another build in this checkout.

After an interrupted offline command, inspect the saved `ownerPid`, its descendants,
and the partial log. Once stopped, record `type: offline_interrupted`, `attemptId`,
`processesStopped: true`, `summary`, and retained `evidence`. The helper refuses
this while the owning process exists. This closes the open attempt as an
infrastructure failure and permits a deliberate retry without erasing its log.

`--reuse` reuses a successful receipt only for matching working contents including
dirty/untracked files, Node version, effective environment, check inventory, timeout,
and intact retained logs. Builds always rerun to restore ignored artifacts. A later
failure/open attempt defeats an older pass. Environment changes may conservatively
prevent reuse. Ignored external configuration must be represented in the effective
environment or recorded context. Never treat unchanged HEAD as sufficient.

Repair loop: preserve the first failure, diagnose the boundary, fix it, run focused
deterministic checks, retest Local with the actual model, then test the dependent
deployed behavior. Workflow-only edits need workflow/export contracts. Repeated
intermediate full tests, both Node versions, and clean export are unnecessary unless
the impact or failures justify them.

Once the candidate is stable and committed, deliberately run the complete release
inventory on Node 22.19.0 and Node 24 with `--mode release --record FILE`. `--reuse`
is refused in release mode. The report requires both current-source checkpoints;
a build change invalidates them. Follow [releasing](../../../docs/runbooks/releasing.md)
for audit and profile checks and finish the selected live release matrix. These
receipts never tag, publish, deploy, or grant release approval.

```sh
npm run verify:regression -- --mode release --record "$run_dir/run.json"
npm run verify:live:record -- report --run "$run_dir/run.json" --output "$run_dir/report-1.md"
```

Run that first command with each required Node runtime on PATH. Generate a new
report filename after updates; the command refuses to overwrite evidence. Reports
include first failures, current invalidation, open attempts, exact cleanup, measured
time and known/unknown cost. Original command duration on a reused receipt is an
avoided check duration, not a measured end-to-end speedup.
