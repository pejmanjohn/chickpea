# Slack Developer sandbox capability evidence

Date: 2026-09-01  
Unit: U12  
Scope: external capability validation only; no scored Chickpea behavior

## Verdict

**Provisional — three-workspace shell confirmed; app and isolation proofs remain.**

After explicit action-time confirmation, Slack created one password-free, empty
developer sandbox named `Chickpea Phase 1`. The live sandbox list now shows one
active sandbox and its lifecycle countdown. Opening the sandbox reaches Slack's
email sign-in form. After explicit action-time confirmation, U12 filled the
account email without emitting or retaining its value and invoked **Sign In
With Email**. Slack then required reCAPTCHA before it would submit the form.
After separate action-time confirmation, the CAPTCHA passed and Slack displayed
**We emailed you a code**. After the first supplied credentials failed, the user
completed the fresh developer-sandbox sign-in directly. U12 then observed the
authenticated organization, initial workspace, actor roles, channels, apps,
policy surface, and Computer Use accessibility. After fresh action-time
confirmation, U12 created `Chickpea Cobalt` once and observed its immutable ID,
access, owner, member count, and empty app baseline. After a separate fresh
confirmation, U12 created `Chickpea Fern` once and observed the corresponding
facts. The live organization now contains exactly the source workspace, Cobalt,
and Fern, leaving two of the documented five workspace slots unused. Until app
lifecycle, mutable-setting isolation, and deletion recovery are observed, this
report does not approve the topology.

The user subsequently clicked the prepared Amber rename save. A fresh Computer
Use read observed the Chrome title `Admin Settings | Chickpea Amber Slack`, so
the new workspace name is confirmed at title level. At that point Chrome's
accessibility bridge degraded to window-title-only output with no screenshot.
The immutable ID, new domain, organization count, and access state have not yet
been re-read after the rename; the table below distinguishes the last complete
inventory from this newer title-level observation.

No `dedicated-qa`, `install`, `demo`, `spare`, qualification, or deep resource
was created. U12 created only the explicitly confirmed capability sandbox,
`Chickpea Cobalt`, and `Chickpea Fern`; it did not create a Slack app, OAuth
credential, configuration token, Cloudflare resource, or scored Chickpea
fixture.

## Evidence rules

- `Observed` means the fact was read from the live provider UI or a read-only
  provider API/CLI during this run.
- `Documented` means the fact comes from current official provider
  documentation and is not a live account observation.
- `Derived` means the conclusion follows from the checked-in Phase 1 manifest
  or arithmetic over observed/documented limits.
- `Blocked` means the next proof requires a confirmation-gated external action.
- `Not yet confirmed` is never treated as a pass.
- Account email, billing details, credentials, tokens, cookies, and secret
  values are intentionally absent from this artifact.

## Live Slack observations

| Capability | State | Evidence |
|---|---|---|
| Developer Program membership | Observed | The signed-in Developer Dashboard displayed the member welcome and enabled the Sandboxes area. |
| Provisioning eligibility | Observed | Before billing setup the dashboard refused provisioning; after the user entered billing data directly, the refusal disappeared and **Provision Sandbox** became enabled. Billing data was not inspected or recorded. |
| Active sandbox quota | Observed | `1/2` after the confirmed provisioning action. |
| Monthly provisioning quota | Observed | `1 out of 10` after the confirmed provisioning action. |
| Capability sandbox | Observed | `Chickpea Phase 1` at `chickpea-phase-1.enterprise.slack.com` was created from the password-free, no-event-code, **Empty sandbox** form. |
| Archive/renewal date | Partially observed | The live list displayed **Archives in 179 days** on 2026-09-01. An exact calendar date and renewal control are not yet account-observed. |
| Sandbox sign-in | Observed | The user completed the fresh developer-sandbox confirmation directly. U12 subsequently opened the authenticated workspace directory, Slack web client, and Enterprise management dashboard. No email, code, or magic link is retained. |
| Organization inventory | Observed | Organization ID `E0BTV3N47D5`; after Fern creation the management home reports exactly `3` workspaces, `2` people, `6` channels, and `0` integrations. |
| Amber source workspace | Partially re-observed | Before the rename, U12 observed workspace ID `T0BTV3LC679`, name `Chickpea Phase 1`, domain `e0btv3n47d5-99br4kus.slack.com`, access `By request`, `2` members, and `0` apps. The user then saved the prepared rename and Computer Use observed the title `Admin Settings | Chickpea Amber Slack`. The intended `chickpea-amber.slack.com` domain and unchanged inventory still require a full post-save read. |
| Cobalt workspace | Observed | Workspace ID `T0BTW4Y1KE3`, domain `chickpea-cobalt.slack.com`, access `By invite only`, `1` member after propagation, signed-in actor as `Primary Workspace Owner`, and `0` apps. |
| Fern workspace | Observed | Workspace ID `T0BTWA3DZ3R`, domain `chickpea-fern.slack.com`, access `By invite only`, `1` member, signed-in actor as `Primary Workspace Owner`, and `0` apps. Slack displayed `Chickpea Fern successfully created` after the single confirmed click. |
| Actor roles | Observed | The signed-in actor is `Primary Org Owner` and `Primary Workspace Owner` of the Amber source, Cobalt, and Fern workspaces. The other sandbox identity is the generated `Demo User` with account type `Member`. |
| Workspace quota | Observed + documented arithmetic | Live management shows exactly three workspaces. Slack documents five workspace slots per developer sandbox, so exactly two slots remain unused. |
| Integration quota | Partially observed | Live organization and workspace views both show zero apps/integrations. Official capacity is twenty per workspace and sixty per sandbox. Three one-app workspaces would leave at least seventeen per workspace and fifty-seven across the sandbox before workflows or other integrations are added. |
| App policy baseline | Observed | No organization-level Apps policy is configured; the page only offers **Add Policy**. Slack warns that any organization-level policy applies to every workspace and prevents workspace overrides for that setting. |
| Slack subscription cost | Documented | Developer Program membership and developer sandboxes have no additional Slack cost; the payment method is identity verification and Slack states it will not be charged. This is not a claim about Cloudflare, model, or connector costs. |

Current Slack authority: [Developer sandboxes](https://docs.slack.dev/tools/developer-sandboxes/).
The page states a default six-month active lifespan, renewable in six-month
increments while eligible; five workspaces; eight human users; twenty
integrations per workspace and sixty per sandbox; two active sandboxes; and ten
provisions in thirty days.

## Phase 1 topology calculation

The requested Slack shape fits the published numerical limits:

| Resource | Published sandbox capacity | Phase 1 need | Remaining after Phase 1 |
|---|---:|---:|---:|
| Full-featured workspaces | 5 | 3 | 2 |
| Human users | 8 | 1 required actor + 1 generated demo member | 6 |
| Integrations | 60 total, 20 per workspace | 3 Chickpea apps | 57 total, 17 per workspace |

This arithmetic does not prove workspace/app independence, policy isolation,
or actual quota recovery. Those are live checks below.

## Smallest stable actor pool

**Derived minimum: one human Slack actor, shared across all three workspaces,
plus one synthetic provider account for the Personal OAuth fixture.**

The empty sandbox generated a second Slack identity named `Demo User`, so the
live organization consumes two of eight human-user slots even though the smoke
inventory requires only one stable actor. The demo identity is not needed for
the four enabled smoke variants and does not change the minimum actor pool.

The exact smoke inventory in `qa/live/manifest.ts` requires:

| Variant | Human fixture slot | Human gate |
|---|---|---|
| `LC01-V1-create-welcome` | `owner` | none |
| `LC01-V2-update-approve` | `owner` | approval |
| `LC04-V1-personal-read` | `member` | OAuth consent |
| `LC08-V1-create-due` | `member` | none |

None of these four variants compares two people or requires simultaneous
different Slack roles. One full member who is also the Chickpea Owner can fill
both fixture slots. This actor is assigned to all three workspaces and is
available through one private Computer Use browser alias. The provider account
is a separate fixture and does not add a second Slack human actor. This minimum
must be revised if a later case needs a distinct non-owner, guest, Slack Connect
participant, second editor, or denial subject.

Actor usability is observed across all three workspaces. The actor is both
Primary Org Owner and Primary Workspace Owner and can navigate the Amber-source,
Cobalt, and Fern `#general` and `#random` channels from one authenticated Chrome
session. Each lane exposes an empty composer, and Cobalt and Fern each show the
same actor's join receipt in their own workspace-domain archive URL. No message
was typed or sent.

## Computer Use accessibility preflight

Observed before any scored action:

- Chrome returned a populated accessibility tree and a screenshot for the
  Slack API apps dashboard, Developer Dashboard, Sandboxes page, and sandbox
  provisioning form.
- The native Slack app returned a populated accessibility tree and screenshot,
  including workspace tabs, channels, app/agent views, messages, and composers.
- After sandbox sign-in, Slack web returned a populated accessibility tree for
  the `Chickpea Phase 1` workspace, `#general`, `#random`, two members, the
  composer, Agents & tools, and the AI-feature banner. The Enterprise management
  dashboard exposed workspace/member IDs, roles, app count, and policy pages.
- After creating Cobalt and Fern, the same Chrome accessibility session listed
  separate `#general` and `#random` entries for all three workspaces. Opening the
  Cobalt and Fern `#general` entries produced their distinct channel URLs,
  workspace-domain join receipts, and usable empty composers.
- After the user saved the Amber rename, Chrome exposed the renamed
  `Chickpea Amber` settings title but then returned only window-title text and
  no screenshot. Full post-rename verification is blocked until the management
  tab again exposes its accessibility tree.
- No message was typed or sent and no Chickpea behavior was scored. Apart from
  the explicitly confirmed sandbox and workspace creation actions, no Admin
  mutation was performed.

This proves the one required sandbox actor is addressable through Chrome
Computer Use in all three workspaces. It does not prove app-scoped actor or
OAuth behavior because no sandbox app exists yet.

## Required live capability matrix

| Proof | State | Pass condition or exact blocker |
|---|---|---|
| One sandbox with three independent workspaces | Partially observed | Three distinct workspaces coexist: Amber source `T0BTV3LC679`, Cobalt `T0BTW4Y1KE3`, and Fern `T0BTWA3DZ3R`. The Amber rename is title-confirmed but still needs a full post-save identity read. Independent mutable settings and apps are not yet proven. |
| Two unused workspace slots | Observed + documented arithmetic | Live management shows three workspaces; the documented capacity is five, leaving exactly two unused slots. |
| Three independent apps | Not yet confirmed | One pilot app per workspace must have a different app ID and installation; no app may be shared across targets. |
| No shared mutable workspace settings | Not yet confirmed | Three workspaces now exist, but no reversible setting has been changed. After confirmation, change one workspace-level pilot setting and verify the other two remain unchanged. |
| Org-policy isolation | Partially observed | No Apps org policy is configured. Slack explicitly states that a policy added here applies to every workspace and prevents workspace overrides. Do not use an org policy for a setting Phase 1 needs to vary; workspace-level isolation remains unproved. |
| Agent/AI app feature | Partially observed | Slack web exposes **Agents & tools** and reports Slackbot, Enterprise search, and eight more AI features enabled. A pilot app must still save and expose Agent view/App Home. |
| Bot OAuth and Slack OIDC | Not yet confirmed | Each app accepts the required bot scopes and `openid`, `profile`, `email` user scopes with workspace-specific redirects. No production credential is used. |
| App approvals | Partially observed | Baseline has zero installed apps and no configured Apps org policy. A workspace-level approval/app change in one pilot workspace must still be proven not to affect the other two. |
| Shared actor roles | Observed | The actor is Primary Org Owner and Primary Workspace Owner of the Amber source, Cobalt, and Fern workspaces. |
| Private browser alias | Observed | One authenticated Chrome Computer Use session exposes and can open separate Cobalt, Fern, and Amber-source channels without account switching ambiguity. |
| Configuration token generation/rotation | Partially observed | The account-level Slack API dashboard exposes **Generate Token**. It was not clicked because token generation creates persistent access and requires fresh confirmation. Rotation remains unobserved. |
| Manifest validation/create/export | Partially observed | Slack's **From a manifest** flow exposes a JSON editor and a workspace selector listing `Chickpea Fern`, `Chickpea Cobalt`, and `Chickpea Phase 1`. No workspace was selected, manifest submitted, app created, or manifest exported. |
| Pilot app deletion | Not yet confirmed | Delete only the exact throwaway app after recording its non-secret creation receipt. Deletion is confirmation-gated. |
| Workspace deletion restores quota | Not yet confirmed | Create and delete an exact throwaway workspace, then observe the workspace count return to its prior value. Deletion is confirmation-gated. |
| Archive/renewal metadata | Partially observed | Live sandbox list shows active status and **Archives in 179 days**; the exact calendar date and renewal control remain unobserved. Establish 45/30/14-day warnings in the later environment status implementation. |

## Cloudflare capacity, recorded separately

Read-only observations used the authenticated personal Cloudflare account and
redacted its account identifier:

| Resource | Observed now | Current documented Workers Paid limit | Phase 1 addition | Expected remaining |
|---|---:|---:|---:|---:|
| Worker services | 46 | 500 | 3 | 451 |
| D1 databases | 36 | 50,000 | 3 | 49,961 |
| Durable Object classes/namespaces | 108 | 500 | 18 | 374 |
| Container applications | 2 | not a Phase 1 dependency | 0 | not applicable |

The Durable Object addition is six active class namespaces per Chickpea Worker
after applying the checked-in migrations, times three Workers. Individual
object instances are unlimited; this row concerns class namespaces.

Official limits: [Workers](https://developers.cloudflare.com/workers/platform/limits/),
[D1](https://developers.cloudflare.com/d1/platform/limits/), and
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/limits/).

Workers AI is a separate usage pool. The account could list 65 available models.
Current documentation provides 10,000 Neurons per day at no charge on both Free
and Paid, then paid usage on Workers Paid. Actual current-day consumption was
not available from the read-only CLI check, and no Phase 1 per-run neuron budget
exists yet. Therefore Workers AI **availability is observed, but three-lane
usage headroom is not yet confirmed**. See
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

## Current blocker and next gated action

The user clicked **Save Changes** for the prepared Amber name and
`chickpea-amber` URL. Computer Use subsequently observed the renamed
`Chickpea Amber` settings title. Chrome then stopped returning a page
accessibility tree or screenshot, so U12 could not independently re-read the
new domain, immutable ID, organization count, or access state. Foreground the
Slack management tab and repeat the read-only verification before relying on
the intended domain.

The rename did not include an access change. The last complete inventory showed
Amber as **By request**, while Cobalt and Fern were **By invite only**. Moving
Amber to invite-only is a separate access mutation and remains untouched; it
requires fresh action-time confirmation when its final control is prepared.
App/configuration-token creation, permissions, deletion, and scored behavior
also remain untouched.
