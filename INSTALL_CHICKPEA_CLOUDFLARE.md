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
authorization screens, sending the setup DM in step 6, verifying the
installation in step 7, connecting this coding agent to the new
deployment's MCP server in step 8, so the user can keep managing their
workspace from the agent that installed it, and creating their first
teammate from this conversation in step 9. The Chickpea CLI is not required
for this guide. Perform the installation steps within the user's selected
accounts and your harness's permission rules:

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
Use this guide for the workflow. For version-specific commands and settings,
the selected checkout's install guide, README, `.nvmrc`, and dependency policy
take precedence over examples from `main`. Use that release's dependency
install command; do not copy newer flags or change its manifest to match newer
instructions.
Resolve relative file references in this guide from the Chickpea checkout,
even when the user supplied this file from another directory or a URL.

For the local build and deployment tools, select the Node version in `.nvmrc`.
With an existing nvm installation:

```sh
nvm install
nvm use
node --version
npm --version
npm ci --strict-allow-scripts
```

Use an existing compatible Node manager when nvm is unavailable. On macOS,
an existing Homebrew `node@24` is also suitable if its version meets the minimum;
select it only for this shell with `export PATH="$(brew --prefix node@24)/bin:$PATH"`
and check `node --version` and `npm --version` again. Do not install nvm merely
because the example uses it, or replace the user's global Node. If Node or
Git is missing, use the platform's normal installation method and official
instructions; involve the user only if an installer requires their approval.
Do not change an unrelated project's runtime. The local tools currently require
Node 24.x with a minimum of 24.20.0; `.nvmrc` is the source for the exact build
pin. No Node application server is needed for this installation.

The pinned Node baseline includes npm 11.19.0. This release records exact
reviewed dependency hooks in `package.json` under `allowScripts`; strict mode
rejects any uncovered hook before running it. npm 11.19 otherwise warns and
can still run uncovered hooks. Do not run an approval command that edits the
release manifest, approve every dependency, or disable all scripts. If install
fails on script policy, preserve the selected release/commit, `node --version`,
`npm --version`, and the named package/version from the error. Check this
release's [dependency policy](docs/runbooks/releasing.md#dependency-install-policy)
and selected npm configuration before retrying. Keep credentials out of the
report; do not print the full npm config or credential files.

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
existing deployment follows the [update guide](UPDATE_CHICKPEA_CLOUDFLARE.md),
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

In the selected account's **Workers & Pages** dashboard, check whether a
`workers.dev` subdomain is registered. Keep an existing subdomain. If none is
registered, have the user choose the account-wide name and complete that
registration in the dashboard. The guarded deploy command also checks this
before building or provisioning D1; it never registers or renames the subdomain.
A missing subdomain and insufficient API access are different errors: resolve
the reported cause, then rerun the same guarded deploy command.

## 3. Deploy and open setup

For a fresh installation, or a retry of that same release's unfinished setup,
run this from the selected checkout. Use [later updates](#later-updates) to
change the release of an existing installation.

Customer installs and updates from published releases, with only local
installation settings changed, use this command directly.
Contributor host reservations, process inspection, and test suites are not
installation prerequisites. Development and QA deployments still follow
[host coordination](qa/live/operator/host-checks.md).

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

This command first checks account readiness, then builds Chickpea, provisions
or preserves `AUTH_DB`, applies the
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

If Slack sign-in loses the installation page or does not return to Chickpea,
return to the preserved setup tab and choose **Check Slack installation**.
If still pending, choose **Open Slack authorization again** to reopen the same
saved installation. Finish Slack login and consent, then check again. A status
error preserves the saved installation and offers the same retry controls;
it is not evidence that authorization expired. A confirmed expired or cancelled
installation returns to **Add to Slack** so you can start again. Use these
visible controls; do not edit hidden form actions, inspect credential files,
or repeatedly create installations to recover.

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

For API-key entry, bring the existing Chickpea setup tab to the foreground.
Identify its browser/profile, page title, and public URL without a setup
capability. Focus the key field and ask the user to enter the key there and tell
you when ready. Keep that tab open. Then click **Validate and Continue**
yourself and read the validation result without reading back the key. If the user has already
advanced, inspect the current step and resume there. Continue through model
selection and the Slack reply check below after the handoff.

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

First check whether the intended human user has already sent a test DM and
you have observed Chickpea's substantive reply in this app and workspace.
That conversation counts; preserve its evidence and continue to signed-in
Admin verification without sending a duplicate test. If no such reply has
been observed, continue below.

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
A canned welcome, typing indicator, reaction, error reply, successful upload,
or healthy HTTP endpoint is insufficient. Preserve the request permalink,
reply permalink when available, and time in the private receipt without copying
conversation contents into the repository.

Return to the original Chickpea tab and check for **Reply confirmed in Slack**
and **Chickpea is ready**. Use **Check again** if the page offers it, or refresh
after observing the reply. Open the dashboard and verify signed-in access.
**Proceed to Dashboard** marks onboarding complete and opens the dashboard;
the installing agent still needs to verify a real Slack reply.

If the first message fails, preserve its error and timing before changing
anything. Diagnose the selected deployment, make a supported setup correction,
and then send one new test DM. Do not repeatedly spam messages, create new
installations, or change providers without explaining the cause. Follow the
recovery section if the failure persists.

The built-in Chickpea assistant is enough to complete this step. Do not
create a teammate through Slack, publish anything to channels, connect
unrelated accounts, or create schedules here. The first teammate is designed
and created from this conversation in step 9, after this coding agent is
connected; if the user already supplied a specific first use case, carry it
to that step.

## 7. Verify the installation

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

## 8. Connect this coding agent

Connect the coding agent running this installation, meaning you, to the new
deployment's management MCP server, so the user can keep managing their
Chickpea from this conversation. MCP provides workspace management tools; it
does not deploy or update the Cloudflare installation. Slack and Admin work
without it, so a blocked connection never invalidates the verified install.

Fetch `https://<deployment>/connect.md`, replacing `<deployment>` with the
public deployment URL saved in step 3, and follow its steps 1 to 5. It is
written for you and carries the real server URL, the configuration for every
client, and the same sign-in and verification rules restated here. Skip its
last step; step 9 of this guide covers the first teammate. If that address
answers 404, the installed release predates the connect guide; use the table
at the end of this step instead. Either way:

1. Add the server to the client you are running in, for the project you are
   working in, using the public deployment URL ending in `/mcp`. You should
   know which client you are; ask only if you genuinely cannot tell. Some
   clients only have a user-level configuration file; say so when you write
   one. Use the server name `chickpea` unless it is already taken, and
   preserve every other server the user has configured. Never create, copy,
   or paste a bearer token.
2. Start the client's normal sign-in for the new server. The browser shows
   Slack sign-in for the installed workspace, then Chickpea's consent screen
   with one permission: manage this Chickpea workspace. Ask the user to take
   over for Slack sign-in with the account that became the Owner, keep the
   page open, and continue when they finish.
3. Call `inspect_workspace` without making changes. Confirm it names the
   installed workspace and the signed-in user.

Report the three parts on separate lines, each with its own result:
configured (which client and where the configuration was written), signed in
(whether the browser sign-in and consent completed), and tested (the
workspace and person that `inspect_workspace` returned). A saved
configuration is not a tested connection.

If the client needs a restart to load the server, leave the configuration
prepared, name the one remaining action, and stop there. Do not restart the
user's active session yourself, and do not claim the tool call was tested. If
the connection fails, preserve the first error and report the connection as
blocked while leaving the verified Slack installation available. If the user
declines the connection, record that in the hand-over and continue.

| Client | Where | What to write or run |
| --- | --- | --- |
| Claude Code | terminal | `claude mcp add --transport http chickpea https://<deployment>/mcp`, then `/mcp` inside Claude Code to sign in |
| Codex | terminal | `codex mcp add chickpea --url https://<deployment>/mcp` then `codex mcp login chickpea` |
| Cursor | `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project | `{"mcpServers":{"chickpea":{"url":"https://<deployment>/mcp"}}}` |
| VS Code | terminal, or `.vscode/mcp.json` | `code --add-mcp '{"name":"chickpea","type":"http","url":"https://<deployment>/mcp"}'` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `{"mcpServers":{"chickpea":{"serverUrl":"https://<deployment>/mcp"}}}` |
| Gemini CLI | terminal | `gemini mcp add --transport http chickpea https://<deployment>/mcp` |
| Any other MCP client | the client's MCP server configuration | `{"mcpServers":{"chickpea":{"type":"http","url":"https://<deployment>/mcp"}}}` |

Anyone on the team can connect their own coding agent later from Admin
**Settings → MCP**, or by pasting `Connect my coding agent to my Chickpea
using https://<deployment>/connect.md` into that agent.

## 9. Create the first teammate

Design and create the user's first teammate from this conversation, over the
connection from step 8, then prove it answers in Slack. Do this only after
step 8 reported the connection as tested. If the client still needs a
restart, the connection is blocked, or the user declined it, skip this step,
say so in the hand-over, and tell the user to ask you here once the
connection works. Do not create the teammate through Slack instead.

Read the resource `chickpea://guide/agent-authoring/v1` before you draft. If
the user already named a specific first use case earlier in the
installation, treat it as their answer to the question below and confirm it
in one line instead of asking again. Otherwise ask, in these words:

> What should your first teammate do for your team?

Offer starters from this list as a numbered list, one line each, never as a
table and never one you invent. If the user has said what their team does,
offer the three that fit best; otherwise show all five. Say that none of
them exist yet and that each works today with nothing to connect. They can
reply with a number or describe the job they have in mind.

1. @editor: tightens anything you paste: announcements, emails, posts. Keeps your voice.
2. @notes: turns raw meeting notes into decisions, owners, and next steps.
3. @buddy: answers “how do we do X here” once you tell it a few things about how the team works.
4. @brief: turns a messy ask into a clear brief with goal, scope, and open questions.
5. @planner: breaks a goal into a checklist you can start on today.

Design in a few turns. Call `inspect_workspace` again before you draft; it
names the handles already in use and the model providers available. Ask at
most three more questions, only where the answer changes the role,
procedure, or reach; prefer inferring low-risk defaults and saying so. Draft
the teammate in the conversation: name, handle, one-line description, and
complete instructions. A chosen starter keeps its catalog name and handle
and uses these instructions unchanged:

- `@editor` (Editor): You are an editor. When someone pastes a draft, return a tighter version that keeps their voice, meaning, and format. Cut filler, fix grammar, and keep the length close to the original unless asked to shorten. Show the rewrite first; list only the changes that matter.
- `@notes` (Notes): You turn raw meeting notes into a short record. Return three lists: Decisions, Action items with an owner and a date when one is stated, and Open questions. Keep wording from the notes; never invent owners, dates, or decisions that are not there.
- `@buddy` (Buddy): You answer questions about how this team works. Rely on what people have told you and on your memory of earlier answers. When you do not know, say so and ask the person to tell you, then remember it for next time. Keep answers short and practical.
- `@brief` (Brief): You write briefs. Given a rough request, return a one-page brief with Goal, Audience, Scope and non-goals, Success looks like, and Open questions. Ask at most one clarifying question before drafting; otherwise draft and mark assumptions.
- `@planner` (Planner): You break goals into plans. Given a goal, return an ordered checklist of concrete steps, each small enough to finish in a sitting, with the first step something the person can do today. Flag dependencies and the riskiest step. Keep it under fifteen items.

The user chooses the starter or describes the job; nothing is created while
that is still open. If they decline a teammate or stop answering, create
nothing, say the step is still open, and report it as skipped in the
hand-over.

Once the draft is settled, call `apply_workspace_changes` in that same
turn with exactly one `create_agent` operation and nothing else. Do not add
Channel reach, connections, repositories, or schedules unless the user asked
for them, do not propose the creation instead of applying it, and do not
ask the user to say "create it" or confirm a second time. The result
usually carries `links.admin`, the Agent's page in Admin, and `links.slack`,
which opens the Chickpea app in Slack; pass on whichever links the result
returned and never construct one yourself. If it returns a
duplicate-identity clarification, ask whether to use the existing Agent or
choose a distinct name or handle; do not retry unchanged. If it carries a
warning that the Slack handle needs attention, do not send the mention
below: report the teammate as created with its handle pending, and give the
user the warning and the Admin link.

Then prove it. In the Chickpea DM from step 6, or a Channel the user names,
send one message that mentions the new `@handle` with a small request it was
built for. Use the same human Slack account as step 6 through browser or
computer use; if your harness requires approval for the send, request it for
this exact message. Observe a substantive reply from the new Agent. The tool
result is not a reply, and a canned welcome, typing indicator, reaction, or
error reply is insufficient. Preserve the request permalink, reply permalink
when available, and time in the private receipt without copying the
conversation. If the mention gets no reply or an error, preserve the first
error, diagnose it once, and report the teammate as created but not verified;
do not create another Agent or edit this one blind. A created Agent is not a
verified teammate.

Report two parts on separate lines, each with its own result: created (the
`@handle` from the tool result) and verified (the reply you observed, with
its permalink in the receipt). Then give the user `links.admin`,
`links.slack`, and one line on how to try it: mention `@handle` in Slack.
Close by saying that next time they can ask you here to create, change, or
connect a teammate, and that `/mcp__chickpea__new-agent` starts the next one if
their client shows Chickpea's prompts as slash commands (with the server
name from step 8 in place of `chickpea` if you used another).

## Hand over

Leave a short final response containing:

- The installed Slack workspace and a link to the working Chickpea DM.
- The public Admin URL, with no setup capability in it.
- The absolute local project path and selected provider/model.
- The installed application release and source commit.
- Whether the real Slack reply and signed-in Admin were verified.
- The coding-agent connection from step 8 as three separate lines:
  configured, signed in, and tested, or the one remaining action if the
  client still needs a restart.
- The first teammate from step 9 as two separate lines: created, with its
  `@handle` and the links the result returned, and verified, with whether a
  real reply was observed; or the reason the step was skipped.
- The private receipt path and a simple next prompt to use here: "Create
  another teammate for us", or "Create our first teammate" if step 9 was
  skipped (`/mcp__chickpea__new-agent` where slash commands are shown), or "Help
  me update this Chickpea installation."

If any required step is blocked, name it plainly. For example, "Deployed to
Cloudflare; Slack admin approval is still pending." Do not call the install
complete until both the Slack reply and signed-in Admin have been verified.

## Installation recovery

| What happened | What the agent should do |
| --- | --- |
| The task stopped halfway through | Read the private receipt, inspect the exact deployment, and resume the current screen. Do not automatically clone, deploy, or install again. |
| Wrangler authorization expired or the callback timed out | Inspect the terminal result. If authorization completed, activate the named profile if applicable and verify access with `whoami`. Otherwise restart the same `login` or `auth create <selected-profile>` command and use its fresh authorization URL. Preserve the chosen account and requested scopes. Wait for terminal confirmation, then activate the named profile if needed and verify with `whoami`. Do not replace an unrelated login or broaden access to recover. |
| The account has no `workers.dev` subdomain | Open the selected account dashboard, obtain the user's choice of account-wide name, register it, and rerun the same guarded deploy command. Do not rename an existing subdomain. An access or network error needs its own diagnosis. |
| npm reports an uncovered or conflicting script policy | Record release/commit, Node/npm versions and the named package/version. Use the release-matched policy and npm config; do not edit retained source or use blanket approvals. |
| Build or deploy failed | Keep the first error and private logs. Check Node, dependencies, account, and target. Correct the diagnosed problem and rerun the guarded command against the same resources. |
| A new `workers.dev` address temporarily returns a TLS or HTTPS connection error | Let the guarded deployment's bounded readiness wait finish; a newly provisioned address may not be reachable immediately. Do not start another deployment or disable TLS verification while it waits. If it still fails, preserve the error and use the serving-version and readiness checks below. |
| Upload succeeded but readiness failed | Inspect the existing Worker's serving version and the readiness error. Preserve the original evidence before any retry; do not create another Worker or call this a successful install. |
| Admin shows an unexpected release or source commit | Compare Installation details with the selected release and Cloudflare serving version. Check for a competing Cloudflare Builds trigger or a different target before changing anything. Never edit version labels to hide a mismatch. |
| A D1 migration or database identity check failed | Preserve the database. Read [the AUTH_DB contract](docs/runbooks/auth-db-deployment.md). Do not delete data, clear IDs, or rewrite migration history to bypass the failure. |
| The private setup link expired or was lost | First try the preserved setup tab. If an Owner already exists, use normal Slack sign-in. For an unfinished install with no Owner and no usable capability, verify the exact account/Worker/database and rerun the unchanged guarded deployment to mint a new link, preserving data and secrets. |
| Slack asks for workspace admin approval | Leave the installation pending and report the requested app/workspace. Resume after approval. Do not install into a different workspace to bypass it. |
| Slack returns to the wrong place or sign-in fails | Return to the original setup tab, use **Check Slack installation**, then **Open Slack authorization again** if pending. Check app installation versus Owner sign-in, exact workspace and signed-in user. Use [Slack auth recovery](docs/runbooks/slack-auth-recovery.md) only for the credential failures it covers. |
| Chickpea does not answer or reports a provider error | Read [runtime observability](docs/runbooks/runtime-observability.md), resolve the exact deployed target, and investigate the first request. If live logs are needed, attach Wrangler tail before the next authorized DM and stop it afterward. Missing telemetry alone does not prove that no request ran. |
| Custom Agent handle creation is blocked | Keep the working built-in Chickpea DM. Consult [the handle prerequisite](SETUP_AGENT.md#agent-handle-prerequisite-for-a-customer-owned-app). Explain any paid Slack requirement or workspace-wide permission change and get the user's decision; do not silently change workspace policy. |

If help is needed, use the previewable support report in **About & updates**.
Review its contents before copying it. Keep private deployment logs, source
receipts, credentials, and Slack content outside public issues or the repository.
Report the specific blocker to the user; do not publish a report on their behalf.

## Later updates

When the user asks for an update, keep the original source and private
installation receipt, then follow [Update Chickpea on Cloudflare](UPDATE_CHICKPEA_CLOUDFLARE.md).
That guide starts from the cloned folder, identifies the live installation,
updates to the latest stable application release, and verifies Admin access
without sending Slack test messages. Do not rerun setup, reinstall Slack, or
recreate Cloudflare resources as an update.
