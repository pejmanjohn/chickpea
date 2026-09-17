# Install Chickpea on a Mac

The Node installer prepares Chickpea on one Mac with private SQLite state. It
downloads Node 24.20.0, builds a versioned application release, creates the
runtime settings and setup link, then starts Chickpea and opens your browser.
You do not need nvm, Homebrew, a global npm package, or a Cloudflare Worker.

The guided ngrok option provides an account-assigned public HTTPS address without
buying a domain or using Cloudflare. You sign in to ngrok and authorize Slack and
your model provider. Slack must be able to reach the Mac through that address.
Keep the Mac awake and connected. Scheduled work runs only while Chickpea is
running. Node does not include the Cloudflare coding sandbox.

## Before you start

- Use an Apple Silicon or Intel Mac with internet access and enough disk space
  for Node, application source, dependencies, and persistent data.
- Use a Slack workspace where you can create and install an app. The Node
  installation requires your own Slack app.
- Have a supported model provider account or API credential ready.
- Choose one of the [HTTPS options](#choose-an-https-route) below.

Mac installation is supported starting with v0.1.21. The default command uses
the latest stable application release. Installing the management CLI from npm
does not install the application.

Guided ngrok setup is new on `main` and is not included in v0.1.21. Until an
application release includes it, use the [preview procedure](#test-an-unreleased-installer)
with a reviewed commit containing this change. The bootstrap refuses ngrok mode
when the selected application release does not support it.

## Install

Run this command in Terminal as your usual user, without `sudo`:

```sh
curl -fsSL https://chickpea.co/install.sh | bash
```

With a release that includes guided ngrok setup, the installer offers ngrok
first, then Cloudflare Tunnel and an existing HTTPS route. It opens the ngrok
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
or permanently renewable free service. If a limit is reached, Slack events,
callbacks, and Admin may become unavailable. Choose a suitable paid plan or a
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

Follow [the customer-owned Slack app setup](SETUP_AGENT.md):

1. Choose **Create the Slack app** and supply a short-lived Slack configuration
   token. Chickpea creates the app from its reviewed manifest.
2. Install the app in your workspace and verify its Events URL.
3. Sign in with Slack to become the first Owner.
4. Choose a provider and model.
5. Send a direct message to `@Chickpea`, confirm its reply, and sign in to Admin.

These are account choices and authorization steps. The shell installer does
not grant itself Slack or model-provider access. This flow uses Slack's HTTP
Events API and does not require an app-level `xapp-` token.

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

Status checks show process and HTTP availability and return a failing exit code
when the public route is unavailable. They do not prove that Slack
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
