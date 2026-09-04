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

## Select one environment

1. Inspect the complete diff, including branch, staged, unstaged, and untracked
   changes. Start with `npm run verify:regression -- --plan`; use `--base REF`
   when the intended comparison differs from local `origin/main`. The mapping is
   a starting point. Include indirectly affected behavior identified in review.
2. Reuse a matching claim. Otherwise inspect `npm run env -- status --worktree
   <absolute-worktree>`, then claim one free deployed lane when needed. Never
   borrow another task's claim. Both busy means report availability and continue
   offline checks, not ask the operator to manufacture another environment.
3. Prefer an initialized local workerd/HTTP lane for repeated application edits.
   Run `npm run dev:cf -- status --lane <lane>` and verify its owning worktree,
   app/workspace pair, endpoint, state, and actual effective model. Follow
   [local Worker development](../../../docs/runbooks/local-worker-development.md).
   Local state is currently worktree-bound. Do not copy it into a fresh worktree;
   use an available deployed lane until an explicit local handoff is supported.
4. Use a deployed lane for shared-gateway behavior, deployed bindings/credentials,
   real due-time delivery, or release acceptance. Claim and attest through the
   existing environment commands: `npm run env -- claim <alias>`, then
   `target <alias>` and `attest <alias>` through the same command. Pass
   `--worktree <absolute-worktree>` throughout. Read the
   [lane runbook](../../../docs/runbooks/parallel-live-test-environments.md)
   for target resolution and claims. Refresh readiness when build, actor, claim,
   browser, or target state changes. A status label or live PID alone is not
   evidence that Slack is working.
5. When deploying, set `CHICKPEA_DEPLOY_TARGET=<alias>` explicitly for the
   guarded `npm run deploy`. The wrapper resolves the claimed lane's AUTH_DB ID
   and schema generation from its own preflight; explicit
   `CHICKPEA_DEPLOY_AUTH_DB_ID` / `CHICKPEA_DEPLOY_SCHEMA_GENERATION` still win.
   The preflight reads every active lane's live-authority credential, not only
   the claimed one: from `CHICKPEA_ENV_<COLOR>_LIVE_AUTHORITY_URL` and
   `_READ_TOKEN`, or from the owner-only file
   `~/.chickpea/lane-credentials/<color>-live.json` (`origin`,
   `authorityReadToken`). A `LIVE_AUTHORITY_READ_TOKEN_INVALID` on a lane you
   did not claim means that other lane's credential is missing. Never print
   the token. Never use a bare/default deploy to reach a QA lane. Preserve
   source/claim fences. Verification does not imply landing on main.
6. `npm run env -- attest <alias>` returns one JSON object whose `targetOverlay`
   and `doctorSnapshot` members are the two doctor inputs; write each to its
   own private file before `npm run verify:live:doctor -- --target <overlay>
   --snapshot <snapshot>`. A doctor `missing_actor` diagnostic is a registry
   gap (no registered actor alias for that lane), not a build failure: report
   it, and continue with the attended checklist as the signed-in test actor.

Use one suitable lane by default. Both colors are needed when explicitly
requested or testing cross-lane isolation, not for every application change.
Amber and Cobalt are ordinary exclusive QA lanes; the historical first protected
Cobalt qualification is not a standing requirement to merge before testing.

## Execute and grade

Run deterministic checks first, serially in the checkout. The regression command
uses isolated state and fake services, needs no OAuth, and does not send Slack
messages. Real-model evaluations are a separate layer. Real browser journeys
remain necessary for UI, installation, and actual delivery acceptance.

Reuse a completed local check from this task when its source tree (including
dirty/untracked inputs), lockfile, Node version, relevant configuration, and
check inventory are unchanged. Record the original result and log reference;
do not call it a fresh run. A commit SHA alone does not establish those inputs.
After a relevant edit, rerun the affected checks. Workflow-only edits do not
invalidate earlier product evidence, but exercise the revised workflow and
validate its public skill/export contracts. A different serving build, model,
actor, connection, or lane state requires fresh dependent live evidence.

Use normal browser tools and the existing short local UI mutex for competing
browser actions. Hold the environment claim through readback and cleanup. Release
the UI mutex while waiting for human input; retain the affected tab and browser
reservation. A hostname change does not change local ownership. Recovery requires
proof that the prior owner stopped. Never copy lock state between machines.

Record one lightweight private run record with mode, selected checks, source
commit and dirty diff identity, serving version, actual model, target, actor,
before-state, exact run-owned IDs, evidence references, result, and cleanup.
Reuse the existing journal when resuming. Capture certification, one-use
challenges, and the legacy coordinator are not prerequisites for this workflow.
The `verify:live:case/smoke/deep` CLIs are legacy entrypoints; do not invoke them
expecting these skill modes to run. Read the
[legacy coordinator runbook](../../../docs/runbooks/live-contract-verification.md)
only when explicitly operating that coordinator.

For each action, read the resulting state. After a timeout or ambiguous response,
inspect the UI and native dialogs before retrying. Replay only after proving the
action did not apply. Retry read-only observations within a bounded window. Do
not repeat a failed mutation merely to obtain a green result.

When an Agent shows "Thinking…" past about two minutes, treat it as a stall, not
a slow reply. Capture one bounded `npx wrangler tail <worker> --format json`
window (30 to 60 seconds) into a private file and stop it. The output is
pretty-printed JSON objects back to back, not one object per line; split on
top-level braces before reading. A repeating
`memory_metric {"event":"delivery_lease","outcome":"rejected"}` from the
`TagStateStore` entrypoint means the run cannot take the thread's delivery lease
and is polling; record the thread, the prior owner of that thread, and the
message that triggered it. Follow
[runtime observability](../../../docs/runbooks/runtime-observability.md) for the
rest. Do not send the same request again to "unstick" it.

Instruction and identity changes reach an Agent only on a fresh conversation
root. Existing threads carry a frozen snapshot of the Agent's effective
instructions, so a redeployed instruction fix must be verified in a new DM root
or channel message, never by continuing the thread that showed the failure.

Use exact comparisons for saved instructions, opaque proposal identity, fixture
values, destination, and resource ownership. Grade ordinary explanatory prose
by meaning unless the user explicitly requested literal output. Verify real
provider execution; an Agent's claim of success is insufficient. A simulated
cron or Run now is not deployed due-time proof. Check duplicates during the
declared observation window without claiming indefinite exactly-once delivery.

Clean only exact run-owned IDs or restore recorded before-values. Preserve
baseline connections and credentials, attributed Slack messages, and archived
Agent residue. Classify failures as product, verifier, environment, or unknown;
report cleanup separately. After a failure, rerun its journey and necessary setup
only when something relevant changed. A targeted pass does not upgrade an earlier
failed full run; rerun the requested inventory on the final build when needed.

For diagnosis read the existing evidence first and follow
[runtime observability](../../../docs/runbooks/runtime-observability.md).
Use the owning terminal locally and bounded historical logs or tail on the
deployed target. Attach tail before an authorized reproduction and stop afterward.
Missing sampled logs do not establish that an action never happened.

Return the mode/target/source, checks passed or failed, untested or blocked
coverage, cleanup, and elapsed time split into automated, browser/model, and human
waiting where available. Keep coordinates, transcripts, credentials, and evidence
outside Git. Never describe deterministic or model-only checks as live acceptance.
