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
npm run verify:live:record -- template --mode changed --purpose verification --area routines --output "$run_dir/spec.json"
# Read/edit spec.json using observed target, actor, capability and fixture evidence.
npm run verify:live:record -- init --spec "$run_dir/spec.json" --run "$run_dir/run.json"
npm run verify:live:record -- preflight --run "$run_dir/run.json"
```

The template starts unresolved. It never claims that a browser, actor, fixture,
or disposable target exists. `release` includes fresh installation prerequisites
on separate temporary resources in an exclusively reserved lane, fresh OAuth, distinct actors, private-channel and connector
fixtures. Review it against the advertised release matrix and add missing variants,
hosting paths, upgrade journeys, and relevant permission/failure cases. For a
documentation/workflow-only task, `cases: []` with empty contexts/capabilities
records offline checks without implying live coverage.

Use `case-add` when the selected journey is not already in the template. It
writes a distinct spec so the reviewed input is never replaced in place. Repeat
`--area`, `--require`, and `--proof` as needed. For an existing template case,
add the intent fields to that private case before initialization; do not add a
duplicate journey just to attach the contract. Private spec preparation is part
of the authorized run and needs no additional approval.

```sh
npm run verify:live:record -- case-add \
  --spec "$run_dir/spec.json" --output "$run_dir/spec-with-case.json" \
  --case requested-schedule --title "Requested schedule" --context candidate \
  --area routines --require candidate.owner --require candidate.channel \
  --proof slack --proof admin \
  --original-request "Post the requested report on the chosen schedule." \
  --expected-outcome "One attributable Slack message contains the requested report." \
  --variant "A denied actor receives no delivery and an actionable error." \
  --cleanup-contract "Remove the temporary schedule and verify absence by immutable ID."
```

These four contract fields become immutable once present. A refresh may add a
missing field, but cannot change or remove recorded product intent. Resolve the
new spec's contexts and capabilities, then pass that file to `init`.

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

Every capability also needs `scope` containing the exact `context` ID plus that
context's `target`, `grade`, `model`, `actor`, `fixtures`, `state`, and `config`
values. The template supplies unresolved snapshots; replace them only after
readback on the resolved context. `contextScope(id, context)` in
`scripts/lib/verification-scope.mjs` constructs this snapshot. Serving version
is excluded because candidate transitions already govern it. A lane/actor/fixture
or configuration change requires new scoped evidence. An actor on Local and a
provider fixture on a deployed lane cannot jointly satisfy a same-lane case.
Use distinct capability IDs for each context, including target aliases.

Only a genuinely shared `kind: "tool"` may use
`scope: {"shared": true, "reason": "Observed browser supports both selected origins"}`.
This scopes the control tool, never its signed-in actors, accounts or fixture
authority. Available capabilities without scope in older records remain readable
but block new attempts and candidate carry-forward. Read historical records in
place; do not migrate or rewrite active/private historical runs. A currently
owned run can append a truthful refresh when continued work is authorized.
Refresh cannot remove existing scope or broaden a scoped capability to shared.

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

## Required variants

Use existing catalog/attended case IDs for independently observed variants. Keep
each child's own attempts, prerequisites, proof and context. Add a derived group:

```json
{
  "id": "LC05-V3-revoke-reconnect",
  "title": "Revocation and dependent-work recovery",
  "required": ["connection-revocation", "connection-dependent-schedule-recovery"],
  "optional": [],
  "scopeReason": "Selected release profile includes provider reconnect and dependent scheduled-work recovery."
}
```

Place it in the spec's `groups` array. The template includes this split when
both journeys are selected. Reconnect/provider read alone cannot pass the parent.
Groups reference case IDs, never nested groups, and all children use the same
context. Separate Local/deployed/model or different models into separate groups.
There is no manual parent outcome. Required children must all pass with current
evidence. Failed, ambiguous, stale, blocked, open or not-run children keep the
parent incomplete, with the remaining IDs visible in the generated report.

Declare optional variants and the agreed scope reason before initialization.
Optional results remain visible, including failures and missing coverage; open
actions and their cleanup still need reconciliation. Ungrouped cases are required.
Refresh can add required coverage or promote optional coverage, but cannot remove
a selected group/variant or demote required coverage. A narrower follow-up run
does not change the broader run's result. Select the relevant release profile,
not every historical retrospective row by default.

## Attempts, interruption, and a fix

```sh
npm run verify:regression -- --area routines --record "$run_dir/run.json"
npm run verify:live:record -- begin --case channel-schedule --run "$run_dir/run.json"
# Record the returned attempt ID before acting. Perform the authorized journey once.
# Save the product result and each required readback before finishing.
npm run verify:live:record -- finish --run "$run_dir/run.json" \
  --attempt "$attempt_id" --result pass \
  --summary "Expected the saved destination; observed it in Admin and the due Slack message." \
  --evidence "$run_dir/attempt.json" \
  --proof "slack=$run_dir/slack.json" --proof "admin=$run_dir/admin.json" \
  --completed-at 2026-10-01T12:00:19Z --observed-at 2026-10-01T12:00:31Z \
  --timing-observation-ms 30000 --cost-usd unknown
# After interruption, inspect the same record. Do not create a replacement.
npm run verify:live:record -- status --run "$run_dir/run.json"
# Refresh observed contexts/capabilities after a fix, restart, actor or browser change.
npm run verify:live:record -- refresh --spec "$run_dir/spec.json" --reason "Local candidate updated after diagnosis" --run "$run_dir/run.json"
npm run verify:regression -- --area routines --record "$run_dir/run.json"
npm run verify:live:record -- begin --case channel-schedule --reason "Fixed persisted destination; new conversation and due occurrence" --run "$run_dir/run.json"
```

Paths refer to files you actually saved. Repeat `--evidence` or
`--proof surface=path` when a surface has multiple receipts. The helper verifies
receipt presence and integrity, not the assertions inside them. It still rejects
a pass that lacks any proof surface required by the selected case.

Non-passes require `category: product|model|tool|infrastructure|unknown`. Keep the
expected/observed difference in `summary`. `ambiguous` prevents a new attempt
until an event with `type: reconcile`, `attemptId`, `outcome: not_applied`, summary,
and evidence proves absence. `outcome: applied` instead permits a `resolve` event
with the same fields as finish to grade the original action. `unknown` permits
neither replay nor a pass. See [recovery.md](recovery.md).
`resolve` accepts the same builder options as `finish`. Timing and cost on a
resolution are cumulative for that attempt; the report uses the latest receipt
once. Use raw `record --event` for the less common manual timing categories.
Missing timing categories stay explicitly unmeasured.

`completedAt` is when the product produced the outcome. `observedAt` is when the
operator obtained its authoritative readback. The event `at` remains the later
record-write time. Neither timestamp is inferred when omitted. Reports show
attempt-start-to-completion time, readback-to-record delay, recording after the observation
deadline, and completion beyond that deadline separately. `maxWaitMs` remains an
observation deadline, not a universal product SLA, so lateness is advisory and
does not rewrite the recorded result. Legacy events keep their original elapsed
bookkeeping span and show unknown product completion.

Attempt-start-to-completion includes any operator work between `begin` and the
product outcome. It is not pure model, provider, or product execution latency.
Keep raw provider timestamps in evidence when its clock differs from the local
clock. Only record comparable completion times supported by a measured offset;
otherwise leave completion unknown. Do not clamp a timestamp or relax the
observation window to turn uncertain timing into a pass.

Measure attended work with explicit phases. Start immediately before the phase
and stop the returned ID afterward.

```sh
npm run verify:live:record -- phase-start --run "$run_dir/run.json" \
  --phase browser-wait --attempt "$attempt_id"
npm run verify:live:record -- phase-stop --run "$run_dir/run.json" \
  --phase-id "$phase_id"
```

Supported phases are `lane-wait`, `host-wait`, `browser-wait`, `setup`,
`deployment`, `request`, `observation`, `repair`, `review-wait`, `human-input`,
and `cleanup`. A phase may also name `--case`. Overlap is allowed. Status and
reports show open phases, sums by phase, and the union of measured intervals so
overlap counts once. That union is not a measured critical path. Phase receipts
never satisfy minimum observation duration or proof requirements.

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

Register resources immediately after reading their exact returned ID. The
builder derives the target from the selected case and context. This command
registers an owned schedule with an absence cleanup contract and a bounded stop
condition. Use an actual future UTC deadline within two hours.

```sh
npm run verify:live:record -- resource --run "$run_dir/run.json" \
  --case channel-schedule --provider chickpea --kind schedule \
  --resource-id "$schedule_id" --ownership owned --cleanup-preset absent \
  --evidence "$run_dir/saved-schedule.json" \
  --stop-at 2026-10-01T12:30:00Z --max-occurrences 2
```

The event returns a registration `id`. Record actual occurrences with
`type: occurrence`, `resourceId`, `occurrenceId`, and `evidence`. Duplicate receipt
IDs count once. When the limit, deadline, or a case failure is reached, `status`
shows `stopDue` and blocks new attempts until exact cleanup is verified. The helper
does not poll or stop remote schedules. Arrange an independent stop before leaving
an intentional reliability run unattended. `purpose: reliability` permits up to
100 attempts/occurrences and a 24-hour schedule deadline; it does not start them.

After product cleanup, save the independently observed state and record it:

```sh
npm run verify:live:record -- cleanup --run "$run_dir/run.json" \
  --resource "$registration_id" --outcome verified \
  --observed-file "$run_dir/cleanup-state.json" \
  --evidence "$run_dir/cleanup-readback.json"
```

A mismatch cannot verify cleanup. `--outcome failed` preserves the attempt; a
later verified readback resolves current cleanup without erasing that failure.
Re-registering the same immutable ID after cleanup creates a new registration
and new cleanup obligation.

For reusable fixtures use `--ownership restore --expected-file BEFORE.json`.
For attributed Slack output or archived residue use `--ownership retain` and an
exact retained-state file. Restore and retain do not accept cleanup presets; the
builder copies the exact supplied state into both the before and expected fields.
Never infer ownership from names or clean a baseline credential/connection.

Successful exact-command cleanup does not pass a failed natural-language deletion
case. Keep its original request/result and grade the command path separately.
Restore standing fixtures to exact before-values. A disposable run-owned Agent
may instead have an expected archived state; archiving it need not undo every
temporary avatar/name/model change. Verify archival and removed grants, including
after Retry, without reactivating intentionally disabled reach.

Register new run-owned Agents with `--kind agent --ownership owned
--cleanup-preset archived-agent`. This records `expected:
{"lifecycle":"archived","channelCount":0,"dmAccess":"unavailable"}`. If an older record incorrectly
required permanent absence, append `type: resource_contract_correction` with its
`resourceId`, exact `previousExpected: {"present":false}`, the archived `expected`
above, a `reason` explaining the product contract, and supporting `evidence`.
This narrowly corrects an owned Agent's cleanup contract; it cannot change
customer fixture before-values, schedule limits, or acceptance outcomes. It does
not verify cleanup. Obtain a fresh archival and access readback, then append a
new cleanup event. The original registration and failed cleanup remain visible.

## Offline receipts and the final checkpoint

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

Every offline run executes its checks; a receipt is never copied forward.
(Records written before `--reuse` was removed show a reused step as not run.) It
covers only its working contents including dirty/untracked files, Node version,
effective environment, check inventory, timeout, and intact retained logs. A later
failure/open attempt defeats an older pass. Ignored external configuration must be
represented in the effective environment or recorded context. Never treat
unchanged HEAD as sufficient.

Required offline coverage accumulates across the run's Node 24 plans. A Node 24
update carries those obligations forward, but receipts must match the current
exact version and execution configuration. Other Node majors remain visible
history and neither satisfy nor block current Node 24 acceptance. Open attempts
still require reconciliation before another run. Passing a narrower independent plan cannot hide a failed or unfinished
check from an earlier plan. A relevant passing rerun on current source and matching
execution configuration can resolve it; the original failure remains recorded.
The report lists outstanding check obligations. A failed full release run needs
a later successful full release checkpoint, even after focused recovery passes.

Repair loop: preserve first failures, diagnose promptly, delegate eligible work,
and choose a bounded useful checkpoint for compatible reviewed repairs. Run the
union of affected deterministic checks, retest Local with the actual model, then
test dependent deployed behavior. Follow [modes.md](modes.md#repair-loop-and-final-checkpoint).
Workflow-only edits need workflow/export contracts. Repeated
intermediate full tests and clean export are unnecessary unless
the impact or failures justify them.

Once the candidate is stable and committed, deliberately run the complete release
inventory on Node 24.20.0 from `.nvmrc` with `--mode release --record FILE`. The report requires this one current-source checkpoint;
a build change invalidates them. Follow [releasing](../../../docs/runbooks/releasing.md)
for audit and profile checks and finish the selected live release matrix. These
receipts never tag, publish, deploy, or grant release approval. The clean export
receipt includes its full root/CLI tests and offline turn/durability/provider
checks; the outer release plan does not repeat them. Only newly recorded export
plans declare that coverage. Original receipts and failures remain unchanged.

```sh
npm run verify:regression -- --mode release --record "$run_dir/run.json"
npm run verify:live:record -- report --run "$run_dir/run.json" --output "$run_dir/report-1.md"
```

Run that first command once with the pinned Node 24 runtime on PATH. Generate a new
report filename after updates; the command refuses to overwrite evidence. Reports
include first failures, current invalidation, open attempts, exact cleanup, measured
time and known/unknown cost.

## Follow-up run history

Prefer resuming one record. If a bounded follow-up needs a new spec,
link it to the direct parent during initialization. Each mapping uses the new
child case ID on the left and the parent case ID on the right.

```sh
npm run verify:live:record -- init \
  --spec "$run_dir/follow-up-spec.json" --run "$run_dir/follow-up-run.json" \
  --parent-run "$prior_run_dir/run.json" \
  --original-case attachment-retest=attachment-original
```

The helper stores the canonical private parent path and actual run ID. It rejects
missing parents, mismatched IDs, missing current-spec cases, mapping mismatches,
cycles, and family depth beyond 32 records. It does not rewrite or hash-lock a
mutable parent. Keep every linked record and its evidence at the recorded path.

Generate a read-only family report with `--family`:

```sh
npm run verify:live:record -- report --family \
  --run "$run_dir/follow-up-run.json" --output "$run_dir/family-report.md"
```

The current run appears first and is graded against the caller's current source.
Parent results are labeled historical and graded against each parent's latest
recorded refresh source, or its initial recorded source when it has no refresh,
as of that parent's final recorded event time. They include private paths, the
historical `asOf`, first failures, unresolved cases, and pending cleanup.
This preserves a completed parent's result on its recorded candidate without
letting a child repair prior failures or cleanup. A child pass cannot complete an
incomplete parent. A parent that disappears after linking is reported as missing
and keeps family completion false.

Family completion means every linked run was complete in its own recorded context.
It is not current-source release acceptance and does not combine historical proof
into a new release checkpoint.

Cleanup belongs to the record that registered the resource. Update that parent
record with the exact cleanup readback even when a child retest supplied it;
linking a child neither transfers ownership nor satisfies the original obligation.
