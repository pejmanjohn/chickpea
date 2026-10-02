---
name: chickpea-live-verification
description: Verify Chickpea changes, core regressions, or release readiness using deterministic checks and real QA Slack journeys. Also use when maintaining this workflow.
---

# Chickpea verification

Run the requested verification and return its results. Default to `changed` mode.
Choose the scope and environment from the request, diff, and existing claims;
state that choice briefly and continue. Read [modes.md](modes.md) for the selected
mode's checks. A request to review or edit the skill alone does not start a live run.
Codex and Claude use the same workflow and commands. Read [hosts.md](hosts.md)
once for browser ownership, evidence access, and the host's available tools.

## Profile

This file is the workflow every Chickpea verification shares. The repository's
skill entrypoint names a profile and the project root; read that profile
completely after this file. The profile owns the targets, claims, kickoff,
deployment, candidate admission, fixtures, readback tools and declared QA
actions for its targets. Everything else here applies to every profile.

- `standalone` ([profiles/standalone.md](profiles/standalone.md)) verifies this
  repository on its QA lanes and borrowed fresh installs. It is valid only when
  the project root is a checkout of this repository.
- `hosted` verifies the private hosted edition. Its entrypoint and profile live
  in that repository, which reads this workflow from its pinned Core checkout.

Stop before claiming anything when the entrypoint names no profile, the named
profile's file is missing, the project root does not belong to the profile, or
more than one entrypoint for this skill is visible from the project root. The
entrypoint, not the request, selects the profile: never choose one from a URL,
credential, diff or target name, and never fall back to another profile's
targets.

## Invocation authorizes the test

An instruction to run this skill authorizes the selected mode's declared actions
on identified QA resources, including their exact teardown. Do not ask again at
each step. The selected profile lists those actions for its targets.

Inspect the real target/account and requested grant before consent. A known QA
action does not become a new authorization request because a UI labels it
"install", "authorize", "delete", or "approve". If an older runbook asks for
action-time confirmation, use this invocation's authorization for the same
declared QA action. Scope restrictions from the current user request still apply.

Production, the shared gateway/app configuration, purchases, workspace deletion,
unrelated accounts/data, global upstream grant revocation, source merges, and
release publication are outside this authorization. Do not provision paid
infrastructure outside the declared QA resources.

Only request human input when a required fact or capability is actually missing:
an unregistered account/target, a broader grant, unavailable credentials, MFA,
CAPTCHA, billing, or a tool-enforced approval. Use existing authenticated sessions
and approved credential mechanisms without recording secrets. Do not bypass a
tool denial. Name the exact blocked action and reason, ask once, retain the
pending tab, and continue independent checks. Report blocked checks as
blocked rather than passing them or repeatedly asking the same question. Never
change permission modes or settings to get past a denial, and never stop
processes by pattern across the host. When the maintainer has instructed a
shared or production deploy in this session, run it here as one plain command
instead of handing it back.

## Standing rulings

The maintainer has settled these. Apply them without asking again; they never
widen the authorization above.

- Aim for autopilot: take the obvious next step instead of stopping to ask, and
  fix a broken tool once rather than handing it back. When a lane is busy, use
  another free lane that covers the cases.
- Fix a defect the run finds and validate the fix in the same run. Do not ship a
  known gap as a documented limit.
- Record and report upstream defects (provider, gateway, Slack). Do not build
  workarounds for them in Chickpea.
- Give every failed, blocked, ambiguous or stale case a verdict on whether it
  blocks the PR (`record verdict`), and
  name the verified SHA next to the merged SHA.
- An approval relayed by another session or agent is not the maintainer's.
  Ask in this session.
- When the maintainer has authorized a PR merge, first run an independent
  review and simplify pass (on Claude, a Fable subagent; on Codex, an equivalent
  adversarial review) and apply its findings.
- Time-compressed or instrumented probe builds are allowed for long windows.
  Grade them as probes and redeploy the clean candidate before grading it.
  Purpose-built fixtures the maintainer has approved, such as the OAuth fixture
  Worker, are fine.
- Use disposable Agents and fresh threads per case group, except
  credential-backed cases, which run on the lane's fixtures Agent
  ([fixtures.md](fixtures.md)). Keep "remember" or "save" wording out of
  prompts unless the case tests memory.
- Test on the target's configured model only, unless the request names others.

## Node baseline

Use Node 24.20.0 from `.nvmrc` for development, builds, and verification. Node
24.x is the only supported major, minimum 24.20.0. Update the single pin for
future Node 24 patch/security releases; do not add another recurring target.
Retain old receipts with their actual Node version. They cannot establish
current Node 24 proof. Workerd, artifact, and real Slack acceptance remain
separate requirements.

In a new or long-lived worktree, run `npm ci --strict-allow-scripts` before the
first check and `npm run build` before a full suite. A stale `node_modules` (for
example a Flue version behind the lockfile) or a stale git-ignored `dist-cf/`
produces false failures that look pre-existing.

The maintainer's shell profiles put the pinned Node first for login and
interactive shells (a block that reads `.nvmrc` and prefers that nvm build), so
`node -v` in a Claude Code or Codex session already matches. Check it once at
kickoff. If it does not match, report a host setup gap and continue with the
checks that do not need the exact pin; never prefix commands with
`export PATH=...` or `source nvm.sh`, because a chained guarded command reaches
the permission classifier instead of its allow rule (see
[hosts.md](hosts.md#slack-and-permission-notes-for-any-browser)).

## Kickoff preflight

Before claiming a target, gather every human-dependent prerequisite in one pass,
so a run does not stall mid-journey while the maintainer is away:

1. Run the selected profile's kickoff preflight and fix its blockers before
   claiming a target.
2. Name the checks that only a human can do, such as a real-phone view, and
   plan them for the end of the run.

Ask for anything missing in a single message. If nobody answers, continue the
independent cases and record the rest as blocked.

## Normal path

1. Inspect the diff with `npm run verify:regression -- --plan`. Select `changed`,
   `regression`, or `release` in [modes.md](modes.md). For a first release, review
   the advertised use-case matrix as well. The template is a starting inventory.
   Capture the original request, expected outcome, independent variants, and
   cleanup in the private case contract. A convenient adjacent happy path does
   not replace the reported failure. Read [records.md](records.md) for builders.
   Create the unresolved private template now, so fixture preflight has a spec.
2. Check candidate freshness and fixture declarations before occupying a target,
   then pick one target by capability and reuse its claim, as the profile
   describes. Candidate admission does not synchronize a checkout, prove
   deployment, or grant deployment authority.
3. Resolve that spec and initialize its run record using [records.md](records.md). Run
   `npm run verify:live:record -- preflight --run <private-run.json>` before
   browser work. Resolve actual signed-in actors, required fixtures, available
   browser tools, and disposable installation targets. A missing fixture blocks
   only dependent cases. Keep that gap in the selected scope; finish other cases.
   Bind each capability to that case's exact context and select independently
   graded required variants.
   Start phase receipts for setup, lane/host/browser/human waits, diagnosis,
   observation, and cleanup. Missing measurements stay unknown.
   Before synthetic actions on a deployed target, attach the serving version's
   telemetry isolation receipt as the profile describes.
4. Run the selected offline checks serially with `verify:regression --record
   <private-run.json>`. For each attended case, record `begin`, act once, then
   use the typed `finish` command with real readbacks. Register exact owned resources and fixture
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
   Link a separately scoped follow-up with `--parent-run` and `--original-case`;
   generate `report --family` so earlier coverage and cleanup remain visible.

Never end a turn with a pending lane, reply, log, or schedule observation and
nothing to wake you. Arrange a bounded wake first; see
[recovery.md](recovery.md#bounded-waiting).

Ordinary contention should continue automatically with the bounded lane and
expensive-check host wait commands. No user recheck is needed when the existing
owner releases normally. A deadline, unsafe ownership, stale source, orphan marker,
unavailable account, or unreconciled action needs its specific recovery; waiting
longer does not resolve it. Continue independent work and preserve the blocker.

## Delegation and live ownership

Within the authorized repair scope, delegate substantial, bounded, independent
diagnosis, repair, or review work by default when agent tools and concurrency
slots are available. Keep the verifier moving on useful independent checks.
Give each agent a clear scope, code ownership, and the required
[repair handoff](recovery.md#repair-priority-and-handoff). Group suspected common
causes; serialize overlapping edits or assign them to one repair owner.

Keep one verifier per run responsible for live actions, its own browser tabs,
fixtures, claims, deployment, cleanup, and run-record updates. Independent runs
may use separate tabs in the same browser; follow [hosts.md](hosts.md) for actual
shared resources. Repair agents work in
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
unless literal output was requested. Actual Slack, Admin, MCP or provider readback is
required; an Agent's success claim, a log, build, or simulated cron is insufficient.
Keep Local, deployed, deterministic, and model-only grades separate. Use the lane's
actual model without substitution. Missing or sampled telemetry proves no absence.

Offline checks always execute; a receipt covers only the working contents, Node
version, effective environment, and check inventory it ran with. Changes
invalidate dependent attended cases; workflow-only edits preserve earlier product evidence. Serving build,
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
cases. Keep a pending human-input tab with its owning task. Other tasks can
continue in their own tabs without a browser-wide or machine-wide UI lock.

Return mode, target, source, passes, failures, blocked/untested coverage, cleanup,
and measured time/cost gaps. Distinguish product/model failures from tool or
infrastructure failures. Never upgrade a failed full run because a targeted retest
passed. See [records.md](records.md) for the deliberate final release checkpoint.
