# Parallel live test environments

## Current execution scope: two standalone lanes

For ordinary verification use the [operator skill](../../qa/live/operator/SKILL.md).
Its invocation authorizes declared QA actions and exact cleanup, including
test OAuth consent and product approval dialogs. The historical provisioning
gates below do not add per-step confirmation to an already authorized QA run.
New infrastructure, billing, unrelated permissions, and shared app/gateway changes
remain outside that invocation. Existing claimed Amber and Cobalt lanes may test
branch candidates without requiring a source merge.

The latest user-approved amendment in
`docs/plans/2026-08-27-parallel-lanes.md` starts with **Amber and Cobalt only**,
each in a standalone Slack Pro workspace with the Chickpea-owned shared app.
The earlier three-workspace Enterprise sandbox instructions below are historical
capability-pilot instructions, not the active provisioning recipe.

Keep Fern and the old sandbox resources intact but outside active registration,
claims, browser aliases, connector provisioning, deployments, and acceptance.
Do not buy a third workspace or invent a third registry entry. All active fleet
operations must depend only on Amber and Cobalt. Reject Fern as inactive.

Confirm one paid human seat per workspace and monthly billing at checkout.
Disable automatic email-domain membership and avoid invitations to unrelated
people. Record each workspace-local actor, bot, DM, and installation identity.
Never use labels or the shared app ID as routing proof. Preserve existing
deployment state until an exact-target migration and rollback path are recorded.

The active standalone resources are `chickpea-amber-live` with
`chickpea-auth-db-amber-live`, and `chickpea-cobalt-live` with
`chickpea-auth-db-cobalt-live`. The profile enforces these names. Keep the old
unsuffixed resources and installations unchanged for rollback, outside active
registration. Never attach a fresh workspace to an already-installed deployment.

Run the first protected-source smoke on clean, unclaimed Cobalt, then prove
different worktree revisions on both lanes with the four existing smoke cases.
Require real Computer Use DM/channel proof, connector behavior, cleanup, and
postflight before either lane is declared ready. Add Fern only after the user
decides to continue with a third verified lane.

## Historical three-lane capability pilot

This runbook covers the Slack and Cloudflare capability pilot and the
three Phase 1 targets. Product acceptance runs belong to the Live Contract
Verifier. This runbook does not authorize any continuation environment.

Phase 1 has exactly three target names: `amber`, `cobalt`, and `fern`. Do not
create resources for `dedicated-qa`, `install`, `demo`, `spare`, qualification,
or deep testing.

## Everyday lanes use the Chickpea-owned app

The three everyday lanes use Chickpea's recommended **Add to Slack** flow,
with one shared app and three workspace installation bindings. Each lane keeps
its own Worker, D1, Durable Object state, deployment signing identity,
auth/encryption roots, Agents, connector bindings, fixtures, and evidence root.
The app ID may repeat only for gateway-transport lanes. It does not identify a
lane on its own.

Keep the color in workspace names, Admin badges, CLI status, and verifier
reports. Do not rename the shared app for a lane. Claims and attestation must
check the workspace, installation binding, deployment identity, and live Worker
revision together. Never infer routing from a Slack subdomain or display name.
Within an Enterprise organization, visibly prove the intended lane receives
each DM and channel request before declaring the workspaces independent.

The shared gateway and app-global configuration are common dependencies.
Ordinary lane work may install and use the app, but must not deploy, change
permissions on, revoke, or delete those shared resources. Gateway deployments
must not receive the shared app's bot token or signing secret. Preflight needs
live installation authority, including granted permissions, without copying
those secrets into a lane. A manifest describes requested permissions; it is
not proof of an existing installation's granted permissions.

### First bootstrap and runtime authority

All three permanent lanes use gateway transport. The built-in
`/internal/environment/authority` endpoint supports that topology only; the
legacy Events authority contract requires a separate private adapter and is
not the bootstrap recipe for this fleet. Do not mix a manual pilot into the
permanent registry.

Before the registry exists, bootstrap each **fresh, unregistered** target with
the normal deployment wrapper after proving its exact Worker and D1 names do
not exist. This one-time bootstrap must not claim guarded-deployment readiness:
the guard requires both authority endpoints and complete registrations.
Keep creation receipts, provision independent secrets, install through Add to
Slack, and verify real UI behavior before recording baselines. Once registered,
use the claimed target and guarded wrapper for every deployment. With a claim
marker present, the wrapper resolves the registered AUTH_DB ID and schema
generation itself; `CHICKPEA_DEPLOY_AUTH_DB_ID` and
`CHICKPEA_DEPLOY_SCHEMA_GENERATION` only need setting to override them.

Provision a separate 32-byte random base64url read token (43 characters) in the
Worker's `CHICKPEA_ENV_AUTHORITY_READ_TOKEN` and the host's corresponding
`CHICKPEA_ENV_<COLOR>_LIVE_AUTHORITY_READ_TOKEN`; the host URL is
`CHICKPEA_ENV_<COLOR>_LIVE_AUTHORITY_URL` (the Worker origin plus
`/internal/environment/authority`). When those variables are absent, the
preflight reads the owner-only file `~/.chickpea/lane-credentials/<color>-live.json`
with `origin` and `authorityReadToken`. The preflight needs every active lane's
credential, not only the claimed lane's. Keep these values owner-only outside
the repository. They are not Slack credentials. Invalid token shapes fail
locally before any authority request.

The bootstrap Worker must also set the non-secret `CHICKPEA_ENV_TARGET` plain
variable to its color. Keep claim metadata absent until the first claimed deploy;
the initial preflight admits only that exact registered, unstamped version.

The gateway projection reports its installed binding and recorded OAuth
grants, not a fresh Slack scope-header observation. Runtime attestation also
requires a successful fresh `auth.test` for the same workspace/bot and a
current-version gateway session. It does not replace real inbound Slack proof.
Stored health can be stale after a Slack error; a failed fresh authentication
check always blocks readiness. Binding mismatch stops the lane; never
automatically reinstall and displace another deployment.

The customer-owned app lifecycle below is a disposable compatibility pilot,
not the permanent lane recipe. Finish one representative manual installation
through real Slack and signed-in Admin, fix and verify observed defects, then
remove only its receipted pilot resources. Existing additional manual pilot
apps may be cleaned up without completing every redundant installation.
Preserve the three workspaces and any accepted unmanaged workspace. Record
the manual-test evidence separately from final fleet readiness.

Manual app scopes do not change Slack workspace policy. The canonical manifest
already requests user-group read/write scopes; follow the separate
[Agent handle prerequisite](../../SETUP_AGENT.md#agent-handle-prerequisite-for-a-customer-owned-app)
and prove a real Agent mention/reply after any permission recovery. Confirm the
workspace before changing policy; a generic Slack admin link may open another
signed-in workspace.

Capacity in Admin is a recorded registry snapshot, not a live Slack inventory.
Recheck actual workspace usage in Slack before provisioning more resources.

## Safety and evidence contract

1. Use Computer Use for every Slack or browser UI action and observation.
   Authorized provider APIs/CLI may set up, inventory, deploy, attest, and
   tear down infrastructure. They cannot perform or score end-user behavior.
2. Respect the actual tool's execution policy and the user's authorized scope.
   Invocation of the verification skill authorizes its declared QA actions in
   both browser and terminal, including consent and confirmation dialogs. Do
   not add action-time permission questions for these same actions. Inspect
   target/account/grant identities before mutation and reconcile ambiguous
   outcomes before retrying. Ask only for missing authority or capabilities;
   never bypass a tool-enforced gate or extract browser credentials.
3. The user enters billing details, secret values, OTPs, and unavailable
   credentials directly. Never retain them in the repository, shell history,
   prompts, screenshots, logs, or evidence.
4. Record each fact as `observed`, `documented`, `derived`, `blocked`, or
   `not yet confirmed`. Documentation is not live provider proof.
5. Record only allowlisted non-secret identifiers needed for reconciliation:
   sandbox status/archive date, immutable workspace/app IDs, role names,
   integration counts, manifest fingerprint, and pass/fail outcomes.
6. A label never authorizes deletion or reuse. Require the exact immutable ID
   and its creation receipt.

## Phase 1 baseline recipe

The public baseline definitions are
`config/environments/qa/workspace-recipe.json` and
`config/environments/qa/desired-state.json`. They contain portable logical
names only. Workspace IDs, Slack user IDs, account addresses, credentials, and
Computer Use browser aliases belong in the owner-only environment root.

The recipe is derived from the verifier's four Phase 1 smoke variants. It
defines only these reusable resources:

| Resource | Scope | Fixture class | Purpose |
|---|---|---|---|
| primary actor | shared | `immutable_baseline` | fills the `owner` and `member` slots in Amber and Cobalt |
| QA channel | per target | `immutable_baseline` | receives welcome and due-routine observations |
| smoke Agent | per target | `resettable_fixture` | supports update, connection, and routine cases |
| Agent-channel grant | per target | `resettable_fixture` | keeps the smoke Agent authorized for the QA channel |
| synthetic Google account | shared | `immutable_baseline` | supplies the provider fixture without adding a Slack actor |
| Personal Google Sheets binding | per target | `resettable_fixture` | uses the reviewed standard nine-capability grant; smoke exercises reads only |

The environment baseline library reads the verifier manifest to bind fixture
slots to this recipe. It rejects undeclared or deep-only variants and any
fixture class other than `immutable_baseline` or `resettable_fixture`.
Run-created Agents, connections, routines, messages, and attributed residue
remain verifier-owned product state. Do not add them to this recipe or an
infrastructure cleanup plan.

Before one-time provisioning, build a plan with
`createPhaseOneBaselinePlan(target)`, then call `inspectPhaseOneBaseline` with
read-only alias and product-resource observers. Print only
`describePhaseOneBaselineDryRun(plan, report)`. A fresh target will list the
logical aliases and resource keys that are missing; it never returns resolved
values or observer errors. A drift report is diagnostic only: it does not
create, reset, delete, grade, or clean product state.

Resource observers must return the requested target and logical resource key,
plus a boolean for every named health check in the request. A generic `ready`
label is insufficient. Checks include the full-member/Owner actor role, the
signed-in Computer Use profile, exact Agent-channel grant, model availability,
and Agent-owned Personal Sheets binding. The v2 recipe declares `access: write`
for the normal managed OAuth grant and `exerciseAccess: read` for the smoke
actions. Its exact nine-capability allowlist includes search, metadata, value
reads, table queries, spreadsheet creation, value updates/appends, row upserts,
and adding sheets. It does not permit arbitrary API calls, deletion, or sharing.
The request includes the expected capabilities so the observer can compare
the actual state. Do not claim that smoke read-only behavior narrows OAuth
consent; keep all exercises within the approved test fixture.

The infrastructure aliases come from the registry. Resolve the fixture aliases
through separate private bindings: `actor-identity`, `computer-use-profile`,
`channel-identity`, `agent-identity`, `model-provider`,
`agent-channel-grant-identity`, `synthetic-account-identity`, and
`sheets-binding-identity`, each prefixed with `env-<target>-`. The same actor and
synthetic account may resolve in both targets; mutable fixture IDs must
resolve within the target's attested Worker/D1 and Slack workspace. A bare
local Agent ID may repeat in different databases; compare the full target and
resource identity, not that string alone. `model-provider` names a
non-production provider source, never its API key.

Pass the report and a separately attested snapshot to
`diagnosePhaseOneBaseline(plan, report, snapshot)`. Missing prerequisites block
the existing verifier doctor. This helper cannot override a failed Computer
Use preflight or create a product verdict. Do not use a baseline connection as
proof of `LC04-V1-personal-read`: that case must authorize its own run-owned
connection through the UI and clean it through the verifier. Its local
connection ID and managed-provider account reference must differ from the
standing baseline binding. Attribute both to the run before reversal, delete
only the run-owned remote account, and recheck baseline health afterward.
Do not revoke the shared upstream Google grant.

### Migrating an existing v1 provider registration

New registries use `chickpea-environment-registry/v2` and
`providerAuthConfigId`. New claims, deploys, and attestations against existing
v1 registries fail closed with `PROVIDER_AUTH_CONFIG_MIGRATION_REQUIRED` until
explicitly migrated. Status, reclaim, fenced release, and reconciliation stay
available to finish existing work, preserving v1 until migration. Verify
each normal managed auth config in its matching provider project first; this
operation only changes local metadata, not provider grants or connections.

Release both lane claims and resolve every target lock or deployment intent.
If a release process died after committing, `env reconciliation <target>`
can clear its same-host dead-process lock only when the existing run journal
is safe to clear. Live/foreign locks and unresolved product cleanup remain
blocked; infrastructure cleanup never substitutes for verifier cleanup.
Prepare an owner-only JSON file outside the repository with
`expectedRegistryRevision` and exactly two `targets` entries, each containing
`target`, `providerProjectId`, `previousAuthConfigId`, and
`providerAuthConfigId`. Then run:

```sh
npm run env -- migrate-provider-auth --bindings /absolute/private/migration.json
```

The migration compares the revision and prior identities, appends one v2
snapshot, preserves all v1 history, and clears both prior attestations. A
snapshot-first interruption is recovered by normal registry reads; a repeated
migration reports `REGISTRY_ALREADY_CURRENT` and cannot duplicate or overwrite
the transition. Regenerate private verifier inputs (v2) and baseline plans (v2),
deploy each claimed lane using the guarded wrapper, and attest afresh. The
wrapper pins both `COMPOSIO_SHEETS_READ_AUTH_CONFIG_ID` and
`COMPOSIO_SHEETS_WRITE_AUTH_CONFIG_ID` to the same registered normal config,
including when reusing an artifact with an old READ override. The product's
read capability lane does not narrow the provider's OAuth grant. It does not
erase legacy provider configs or unrelated connections.

Afterward, `npm run env -- status --all` must read the registry successfully
with both claims released and no prior attested revision. Compare the new
snapshot to its v1 predecessor: only the schema/revision, two auth-config
fields, cleared attestations, and appended audit events may differ. Do not
run an old v1 environment controller against this registry. There is no schema
downgrade command: a correction must append a reviewed v2 revision under the
same ownership and lock checks, never replace old snapshots. Worker code and
provider resources are unchanged by the migration itself, so stopping before
the subsequent deployment preserves the existing live service.

Inspect afresh before each run; do not reuse an older ready report. Always show
the content-free dry-run report alongside doctor output: a non-actor fixture
failure blocks doctor with `target_drift`, while the dry-run report names the
exact missing alias or drifted resource.

Provision missing reusable fixtures only after the ordinary target claim and
live-identity preflight succeed. Resolve the actor identity, its Computer Use
profile, and the synthetic provider identity from private bindings. After
provisioning, store resolved product IDs in the target's protected-resource
inventory with `projectProtectedProductInventory`; the infrastructure cleanup
projection for this baseline must remain empty.

Baseline health requires all environment aliases to resolve, the actor and its
Computer Use profile to be available, the channel and Agent to be visible, the
grant to be exact, and the Google Sheets binding to remain Personal and
read-only. Doctor owns readiness checks; the verifier owns suite policy,
visible product observations, run journals, evidence, cleanup, and verdicts.
Baseline code must not inspect verifier journals or perform scored product
actions.

## Gate 1: operating-host preflight

Before any provider mutation:

1. With Computer Use, verify Chrome returns accessibility text and a screenshot
   on a Slack developer page.
2. Verify the native Slack app returns accessibility text and a screenshot for
   workspace navigation and a normal message surface. Do not type or send.
3. Reserve one private browser alias for each human actor. The current Phase 1
   smoke inventory needs one actor; use more only when an enabled case requires
   distinct identities.
4. Read the active sandbox count, monthly provisioning count, and eligibility.
5. Read Cloudflare Worker, D1, and Durable Object counts. Compare them with the
   current official limits. Keep Workers AI consumption separate.

If accessibility text or screenshots are unavailable, stop. API output cannot
substitute for the Computer Use requirement.

## Gate 2: create the capability sandbox

The capability form uses:

- sandbox name: `Chickpea Phase 1`;
- sandbox domain: `chickpea-phase-1` if Slack confirms availability;
- authentication: password-free;
- event code: blank;
- data template: Empty sandbox.

Pause at the final **Provision sandbox** button. After action-time confirmation,
click once. If the response is ambiguous, inspect the sandbox list before any
retry. Never retry creation based only on a timeout.

Record the new sandbox's immutable identifier, active status, archive date, and
renewal owner in the private environment registry. The evidence report should
record only status and date, not account or billing data.

Opening a newly provisioned sandbox may redirect to **Sign in to the Slack
Developer sandbox**. Treat entering the account email and submitting **Sign In
With Email** as sensitive-data transmission: pause at the empty form, obtain
action-time confirmation or let the user complete it directly, and never retain
the address or sign-in message. After authentication, inventory the initial
workspace read-only before preparing any additional workspace.

Slack may reveal reCAPTCHA only after the first submit attempt. If it does,
stop at the unchecked CAPTCHA and have the user complete it directly. Do not
assume the first click sent a magic link: require a visible check-email state.
If CAPTCHA completion merely re-enables **Sign In With Email**, obtain fresh
action-time confirmation before the follow-up click.

Treat the emailed one-time code or magic link as a credential. Prefer that the
user complete it directly. If the user explicitly authorizes U12 to continue,
use the supplied credential once in the current sign-in flow, never emit or
retain it, and clear transient variables immediately. Confirm the Mac is
unlocked before attempting the credential; a host lock is a blocker, not a
reason to request another code. If Slack visibly rejects the credential or says
the magic link was already used, do not retry it. Pause before re-entering the
account email or clicking a control that requests a fresh sign-in message;
those are new sensitive-data transmission actions requiring fresh confirmation.

## Gate 3: workspace and actor pilot

An empty sandbox begins with one workspace. Use it as the first pilot workspace;
create exactly two more lane workspaces. Only these three are managed targets.
Do not create workspaces merely to fill capacity. Existing unused development
workspaces may remain outside the registry; count their slots without treating
them as lanes or giving them deployment resources.

Use the final low-cognitive-lift identities throughout the pilot and permanent
fleet:

| Lane | Workspace name | Workspace domain | Access |
|---|---|---|---|
| `amber` | `Chickpea Amber` | `chickpea-amber` | By invite only |
| `cobalt` | `Chickpea Cobalt` | `chickpea-cobalt` | By invite only |
| `fern` | `Chickpea Fern` | `chickpea-fern` | By invite only |

The initial generated workspace must be mapped to Amber; renaming it is a
confirmation-gated workspace mutation. Do not create a separate Amber workspace
and leave the initial workspace unused. Slack's empty template also creates a
Demo User. That identity consumes one human-user slot but is not part of the
minimum smoke actor pool.

For each workspace:

1. Pause before the final create action and obtain action-time confirmation.
2. Record its immutable workspace ID and current integration count.
3. Add the single Phase 1 human actor as a full member and give that same actor
   the workspace/Chickpea Owner authority needed by the smoke inventory.
4. Open the workspace through the actor's private Computer Use browser alias.
5. Confirm workspace switcher text, one non-scored channel, and screenshots are
   accessible. Do not send a scored message.

The one actor may fill both `owner` and `member` fixture slots because the exact
smoke inventory has no two-person or denial comparison. Preserve one synthetic
provider account for `LC04-V1-personal-read`; it is not a second Slack actor.

The shared actor must be a full member and Chickpea Owner in all three
workspaces. Invite-only access keeps unrelated organization members from
joining a lane without an explicit Workspace Owner/Admin invitation.

Pass only when the same actor is independently addressable in all three
lane workspaces and the live workspace count fits the sandbox capacity. Record
actual unused slots, including any unmanaged development workspace usage.
Two free slots are not a readiness requirement. Keep live results in private
capability evidence, not this public runbook.

## Gate 4: workspace and org policy isolation

Build a three-column observation table for the pilot workspaces. Record:

- app-management/approval policy;
- whether custom apps and requested scopes are allowed;
- Agent/AI app and App Home availability;
- OIDC and OAuth availability;
- relevant channel/member policy;
- integration count.

Select one reversible workspace-level pilot setting. A UI change or restore
that changes access or permissions requires action-time confirmation. An
already authorized setup API follows the scope and identity checks above.
Change the first workspace, observe the other two with Computer Use, then
restore the first workspace and verify the original state.

Separately record the baseline settings Slack intentionally inherits from the
Enterprise organization. Org-wide inheritance is acceptable only when Phase 1
does not need per-workspace variation. If a required app, approval, identity,
OAuth/OIDC, Agent, or access setting cannot be isolated because of unavoidable
org coupling, stop and mark the one-sandbox topology failed. Do not silently
add another sandbox or paid workspace.

Preserve an empty org-policy baseline during isolation proof; use
workspace-level settings for the reversible check. Record any inherited policy
and its exact provider behavior in private capability evidence.

## Gate 5: configuration-token and app lifecycle pilot

This is a provider capability test, not first-install scoring.

1. Use one pilot workspace only. Generate a short-lived Slack App Configuration
   token after action-time confirmation. Do not record or screenshot its value
   or the accompanying refresh token.
2. Build the canonical Chickpea manifest with a pilot HTTPS origin. Compare the
   safe contract fields: app/bot names, bot and OIDC scopes, redirect URLs,
   Events URL/events, interactivity URL, App Home, and Agent view.
3. `apps.manifest.create` creates a Slack app and returns persistent
   credentials. When the user has authorized the pilot, an ordinary API call
   needs no additional Computer Use confirmation. A UI submission still does.
   Bind the token to the exact workspace using its observed token-dashboard
   row or the `team_id` in its rotation response; do not trust an extra
   `team_id` request parameter to select the workspace. Process one workspace
   token at a time. Verify the submitted manifest, then submit once.
4. Record only the app ID, workspace ID, manifest fingerprint, and result. Do
   not retain client secret, signing secret, configuration token, bot token,
   OAuth code/state, or cookies. Independently verify through Computer Use
   that the returned app ID appears under the intended workspace before
   recording that mapping as confirmed. If the mapping cannot be established,
   stop and reconcile; another confirmation does not substitute for identity.
5. Export the live manifest read-only and compare the safe contract/fingerprint.
6. Rotate the pilot configuration token using the authorized setup API. Verify
   that the replacement differs, belongs to the same workspace, and works.
   Probe both tokens only with read-only `apps.manifest.export` of the
   recorded pilot app ID, never a create/update/delete request.
   Check the old access token separately; rotation must not be reported as
   immediate revocation if the old token still works. Keep both values out of
   output and evidence. Record the observed validity window and cleanup needs.
7. Do not create one permanent custom app per lane. If separate manual pilot
   apps already exist, inventory their exact IDs and installation states.
   Complete one representative manual installation; leave redundant uninstalled
   pilots uninstalled until cleanup.
8. Make one reversible workspace-level app/approval change and prove the other
   two workspaces do not change. Preserve a previously completed proof rather
   than repeating access changes merely because an installation path changed.
9. Delete only throwaway pilot resources with exact-ID creation receipts.
   An authorized teardown API needs no additional Computer Use confirmation;
   a UI deletion requires it. Reconcile the outcome before retrying. The
   shared Chickpea app and gateway are never pilot cleanup targets.

Any Enterprise restriction must be recorded by its visible Slack error/state.
Do not weaken the manifest or scopes just to obtain a pass.

## Optional maintenance: workspace deletion and quota recovery

Workspace deletion is not a Phase 1 readiness gate. If an unused development
workspace remains and the three lanes fit, retain it outside the lane registry,
report actual capacity, and continue. Do not create another lifecycle probe or
contact provider support just to recover a slot that is not needed. Revisit
cleanup when capacity is needed or the user requests it.

For a separately requested lifecycle-recovery check:

1. Record the current workspace count.
2. Create one explicitly throwaway workspace within the authorized pilot.
   A UI creation requires action-time confirmation.
3. Record its exact immutable ID and the count increase.
4. Delete only that exact throwaway ID within the authorized teardown scope.
   A UI deletion requires a separate action-time confirmation.
5. Observe the count return to the recorded baseline.

If deletion does not restore quota, or provider state is ambiguous, stop that
cleanup operation and record the residual. Never delete another workspace or
the whole sandbox to investigate. An unresolved optional cleanup operation does
not block independent lane setup when sufficient capacity remains.

## Gate 7: Cloudflare headroom

Use authenticated read-only API/CLI calls or Computer Use and retain only
the relevant counts and aggregate usage, never credentials. At minimum,
record:

- Worker service count versus the current Workers plan limit;
- D1 database count versus the plan limit;
- Durable Object class/namespace count versus the plan limit;
- Workers AI model availability and current usage visibility.

One Phase 1 fleet adds three Workers, three D1 databases, and eighteen Durable
Object class namespaces under the current Chickpea migration history. Workers
AI uses a shared daily neuron pool; do not infer headroom from model-list access.

Cloudflare capacity cannot repair a failed Slack isolation check. Keep the two
provider verdicts separate.

## Capability verdict

Approve one sandbox for Phase 1 only when all of these are observed:

- active Developer Program membership, active sandbox, archive date, and
  renewal path;
- exactly three managed lane workspaces, with actual workspace usage within
  the sandbox limit; unused development workspaces remain unmanaged;
- three workspace installations of the shared Chickpea app with enough
  integration headroom, exact deployment bindings, and live routing proof;
- Agent behavior, App Home, OAuth/OIDC, scopes, and actor roles;
- workspace-level independence and acceptable org-wide inheritance;
- the representative manual-install and disposable app-lifecycle evidence;
- one-actor Computer Use accessibility across all three workspaces;
- Cloudflare Worker, D1, Durable Object, and Workers AI capacity recorded
  separately.

If any required Slack capability fails, mark the one-sandbox topology failed and
return to `docs/plans/2026-08-27-parallel-lanes.md` for an explicit paid fallback
decision. Do not provision `amber`, `cobalt`, or `fern` while the verdict is
provisional.
