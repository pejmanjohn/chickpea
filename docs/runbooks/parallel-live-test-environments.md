# Parallel live test environments

This runbook covers the Slack and Cloudflare capability pilot that gates the
three Phase 1 targets. It does not authorize scored Chickpea behavior or any
continuation environment.

Phase 1 has exactly three target names: `amber`, `cobalt`, and `fern`. Do not
create resources for `dedicated-qa`, `install`, `demo`, `spare`, qualification,
or deep testing.

## Safety and evidence contract

1. Use Computer Use for every Slack or browser UI action and observation.
   Read-only provider APIs/CLI may inventory metadata and quota.
2. Stop for action-time confirmation immediately before:
   - creating a sandbox, workspace, Slack app, configuration token, OAuth key,
     or other persistent access;
   - changing permissions, access, app approvals, or policy;
   - deleting a workspace, app, or sandbox;
   - typing sensitive identity, address, billing, token, or credential data;
   - solving a CAPTCHA.
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
create exactly two more pilot workspaces so the sandbox has three total. Do not
create five and do not label the unused capacity as an environment.

Use the final low-cognitive-lift identities throughout the pilot and permanent
fleet:

| Lane | Workspace name | Workspace domain | Access |
|---|---|---|---|
| `amber` | `Chickpea Amber` | `chickpea-amber` | By invite only |
| `cobalt` | `Chickpea Cobalt` | `chickpea-cobalt` | By invite only |
| `fern` | `Chickpea Fern` | `chickpea-fern` | By invite only |

Observed capability inventory on 2026-09-01:

| Lane | Immutable workspace ID | Current live name/domain | Access | Members | Apps |
|---|---|---|---|---:|---:|
| `amber` source | `T0BTV3LC679` | `Chickpea Amber` title observed after save; intended `chickpea-amber.slack.com` pending full re-read | By request at last complete inventory | 2 | 0 |
| `cobalt` | `T0BTW4Y1KE3` | `Chickpea Cobalt` / `chickpea-cobalt.slack.com` | By invite only | 1 | 0 |
| `fern` | `T0BTWA3DZ3R` | `Chickpea Fern` / `chickpea-fern.slack.com` | By invite only | 1 | 0 |

The live organization reports exactly three workspaces, two people, six
channels, and zero integrations. Under Slack's documented five-workspace limit,
exactly two workspace slots remain unused. The shared actor is Primary
Workspace Owner in all three workspaces and can open each lane's `#general` and
`#random` entries from one authenticated Chrome Computer Use session without
sending a message.

The initial generated workspace must be mapped to Amber; renaming it is a
confirmation-gated workspace mutation. Do not create a separate Amber workspace
and leave the initial workspace unused. Slack's empty template also creates a
Demo User. That identity consumes one human-user slot but is not part of the
minimum smoke actor pool.

The user clicked the prepared Amber **Save Changes** control. Computer Use then
observed the Chrome title `Admin Settings | Chickpea Amber Slack`, confirming
the renamed name at title level. Chrome's accessibility bridge subsequently
returned only the window title and no screenshot, so the intended
`chickpea-amber.slack.com` domain, immutable ID, organization count, and access
state still require a full post-save read. The rename did not include an access
change; moving Amber from **By request** to **By invite only** remains a
separate confirmation boundary.

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

On the observed initial workspace, the actor is Primary Org Owner and Primary
Workspace Owner; the generated Demo User is a normal Member. The actor is also
the observed Primary Workspace Owner of Cobalt and Fern. Invite-only access
keeps unrelated organization members from joining those two lanes without an
explicit Workspace Owner/Admin invitation; Amber still requires the separate
access change described above.

Pass only when the same actor is independently addressable in all three
workspaces and the live workspace count shows two unused slots. Those two
conditions are now observed; the overall capability verdict remains provisional
until the later app, isolation, and lifecycle gates pass.

## Gate 4: workspace and org policy isolation

Build a three-column observation table for the pilot workspaces. Record:

- app-management/approval policy;
- whether custom apps and requested scopes are allowed;
- Agent/AI app and App Home availability;
- OIDC and OAuth availability;
- relevant channel/member policy;
- integration count.

Select one reversible workspace-level pilot setting. After action-time
confirmation, change it in the first workspace and observe the other two with
Computer Use. Restore the first workspace after a second confirmation if the
restore changes access or permissions.

Separately record the baseline settings Slack intentionally inherits from the
Enterprise organization. Org-wide inheritance is acceptable only when Phase 1
does not need per-workspace variation. If a required app, approval, identity,
OAuth/OIDC, Agent, or access setting cannot be isolated because of unavoidable
org coupling, stop and mark the one-sandbox topology failed. Do not silently
add another sandbox or paid workspace.

The observed Apps organization-policy page began with no configured policy.
Slack states that adding a policy there changes every workspace and prevents
workspace overrides for that setting. Preserve the empty org-policy baseline
during isolation proof; use workspace-level settings for the reversible check.

## Gate 5: configuration-token and app lifecycle pilot

This is a provider capability test, not first-install scoring.

1. Use one pilot workspace only. Generate a short-lived Slack App Configuration
   token after action-time confirmation. Do not record or screenshot its value
   or the accompanying refresh token.
2. Build the canonical Chickpea manifest with a pilot HTTPS origin. Compare the
   safe contract fields: app/bot names, bot and OIDC scopes, redirect URLs,
   Events URL/events, interactivity URL, App Home, and Agent view.
3. Pause immediately before `apps.manifest.create` because it creates a Slack
   app and returns persistent credentials. After confirmation, submit once.
4. Record only the app ID, workspace ID, manifest fingerprint, and result. Do
   not retain client secret, signing secret, configuration token, bot token,
   OAuth code/state, or cookies.
5. Export the live manifest read-only and compare the safe contract/fingerprint.
6. Rotate the pilot configuration token only after a fresh confirmation. Verify
   that the prior token is no longer the active one without printing either.
7. Create one separate pilot app in each of the other workspaces after separate
   creation confirmations. Verify three different app/install identities.
8. Make one reversible workspace-level app/approval change and prove the other
   two apps/workspaces do not change.
9. Delete only the throwaway lifecycle app after action-time confirmation and
   an exact-ID receipt. The permanent target apps do not exist during U12.

Any Enterprise restriction must be recorded by its visible Slack error/state.
Do not weaken the manifest or scopes just to obtain a pass.

The read-only Slack API preflight reached the **From a manifest** flow. Its JSON
editor was accessible, and the workspace selector listed the Amber source,
Cobalt, and Fern workspaces. The same page exposes **Generate Token**. No
workspace was selected, no manifest was submitted, and neither **Generate
Token** nor any app-creation action was invoked.

## Gate 6: workspace deletion and quota recovery

To prove lifecycle quota recovery without touching the three target workspaces:

1. Record the current workspace count.
2. After action-time confirmation, create one explicitly throwaway workspace.
3. Record its exact immutable ID and the count increase.
4. Pause for a separate deletion confirmation. Delete only that exact ID.
5. Observe the count return to the recorded baseline.

If deletion does not restore quota, or provider state is ambiguous, stop. Never
delete another workspace to investigate.

## Gate 7: Cloudflare headroom

Use authenticated read-only API/CLI calls and emit counts only. At minimum,
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
- exactly three pilot workspaces with two unused slots;
- three distinct apps/installations with enough integration headroom;
- Agent behavior, App Home, OAuth/OIDC, scopes, and actor roles;
- workspace-level independence and acceptable org-wide inheritance;
- configuration-token generation/rotation and manifest create/export/delete;
- one-actor Computer Use accessibility across all three workspaces;
- throwaway workspace deletion restores quota;
- Cloudflare Worker, D1, Durable Object, and Workers AI capacity recorded
  separately.

If any required Slack capability fails, mark the one-sandbox topology failed and
return to `docs/plans/2026-08-27-parallel-lanes.md` for an explicit paid fallback
decision. Do not provision `amber`, `cobalt`, or `fern` while the verdict is
provisional.
