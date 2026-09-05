# Verification modes

Use `changed` by default. An explicit mode or narrower user request wins.
These are skill workflows, separate from the dormant coordinator's typed suites.

| Mode | Beneath the browser | Live journey |
| --- | --- | --- |
| `changed` | Focused tests and applicable offline checks selected from the diff | Changed behavior and its nearest failure, permission, or persistence case on one suitable lane |
| `regression` | Fixed core tests, offline delivery/durability/provider checks, authoring evaluation, Admin checks | Essential journeys below using reusable fixtures on one deployed candidate lane |
| `release` | Full repository tests, local workerd, offline checks, lockfile and committed-source export | Core journeys plus fresh OAuth, installation, authority, restart, and relevant feature coverage |

`smoke` remains a compatibility request for the original four journeys: create
and welcome, full instruction approval, fresh Personal OAuth/read, and actual
channel schedule delivery. Use the requested target, or one available deployed
lane when none is named. "Amber then Cobalt" explicitly runs both. `deep` requires
an explicit inventory; dormant catalog contracts are not executable coverage.

## Changed behavior

```sh
npm run verify:regression -- --plan
npm run verify:regression
# Explicit scope when it is clearer than the inferred diff:
npm run verify:regression -- --area routines --area delivery
```

The command compares with the merge base of local `origin/main`, including
uncommitted and untracked files. `--base REF` changes the comparison. `--area`
selects an explicit scope; combine it with `--base` to include both. Unknown
runtime changes and the shared Admin route module broaden to full tests and
local workerd. No changes specified
falls back to core regression. Documentation-only changes need no live journey.
The mapping is conservative, not proof of complete impact analysis.

- Instruction/tool guidance: preserve the full frozen proposal, approve once,
  and inspect the entire saved value. Check no early mutation. Use the existing
  [authoring evaluation](../../../docs/runbooks/agent-authoring-evaluation.md)
  for the relevant synthetic prompts before opening Slack.
- Delivery/routing: DM, channel root, and mention-free thread follow-up. Check
  the intended Agent, context, destination, and one terminal reply. Existing
  offline durability checks exercise duplicate ingress and process restart.
- Connections: use an existing registered connection for execution/formatting
  changes. Fresh OAuth is required when setup, callback, ownership, or reconnect
  behavior changes. Never count an existing read as fresh authorization proof.
- Schedules: check saved schedule and acknowledgement, then actual due delivery
  on a deployed lane. Exercise pause or private destination when affected.
- Auth/privacy: test an actual forbidden read or mutation using a distinct
  registered actor. An Owner acting as a Member cannot prove role denial.
- Memory/skills: save or import, verify behavior in a fresh conversation, then
  forget/remove and verify the effect ends. Restore the fixture afterward.

For prompt/model changes, use bounded relevant real-model cases with the lane's
actual configured model. The invocation authorizes this test-model use. Preserve
the model choice; do not silently substitute one or run the whole provider matrix.
The deterministic authoring check uses a faux provider and cannot establish model
quality. Record every first attempt; exact fixture/state assertions remain strict.

### Repair loop and final checkpoint

Use the private [run record commands](records.md) to preserve the first failure,
refresh prerequisites, and see which evidence a fix invalidates. Follow
[repair priority and handoff](recovery.md#repair-priority-and-handoff) and keep
independent journeys running on the current serving candidate while isolated
repairs proceed.

Choose an integration checkpoint by the useful work a repair unlocks, readiness
of reviewed fixes, code conflicts, and deployment/retest cost. Urgent blockers
may justify a single-fix checkpoint. For other failures, batch compatible reviewed
repairs instead of deploying each as it arrives. Set a bounded wait or next useful
checkpoint; then integrate the ready compatible subset or record what still
blocks it. Never wait for an arbitrary bug count or indefinitely for every repair.

When source integration is authorized, preserve individual repair commits and
failure identities. Review the combined diff for interactions and collect the
union of affected checks, including indirect dependencies. Run that union once
on the integrated candidate, with tests and builds serially in the checkout.
Changed source or a failed check requires the relevant validation again.

Keep the serving candidate fixed throughout each scenario and its observation
window. At the checkpoint, finish or reconcile open attempts and refresh source,
context, and prerequisites under the existing [deployment fences](environments.md).
Run the affected Local journeys with the actual model. Use one guarded QA deploy
for the batch when dependent deployed proof is required and authorized, then
retest each original failure and the combined impact on that candidate. Record
the hypothesis and changed variables; use fresh conversation roots for instruction
changes. Local results remain separate from deployed acceptance, and successful
retests never replace first failures.

After a truthful serving-version refresh, record a
[proven candidate transition](records.md#proven-candidate-transitions) to retain
unaffected passing evidence when source impact and stable runtime inputs support
it. Keep original version provenance. Without that proof, changed context stays
stale and needs fresh evidence; never leave the serving version artificially old.

Pass `--record <private-run.json>` to the regression command for logs and timing.
An unchanged repeat may add `--reuse`; a new source/configuration/inventory cannot
reuse those offline receipts. Reserve both Node versions and clean export for
the deliberate stable-candidate release checkpoint, unless a broader failure or
impact justifies them earlier. For a release run, once the final candidate is
stable and committed, run the complete release checkpoint and selected live
release matrix. Batching does not waive any final release gate.

## Core regression

```sh
npm run verify:regression -- --mode regression
```

Use existing signed-in test actors, Agents, and connections. Start independent
scheduled work early when its fixtures do not conflict with other cases, then
observe its due result while finishing the remaining checks. Do not shorten the
observation window to claim a faster pass.

1. Send a run-marked DM and channel request, then follow up in the channel thread.
   Verify correct Agent, destination, context, and no duplicate terminal reply.
2. Ask `@Chickpea` in the QA channel to create one run-marked Agent and assign it
   to that channel. Observe exactly one welcome in the creation thread. Reuse
   this Agent for the instruction test: mention its own resolved Slack handle in
   a fresh thread, request a complete frozen update, prove no early save, approve
   it, and read the full result. An unrelated user Agent cannot edit it. Admin
   creation and later channel attachment do not exercise the Slack welcome path.
3. Read the declared synthetic provider fixture through an existing connection
   in its allowed context. Personal accounts stay in the owning user's DM;
   channel execution requires a Team connection. Check actual provider execution.
4. Create a run-owned channel schedule. Verify its saved destination, meaningful
   acknowledgement, and actual due delivery linked to a scheduled occurrence.
   Confirm no wrong-thread or duplicate output within the observation window.

Use the assertions in the corresponding [cases](../cases/) and exact cleanup.
The simple routing journey is behavioral coverage; it does not certify every
internal route-state assertion in dormant LC-03. Missing fixtures block only the
dependent check. Complete the rest and report the gap.

### Repeatable browser steps

- Fill or paste the complete message into the composer in one operation. Resolve
  its intended mention through Slack's current suggestion list, then send once.
  Character-by-character entry of long prompts is slow and can time out with a
  partial unsent draft. Reinspect that draft before replacing or sending it.
- Read the specific run-marked message or thread instead of dumping channel
  history. Record its canonical permalink after Slack replaces any provisional
  timestamp. After navigation, wait for the relevant heading or control; a
  loading shell or a short observation timeout is not a failed product action.
- For instruction updates, use explicit replacement delimiters and a multiline
  final sentinel. In the Agent's Admin page, expand **Slack update proposal
  details** and **Refresh Slack proposals**. Compare the full frozen value,
  target, requester, conversation, and revision before sending bare `approve`
  in that same thread. Refresh the proposal result, then reload the Agent page
  before comparing the saved textarea's actual value, including newlines.
  Refreshing proposals alone does not reload the instruction editor; snapshot
  prose can also collapse whitespace. Check one retained approval turn and its
  completed apply result.
- For creation, use **Saved Agent details** and **Creation delivery details →
  Refresh creation delivery** to match the welcome's Agent, channel, thread,
  delivery reference, publication, and settled activity to the actual Slack
  message. Record the returned Agent ID; do not derive it from its display name.
  If creation did not request a model, verify workspace-model inheritance in
  **Model** and exercise a real request to the new Agent. A welcome can succeed
  even when a bad model pin makes the Agent's first actual request fail.
- Inspect the declared synthetic provider range before requesting it. Prefer
  stable baseline rows for regression; a previous run's temporary rows may have
  been cleaned. Request a JSON array in a code block preserving every cell
  character as strings, with no typography substitutions. Compare parsed values exactly
  and inspect the matching provider execution's account, range, and result.
  A successful call alone does not pass a response with altered fixture data.
- The saved schedule and occurrence history are available at the selected
  Admin origin's `/admin/audit-logs/scheduled-work`. Open the run-marked routine,
  then **View run history and activity**. Match its real scheduled occurrence's
  **Open message** link to Slack. Inspect immutable channel IDs when display
  labels disagree; record the discrepancy rather than assuming wrong delivery.

### Slack desktop through Computer Use

When the Chrome extension is unavailable, the Slack desktop app under background
Computer Use control works for every journey above. Facts that cost time to learn:

- Grant "Slack" once; the invocation covers it. The window title is withheld, so
  target it by `window_id` from the window list. Switch workspaces through the
  accessibility tab named for the lane ("Chickpea Cobalt").
- The sidebar row for Chickpea under Agents & apps does not open the DM on an
  accessibility press; the toolbar button "Open Chickpea" does. Thread "N
  replies" links open through their accessibility index, not by coordinate.
- Click the composer, then type in one operation. The raw-keystroke fallback can
  duplicate the whole message; take a screenshot before sending and replace the
  field (click on the text itself, then type with overwrite) if it doubled.
  Send with the composer's send button rather than Return, which is refused
  while a native dialog is attached to Slack.
- Typing `@handle` as plain text still becomes a real mention on send. That
  hands the thread to that Agent, which is often the point, but it means an
  explicit `@Chickpea` is required to get Chickpea back in a thread another
  Agent owns.
- Replies take 15 to 40 seconds. Wait with a background `until` timer and a
  fresh screenshot, then read the thread pane at full scale for exact text.

These steps reduce navigation and setup; they do not replace the case assertions
or turn an initial failure into a first-attempt pass. Keep the initial outcome
and the changed procedure or product fix next to each targeted retest result.

## Release acceptance

```sh
npm run verify:regression -- --mode release
```

This command requires clean committed source because OSS export checks HEAD.
Follow [releasing](../../../docs/runbooks/releasing.md) for required Node versions,
dependency audit, and advertised deployment profiles. This mode verifies a
candidate; it never tags, publishes, merges, or deploys production.

Run core regression plus fresh Personal connection setup on the empty connector
test Agent, actual second-user denial, and retained state/sign-in/delivery after
restart or QA redeploy. For first release or setup changes, exercise installation
from the public-source artifact on a designated disposable target. For later
releases exercise the documented upgrade as well. Include affected memory, skill,
private schedule, revocation, and other advertised feature journeys. Report each
missing actor, fixture, or unsupported contract as untested/blocked.

Fresh OAuth consent and exact test teardown are already authorized by invocation.
Pause only for a real missing credential/capability or an out-of-scope change,
as described in the skill. One failed lane cannot be averaged into a release pass.
