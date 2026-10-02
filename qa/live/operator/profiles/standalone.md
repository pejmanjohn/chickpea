# Standalone profile

The `standalone` profile verifies this repository on Chickpea's QA lanes: Local
(an owned local workerd lane), Amber, Cobalt and Violet, plus a borrowed lane for
a fresh installation. This repository's skill entrypoint selects it, and it is
valid only when the project root is a checkout of this repository. Read it after
the [shared workflow](../SKILL.md).

## Normal path card

The commands of an ordinary deployed-lane run, in order. The shared workflow and
the sections below say why each step exists and what to do when one refuses.

1. `npm run verify:live:kickoff`, then fix its blockers. Ask once, in one
   message, for everything it lists under "Needs a person".
2. `npm run verify:regression -- --plan` to choose the mode and areas.
3. `npm run verify:live:record -- template ... --output <run>/spec.json`, plus
   `case-add` for journeys the template lacks.
4. `npm run env -- wait-claim <lane> --timeout-ms 0 --poll-ms 1000 --worktree <abs-worktree>`.
5. The deploy command the doctor printed for that lane, for example
   `CHICKPEA_DEPLOY_TARGET=<lane> npm run verify:host -- --wait-ms 300000 npm run deploy`.
   It writes the telemetry receipt.
6. Resolve the spec's contexts and capabilities against the deployed lane, then
   `record init` and `record preflight`.
7. `npm run verify:regression -- --record <run>/run.json` for the offline
   checks; it takes the host reservation itself.
8. `npm run lane:tail -- <lane> --out <private file> --minutes <N>` as one
   background command, when the run needs Worker logs.
9. For each case: `record begin`, act once through the lane browser, `record
   resource` for every run-owned ID and fixture before-value, save the
   readbacks, then `record finish`. Use `record blocked` for a case that
   cannot run.
10. After a fix commit or rebase: `npm run env -- restamp <lane>`, redeploy, and
    `record refresh`.
11. Clean every run-owned resource and record `cleanup` with its readback.
12. `record verdict` for each failed, blocked, ambiguous or stale case, `record report --output
    <run>/report.md`, then `npm run env -- release <lane>`.

## Declared QA actions on lanes

An invocation authorizes these actions on established Local, Amber, Cobalt, or
Violet test environments:

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
- Sending, creating, editing, archiving and cleaning in the lane Slack
  workspaces and their test accounts without asking. The shared exclusions
  still apply: no workspace deletion, no app or gateway configuration, and
  standing fixtures and sign-ins stay as they are. In Asana, use private tasks
  only, never shared projects.

A fresh Slack installation may borrow any eligible free registered lane using
the [installation reservation](../environments.md#borrow-a-lane-for-a-fresh-install).
Select it with `wait-claim any`; do not ask the user to permanently designate an
installation workspace. Choose `node` for a local installation, including macOS,
or `cloudflare` for a temporary Worker/D1 installation. Node uses newly allocated
local state and the guarded local launcher; it requires no Cloudflare deployment.
Preserve the standing installation and hold the claim through verified restoration.
Missing credentials, occupied lanes and unresolved restoration remain blockers.

## Kickoff preflight

1. Run `npm run verify:live:kickoff` (add `--lane <alias>` to check one). In
   one pass that changes nothing but starting any stopped lane browser, it
   checks host Node and `node_modules`, the host
   reservation, source freshness against remote main, and for each lane its
   health, claim, deploy profile and exact deploy command, schema generation
   against the candidate, models, Worker secrets, actors, telemetry receipt,
   and whether its browser daemon is signed in to Admin and Slack. It ends
   with what needs a person and the ready lanes. Fix its blockers before
   claiming. Then pick the lane by capability
   ([choose a lane by capability](../environments.md#choose-a-lane-by-capability)):
   registered connector fixtures and the selected cases' models must also fit.
   `npm run env -- --help` lists every lane command.
2. Lane browsers are yours to run: the doctor starts a stopped one, and if a
   `chrome-<lane>` tool cannot connect later, run
   `npm run lane:browser -- start <lane>` yourself and retry (see
   [hosts.md](../hosts.md#lane-browsers)). Never ask the maintainer to start one.
   A `held` profile belongs to another session; ask it to quit. Fall back to
   the host's own browser tool only when no daemon can start. Request any desktop-control grant the run will use now (see
   the [host adapter table](../hosts.md#host-adapter-table)).
3. Confirm the required credential fixtures exist on that lane (see
   [fixtures.md](../fixtures.md#credentials)). Never ask for a secret in chat.

## Targets, candidate admission and telemetry

These complete the shared normal path's steps 2 and 3 on lanes.

- `npm run verify:live:candidate` observes canonical remote main without
  fetching; handle its exact refusal using [environments.md](../environments.md).
- Check [fixtures.md](../fixtures.md) for selected operations and missing accounts,
  and bind capabilities using the [fixture inventory](../environments.md#fixture-inventory).
- Pick one QA lane using [environments.md](../environments.md), by capability
  rather than by trial and error. Reuse its claim. Prefer an owned local
  workerd/HTTP lane for repair cycles; deployed due-time, gateway, bindings, and
  release proof require a deployed lane.
- Advance a lane's schema with `npm run env -- schema-advance <lane>` whenever
  the candidate needs it, merged or not, without asking. Prefer a lane already
  at the candidate's generation, because an advance is permanent, and name it
  in the run report.
- Before synthetic actions on a deployed target, attach the serving version's
  [telemetry isolation receipt](../environments.md#product-telemetry-isolation):
  the guarded lane deploy writes it and prints its path, and
  `npm run verify:telemetry -- --target <alias>` produces it for a lane you did
  not deploy. This includes disposable fresh-install fixtures before their
  first Slack connection.

## Runner matrix mode

The parallel-turns / runner-stack matrix (parity, first status, concurrent long
turns with an interruption, mid-turn redeploys, a mention burst) is scripted.
Follow [runner-matrix.md](../runner-matrix.md): the verifier arms the page harness in
the lane browser, starts the driver, collects the export, and records results in
the same run record. It uses only the actions declared above.
