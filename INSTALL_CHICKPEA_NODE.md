# Install Chickpea on a Mac

The Node installer prepares Chickpea on one Mac with private SQLite state. It
downloads Node 24.20.0, builds a versioned application release, creates the
runtime settings and setup link, then starts Chickpea and opens your browser.
You do not need nvm, Homebrew, a global npm package, or a Cloudflare Worker.

The guided ngrok option provides an account-assigned public HTTPS address without
buying a domain or using Cloudflare. You sign in to ngrok and authorize Slack and
your model provider. The address serves setup, sign-in, connector callbacks, and
Admin links. The shared Chickpea app delivers Slack events over an outbound
connection from your Mac; a customer-owned Slack app uses the public address.
Keep the Mac awake and connected. Scheduled work runs only while Chickpea is
running. Node does not include the Cloudflare coding sandbox.

## Before you start

- Use an Apple Silicon or Intel Mac with internet access and enough disk space
  for Node, application source, dependencies, and persistent data.
- Use a Slack workspace where you can install the shared Chickpea app. You can
  also create and use your own Slack app.
- Have a supported model provider account or API credential ready.
- Choose one of the [HTTPS options](#choose-an-https-route) below.

Mac installation is supported starting with v0.1.21. The default command uses
the latest stable application release. Installing the management CLI from npm
does not install the application.

Guided ngrok setup and Node support for the shared Chickpea Slack app are
available starting with v0.1.22. The bootstrap refuses ngrok mode when the
selected application release does not support it. With v0.1.21, use your own
Slack app and an existing HTTPS route or Cloudflare Tunnel.

## Install

Run this command in Terminal as your usual user, without `sudo`:

```sh
curl -fsSL https://chickpea.co/install.sh | bash
```

The installer offers ngrok as the default (press Enter), followed by Cloudflare
Tunnel and an existing HTTPS route. It opens the ngrok
dashboard so you can copy your assigned dev domain and authtoken. Token input
is hidden. `--no-open` leaves dashboard and setup pages for you to open manually.
It downloads tools into `~/.chickpea-node`, builds an immutable stable GitHub
application release, and starts in the foreground. Keep that Terminal open.

To inspect the script before running it, download
[install-node.sh](https://github.com/pejmanjohn/chickpea/blob/main/scripts/install-node.sh)
and run `bash /path/to/install-node.sh`. The bootstrap comes from `main`;
the application comes from the selected release's exact commit.

To choose a release explicitly or prepare an installation without starting it:

```sh
bash /path/to/install-node.sh \
  --version vX.Y.Z \
  --origin https://chickpea.example.com \
  --tunnel external \
  --no-start
```

Replace `vX.Y.Z` with a compatible published application release. `--no-open`
starts the service without opening the browser. `--port` changes the loopback
port from 3000. Managed ngrok follows this port automatically; update an external
or Cloudflare route yourself. `--home` selects a
different absolute installation directory, including paths containing spaces.

The installer leaves system Node, shell startup files, and other Chickpea
installations alone. It refuses an existing directory that it does not own.
An installation made with the older manual guide stays on its existing
launcher and state paths; the installer does not adopt or migrate it.

## Choose an HTTPS route

### Managed ngrok, no domain purchase

Use this option to try Chickpea on a Mac with ngrok's assigned HTTPS dev domain.
It needs an ngrok account, but no DNS setup, Homebrew, or administrator access.

1. Select **1, ngrok** in the installer.
2. Sign in or create an account in the opened
   [ngrok dashboard](https://dashboard.ngrok.com/domains). Copy the assigned dev
   domain into the Terminal prompt. You can paste the hostname or its HTTPS URL.
   Dedicate it to this installation; do not reuse a domain already serving another app.
3. Copy only the authtoken from
   [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) into
   the hidden prompt. Complete any account/email verification ngrok requests.
4. The installer downloads a pinned, checksum-verified ngrok v3 client into its
   private directory. It starts Chickpea, forwards to its actual loopback port,
   and compares a public response with Chickpea's local setup asset before opening setup.
5. If ngrok shows a browser warning, select **Visit Site** before continuing
   setup and before beginning Slack sign-in or another browser OAuth flow.

The domain belongs to your ngrok account and stays the same across restarts.
The installer saves it and the token privately, so reruns do not ask again.
It uses its own config, disables the local traffic inspector and remote agent
management, and does not start endpoints from your global ngrok config. It never
enables endpoint pooling or stops a competing tunnel. ngrok still handles public
traffic; review its account-level traffic retention settings for your needs.

For unattended installation, use a private token file and your assigned domain:

```sh
bash /path/to/install-node.sh \
  --origin https://YOUR-ASSIGNED-DOMAIN.ngrok-free.app \
  --tunnel ngrok \
  --tunnel-token-file /absolute/path/to/private-ngrok-token.txt \
  --no-start
```

Replace the example domain with the exact one shown in your dashboard. Supply
`--ngrok /absolute/path/to/ngrok` to use an existing v3 executable, including one
installed by Homebrew. Its global config and credentials are not imported.
Keep token files readable only by your user. Never put the token in a command
argument, shell history, issue, or chat message.

#### Free-plan limits

Checked September 16, 2026. ngrok's [free-plan documentation](https://ngrok.com/docs/pricing-limits/free-plan-limits)
lists one assigned dev domain, HTTPS, no endpoint session timeout, up to three
online endpoints, and monthly allowances of 1 GB outgoing data and 20,000 HTTP
requests. HTML browser visits show a warning; after you continue, a cookie
suppresses it for seven days. API requests and webhooks do not require that
browser interaction. Chickpea uses its own Slack signature verification and
OAuth, not ngrok's optional verification or OAuth traffic policies.

The [pricing page](https://ngrok.com/pricing) also describes Free as having $5
of one-time usage credit with no additional usage beyond that credit. These
pages do not describe the allowance identically. Check your account's
[usage](https://dashboard.ngrok.com/usage) and billing; do not assume an unlimited
or permanently renewable free service. If a limit is reached, setup, callbacks,
and Admin may become unavailable. A customer-owned Slack app also depends on
the tunnel for incoming events. Choose a suitable paid plan or a
different stable HTTPS route for traffic that must stay available.

ngrok's current [terms](https://ngrok.com/tos) cover individuals and companies;
its Free comparison does not state a personal-only eligibility rule. It is
presented as a development option, with production traffic on paid plans.
Tailscale Funnel remains an external-route alternative, but Tailscale's
[free Personal plan](https://tailscale.com/pricing) is for noncommercial use.
[Funnel](https://tailscale.com/docs/features/tailscale-funnel) also has bandwidth
limits, requires HTTPS and tailnet DNS setup, and supports only designated
public ports. It can proxy local ports on macOS, but Chickpea does not configure
or manage it.

### Managed Cloudflare Tunnel

Use this option if your domain is on Cloudflare and you want the installer to
run the tunnel alongside Chickpea.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), create a
   remotely managed Cloudflare Tunnel for this installation.
2. Add a public hostname, such as `chickpea.example.com`, with service type
   **HTTP** and URL **127.0.0.1:3000**. Use your chosen port if different.
3. Copy the tunnel token from the connector installation command. It is the
   long `eyJ...` value. Paste only that token into the installer's hidden prompt.
   The installer runs the connector, so you do not need to run Cloudflare's
   separate service-install command.

The installer downloads a checksum-verified `cloudflared` into its own directory
and saves the token privately. It passes a token-file path to `cloudflared`, so
the token does not appear in process arguments. It does not request an
account-wide certificate, create DNS records, or change another tunnel.

For unattended provisioning, provide a private token file rather than a token
in your shell command:

```sh
bash /path/to/install-node.sh \
  --origin https://chickpea.example.com \
  --tunnel cloudflare \
  --tunnel-token-file /absolute/path/to/private-tunnel-token.txt \
  --no-start
```

Keep that file readable only by your user. The installer copies it into its
private installation directory. An existing `cloudflared` executable can be
selected with `--cloudflared /absolute/path/to/cloudflared`.

Cloudflare documents [tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)
and [the token-file option](https://developers.cloudflare.com/tunnel/reference/run-parameters/).
The dashboard's hostname and forwarding port must match your installation.
The installer cannot infer or repair that remote configuration.

### An existing tunnel or reverse proxy

Choose `external` if you already have a stable HTTPS address forwarding to
`http://127.0.0.1:3000`. Keep that tunnel or proxy running separately. Chickpea
manages only its own process in this mode. The existing
[locally managed Cloudflare Tunnel procedure](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)
also works with this option.

Preserve the public hostname and HTTPS scheme through the proxy, allow Slack
events and OAuth callbacks, and support streaming responses. Keep Chickpea's
HTTP listener on loopback. Do not put an interactive proxy login in front of
Slack event or callback routes. Random `trycloudflare.com` quick tunnels are
unsuitable because Slack needs a stable address.

## Finish setup in your browser

The private setup link expires after 24 hours. The installer opens it without
printing it. Keep saved setup links, runtime settings, and tunnel tokens out of
messages, source control, and issue attachments.

Use the shared Chickpea app for the shortest setup:

1. Choose **Add to Slack** and authorize Chickpea in your workspace.
2. Sign in with Slack to become the first Owner.
3. Choose a provider and model.
4. Send a direct message to `@Chickpea`, confirm its reply, and sign in to Admin.

These are account choices and authorization steps. The shell installer does
not grant itself Slack or model-provider access. The shared app requires no
Slack configuration token, signing secret, or app-level `xapp-` token. Your
installation saves incoming deliveries to its SQLite inbox before acknowledging
them and resumes pending work when it restarts. Keep its state directory.

If you prefer to operate the Slack app yourself, follow
[the customer-owned Slack app setup](SETUP_AGENT.md). That path uses Slack's
HTTP Events API through your public HTTPS address.

The setup page supports Anthropic, OpenAI, OpenRouter, and REST-based Cloudflare
Workers AI. A Node installation cannot use a Worker-only binding.

For OpenAI chat, connect a ChatGPT subscription in **Settings → Model providers
→ OpenAI** and follow the device sign-in instructions. OpenAI may require
enabling device code authorization for Codex in the account's security settings.
Usage shares that account's limits; Chickpea does not switch to API billing
automatically.

**ChatGPT Image** uses the connected subscription independently of the selected
chat authentication method. It generates one image per call, does not edit
images, and lets ChatGPT choose the output settings. Flare and Sunburst require
a separate OpenAI API key. Saving that key does not change chat authentication.
For a workspace with no previous image default, its first subscription connection
selects ChatGPT Image, or its first OpenAI API key selects Flare. Existing
selections and deliberately cleared defaults are preserved.

## Connect this coding agent

If a coding agent ran this installation, it connects itself to the new
installation's management MCP server before it finishes, so you can keep
managing Chickpea from the same conversation. This happens after the Slack
reply is confirmed: the `/mcp` endpoint and its OAuth metadata answer 404
until setup in the browser is finished. MCP provides workspace management
tools; it does not install, update, or restart Chickpea, and Slack and Admin
work without it. If you decline the connection, the agent says so and moves
on.

The agent fetches `https://<deployment>/connect.md`, with `<deployment>`
replaced by the installation's public HTTPS address, and follows its steps 1
to 5. That page is written for the agent and carries the real server URL, the
configuration for every client, and the same sign-in and verification rules
restated here. If the address answers 404, the installed release predates the
connect guide and the agent uses the table at the end of this section
instead. Either way, the agent:

1. Adds the server to the client it is running in, for the project it is
   working in, using the public address ending in `/mcp`. It should know
   which client it is and asks only if it genuinely cannot tell. Some clients
   only have a user-level configuration file; it says so when it writes one.
   It uses the server name `chickpea` unless that is already taken, preserves
   every other configured server, and never creates, copies, or pastes a
   bearer token.
2. Starts the client's normal sign-in for the new server. The browser shows
   Slack sign-in for the installed workspace, then Chickpea's consent screen
   with one permission: manage this Chickpea workspace. Slack sign-in needs
   the person who became the Owner; the agent keeps the page open and
   continues when you finish.
3. Calls `inspect_workspace` without making changes and confirms it names
   the installed workspace and the signed-in user.

The agent reports the three parts on separate lines, each with its own
result: configured (which client and where the configuration was written),
signed in (whether the browser sign-in and consent completed), and tested
(the workspace and person that `inspect_workspace` returned). A saved
configuration is not a tested connection. If the client needs a restart to
load the server, the agent leaves the configuration prepared, names the one
remaining action, and stops there without restarting the active session or
claiming the tool call was tested. If the connection fails, it preserves the
first error and reports the connection as blocked while the verified
installation stays available.

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

## Create the first teammate

Once the connection is tested, the agent designs and creates your first
teammate from the same conversation and proves it answers in Slack. It skips
this section, and says so, if the client still needs a restart, the
connection is blocked, or you declined it; ask it again once the connection
works. It does not create the teammate through Slack instead.

The agent reads the resource `chickpea://guide/agent-authoring/v1` before it
drafts. If you already named a first use case, it confirms that in one line
instead of asking; otherwise it asks, in these words:

> What should your first teammate do for your team?

It offers starters from this list as a numbered list, one line each, never
as a table and never one it invents. If you have said what your team does,
it offers the three that fit best; otherwise it shows all five. None of them
exist yet, and each works today with nothing to connect. Reply with a number
or describe the job you have in mind.

1. @editor: tightens anything you paste: announcements, emails, posts. Keeps your voice.
2. @notes: turns raw meeting notes into decisions, owners, and next steps.
3. @buddy: answers “how do we do X here” once you tell it a few things about how the team works.
4. @brief: turns a messy ask into a clear brief with goal, scope, and open questions.
5. @planner: breaks a goal into a checklist you can start on today.

Design takes a few turns. The agent calls `inspect_workspace` again before
it drafts, for the handles already in use and the model providers
available. It asks at most three more questions, only where the answer
changes the role, procedure, or reach, and prefers inferring low-risk
defaults and saying so. It drafts the teammate in the conversation: name,
handle, one-line description, and complete instructions. A chosen starter
keeps its catalog name and handle and uses these instructions unchanged:

- `@editor` (Editor): You are an editor. When someone pastes a draft, return a tighter version that keeps their voice, meaning, and format. Cut filler, fix grammar, and keep the length close to the original unless asked to shorten. Show the rewrite first; list only the changes that matter.
- `@notes` (Notes): You turn raw meeting notes into a short record. Return three lists: Decisions, Action items with an owner and a date when one is stated, and Open questions. Keep wording from the notes; never invent owners, dates, or decisions that are not there.
- `@buddy` (Buddy): You answer questions about how this team works. Rely on what people have told you and on your memory of earlier answers. When you do not know, say so and ask the person to tell you, then remember it for next time. Keep answers short and practical.
- `@brief` (Brief): You write briefs. Given a rough request, return a one-page brief with Goal, Audience, Scope and non-goals, Success looks like, and Open questions. Ask at most one clarifying question before drafting; otherwise draft and mark assumptions.
- `@planner` (Planner): You break goals into plans. Given a goal, return an ordered checklist of concrete steps, each small enough to finish in a sitting, with the first step something the person can do today. Flag dependencies and the riskiest step. Keep it under fifteen items.

You choose the starter or describe the job; nothing is created while that
is still open. If you decline a teammate or stop answering, the agent
creates nothing and reports the step as skipped.

Once the draft is settled, the agent calls `apply_workspace_changes` in
that same turn with exactly one `create_agent` operation and nothing else:
no Channel reach, connections, repositories, or schedules unless you asked
for them, no proposal in place of the creation, and no request that you say
"create it" or confirm a second time. The result usually carries
`links.admin`, the Agent's page in Admin, and `links.slack`, which opens the
Chickpea app in Slack; the agent passes on whichever links it received and
never constructs one. If creation reports a duplicate identity, the agent
asks whether to use the existing Agent or pick a distinct name or handle,
and does not retry unchanged. If the result warns that the Slack handle
needs attention, the agent skips the mention below, reports the teammate as
created with its handle pending, and gives you the warning and the Admin
link.

Then it proves it. In the Chickpea DM you used to confirm setup, or a Channel
you name, it sends one message that mentions the new `@handle` with a small
request the teammate was built for, using your Slack account through browser
or computer use, and asks for approval first if its harness requires that. It
waits for a substantive reply from the new Agent; the tool result is not a
reply, and a canned welcome, typing indicator, reaction, or error reply is
insufficient. It keeps the request and reply permalinks in its private
receipt without copying the conversation. If the mention gets no reply or an
error, it preserves the first error, diagnoses it once, and reports the
teammate as created but not verified, without creating another Agent or
editing this one blind. A created Agent is not a verified teammate.

The agent reports two parts on separate lines, each with its own result:
created (the `@handle` from the tool result) and verified (the reply it
observed). It then gives you `links.admin`, `links.slack`, and one line on
how to try it: mention `@handle` in Slack. Next time, ask it here to create,
change, or connect a teammate; `/mcp__chickpea__new-agent` starts the next one if
your client shows Chickpea's prompts as slash commands (with the server name
the agent chose in place of `chickpea` if `chickpea` was taken).

## Start, stop, and check status

The commands live inside the installation, so they use its private Node even
when your shell has another Node version selected:

```sh
"$HOME/.chickpea-node/bin/chickpea-node" start
"$HOME/.chickpea-node/bin/chickpea-node" restart
"$HOME/.chickpea-node/bin/chickpea-node" status
"$HOME/.chickpea-node/bin/chickpea-node" stop
"$HOME/.chickpea-node/bin/chickpea-node" setup
```

`start` stays in the foreground and starts the configured tunnel too. Use
another Terminal for `status`, `stop`, or `setup`. `start --open` also opens
setup after the local listener is ready and the managed public route checks out.
If public verification fails, the processes keep running so a temporary network
failure can recover. Check `status`, then run `setup` once HTTPS is reachable.
Stop with Control-C or the `stop`
command and wait for graceful shutdown. A second Control-C does not skip the
drain. Logs are private files inside the installation directory.

`restart` restarts both managed processes with the saved domain and port. With
start at login installed, it reloads that service; otherwise it stays in the
foreground. `stop` unloads the login service for the current session. Use
`service uninstall` to remove startup at future logins.

Status checks show process and HTTP availability. The exit code reports whether
the managed application is running and reachable locally; public HTTPS is
reported separately. These checks do not prove that Slack
can deliver a message, that your provider can answer, or that Admin sign-in
works. Confirm those in Slack and your browser after first setup and restarts.

### Start at login

Opt in to a macOS LaunchAgent with:

```sh
"$HOME/.chickpea-node/bin/chickpea-node" service install
```

Stop the foreground instance first. The LaunchAgent starts Chickpea and its
managed tunnel at login and restarts after a failure. It does not run before
login or while the Mac is asleep. No root service or sleep-setting change is
installed. Remove automatic startup with:

```sh
"$HOME/.chickpea-node/bin/chickpea-node" service uninstall
```

## Reruns and recovery

Rerunning the installer for the same installation reuses its release and private
settings. It does not automatically update to a newer release or replace your
auth secret, databases, or connected accounts. Stop the installation before
rerunning. A failed download or build does not activate incomplete source.
Fix the reported issue and run the same command again.

For ngrok authentication errors, sign in to the same ngrok account, verify it,
and copy a valid authtoken into a file readable only by your user. Then run:

```sh
"$HOME/.chickpea-node/bin/chickpea-node" stop
"$HOME/.chickpea-node/bin/chickpea-node" tunnel authenticate \
  --token-file /absolute/path/to/private-ngrok-token.txt
"$HOME/.chickpea-node/bin/chickpea-node" restart
```

This replaces the tunnel token and preserves the public URL, app credentials,
and databases. Authentication is checked by ngrok when the tunnel starts.
If the domain is already online or the agent limit is reached, inspect your
ngrok dashboard. Do not stop an unrelated tunnel or enable pooling to work
around the conflict. Quota errors require an allowance reset or plan change;
reinstalling Chickpea does not fix them. The manager prints recognized error
guidance but discards raw ngrok output because it can contain tokens.

If setup expires before you finish, stop Chickpea, renew only the setup
capability, then start it again:

```sh
"$HOME/.chickpea-node/bin/chickpea-node" stop
"$HOME/.chickpea-node/bin/chickpea-node" setup --renew
"$HOME/.chickpea-node/bin/chickpea-node" start --open
```

Renewal preserves the auth secret and state. It refuses to create a new
first-owner setup link after the installation already has an Owner. Use normal
Slack sign-in or the [auth recovery procedure](docs/runbooks/slack-auth-recovery.md)
for an installed workspace.

If port 3000 is occupied, stop only the process you own or choose another port
for a new installation and update the HTTPS route. If the local service works
but setup cannot open publicly, check your hostname, forwarding port, tunnel
credentials, and tunnel status. Do not reinstall or clear state to fix routing.

An interrupted installer may leave its install lock. Follow its error message
to verify the owning installer has stopped before removing that exact lock.
A forcibly killed runtime manager can also leave a runtime lock.
Locks are tied to the operating system's boot session, so an old lock does not
block startup after a reboot. Within the same boot, verify that the application
and tunnel have stopped before clearing the exact lock named in the error.
The login service stops retrying this condition; after resolving it, run
`service install` again to restart it. The manager never kills an unverified PID
to recover. Do not remove the runtime databases or another installation's lock.

## Files, backups, and upgrades

The default layout is:

| Path under `~/.chickpea-node` | Contents |
| --- | --- |
| `tools/` | Private Node and optional tunnel executable |
| `releases/<commit>/` | Exact application source, dependencies, and build |
| `current` | Link to the installed release |
| `bin/chickpea-node` | Installation management command |
| `runtime.env`, `installation.json` | Runtime secrets and installation settings |
| `state/` | SQLite databases and credential keyring |
| `setup-url.txt` | Private initial setup link |
| `tunnel-token.txt`, `ngrok.yml` | Private managed tunnel credential and ngrok config |
| `logs/` | Private process logs |

Keep the application files available while it runs. Before a backup, stop
Chickpea and ingress, then copy the whole state directory with any SQLite
`-wal` and `-shm` files, its credential keyring, `runtime.env`, and
`installation.json`. Include `tunnel-token.txt` when using a managed tunnel and
`ngrok.yml` when using ngrok.
Record the installed commit. Protect and test the backup as described in
[operations](docs/runbooks/operations.md#back-up-and-restore-node).

The installer deliberately refuses to switch an existing installation to a
different release. Follow the selected release's migration instructions and
the [Node upgrade policy](docs/runbooks/operations.md#upgrade-and-compatibility-policy).
Changing a code link alone cannot undo a database migration.

## Test an unreleased installer

For a reviewed commit that contains this installer, use `--ref` with its full
40-character commit SHA. This explicitly opts into unreleased source; it does
not pass the immutable-release check. Use a separate installation home, an
unused port, and disposable accounts. Do not point a preview at an existing
installation's state or live tunnel.

From a clean, committed checkout containing the installer:

```sh
bash scripts/install-node.sh \
  --source "$PWD" \
  --home "$HOME/.chickpea-node-preview" \
  --port 3300 \
  --tunnel ngrok \
  --no-start
```

`--source` requires Git and exports committed files only. Neither untracked
credentials nor local dependencies are copied. `--source`, `--ref`, and
`--version` are mutually exclusive. Contributor tests and builds must also
follow the host reservation instructions in [CONTRIBUTING.md](CONTRIBUTING.md).
The command prompts for a disposable ngrok account's dev domain and authtoken.
Use `--origin ... --tunnel external` instead for an existing disposable HTTPS route.

The bootstrap supports macOS first. Linux can use the manual Node and systemd
instructions in [operations](docs/runbooks/operations.md); this installer does
not claim Linux or Windows acceptance.
