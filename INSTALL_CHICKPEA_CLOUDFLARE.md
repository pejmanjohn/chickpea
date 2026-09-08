# Install Chickpea on Cloudflare

You are the installing agent. Carry out the workflow below using your terminal
and browser or computer-use tools. Handle the commands, forms, redirects, and
setup checks yourself. Ask the user for their model-provider choice, missing
account or workspace details, sign-in that requires their presence, and any
decision outside this installation. Resume the work after each answer.

Install the core Chickpea deployment in the user's Cloudflare account, connect
it to their selected Slack workspace, and keep the source in a local project
folder. Finish with a working Chickpea conversation in Slack, signed-in Admin,
and the local project ready for future edits and troubleshooting.

This workflow is exclusively for Cloudflare Workers. Node.js on the user's
computer runs the build, deployment, and management tools; Chickpea itself runs
on Cloudflare's workerd runtime. Do not start a local Node server or switch to
Node-based hosting if a Cloudflare step fails. The user's computer can be
turned off after installation without stopping Chickpea.

## How to run this install

Apply this guide when the user asks you to install Chickpea. A request to read,
review, or edit the guide is not an instruction to deploy anything.

Use the tools you actually have. Prefer existing CLI commands for local work
and infrastructure, and browser or computer use for interactive setup. Read
your harness's browser instructions before controlling it. Inspect each page
before acting and follow the live labels if they differ slightly from this
guide. Do not assume a screenshot, selector, browser session, or credential
from another task is still valid.

The requested installation includes cloning and configuring the project,
deploying its Cloudflare resources, completing the normal Cloudflare and Slack
authorization screens, sending the setup DM in step 6, and verifying the
installation in step 7. An external MCP connection is an optional follow-up
for users who want their coding agent to manage the workspace. The Chickpea
CLI is not required for this guide. Perform the installation steps
within the user's selected accounts and your harness's permission rules:

- Navigate, fill forms, select the agreed accounts, and click the ordinary
  install, OAuth consent, and Continue buttons yourself where your tools allow
  it. Check the application, account, and requested access before granting it.
  Do not stop at every button to ask for the same permission again.
- Ask the user to take over for passwords, one-time codes, passkeys, CAPTCHA,
  or another step that requires their presence. Keep the exact page open, name
  the one action needed, and resume when they finish. If a tool requires its
  own approval, honor it and explain the specific blocked action.
- Ask once when the intended Slack workspace, Cloudflare account, or first
  Owner is ambiguous. Never select whichever workspace happens to be open.
  Prefer a compact question over separate questions for each known detail.
- Keep existing billing plans. New purchases, plan upgrades, broad workspace
  permission changes, and changes to unrelated installations require a new
  decision from the user.
- Use the shared Slack app by default. The user chooses the model provider;
  there is no default or recommended provider in this guide. Honor a choice
  they have already made, or ask at the provider step and wait for their answer.
- Keep credentials and private setup links out of chat summaries, commits,
  shared screenshots, and the installation receipt. Use the intended credential
  forms or a secure local secret handoff. Never ask the user to paste a key into
  the conversation or extract credentials from their coding agent's login.

Give short progress updates at meaningful milestones. When blocked, explain
what is already working and the smallest remaining action. If browser tools
are unavailable, complete the terminal work and give the user the exact page
and next click, then resume; do not hand them the entire guide as homework.

## 1. Establish the local project

First identify the requested Slack workspace and whether this is a fresh
install or an existing Chickpea deployment. Inspect a relevant existing local
checkout before creating another one. Establish that it belongs to this
installation before using its deployment settings.

For a fresh install, use the user's requested directory. Otherwise choose a
new `chickpea` directory inside their normal projects folder and state its
absolute path. Select the latest stable application release from the
[official releases](https://github.com/pejmanjohn/chickpea/releases/latest),
unless the user requested a specific released version. Use a published,
immutable release with an exact `vX.Y.Z` tag. Read its installation notes and
resolve the tag's full source commit. The public GitHub API can provide the
release and tag metadata without requiring the user to create a GitHub account.
Application releases and `cli-v*` releases are separate; select the application.

Replace `<release-tag>` below with that exact tag before running the command:

```sh
git clone --branch <release-tag> --single-branch https://github.com/pejmanjohn/chickpea.git chickpea
cd chickpea
git rev-parse HEAD
git status --short
```

Run these commands in the chosen parent directory, not inside an unrelated
project. If `chickpea` already exists, inspect it or choose a different empty
directory. Preserve local changes. A GitHub fork is optional and should not
be a prerequisite for getting started.

Check that `HEAD` matches the official tag's commit, the checkout is clean,
and `package.json` and `release.json` name the selected version. A tag checkout
normally has a detached HEAD; the source remains available locally. Keep this
release selected throughout installation. Do not replace it with `main` or
pull newer commits partway through setup. Keep application code and release
metadata intact; only adjust the installation settings described in step 2.

Read the Cloudflare section of this checkout's [README.md](README.md#cloudflare).
Use the setup documentation and commands matching the checked-out source. If
this draft is not in the upstream checkout yet, keep the user-supplied copy as
the entry point and verify its referenced commands against that checkout.
Resolve relative file references in this guide from the Chickpea checkout,
even when the user supplied this file from another directory or a URL.

For the local build and deployment tools, select the Node version in `.nvmrc`.
With an existing nvm installation:

```sh
nvm install
nvm use
node --version
npm ci
```

Use an existing compatible Node manager when nvm is unavailable. If Node or
Git is missing, use the platform's normal installation method and official
instructions; involve the user only if an installer requires their approval.
Do not change an unrelated project's runtime. The local tools currently require
Node 24.x with a minimum of 24.20.0; `.nvmrc` is the source for the exact build
pin. No Node application server is needed for this installation.

Create a private installation receipt outside the repository, for example
`~/.chickpea/installs/<account-id>/<worker-name>/INSTALLATION.md`, once the
account and Worker are resolved. Record the absolute checkout path, source
repository, release tag and full commit, account ID, Worker name, deployment
profile `core`, and completed steps. Add the database ID, Cloudflare serving
version ID, Slack workspace/app IDs, provider/model, and safe links as they
become known. Keep the application release version distinct from Cloudflare's
Worker version ID. Record only verified values and no secrets.
On a resumed task, inspect this receipt and live state before repeating work.

### If the user already used Deploy to Cloudflare

Clone the repository created in **their** GitHub or GitLab account. Inspect its
build configuration and the existing Worker's bindings. Match the repository,
Worker, account, and `AUTH_DB` database before making any changes. Resource IDs
may need to be read from Cloudflare; a local clone alone does not establish
which resources are serving the deployment.

If the deployment is healthy, continue its current Slack setup or sign in to
Admin. Do not deploy again just to create a local checkout. An existing Owner
uses ordinary Slack sign-in; do not try to claim ownership again. Updating an
existing deployment follows [guided upgrades](docs/runbooks/upgrading.md),
preserving local customization and the exact resource identities. Check
**Settings → About & updates** for its installed release and source commit.
An unversioned or customized deployment needs its source and compatibility
established before adoption; do not label it as a release or redeploy over its
data to make it eligible. See [later updates](#later-updates) for existing
Cloudflare Builds triggers and supported upgrade paths.

## 2. Connect Cloudflare and select the target

The core installation supports Workers Free; a Workers Paid upgrade is not
required for this setup. Keep the account's existing plan. Cloudflare hosting
and model-provider usage are separate: using Workers Free does not make OpenAI
or another provider's API usage free. The optional coding sandbox requires
Workers Paid and is outside this installation. See the README's
[usage and billing notes](README.md#good-to-know) for limits and optional costs.

Use the repository's installed Wrangler:

```sh
npx --no-install wrangler whoami
```

If it is not authenticated:

```sh
npx --no-install wrangler login
```

Open the authorization URL with browser tools if needed. Complete the normal
Cloudflare authorization, using the user's intended account. If they need to
sign in, leave the page ready for them. Return to the terminal and run
`whoami` again. A signed-in dashboard does not by itself authenticate Wrangler.

One email can have access to several Cloudflare accounts. The intended account
may differ from the one authorized in Wrangler, even when the dashboard is
already open to the right account. Resolve the exact account ID and confirm
Wrangler can access it; an email match alone is insufficient. Confirm the
account, Worker name, and new-versus-existing install before mutation. If the
user already supplied an unambiguous target, report it and continue.

If the current authorization can reach the selected account, keep it and set
the explicit `account_id` below. If a separate login is needed, preserve the
existing default login by using a named Wrangler authentication profile.
From this installation's checkout, inspect available profiles:

```sh
npx --no-install wrangler auth list
```

Reuse a matching profile when available. Otherwise choose an unused name,
replace `<selected-profile>` below, and complete authorization for the intended
account:

```sh
npx --no-install wrangler auth create <selected-profile>
```

Activate the selected profile from this checkout, then verify its identity and
account access:

```sh
npx --no-install wrangler auth activate <selected-profile>
npx --no-install wrangler whoami
```

Activation binds the profile to the current directory and its subdirectories;
do not activate it from a shared projects folder. Use plain `whoami` after
activation, rather than assuming it accepts `--profile`. Keep the same profile
for inspection and deployment, and record its name in the private receipt.
These are Wrangler authentication profiles, distinct from Chickpea's `core`
deployment profile. See [Wrangler's command reference](https://developers.cloudflare.com/workers/wrangler/commands/general/)
if the installed CLI reports different options.

For a **fresh** installation, inspect the account for both the proposed Worker
name and D1 database name. The repository defaults are `chickpea` and
`chickpea-auth-db`. If either is already in use, determine whether it belongs
to this installation. Resume it only after establishing that match; otherwise
choose unused names for both, such as `chickpea-<workspace>` and
`chickpea-<workspace>-auth-db`.

Set the top-level `account_id` and Worker `name` in the local `wrangler.jsonc`,
and set `database_name` on the `d1_databases` entry with binding `AUTH_DB`.
For new resources, leave `database_id` empty so the guarded deploy command can
create it. Preserve an existing installation's
exact database ID. Keep all other bindings, migrations, compatibility flags,
assets, and observability settings intact. These local deployment settings
belong to this installation; do not push them to the upstream project.

Use the core deployment and its `workers.dev` address. A custom domain,
Cloudflare Access, R2, Alchemy, Docker, and the optional coding sandbox are
not prerequisites for this path. If Cloudflare asks for new billing or a plan
change, explain why and ask before accepting it.

## 3. Deploy and open setup

For a fresh installation, or a retry of that same release's unfinished setup,
run this from the selected checkout. Use [later updates](#later-updates) to
change the release of an existing installation.

```sh
npm run deploy
```

If a Wrangler profile was selected, pass the same profile through the wrapper:

```sh
npm run deploy -- --profile <selected-profile>
```

Replace placeholders with observed values and shell-quote them correctly.
Do not pass `--name` or `--config` to this wrapper; it rejects overrides that
could separate its checks from the actual target.

This command builds Chickpea, provisions or preserves `AUTH_DB`, applies the
reviewed migrations, provisions the required internal secrets, uploads the
Worker, and waits for the current deployment to become ready. Let it finish.
Do not separately launch another build or deploy while it is running.

Use `npm run deploy`, not bare `wrangler deploy`. Do not generate internal
signing secrets yourself, edit generated build files, or remove migration and
identity checks to make a failing install pass. If the wrapper refuses the
selected target, resolve the checkout and target using
[operations](docs/runbooks/operations.md#cloudflare-operations). Preserve its
deployment guards and use the documented recovery for the actual error.

On success, open the **private setup link** printed by the command directly
with browser tools. It includes a `#setup=...` fragment. Keep the full link for
this handoff, then preserve the setup tab across redirects and Slack popups.
Chickpea removes the fragment and keeps the capability in same-tab storage.
A different browser profile or new setup tab may lose that continuity.

Save the public deployment URL and serving version in the private receipt.
Keep any log containing the setup link private. Do not paste that link in the
final response. The link expires after 24 hours; see recovery below if needed.

## 4. Install the Slack app and establish the Owner

On the setup page, choose **Add to Slack**. This uses Chickpea's shared app
through its gateway; it does not ask the user to create an app or copy Slack
secrets. The data-handling details are in
[the shared gateway guide](docs/shared-gateway-data-handling.md).

Use the browser to finish the sequence:

1. Open the Slack installation screen. Check the selected workspace against
   the intended workspace before granting access. Switch it if necessary.
2. Review the Chickpea app and requested permissions, then click **Allow**
   within the user's installation authorization. If Slack requires an admin
   approval request, submit the normal request for this app when available,
   preserve the setup state, and report that external approval is pending.
3. Follow the callback back to Chickpea. Continue with **Continue with Slack**
   or the displayed Slack sign-in action to establish the first Owner.
4. Verify that the signed-in person is the intended Owner in the same Slack
   workspace. Complete the normal consent and choose **Open Chickpea** when
   it appears. App installation and Owner sign-in are separate steps.

Prefer the existing authenticated browser. Use Slack in the browser if a deep
link opens a desktop app your tools cannot control. Do not reinstall the app
because a desktop-app redirect failed. Check the callback and current setup
state first.

If the user requested a **customer-owned Slack app**, choose **Use your own
Slack app instead** and follow [SETUP_AGENT.md](SETUP_AGENT.md). Perform its
browser actions too: create or adopt the exact app, install it, verify and save
the Events URL after credential adoption, and complete Owner sign-in. Keep
credentials in the intended forms. On an ambiguous app-creation result, inspect
the user's apps and adopt the matching one instead of creating a duplicate.
Do not switch to this route merely because a shared-app callback is slow.

## 5. Choose the provider and model

At **Choose provider**, use a provider the user has already explicitly chosen.
Otherwise, read the available options from the current screen and ask which
one they want to use. Present the options neutrally, with no recommendation or
preselected answer. Wait for their choice before selecting a provider or
advancing. The Cloudflare hosting account does not imply a model-provider
preference, and an available key or binding is not permission to choose one.

Complete the chosen provider's setup using the normal credential form or an
explicitly authorized secure local handoff. Ask for only the credentials that
provider needs. A coding-agent subscription is not a provider API key.

At **Choose your model**, honor any model the user already named. Otherwise
show the models available for their selected provider and ask them to choose
or delegate the model choice to you. Read the current model picker and account
restrictions; do not copy an old model ID from a comment, screenshot, or
another installation. If their choice is unavailable, explain the issue and
ask before substituting a provider or model.

Click **Select Model** and wait for **Meet Chickpea in Slack**. If a provider
requires a purchase, extra credentials, or unavailable permissions, complete
everything independent of that decision and report the exact remaining choice.
Do not enable an unrelated paid capability to get past the screen.

## 6. Complete the first conversation in Slack

Choose **Message Chickpea in Slack** on the Try screen. Use its generated link
to reach the exact app in the installed workspace. In Slack, open the app's
Messages conversation if it initially shows App Home.

Using the **same human Slack account that reached the Try screen**, send this
direct message through browser or computer use:

> Hi Chickpea! I'm checking that my installation works. Briefly tell me what
> you can help our team with in Slack. Don't create anything yet.

Send this DM as the first-use step of the requested installation, respecting
any narrower limits the user has given. If your harness requires approval for
the send action, request it for this exact DM and resume afterward. Use the
human Slack session so the reply completes that user's onboarding.

Observe a successful, substantive reply from Chickpea in that conversation.
A typing indicator, reaction, error reply, successful upload, or healthy HTTP
endpoint is insufficient. Preserve the request permalink, reply permalink
when available, and time in the private receipt without copying conversation
contents into the repository.

Return to the original Chickpea tab and check for **Reply confirmed in Slack**
and **Chickpea is ready**. Use **Check again** if the page offers it, or refresh
after observing the reply. Open the dashboard and verify signed-in access.
**Proceed to Dashboard** is navigation and does not substitute for proof.

If the first message fails, preserve its error and timing before changing
anything. Diagnose the selected deployment, make a supported setup correction,
and then send one new test DM. Do not repeatedly spam messages, create new
installations, or change providers without explaining the cause. Follow the
recovery section if the failure persists.

The built-in Chickpea assistant is enough to complete installation. Do not
invent a custom teammate, publish it to channels, connect unrelated accounts,
or create schedules as part of a generic install. If the user already supplied
a specific first use case, help them set up that teammate afterward. Otherwise
leave the working DM ready for them to ask, "Help me create my first teammate."

## 7. Verify the installation and hand over

Open **Settings → About & updates** and expand **Installation details**.
Confirm the application version and full source commit match the selected
release, and that the deployment is Cloudflare Workers. Record these values
and the release-notes link in the private receipt. Investigate a mismatch
before handing over; a successful upload alone does not establish which
release the customer is using.

If the update check reports a GitHub rate limit, use **Installation details**
to verify the installed version and commit against the release selected in
step 1. An unavailable update check does not invalidate a matching installation.
Record the retry time; do not redeploy or change credentials to retry it.

Leave a short final response containing:

- The installed Slack workspace and a link to the working Chickpea DM.
- The public Admin URL, with no setup capability in it.
- The absolute local project path and selected provider/model.
- The installed application release and source commit.
- Whether the real Slack reply and signed-in Admin were verified.
- If requested, whether the optional coding-agent connection is working or
  needs a remaining step.
- The private receipt path and a simple next prompt: "Help me create my first
  teammate" or "Help me update this Chickpea installation."

If any required step is blocked, name it plainly. For example, "Deployed to
Cloudflare; Slack admin approval is still pending." Do not call the install
complete until both the Slack reply and signed-in Admin have been verified.

## Optional: connect a coding agent

Do this when the user asks to manage Chickpea from their coding agent. Slack
and Admin work without it. MCP provides workspace management tools; it does
not deploy or update the Cloudflare installation.

1. Use the client's native remote-MCP setup with the public deployment URL
   ending in `/mcp`. Add it to the current project under an unused server name,
   preserving other connections. Never create or copy a bearer token.
2. Start the client's normal OAuth login. Finish Slack sign-in if prompted,
   verify the deployment and requested workspace-management permission, and
   approve Chickpea's consent screen within the user's requested connection.
3. Call `inspect_workspace` without making changes. Confirm the expected
   workspace and signed-in person. Report configuration, authentication, and
   this successful tool call separately; a saved URL alone is not a tested
   connection.

For Codex, add an entry to the project's `.codex/config.toml`. Replace the
example name and origin with the selected installation before writing it:

```toml
[mcp_servers.chickpea_workspace]
url = "https://<deployment>/mcp"
```

Run `codex mcp login chickpea_workspace` from that project, using the server
name you actually configured. For other clients, use their supported project
configuration or remote-server settings. The client handles OAuth discovery
and token storage directly.

If the active agent needs a restart to load the server, leave the configuration
prepared and name the remaining action. Do not restart the user's active
session yourself or claim the tool call was tested. If MCP fails, preserve
the first error and report that connection as blocked while leaving the
verified Slack installation available.

## Installation recovery

| What happened | What the agent should do |
| --- | --- |
| The task stopped halfway through | Read the private receipt, inspect the exact deployment, and resume the current screen. Do not automatically clone, deploy, or install again. |
| Wrangler authorization expired or the callback timed out | Inspect the terminal result. If authorization completed, activate the named profile if applicable and verify access with `whoami`. Otherwise restart the same `login` or `auth create <selected-profile>` command and use its fresh authorization URL. Preserve the chosen account and requested scopes. Wait for terminal confirmation, then activate the named profile if needed and verify with `whoami`. Do not replace an unrelated login or broaden access to recover. |
| Build or deploy failed | Keep the first error and private logs. Check Node, dependencies, account, and target. Correct the diagnosed problem and rerun the guarded command against the same resources. |
| A new `workers.dev` address temporarily returns a TLS or HTTPS connection error | Let the guarded deployment's bounded readiness wait finish; a newly provisioned address may not be reachable immediately. Do not start another deployment or disable TLS verification while it waits. If it still fails, preserve the error and use the serving-version and readiness checks below. |
| Upload succeeded but readiness failed | Inspect the existing Worker's serving version and the readiness error. Preserve the original evidence before any retry; do not create another Worker or call this a successful install. |
| Admin shows an unexpected release or source commit | Compare Installation details with the selected release and Cloudflare serving version. Check for a competing Cloudflare Builds trigger or a different target before changing anything. Never edit version labels to hide a mismatch. |
| A D1 migration or database identity check failed | Preserve the database. Read [the AUTH_DB contract](docs/runbooks/auth-db-deployment.md). Do not delete data, clear IDs, or rewrite migration history to bypass the failure. |
| The private setup link expired or was lost | First try the preserved setup tab. If an Owner already exists, use normal Slack sign-in. For an unfinished install with no Owner and no usable capability, verify the exact account/Worker/database and rerun the unchanged guarded deployment to mint a new link, preserving data and secrets. |
| Slack asks for workspace admin approval | Leave the installation pending and report the requested app/workspace. Resume after approval. Do not install into a different workspace to bypass it. |
| Slack returns to the wrong place or sign-in fails | Check app installation versus Owner sign-in, exact workspace, signed-in user, and the original setup tab. Use [Slack auth recovery](docs/runbooks/slack-auth-recovery.md) only for the credential failures it covers. |
| Chickpea does not answer or reports a provider error | Read [runtime observability](docs/runbooks/runtime-observability.md), resolve the exact deployed target, and investigate the first request. If live logs are needed, attach Wrangler tail before the next authorized DM and stop it afterward. Missing telemetry alone does not prove that no request ran. |
| Custom Agent handle creation is blocked | Keep the working built-in Chickpea DM. Consult [the handle prerequisite](SETUP_AGENT.md#agent-handle-prerequisite-for-a-customer-owned-app). Explain any paid Slack requirement or workspace-wide permission change and get the user's decision; do not silently change workspace policy. |

If help is needed, use the previewable support report in **About & updates**.
Review its contents before copying it. Keep private deployment logs, source
receipts, credentials, and Slack content outside public issues or the repository.
Report the specific blocker to the user; do not publish a report on their behalf.

## Later updates

Run this section only when the user asks to update an existing installation.
Keep the original local source and installation receipt. Read the current
[guided upgrade instructions](docs/runbooks/upgrading.md) and the destination's
release notes. **Settings → About & updates** shows the installed release and
an exact update command; the browser does not deploy updates itself.

Use a separate local `chickpea-upgrades` checkout of the latest stable official
application release for upgrade tooling. Select and verify its tag as in
step 1, then use its `.nvmrc` and run `npm ci`. This keeps the current launcher
available even when the deployed application is older. Preserve older tooling
directories and receipts for recovery. Authenticate Wrangler from this tooling
directory to the intended Cloudflare account and verify access there, including
when the original deploy used a named Wrangler authentication profile.

Configure a named installation once, using the exact existing account, Worker,
and public HTTPS origin from the installation receipt and live inspection.
Replace every placeholder before running:

```sh
npm run upgrade -- --configure --installation <installation-name> --account <account-id> --worker <existing-worker-name> --profile core --url https://<deployment>
```

Here `--profile core` selects Chickpea's deployment profile, not a Wrangler
authentication profile. Configuration only inspects the existing deployment
and records its resource identities privately under `~/.chickpea/upgrades/`.
It does not create resources or deploy. Record the tooling directory and chosen
installation name in the installation receipt, and use that same name below.
If Cloudflare Builds deploys automatically from the old repository, disable
that deployment trigger as part of switching to guided updates. Otherwise a
later push could overwrite the release installed by the updater.

Choose an exact destination whose `release.json` lists the installed version
in `supportedOrigins`. Apply required intermediate releases in order. For
example, v0.1.0 must go through v0.1.1 and v0.1.2 before v0.1.3. Fresh installations can
start directly on the latest release. Do not assume every older version can
upgrade directly to the latest, or that an unknown source is v0.1.0.

From the current tooling directory, run:

```sh
npm run upgrade -- --installation <installation-name> --to <release-tag> --preflight
npm run upgrade -- --installation <installation-name> --to <release-tag>
```

Preflight downloads and builds verified release source locally without
deploying. Review the displayed account, Worker, installed release,
destination, and receipt path. Run the actual update in an interactive
terminal and enter the exact Worker name at its confirmation prompt once it
matches the user's requested target. Honor any additional approval required
by your tools. Do not bypass the checks with `git pull` followed by redeploy,
bare Wrangler, edited version labels, or removed bindings.

The guided command preserves the supported installation's existing D1 and
Durable Object identities, credentials, and setup authority. If it refuses
unknown source, customization, or incompatible storage, preserve the working
installation and report the exact compatibility blocker. This is not a reason
to recreate resources or force a version change.

Keep the command's private receipt and neighboring source directories. For an
interrupted update or a requested return to the previous code, use the same
current tooling and the exact printed receipt:

```sh
npm run upgrade -- --resume /absolute/path/to/receipt.json
npm run upgrade -- --recover /absolute/path/to/receipt.json
```

Choose the command for the situation; do not run both in sequence. Inspect the
serving version before retrying, since a failed command may already have
activated the new code. Recovery restores previous code for a supported
transition. It does not undo application writes, restore deleted data, or roll
back schemas. An upgrade receipt is not a data backup.

After success, confirm the release and source commit in signed-in Admin and
complete an ordinary Slack conversation. Check any existing connections or
schedules the user relies on without creating new ones. Update the private
installation receipt with the serving release, Worker version ID, upgrade
receipt, and retained source path for that release. The original project
checkout is still available; use the source matching the serving release for
troubleshooting, and preserve any local edits separately.
