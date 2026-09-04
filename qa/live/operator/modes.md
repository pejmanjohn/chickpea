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
2. Create a run-marked Agent and observe exactly one welcome. Preview a complete
   instruction update, prove no early save, approve it, and read the full result.
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
