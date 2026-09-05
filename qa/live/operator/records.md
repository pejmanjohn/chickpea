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
Refresh also preserves each selected case's acceptance grade, even if it moves
to another context. A Local repair journey needs a separate case while deployed
acceptance remains pending. Required capability kinds and expected actor roles
cannot be removed or weakened during refresh.
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

## Proven candidate transitions

A truthful serving-version refresh initially makes every case on that context
stale. To carry unaffected evidence across an actual upgrade, record an explicit
transition after the refresh. Keep the original serving version on the original
attempt. The receipt links both clean source snapshots to the observed versions
and records the impact review; it does not deploy or infer which source is serving.

```json
{
  "type": "candidate_transition", "fromId": "PASSED_BEGIN_OR_PREVIOUS_TRANSITION_ID",
  "context": "candidate", "impactAreas": ["routines"],
  "summary": "Observed the new version serving the reviewed routine-only candidate; model, actors, configuration, fixtures and state are unchanged.",
  "evidence": ["/private/path/candidate-source-and-impact-readbacks.json"]
}
```

`fromId` references the passed attempt that anchors the old candidate, or the
previous transition for a further upgrade. Evidence must connect the actual
serving versions to the exact recorded source snapshots and support the impact
and runtime comparison. A version string alone is insufficient. Finish open
scenarios, reconcile ambiguous actions, and verify exact cleanup first.

The helper requires the latest refresh to match the current clean source and new
version. Declared impact must include every changed source area and any indirect
dependencies. Unknown shared source changes affect all areas; unmapped source
changes cannot carry evidence. Changed target, grade, model, actor, configuration,
fixture/state identity, or prerequisite contracts require fresh proof. Changing
such inputs and later restoring their values does not erase the interruption.

Only intact passing outcomes outside the impact with usable observed prerequisites
can carry. Recorded loss of a required actor or fixture breaks that continuity,
even if it is later restored. The event records
their exact attempt/outcome IDs and prior transition chain. The report shows the
original observed version and each carry receipt. Lost or replaced transition
evidence invalidates that chain. Changed cases still need new attempts, and a
transition can never make an attempt pass after a mid-scenario candidate change.
Final offline release checkpoints must still validate the current source.

## Repairs and useful batch checkpoints

Use optional `repair` and `batch` events when a run has repair work to coordinate.
The verifier alone writes them. They preserve failure references, owners, suspended
cases, reviewed commits, and retest obligations; they never dispatch agents,
integrate code, run checks, or deploy. Follow the default delegation and priority
rules in [recovery.md](recovery.md#repair-priority-and-handoff).

After preserving a non-pass, record its returned outcome ID in `failureIds`.
An isolated failure can stay queued while independent cases continue. Use
`priority: urgent` for broad blockers, contaminated fixtures, untrustworthy
evidence, or authorization/isolation failures. `blocks` names only the cases
whose actions must stop until the repair is integrated and prerequisites restored.
The report keeps their previous outcomes but marks current acceptance blocked.

```json
{
  "type": "repair", "repairId": "schedule-destination",
  "failureIds": ["ID_FROM_FAILED_FINISH"],
  "priority": "isolated", "owner": "schedule-repair-agent", "state": "diagnosing",
  "group": "destination-persistence", "paths": ["src/routines"],
  "areas": ["routines"], "blocks": ["channel-schedule"],
  "summary": "Inspect saved destination serialization from the first failed due occurrence."
}
```

Send the same repair fields again to update `state` through `queued`, `diagnosing`,
`repairing`, and `ready`. Keep every prior failure, area, and blocked case.
`group` is an optional suspected common cause; `paths` makes overlapping ownership
visible. Overlap is a coordination hint,
not an automatic merge-conflict detector. Give overlapping edits one owner.
A ready event also requires individual full SHA `commits`, a `reviewer` distinct
from the repair owner, and `evidence` paths for the reviewed patch and focused
validation. Preserve each failure identity even when one fix resolves several.
For a fixture, tool, or evidence recovery without a source change, set
`kind: recovery`. It requires independent review and evidence of restoration,
without a code commit. The default `kind: code` retains the commit requirement.

Record a planned checkpoint with a concrete reason and a future `reviewAt` within
24 hours. Choose a much shorter wait when useful work is running out. At that
boundary, integrate the ready compatible subset or record what blocks it. A
single urgent fix can be its own batch; no minimum repair count applies.

```json
{
  "type": "batch", "batchId": "after-independent-checks",
  "repairIds": ["schedule-destination"], "state": "planned",
  "reason": "Finish independent memory coverage, then unlock schedule retests.",
  "reviewAt": "2026-10-01T12:10:00Z"
}
```

Use a real future timestamp. `status` reports a due review and the members with
intact ready evidence. To integrate a ready subset, use that same batch ID and
only those repair IDs; unfinished repairs remain queued. A repair cannot belong
to two planned batches. Once authorized code integration and combined review are
done, run the union of affected checks once on that candidate, serially:

```sh
npm run verify:regression -- --area routines --area connections --record "$run_dir/run.json"
```

Record `type: batch`, `state: integrated`, `batchId`, the ready `repairIds`, a
`reason`, and `evidence` paths for the combined review and checks. The helper
captures current source and individual commits. It refuses open or unreconciled
scenarios on the affected target, including aliases for that target. Finish due
observations and exact cleanup under the existing ownership rules before changing
the serving candidate. A recorded batch does not grant deployment authority or
prove a candidate is serving. Dependent actions stay blocked until a later
`refresh` records contexts and capability observations from after integration.
Read back the actual serving candidate and restored prerequisites after the
switch or recovery. Older observations cannot clear the suspension.

The batch invalidates earlier passes for its original failures, blocked cases,
and the union of declared areas. Unaffected evidence keeps its existing validity
rules. `status` lists pending retests and useful independent work. The batch stays
in `retest` until every affected case passes after integration with current inputs;
its combined check evidence must also remain current. Local, deployed, and model
grades remain separate. Preserve the original failure and use fresh conversation
roots when instruction changes require them.

Integrated membership and commit identities are immutable. If later changes or
replaced evidence make combined checks stale, rerun the relevant checks and
review, then record `type: batch_check`, `batchId`, `reviewer`, `summary`, and fresh
`evidence`. This appends a current-source receipt without rewriting the original
batch or bypassing stale scenario results. The reviewer must be separate from
the batch's repair owners. This is an operator receipt, not a substitute for the
offline runner or final release checkpoint.

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

Required offline coverage accumulates across the run's plans for each Node
runtime. Passing a narrower independent plan cannot hide a failed or unfinished
check from an earlier plan. A relevant passing rerun on current source and matching
execution configuration can resolve it; the original failure remains recorded.
The report lists outstanding check obligations. A failed full release run needs
a later successful full release checkpoint, even after focused recovery passes.

Repair loop: preserve first failures, diagnose promptly, delegate eligible work,
and choose a bounded useful checkpoint for compatible reviewed repairs. Run the
union of affected deterministic checks, retest Local with the actual model, then
test dependent deployed behavior. Follow [modes.md](modes.md#repair-loop-and-final-checkpoint).
Workflow-only edits need workflow/export contracts. Repeated
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
