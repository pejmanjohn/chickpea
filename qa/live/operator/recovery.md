# Observe before repeating an action

Record the first failure, expected and observed state, exact request permalink
or Run ID, UTC window, build, model, and retained evidence before changing state.
Use the existing [request diagnosis](../../../docs/runbooks/runtime-observability.md)
helper. Start with message serialization, current authority, tool admission and
execution, persistence, and delivery boundaries before changing prompt wording.
For example, exercise actual text-array serialization and database query limits
when those boundaries failed. A mock that bypasses the boundary is insufficient.

## Repair priority and handoff

Start diagnosis promptly from the retained first failure. Within the authorized
repair scope, prioritize broad blockers, fixture contamination, invalid evidence,
and authorization or isolation failures. Contain the affected state and suspend
dependent actions until their prerequisites are trustworthy. Meet existing
ambiguity, schedule-stop, and cleanup obligations; continue independent checks
that remain safe and allowed.

Queue isolated failures with their original attempt and evidence references.
Delegate substantial independent repairs while the verifier continues on the
current candidate, using the [ownership rules](SKILL.md#delegation-and-live-ownership).
Group symptoms with a suspected common cause for diagnosis, while preserving
each failure's identity and first outcome. Serialize overlapping edits or give
them one repair owner. A shared symptom is a hypothesis, not a proven cause.

Each repair handoff returns:

- Original failure/attempt IDs and retained private evidence references.
- Reproduction steps that exercise the failed boundary, causal diagnosis, and
  any remaining uncertainty.
- For code repairs, the patch or individual commit and focused validation logs.
  For recovery without a source change, the exact restoration and its readback.
- Affected scenarios and dependencies, plus recommended Local and deployed
  retests with the actual model where relevant.

The verifier reviews repairs before the [batch checkpoint](modes.md#repair-loop-and-final-checkpoint).
An agent's patch or focused pass does not establish live recovery. Keep unresolved
or conflicting repairs queued with a bounded next checkpoint; they do not delay
ready compatible work indefinitely.

## Ambiguous browser or native action

1. Record an `ambiguous` finish. A timeout describes an observation failure;
   it does not establish whether the product action applied.
2. Reacquire the browser/app and obtain a fresh state with currently supported
   tool APIs. Resolve the exact target by current URL, workspace, and run marker.
   A retained tab handle may have disappeared. Inspect the native dialog and
   browser state independently when they disagree. Do not dismiss an unidentified
   dialog or send a partial composer draft.
3. Inspect authoritative state for the exact operation: sent Slack message,
   frozen proposal/apply result, saved Agent value, provider row, connection, or
   schedule occurrence. Reconcile as `applied`, `not_applied`, or `unknown`, with
   evidence. Unknown remains blocked. Missing sampled logs is not not_applied.
4. If applied, record `resolve` on the original attempt and grade its readback.
   If not applied, begin a bounded retest with the diagnosis and changed variable.
   Never repeat a mutation just to get a successful tool response.

A screensaver report, lost tab, or Computer Use lock diagnostic alone cannot
establish that macOS is locked. Preserve the tool's claim and report what was
actually observed. Ask for intervention only if the required UI remains unavailable.
Classify tool faults as `tool`, unavailable sessions/targets as `infrastructure`,
runtime or authority defects as `product`, and model behavior as `model` only with
supporting execution evidence. Use `unknown` while the boundary is unresolved.

## Bounded waiting

Use read-only observations with an explicit deadline. Wait in intervals of at
most 30 seconds and capture only the relevant thread/control. A reply that stays
in Thinking for about two minutes needs diagnosis, not another request. Record
an open/overdue attempt or ambiguous finish and preserve evidence.

Use the owning terminal and Local Explorer for local workerd. On the resolved
deployed Worker, use a bounded historical query or attach a 30–60 second tail
before an authorized reproduction and stop it afterward. Wrangler tail emits
pretty-printed objects, not necessarily JSONL. A repeating rejected delivery-lease
metric means the run cannot take the thread lease; record the prior owner and
triggering message. Do not send another request to unstick it.

Track due-time schedule waiting as a resource deadline and occurrence budget.
Each observation attempt remains bounded. Start independent cases while waiting;
do not shorten duplicate-observation windows to claim a faster pass. A run that
will be unattended needs an independently arranged stop or paused fixtures.

Record measured `automatedMs`, `browserMs`, `modelMs`, `humanWaitMs`, and
`observationMs` when available. They may overlap and are not added to wall time.
Record actual model cost when available; leave unknown cost as null. Preserve
the difference between process time, model latency, browser work, and human waits.
