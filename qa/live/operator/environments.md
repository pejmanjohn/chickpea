# Environment selection and deployment fences

## Select one environment

1. Inspect the complete diff, including branch, staged, unstaged, and untracked
   changes. Start with `npm run verify:regression -- --plan`; use `--base REF`
   when the intended comparison differs from local `origin/main`. The mapping is
   a starting point. Include indirectly affected behavior identified in review.
2. Reuse a matching claim. For bounded automatic acquisition, run exactly
   `npm run env -- wait-claim <amber|cobalt|violet|any> --timeout-ms <milliseconds>
   --poll-ms <milliseconds> --worktree <absolute-worktree>`. It reuses only the
   current worktree's matching live claim. Otherwise it polls read-only status
   and attempts the normal atomic claim only for a healthy free lane with no
   verifier lock. Set the timeout from 0 through 7,200,000 milliseconds and the
   poll interval from 250 through 60,000 milliseconds. Only expected contention
   is retried. A timeout returns a structured timeout result with a distinct
   exit status; a signal cancels the
   wait and releases any claim created during cancellation. Source HEAD drift,
   mismatched ownership, orphan markers, expired claims, unhealthy lanes and
   other errors stop the command for explicit repair. It never deploys,
   reclaims, adopts or clears another owner.

   For manual selection, inspect `npm run env -- status --worktree
   <absolute-worktree>`, then claim one free deployed lane when needed. Never
   borrow another task's claim. A claim remains until its holder runs `release`
   or an operator performs an explicit permitted reclaim; expiry alone does not
   let `wait-claim` repair or take it. When `env status` shows a holder whose
   worktree no longer exists, `npm run env -- reclaim <alias> --adopt-orphan`
   can adopt it,
   but freeing another task's hold is the operator's decision: report the
   holder and ask before adopting. All registered lanes busy means preserve pending work and
   use the bounded wait described above. See [host coordination](hosts.md) for
   longer waits and host reservations.
3. Prefer an initialized local workerd/HTTP lane for repeated application edits.
   Run `npm run dev:cf -- status --lane <lane>` in its owning worktree. From a
   different named worktree of the same Git repository, discovery is read-only:
   `npm run dev:cf -- status --lane <lane> --runner-root
   <absolute-canonical-runner-worktree>`. The result reports the fixed runner,
   state, D1, Slack and endpoint tuple separately from the calling candidate's
   HEAD and working-content fingerprint. The manifest model is only the
   configured default; effective model remains `unverified` until policy or
   real-turn readback proves it. Follow
   [local Worker development](../../../docs/runbooks/local-worker-development.md).
   Local state is currently worktree-bound. Existing manifests do not record
   the D1/DO schema generation that last changed retained state, so
   cross-worktree startup remains unavailable. `--runner-root` is refused for
   init, binding, setup renewal, relocation, setup-link, start and schedule.
   Do not copy or relocate state into a fresh worktree; use an available
   deployed lane until the schema-history and crash-safe advancement contract
   is implemented and accepted.
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
   did not claim means that other lane's credential is missing. Lanes deploy
   independently: another lane's authority is briefly unavailable while that
   lane is itself deploying, so it gets one retry and then its recorded
   credential fingerprints stand in (the deploy prints a notice naming it).
   The claimed lane must always answer live. `LIVE_AUTHORITY_BRIDGE_UNAVAILABLE`
   names the lane at fault: the claimed lane when it does not answer, or an
   unavailable other lane whose recorded baseline is missing or invalid, so
   its fingerprints cannot stand in. Never print
   the token. Never use a bare/default deploy to reach a QA lane. Preserve
   source/claim fences. Verification does not imply landing on main.

   Standing provider keys come from the operator's lane secrets file,
   `~/.chickpea/qa-secrets.env` (override the path with
   `CHICKPEA_LANE_SECRETS_FILE`). It is an owner-only dotenv file outside
   Git. A plain name such as `OPENAI_API_KEY` is shared by every lane, and
   `<LANE>__NAME` (for example `COBALT__OPENAI_API_KEY`) overrides it for one
   lane. Every guarded deploy to a claimed lane uploads the provider keys the
   product reads from its environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
   `OPENROUTER_API_KEY`, `BROWSERBASE_API_KEY`) in its atomic secrets file.
   Empty values are skipped. `COMPOSIO_API_KEY` is lane-only: each lane is
   registered with its own Composio project and auth configs, so only
   `<LANE>__COMPOSIO_API_KEY` is uploaded (use that lane's current project key
   so existing managed connections keep working), and a shared value is
   ignored with a warning. With it set, Admin shows the Composio key as
   deployment-managed. A rebuilt lane therefore regains its keys on its
   first deploy, and changing a key means editing the file and redeploying each
   lane. Other plain or this-lane names, such as a connector token that
   belongs in the database, are listed as held (not Worker secrets) and left
   for a seeding step. The deploy log and
   `npm run lane:secrets -- <lane>` print names, sources, and short
   fingerprints, never values. Set `CHICKPEA_LANE_SECRETS=off` to deploy
   without the file. Verifiers never write or read the values; the maintainer
   edits the file.

   Standing test connections come back the same way after a lane rebuild.
   Each guarded lane deploy also installs the lane's seed token
   (`~/.chickpea/lane-credentials/<lane>-seed.json`, created on first use).
   The private manifest `~/.chickpea/qa-seed.json` has no secrets. It names
   catalog connectors and the secrets-file name that carries each token:

   ```json
   { "schemaVersion": "chickpea-lane-seed/v1",
     "connections": [
       { "connector": "asana", "secret": "ASANA_QA_TOKEN" },
       { "connector": "gmail" } ] }
   ```

   Run `npm run lane:seed -- <lane> --agent <agentId>` (add `--dry-run` to see
   what would be sent). Token connectors (API keys and MCP bearer or header
   credentials) are created on that Agent as team connections owned by the
   workspace owner. A connector the Agent already has is reported `present`
   and left unchanged. OAuth and managed (Composio) connectors return an Admin
   setup link; open it in the verifier's browser, signed in to the lane Admin,
   and complete the consent as a declared QA action. The seed route exists only
   on QA targets and answers only the lane's seed token. Seeded connections on
   a run-owned Agent are run-owned resources: register them and disconnect them
   at cleanup.

   For a one-off credential outside that file, a lane that needs a provider
   credential the product reads from the environment gets it through the same
   guarded deploy: put the names and values in an
   owner-only JSON object at a private absolute path and set
   `CHICKPEA_DEPLOY_SECRETS_FILE=<path>` for that `npm run deploy`. The wrapper
   uploads them in its atomic secrets file, so the deploy still yields one
   live version that matches its receipt. Never upload a lane secret with the
   bare Wrangler secret command: that creates a live version the registry has
   not recorded, and every later guarded deploy and attestation refuses with
   a serving-version mismatch until the Worker is restored to the recorded
   version. A secret uploaded this way persists across later guarded deploys.
   Deleting it would drift the live version the same way the bare upload
   does, so leave it in place at cleanup and report it in the run record.

   Before a guarded QA deployment, `npm run verify:live:candidate -- [--remote
   origin]` provides the same read-only source admission used by the wrapper.
   It observes canonical remote `main` without rewriting refs, verifies that
   the remote identifies the repository declared by the candidate, requires
   the observed tip to exist locally, and requires the candidate to contain
   that tip. This allows independent feature candidates based on the same
   current main; it does not require ancestry from the feature currently
   serving another lane. It also fingerprints working contents. Admission runs
   for every upload, including a resumed upload, and the wrapper rechecks source
   identity before upload. It does not replace claim, install, schema, runtime
   or live-acceptance fences. Read-only reconciliation of an existing intent
   remains available when no new upload occurs.

   A claim is stamped with the worktree's HEAD. Do not commit, amend, or
   rebase in that worktree while a claimed deploy is running, and re-claim
   after committing before the next deploy: a HEAD that differs from the
   claimed revision fails the deploy's final fence with
   `MUTATION_LEASE_AUTHORITY_CHANGED`, and then `release`, `reclaim`, and
   `reconciliation` all refuse with `CLAIM_REVISION_MISMATCH`. Recovery is to
   check out the claimed revision, run `npm run env -- reconciliation <alias>`
   (it adopts the uploaded version and clears the intent lock), release, and
   only then move HEAD again.

   Claims need a named branch. `claim` and `wait-claim` refuse a detached HEAD
   with `INVALID_WORKTREE`, so create a branch at the candidate first. To land
   a fix commit during a claimed run, with no deploy in flight:

   ```sh
   git branch <fix-tip>                # keep the new commit
   git reset --hard <claimed-revision>
   npm run env -- release <alias> --worktree <absolute-worktree>
   git reset --hard <fix-tip>
   npm run env -- wait-claim <alias> --timeout-ms 0 --poll-ms 1000 --worktree <absolute-worktree>
   ```

   Batch fixes between deploys to keep these cycles rare. When `main` has
   moved, the deploy refuses with `QA_SOURCE_BEHIND_MAIN`. Merge or rebase onto
   the new `origin/main` just before the deploy, re-run affected offline checks,
   and re-claim at the new HEAD. For stacked candidates, build a local verify
   branch from `origin/main` plus the needed commits.
   Only the Slack manifest digest, the required scopes, and
   `src/auth/setup-capability.mjs` are hard-gated against the lane baseline; a
   mismatch refuses with `INSTALL_CONTINUATION_REQUIRED`, and the recovery is to
   prove a fresh install on a disposable target and re-record the baseline.
   An existing installation may omit the optional `lists:read` and `lists:write`
   scopes when its entire manifest otherwise matches. That deployment preserves
   the baseline and still verifies the exact recorded live grant; it needs no
   Slack reinstall or baseline rewrite.
   Changes to the setup flow (`src/auth/setup-handoff.ts`,
   `src/management/setup-routes.ts`, `src/config/onboarding-state.ts`,
   `src/admin/onboarding-proof.ts`) deploy normally and mark the lane
   `setupFlowUnprovenSince <sha>` in `env status`. Report that marker; in
   `release` mode clear it with a fresh-install journey on a disposable target
   followed by a baseline re-record.
6. `npm run env -- attest <alias>` returns one JSON object whose `targetOverlay`
   and `doctorSnapshot` members are the two doctor inputs; write each to its
   own private file before `npm run verify:live:doctor -- --target <overlay>
   --snapshot <snapshot>`. A doctor `missing_actor` diagnostic is a registry
   gap (no registered actor alias for that lane), not a build failure: report
   it, and continue with the attended checklist as the signed-in test actor.

## Choose a lane by capability

Lanes are not interchangeable. They differ in deploy profile, provider keys,
model roles, registered fixtures, and registered actors. Before `wait-claim` or
`claim`, run:

```bash
npm run env -- capabilities all          # table; add --json for a record
npm run env -- capabilities all --write  # also refresh the private matrix
```

It fills one row per lane from read-only readbacks and reports an unreachable
lane in its own row (`read errors: ...`) without failing the others. Pass
`--profile`/`--env` the same way as other `env` commands when Wrangler needs
them. Pick a lane that covers every selected case, then use `wait-claim <alias>`
for it. Use `wait-claim any` only when all lanes qualify.

`--write` rewrites only the generated section of the private lane capability
matrix (lane-capabilities.md in `~/.chickpea/environments/`). Keep hand-written
notes, such as GitHub App grants, fixtures, and Chrome sign-in, outside that
section, and keep lane-specific values out of this repository.

| Column | Source |
| --- | --- |
| Deploy profile (`core`, `sandbox`, or `mixed` during a split deployment) and live version | Wrangler: the serving version's `SANDBOX` binding. A core deploy over a sandbox Worker is refused, so use `npm run deploy:sandbox` there. A live version that differs from the registry is shown next to it. |
| Provider keys by name (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `BROWSERBASE_API_KEY`, `COMPOSIO_API_KEY`) and `CHICKPEA_ENV_SEED_TOKEN` | Wrangler `secret list`, names only. The seed token column also shows whether the operator holds the lane's seed token file (existence only). |
| Default chat model and image role | Not generated: no read-only host path exposes them. Read Admin Settings › Model providers, or the model footer of a one-word Agent reply. |
| Missing actor aliases, Slack workspace label, transport, setup-flow marker, claim | The environment registry, as in `env status`. `missing_actor` limits Member-view checks. A `gateway` lane has no operator Slack token (see [hosts.md](hosts.md#slack-evidence-on-gateway-lanes)). |
| GitHub App and granted repositories, sandbox runtime on or off | Not generated. Admin Settings › Coding sandbox and GitHub. |
| Registered connector fixtures and standing QA connections | Not generated. The private fixture inventory ([fixtures.md](fixtures.md)). |
| Whether Chrome is signed in to Slack and Admin | Not generated. The browser. A lane's workspace can display under an older name. |

Rerun the command after any deploy, profile switch, or secret upload. Update
the hand-written notes with their observation date after any model or fixture
change on that lane.
If no lane covers a case, report that as a blocker. Queueing for a capable lane
beats running the case on a lane that must fail it. A weak default model can
produce model failures that look like product bugs. Grade them `model`, or pin
the case's declared model. Do not substitute a model silently.

Use one suitable lane by default. Multiple colors are needed when explicitly
requested or testing cross-lane isolation, not for every application change.
Amber, Cobalt, and Violet are ordinary exclusive QA lanes once registered; the historical first protected
Cobalt qualification is not a standing requirement to merge before testing.

The expected source repository defaults to `pejmanjohn/chickpea`. A maintainer
using a registered fork may explicitly set `CHICKPEA_QA_SOURCE_REPOSITORY=owner/repository`;
do not set this just to clear a refusal. Both package metadata and the selected
remote must match that identity. Candidate metadata cannot redefine the default.
This is an operator error guard, not a sandbox for untrusted deployment code.

## Product telemetry isolation

Before synthetic activity on any deployed target, run
`npm run verify:telemetry -- --worker <resolved-worker-name>
--account-id <resolved-account-id> --output
<private-policy-receipt.json>`, including the target's recorded `--profile` and
`--env` when present. Retain the receipt with the target capability's
private evidence. Repeat after a serving-version or binding change. Every
traffic-serving version must explicitly label telemetry `test` or verifiably
disable it. Enabled telemetry without a `test` label, an unverified opt-out, or a
serving change blocks dependent live actions until resolved through the target's
normal configuration and deployment flow.

Amber, Cobalt, and Violet builds stamp `CHICKPEA_TELEMETRY_ENVIRONMENT=test` automatically,
and the guarded deployment validates that artifact setting. Existing serving
versions still require readback; source configuration alone is not proof.
Local lanes already use `development`, and the offline Cloudflare smoke Worker
disables telemetry directly in its bindings.

For a fresh disposable installation outside those named targets, apply `test`
or the telemetry opt-out before the first Slack connection, then run the same
serving-version check. Do not infer this setting from a Worker name or from
the shell's environment. Preserve the receipt before tearing down disposable
state. See [product telemetry](../../../docs/runbooks/product-telemetry.md#keeping-tests-out-of-product-metrics)
for the distinction between future labeling and historical exclusions.

## Repair worktrees and serving candidates

Give repair agents separate worktrees based on an identified candidate, with
explicit file ownership and only the retained evidence needed for diagnosis.
They must not access live/shared resources, another task's checkout or processes,
Worker state, claims, credentials, or browser sessions. They return patches and
focused local validation to the verifier. One owner handles overlapping code;
tests and builds remain serial within each checkout and expensive groups use
the shared [host reservation](host-checks.md). Use the supported waiting and
continuation rules in [host coordination](hosts.md).

The verifier alone integrates reviewed repairs when authorized and owns the
live lane. Keep its serving candidate fixed for each scenario and observation
window. Fixture changes must follow the declared test actions. Finish or reconcile
open attempts before switching candidates, including pending due-time observations
and cleanup.
Apply the existing source/claim fences at every batch deployment; batching never
permits a stale claim, a mid-deploy HEAD change, or mutation of another task's lane.
Refresh affected evidence after a candidate switch. See the
[batch checkpoint policy](modes.md#repair-loop-and-final-checkpoint).

Use task-owned browser tabs as described in [hosts.md](hosts.md). Coordinate only
operations that affect an actual shared resource. A hostname change does not
change environment or expensive-check lock ownership. Recovery of those locks
requires proof that the prior owner stopped. Never copy lock state between machines.

## Fixture inventory

Before choosing a lane, inventory capabilities by the operation they must enable.
Keep this in the existing private spec and evidence, not a public account list.
Use [fixture readiness](fixtures.md) for the registered private inventory and
per-case blockers.

| Actor and observed role | Exact lane/context | Connection/provider fixture | Operation to prove |
| --- | --- | --- | --- |
| Owner or Admin | Chosen candidate | Declared synthetic provider rows and owning Agent binding | Positive read/write and exact restoration |
| Distinct Member plus authorized completer | Same candidate | Configured connector and the same pending setup | Permission denial or two-completer setup race |
| Authorized reconnect actor | Same candidate | Disposable connection and dependent run-owned schedule | Authority loss, reconnect and separately graded due recovery |
| Registered installer | Exclusively reserved free lane | Fresh public artifact, empty temporary state and approved test account | Fresh installation, first real request and restoration |

Resolve actor identity/role, lane app/workspace pair, Agent/account binding,
provider fixture revision, allowed operation and evidence expiry together.
An existing Member identity does not imply a connector is configured there.
Refresh each capability's context snapshot after any relevant fixture or lane
change. Shared browser control is not shared account authority.

Check installation availability at initial scope selection. If every lane is
occupied, keep fresh installation blocked and finish independent cases. A quiet
Slack channel does not establish that its lane is free.

## Borrow a lane for a fresh install

Fresh installation is a temporary use of any eligible free registered lane's
Slack workspace. Choose the installation runtime independently of the standing
lane's Cloudflare runtime. A local Node installation on macOS needs isolated
local state, not a temporary Cloudflare deployment or a permanently designated
installation workspace. Preserve the standing installation and unrelated state.

1. Select and claim a healthy free lane without asking the user to designate one:

   ```sh
   npm run env -- wait-claim any --timeout-ms 0 --poll-ms 1000
   ```

   Use the returned alias in the commands below. The selector skips claimed,
   unhealthy and verifier-locked lanes. A timed-out selection is an actionable
   availability blocker; do not reclaim another task's lane. Inventory pending
   schedules, proposals, deliveries and cleanup, and resolve ownership of
   independent apps sharing the workspace. Record exact standing Slack, Admin
   and fixture state in owner-only `before.json`, with `slack`, `admin`,
   `fixtures`, `pendingWork: false` and `independentAppsResolved: true`. Those
   booleans are attended observations, not permission to skip inspection.
2. Prepare an isolated installation checkout or release artifact. Use a private
   directory outside Git for evidence and state. Write an owner-only spec with
   `runId`, absolute `installerPath`, absolute `beforeEvidence`, and the runtime
   fields below. Reserve before disconnecting Slack or starting the installation:

   ```sh
   npm run env -- install-reserve <alias> --installation /private/path/spec.json
   ```

   Reservation checks the current claim, unresolved verifier work and live
   standing baseline. Normal lane deployment and release are refused until
   restoration. Expiry, interruption and reclaim retain the reservation.
   Standing Cloudflare authority is inspected for both runtimes; Node needs no
   D1 creation receipt, Worker creation or Cloudflare deployment. Missing read
   credentials for that authority remain a blocker.

### Local Node installation

Use `runtime: "node"` and `stateParent`, an absolute, canonical, owner-only
existing directory outside Git. For example:

```json
{
  "runtime": "node",
  "runId": "node-install-example",
  "installerPath": "/private/path/customer-release",
  "beforeEvidence": "/private/path/before.json",
  "stateParent": "/private/path"
}
```

The reservation creates a new empty directory under `stateParent` and returns
its exact `installation.statePath`. It never adopts or empties an existing local
installation. Keep this path in the private run record. The launcher fixes all
four persistent paths beneath it:

| Runtime variable | File beneath the reserved state path |
| --- | --- |
| `TAG_DB_PATH` | `transcripts.sqlite` |
| `SLACK_STATE_DB_PATH` | `state.sqlite` |
| `CHICKPEA_AUTH_DB_PATH` | `auth.sqlite` |
| `CHICKPEA_CREDENTIAL_KEYRING_PATH` | `credential-keyring.json` |

Follow the [Node installation procedure](../../../docs/runbooks/operations.md#production-node)
for the exact candidate, including its Node build and supported Slack transport.
Use Node 24.20.0. A checkout build uses `npm run flue:build`, with host coordination;
do not deploy to Cloudflare for this local test. Record the artifact/revision,
Node version, transport, local port and public endpoint. Inspect pending work and
use the supported disconnect/install flow for the borrowed workspace. Do not
change shared gateway/app configuration to make a Node test work. Use the
registered test app and credentials required by the candidate's Node transport;
a missing credential or incompatible app remains an explicit blocker.

Put only this run's runtime variables in an owner-only JSON object at
`/private/path/runtime-env.json`. Include its chosen port, public URL, fresh auth
secret, setup capability and declared provider/Slack configuration. Values must
be strings. Do not copy a standing environment wholesale or include another
installation's database or keyring paths. From the claiming operator checkout:

```sh
npm run env -- install-start <alias> --runtime-env /private/path/runtime-env.json
```

The launcher runs the isolated release's unchanged `dist/server.mjs` with these
variables and the reserved state paths. It does not inherit ambient credentials,
load a development `.env`, or use a Cloudflare deployment wrapper. It rejects
path overrides, symlinks, shared files, unsupported Node versions, expired claims
and a second launcher. Its child creates files with an owner-only umask. Keep the
launcher in its owning terminal. Restart through the same command to preserve
this run's state; restarting is not another fresh-install pass. Verify setup,
signed-in Admin and a real Slack request against the local runtime and retain
its evidence separately from deployed-lane acceptance.

Stop the launcher and its own child process group normally. It forwards SIGINT
and SIGTERM to that group. It keeps a private `<statePath>.process.json` receipt
if interrupted or descendants remain. Reclaim your expired claim through the
existing recovery workflow, then run:

```sh
npm run env -- install-reconcile <alias>
```

Reconciliation removes only the process receipt, after proving both the launcher
and child group have stopped. It neither kills processes nor deletes state. A
receipt from interruption before the child PID was recorded is unresolved;
preserve it and inspect the owning terminal/process tree before an attended
recovery. Do not delete an unexplained receipt to obtain a pass. Other tooling
must understand Node reservations before it operates this registry.

After stopping all run-owned processes and endpoints, preserve private evidence
outside the state directory and remove only the exact reserved state directory.
The launcher never recursively deletes state for you. Reconnect the standing
installation and read back its routing, Admin and fixtures. Use the common
restoration receipt below with this `temporary` object:

```json
{
  "runtime": "node",
  "statePath": "/private/path/node-install-RETURNED_SUFFIX",
  "processPresent": false,
  "statePresent": false
}
```

The command checks actual local absence as well as the operator receipt. An
unresolved process receipt or any remaining state path blocks restoration,
including if one appears during the live authority check.

### Cloudflare installation

Use `runtime: "cloudflare"`, `workerName`, `authDatabaseName`, `authDatabaseId`,
and absolute `databaseCreationReceipt` in the spec. Omitted `runtime` remains
compatible with older Cloudflare reservations. Create the empty temporary D1
through the existing resource intent and receipt workflow. Its receipt must
identify the exact D1 created under this lane's current claim.

Follow the customer disconnect/install flow. Use the temporary coordinates in
the isolated installer's `wrangler.jsonc`, then its guarded `npm run deploy` with
`CHICKPEA_INSTALLATION_LANE=<alias>` and `CHICKPEA_DEPLOY_TARGET=production`.
Here `production` selects that checkout's ordinary Worker; the installation fence
checks the exact reserved temporary Worker and D1 before build and mutation.
Never point it at standing resources. An existing temporary Worker is refused;
reconcile an interrupted attempt before another fresh install. The installer
must include the reservation-aware deployment wrapper. An older artifact that
ignores `CHICKPEA_INSTALLATION_LANE` cannot establish this guarded Cloudflare
rehearsal. Do not patch it and call it an unchanged customer release test.

Verify fresh setup, signed-in Admin and a real Slack request. Clean the exact
temporary Worker and D1, reconnect the standing installation, and read back its
routing, Admin and fixture state. Its restoration receipt uses
`temporary: {workerName, authDatabaseId, workerPresent: false, databasePresent: false}`.
Cloudflare and Node startup guards reject a reservation for the other runtime.

### Verify restoration and release

For either runtime, save private JSON readbacks and an owner-only restoration
receipt with `runId`, `restored` equal to the original before-state, the runtime's
`temporary` object above, and absolute `slackEvidence`, `adminEvidence`,
`cleanupEvidence` paths. Include exact run-owned app/endpoint cleanup where used.
These are attended operator receipts. The command also independently checks the
standing live authority, serving version and baseline.

```sh
npm run env -- install-restore <alias> --installation /private/path/restore.json
npm run env -- release <alias>
```

If anything fails, retain the claim and reservation for recovery. Never submit
a successful restoration receipt without actual readbacks. Other lanes can
continue: their preflight checks a borrowed lane's unchanged standing Worker
version and bindings and retains its pinned credential fingerprints for
isolation. That exception is not Slack acceptance for the borrowed lane; its
restoration always requires fresh live authority.
