---
name: chickpea-live-verification
description: Verify Chickpea changes, core regressions, or release readiness using deterministic checks and real QA Slack journeys. Also use when maintaining this workflow.
---

# Chickpea verification

Run the requested verification and return its results. Default to `changed` mode.
Choose the scope and environment from the request, diff, and existing claims;
state that choice briefly and continue. Read [modes.md](modes.md) for the selected
mode's checks. A request to review or edit the skill alone does not start a live run.

## Invocation authorizes the test

An instruction to run this skill authorizes the selected mode's declared actions
on identified QA resources, including their exact teardown. Do not ask again at
each step. For established Local, Amber, or Cobalt test environments this includes:

- Claiming an available lane, starting its existing local Worker, and guarded
  deployment of the candidate to the explicitly selected QA Worker.
- Installing the repository's lockfile dependencies and using its existing
  verification tools with the documented Node version.
- Sending synthetic Slack messages to the designated test channels and DMs;
  creating, editing, archiving, and cleaning run-owned Agents, skills, memory,
  schedules, and grants; restoring exact recorded fixture values.
- Reviewing and approving the test's frozen Chickpea proposal. A product
  `approve` message or confirmation dialog is an action for the verifier to
  perform as the test actor, not another request for the operator's permission.
- Installing or reconnecting the declared test integration, completing OAuth
  consent with an already authenticated registered test account, accepting the
  declared grant, and disconnecting its exact run-owned account during cleanup.
  An account's use of a personal email does not by itself require another approval.
- Reading or writing declared synthetic provider fixtures, recording their
  before-values, and restoring them; using the configured test model for bounded
  journeys and the selected real-model regression cases.
- Dismissing ordinary native confirmation dialogs that implement those actions.

Inspect the real target/account and requested grant before consent. A known QA
action does not become a new authorization request because a UI labels it
"install", "authorize", "delete", or "approve". If an older runbook asks for
action-time confirmation, use this invocation's authorization for the same
declared QA action. Scope restrictions from the current user request still apply.

Production, the shared gateway/app configuration, purchases, workspace deletion,
unrelated accounts/data, global upstream grant revocation, source merges, and
release publication are outside this authorization. A fresh Slack installation
uses an already designated disposable installation target; do not repurpose a
standing lane or provision paid infrastructure to complete it.

Only request human input when a required fact or capability is actually missing:
an unregistered account/target, a broader grant, unavailable credentials, MFA,
CAPTCHA, billing, or a tool-enforced approval. Use existing authenticated sessions
and approved credential mechanisms without recording secrets. Do not bypass a
tool denial. Name the exact blocked action and reason, ask once, retain the
pending browser, and continue independent checks. Report blocked checks as
blocked rather than passing them or repeatedly asking the same question.

## Node baseline

Use Node 24.20.0 from `.nvmrc` for development, builds, and verification. Node
24.x is the only supported major, minimum 24.20.0. Update the single pin for
future Node 24 patch/security releases; do not add another recurring target.
Retain old receipts with their actual Node version. They cannot establish
current Node 24 proof. Workerd, artifact, and real Slack acceptance remain
separate requirements.

## Normal path

1. Inspect the diff with `npm run verify:regression -- --plan`. Select `changed`,
   `regression`, or `release` in [modes.md](modes.md). For a first release, review
   the advertised use-case matrix as well. The template is a starting inventory.
2. Resolve one suitable QA target using [environments.md](environments.md).
   Reuse its claim. Prefer an owned local workerd/HTTP lane for repair cycles;
   deployed due-time, gateway, bindings, and release proof require a deployed lane.
3. Create a private spec and run record using [records.md](records.md). Run
   `npm run verify:live:record -- preflight --run <private-run.json>` before
   browser work. Resolve actual signed-in actors, required fixtures, available
   browser tools, and disposable installation targets. A missing fixture blocks
   only dependent cases. Keep that gap in the selected scope; finish other cases.
   Bind each capability to that case's exact context and select independently
   graded required variants. See the [fixture inventory](environments.md#fixture-inventory).
4. Run the selected offline checks serially with `verify:regression --record
   <private-run.json>`. For each attended case, record `begin`, act once, then
   record `finish` with real readbacks. Register exact owned resources and fixture
   before-values immediately. Follow [recovery.md](recovery.md) for an ambiguous
   action, stalled reply, lost tab, or tool failure.
   Share the [host check reservation](host-checks.md) with other repair worktrees.
5. Start diagnosis promptly and use [recovery.md](recovery.md) to separate urgent
   repairs from isolated failures that can queue while independent checks continue.
   Delegate eligible repair work below. Integrate compatible reviewed repairs at
   the bounded checkpoints in [modes.md](modes.md), then retest original failures
   and the combined impact. For release mode, run the full final checkpoint on
   the stable, clean, committed candidate.
6. On resume, run `status` on the same record. Refresh capability readbacks after
   browser, actor, claim, build, or fixture changes. Reconcile open attempts and
   overdue schedules before starting new work. Never replace the original record.
7. Clean exact run-owned IDs, restore exact before-values, and record authoritative
   cleanup readbacks. Generate `report` from the record; do not maintain a second
   handwritten status table. Hold the environment claim through cleanup.

## Delegation and live ownership

Within the authorized repair scope, delegate substantial, bounded, independent
diagnosis, repair, or review work by default when agent tools and concurrency
slots are available. Keep the verifier moving on useful independent checks.
Give each agent a clear scope, code ownership, and the required
[repair handoff](recovery.md#repair-priority-and-handoff). Group suspected common
causes; serialize overlapping edits or assign them to one repair owner.

Keep one verifier responsible for live actions, browser control, fixtures,
claims, deployment, cleanup, and run-record updates. Repair agents work in
[isolated worktrees](environments.md#repair-worktrees-and-serving-candidates)
without live or shared resource access. Delegation does not expand edit, landing,
deployment, or account authority. When tools or safe independent work are
unavailable, work sequentially and say so; do not claim parallel work occurred.

## Evidence and stopping rules

The record command is an attended notebook. It does not operate browsers, claim
lanes, deploy, execute cleanup, or certify the truth of an operator receipt.
Existing legacy journals remain in place when resuming legacy runs. The
`verify:live:case/smoke/deep` CLIs do not execute these skill modes. Read the
[legacy coordinator runbook](../../../docs/runbooks/live-contract-verification.md)
only when explicitly operating it.

Saved instructions, frozen proposal identity, fixture values, destination, and
resource ownership require exact comparisons. Grade explanatory prose by meaning
unless literal output was requested. Actual Slack/Admin/provider readback is
required; an Agent's success claim, a log, build, or simulated cron is insufficient.
Keep Local, deployed, deterministic, and model-only grades separate. Use the lane's
actual model without substitution. Missing or sampled telemetry proves no absence.

Offline reuse is explicit with `--reuse` and requires matching working contents,
Node version, effective environment, check inventory, and retained logs. Builds
always run to restore generated artifacts. Changes invalidate dependent attended
cases; workflow-only edits preserve earlier product evidence. Serving build,
model, actor, connection, fixture, or lane-state changes invalidate dependent live
proof. Record refreshes truthfully; a source SHA alone is not an input fingerprint.

Ordinary verification uses bounded attempts and observations. Schedules stop after
their declared occurrence budget or deadline; failures also require stopping them.
Pause/delete them through the product and verify the readback. The notebook only
shows stop conditions and cannot stop a schedule while the operator is away.
Overnight reliability testing needs an explicit purpose, larger bounded budget,
stop condition, and cleanup owner. Do not leave recurring fixtures running by default.

After ambiguity, observe the actual UI and native dialogs before replaying. Replay
requires authoritative evidence that the action did not apply. If it applied,
resolve and grade the original attempt. Preserve its first outcome. Request human
input only for the missing capabilities listed above, then continue independent
cases. Use the short UI mutex for competing browser actions, release it during
human waits, and retain the affected browser reservation.

Return mode, target, source, passes, failures, blocked/untested coverage, cleanup,
and measured time/cost gaps. Distinguish product/model failures from tool or
infrastructure failures. Never upgrade a failed full run because a targeted retest
passed. See [records.md](records.md) for the deliberate final release checkpoint.
