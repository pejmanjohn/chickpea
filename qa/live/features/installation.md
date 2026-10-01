# Installation, setup and upgrades

Docs: `/start/get-started-cloudflare/`, `/start/get-started-node/`, `/slack/set-up-your-own-slack-app/`, `/slack/slack-app-lanes/`, `/operate/upgrades/`. Record areas: `auth`, `releases`. Legacy contracts: LC-10.

## What it covers

- Cloudflare: Deploy to Cloudflare (core profile) prints a private setup link in the build log, valid 24 hours. Workers AI answers first with `cloudflare/@cf/zai-org/glm-4.7-flash`, so no key is needed.
- Node: `npm run setup:link -- <origin>` mints the link. There is no keyless model, no scheduler and no coding sandbox, and the docs put Node on the customer-owned Slack app lane because the gateway's durable admission is Cloudflare only.
- Slack lanes: Add to Slack (the shared app through the gateway, no secrets) or Use your own Slack app (a configuration token, or the guided manual path with a signed Events challenge).
- The installing Slack member becomes the first Owner through Sign in with Slack. The wizard then asks for a provider and model, and setup completes only after a real delivered reply.
- First-teammate onboarding: the wizard suggests asking `@Chickpea` in a DM for a first teammate (three starters, a numbered reply creates one). Fresh installs start with no Agent of their own. See [agents.md](agents.md).
- App Home lists up to 24 Agents available to the person; **Message** opens a DM thread that posts "<Agent name> is ready." and gives that Agent the thread.
- Upgrades: the guarded `npm run deploy`, or `npm run deploy:sandbox` for a sandbox install. The receipt-based `npm run upgrade` needs a supported origin. Settings → About & updates shows the installed version and commit.
- Recovery: Reconnect with Slack (Add to Slack lane) refreshes authorization without changing Agents or grants. Customer-owned app repair uses `/admin/recovery`.
- The agent-run guides, [INSTALL_CHICKPEA_CLOUDFLARE.md](../../../INSTALL_CHICKPEA_CLOUDFLARE.md) and [INSTALL_CHICKPEA_NODE.md](../../../INSTALL_CHICKPEA_NODE.md), end by connecting the installing agent over MCP and creating the first teammate.

## How a person reaches it

- Admin: the private `/admin/setup` page, then Settings → About & updates, and Destinations → Slack → Connection for Reconnect with Slack.
- Slack: the install consent, the DM with Chickpea, and the App Home tab.
- MCP: a coding agent following an install guide, which ends with `inspect_workspace` and one `create_agent`.

## How to drive it on a lane

- A fresh install borrows a free lane's Slack workspace through the [installation reservation](../operator/environments.md#borrow-a-lane-for-a-fresh-install): `npm run env -- wait-claim any`, an owner-only `before.json`, then `npm run env -- install-reserve <alias> --installation <spec>`.
- Choose `node` (isolated local state started with `install-start`) or `cloudflare` (a temporary Worker and D1). Install from an isolated checkout or release artifact with no local private files.
- Apply the `test` telemetry label or opt-out before the first Slack connection. For a temporary Worker, check it with `npm run verify:telemetry -- --worker <name> --output <private file>`.
- Case shape: `case-add --area auth --proof slack --proof admin`, with variants for the Slack lane, provider choice and first-Owner sign-in. Use `--area releases` for upgrade cases.
- Request: send "<run marker> Hi Chickpea, what's a good first teammate for a QA team?" in the DM and wait for the reply the setup page detects.
- Upgrade case: deploy the candidate over the lane's previous build, or `--release-tag` for a published tag. Then confirm signed-in Admin, retained Agents, the reported version and a first mention.
- Cleanup: remove the exact temporary state, or the Worker and D1, and reconnect the standing installation (Reconnect with Slack has worked for this). Then run `install-restore` with JSON readbacks, and `release`.

## Proof and gotchas

- Proof is a reply from the candidate deployment in Slack plus a signed-in Admin showing setup complete. An upload, an OAuth page or a verified Events URL alone proves nothing.
- `env status` marks a lane `setupFlowUnprovenSince` after setup-flow changes. Report it; it is a QA marker, not a deploy failure. In `release` mode, clear it with a fresh install on a disposable target and a baseline re-record.
- LC-10 (reinstall route, App Home selection, stale-membership denial) stays blocked: Admin does not expose the baseline, installer, scopes, credential revision, App Home publication or route facts it needs. Record those variants `blocked`, not passed.
- Losing the OAuth return page is a real path: Check Slack installation, then Open Slack authorization again, must reuse the saved claim for the same workspace.
- Never delete or rename a Cloudflare subdomain to manufacture the unregistered-account prerequisite case.
- A receipt-based `npm run upgrade` case needs a release pair listed in `supportedOrigins`; the guarded deploy path does not. Never change that list or publish a release to create eligibility.
- Ordinary customer updates verify the serving version and signed-in Admin only, with no Slack messages unless asked.
- The system Agent invents a version number when asked. Read the version in Settings → About & updates or `npm run env -- status`.
- Google may refuse sign-in in an automated browser, and Slack's email code needs a person. Ask for lane browser sign-ins at kickoff.
- Restoration evidence for `install-restore` must be JSON, and an expected-file must not pin monotonic revisions.
