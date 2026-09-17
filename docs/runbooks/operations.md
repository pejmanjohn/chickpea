# Operating and upgrading Chickpea

This guide covers a single-host Node deployment and the existing Cloudflare
deployment wrapper. For a first-time production Mac installation, use
[Install Chickpea on a Mac with Node](../../INSTALL_CHICKPEA_NODE.md). For
first-time Slack setup, use [SETUP_AGENT.md](../../SETUP_AGENT.md).

## Production Node

Use Node 24.x, minimum 24.20.0, and one running Chickpea process per state directory.
Use the 24.20.0 baseline in `.nvmrc` for reproducible installs and verification.
Later Node 24 updates are supported; other majors are outside the support policy.

Node supports scheduled execution while the Chickpea process is running, but not
the coding sandbox. The shared Slack app delivers over an outbound socket. Node
saves each delivery to the installation's SQLite inbox before acknowledging it,
then processes it asynchronously and resumes pending work at startup. The public
HTTPS address serves setup, sign-in, connector callbacks, and Admin links. A
customer-owned Slack app instead sends events to that public address. See
[gateway data handling](../shared-gateway-data-handling.md).

### Build a release

For a new Mac installation, the [Node installer](../../INSTALL_CHICKPEA_NODE.md)
automates the runtime, release build, private settings, and setup launch. Its
`chickpea-node` command is separate from the `chickpea` remote-management CLI.
The manual instructions below remain useful for existing installations and
Linux hosts.

Check out the release tag you intend to run, then install its exact lockfile and
build the production entry point:

```sh
npm ci --strict-allow-scripts
npm run flue:build
```

Run production through `npm run start:node -- --env-file <path>`, not the Vite
development server. The wrapper validates Node, loads only the explicitly named
environment file, and imports Flue's non-listening `dist/app.mjs` artifact so it
can bind to `HOST` (default `127.0.0.1`) and `PORT` (default `3000`). Existing
process environment values take precedence over values in the file. Keep the
release checkout, its `node_modules`, `migrations/`, and `assets/` available at
runtime.

The production wrapper starts the scheduler after Flue finishes assembling its
runtime. It checks for due work immediately and every minute, using the same
missed-slot policy as Cloudflare. A stopped or sleeping computer is not woken;
the startup check recovers eligible missed work when Chickpea runs again. The
wrapper also retries durable Slack schedule actions and performs Work and image
retention maintenance. Starting a second production launcher against the same
state database is refused before the app runtime starts. The development server
and raw `dist/server.mjs` entry do not participate in this guard; never run them
against a production installation's state.

### Persist state and secrets

Create a dedicated OS account, a private state directory such as
`/var/lib/chickpea`, and a protected runtime environment file such as
`/etc/chickpea/runtime.env`. Make the state directory writable only by that
account; use mode 0700 for the directory and 0600 for the environment file.
Do not put state inside a checkout that will be replaced during upgrades.

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
TAG_DB_PATH=/var/lib/chickpea/transcripts.sqlite
SLACK_STATE_DB_PATH=/var/lib/chickpea/state.sqlite
CHICKPEA_AUTH_DB_PATH=/var/lib/chickpea/auth.sqlite
CHICKPEA_CREDENTIAL_KEYRING_PATH=/var/lib/chickpea/credential-keyring.json
CHICKPEA_AUTH_SECRET=REPLACE_WITH_A_STABLE_RANDOM_SECRET
SLACK_TAG_PUBLIC_URL=https://chickpea.example.com
```

Generate the auth secret **once** with `openssl rand -base64 32 | tr '+/' '-_' |
tr -d '='` and save it in the protected file. Never regenerate it on each start.
The credential keyring is created on first use at mode 0600; preserve it along
with every database. Losing encryption keys makes stored credentials unusable.
For the initial setup, run `npm run setup:link -- https://chickpea.example.com`
and add its digest and issued-at variables to the environment file. Keep the
private setup link out of logs and source control.

The explicit paths above avoid these development defaults:

| Data | Default path |
| --- | --- |
| Conversation transcripts | `./tmp/flue.db` |
| App state, identity, claims, configuration | `<TAG_DB_PATH>.state` |
| Better Auth sessions and accounts | `<SLACK_STATE_DB_PATH>.auth` |
| Slack credential encryption keys | `<SLACK_STATE_DB_PATH>.credential-keyring.json` |

Those derived defaults use the resolved state path when no override is set.
Never use `:memory:` for a production database.

### Run under a supervisor

For systemd, adapt these paths to your host. `/usr/bin/node` must be the supported
Node binary, and `/opt/chickpea/current` must point to the intended release.

```ini
[Unit]
Description=Chickpea Slack agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=chickpea
Group=chickpea
WorkingDirectory=/opt/chickpea/current
EnvironmentFile=/etc/chickpea/runtime.env
ExecStart=/usr/bin/node scripts/start-node.mjs --env-file /etc/chickpea/runtime.env
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=75
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/chickpea

[Install]
WantedBy=multi-user.target
```

The production entry point handles SIGTERM, stops and drains the scheduler before
Flue, and waits for shutdown with a 60-second internal deadline. Production
launchers enforce one process per state database. Do not use a network filesystem
as a substitute for shared-state support.

Terminate HTTPS at a reverse proxy and forward to port 3000. Keep the default
loopback binding when the proxy runs on the same host. If the proxy requires a
different interface, set `HOST` deliberately and use firewall/container network
rules to make the Node port unreachable from the public internet.
Preserve the public host and HTTPS scheme through the proxy, avoid request-body
logging, and configure streaming rather than buffering Slack-related responses.
Complete Slack setup using the exact HTTPS origin. Verify sign-in, a real Slack
reply, and state surviving a service restart before routing normal traffic.

### Operate an installer-managed Mac

The [Mac installer](../../INSTALL_CHICKPEA_NODE.md) creates a separate home at
`~/.chickpea-node`. It keeps a private Node runtime and complete release source
under `tools/` and `releases/`, with persistent databases and the credential
keyring under `state/`. `runtime.env` holds the stable authentication secret.
The `current` link identifies the installed code. It does not adopt a manual
installation from `~/Library/Application Support/Chickpea/node`.

```sh
"$HOME/.chickpea-node/bin/chickpea-node" start
"$HOME/.chickpea-node/bin/chickpea-node" status
"$HOME/.chickpea-node/bin/chickpea-node" stop
```

`start` runs in the foreground. It manages the application and an optional
Cloudflare Tunnel connector as one lifetime and drains them on shutdown.
Use another Terminal for status and stop. An external proxy remains separately
operated. Logs and setup material are private files inside the installation.

`service install` opts into a per-installation macOS LaunchAgent; `service
uninstall` removes it. Stop foreground operation before enabling it. The agent
starts at login and restarts on failure. It cannot run while the Mac is asleep
or before login. Its absolute private-Node path avoids dependence on nvm and
shell startup settings.

The installer sanitizes the application child environment so shell variables
cannot override its private runtime file. This differs from a direct invocation
of `start:node`, which intentionally lets ambient variables take precedence.
To change managed runtime settings, stop the installation and edit its private
file deliberately. Do not change its state paths, origin, or port independently
of its installation configuration and HTTPS route.

Reruns reuse the same release and settings. The installer refuses a different
release for existing state; it is not an updater. Use the release's migration
instructions and the stopped-backup procedure below. Installing a preview into
a separate home proves neither a safe upgrade nor live Slack acceptance.

### Run an existing manual installation on macOS

Keep the original release checkout and private environment file. To start an
installation created with the earlier manual guide, run its built release:

```sh
npm run start:node -- \
  --env-file "$HOME/Library/Application Support/Chickpea/node/runtime.env"
```

This direct launcher does not install a LaunchAgent or start at login. Keep the Mac awake,
and keep both this launcher and the HTTPS tunnel running. Stop the launcher with
Control-C and wait for its graceful shutdown before closing the Terminal. Reuse
the same environment file and authentication secret for every restart.

### Recover a stale Node process owner

After an unclean exit, the launcher automatically replaces an owner whose PID
no longer exists. If the operating system reused that PID, or the service account
cannot inspect it, startup refuses to take over. It does not assume another
process is safe to displace.

Inspect `owner_pid`, `owner_token`, and `acquired_at` in the state database's
`chickpea_node_runtime_owner` table. Use `ps` to identify that PID and `lsof` to
check which processes have the configured SQLite files open. If Chickpea is
running, stop it through its owning supervisor. If process access is denied,
resolve the service account permissions before proceeding.

Only after verifying that no Chickpea process is using this installation, back
up the stopped state directory and remove the exact stale row. Substitute the
observed PID and token; do not delete the database or clear an unverified owner:

```sql
DELETE FROM chickpea_node_runtime_owner
WHERE singleton = 1 AND owner_pid = <observed_pid>
  AND owner_token = '<observed_token>';
```

Restart using the production launcher and the same environment file.

### Back up and restore Node

1. Schedule an interruption, pause work where supported, and stop new ingress.
   Let active work finish, then stop the Chickpea service.
2. Snapshot the **whole state directory** while stopped, including any SQLite
   `-wal`/`-shm` files and the credential keyring. Back up the runtime environment
   file and record the exact release/commit separately. Copying only the main
   SQLite files while the service is running is not a consistent backup.
3. Encrypt backups, restrict access, and set a retention policy appropriate for
   the Slack content and credentials they contain. Do not attach them to issues.
4. Test restoration on an isolated host with outbound traffic disabled. Restore
   all databases and keys from the same snapshot, with the same secret and code
   version. Confirm SQLite integrity before allowing any Slack/provider traffic.

For a production restore, stop ingress and the service before replacing state.
Do not allow the old and restored copies to answer Slack simultaneously. A
restore rolls state back in time and may lose recent work or replay events;
reconcile that interval before reopening ingress. A backup is not proven until
its restore has been tested.

## Cloudflare operations

Use `npm run deploy` for core or `npm run deploy:sandbox` for the optional coding
sandbox. These wrappers check the generated artifact, preserve the deployed
`AUTH_DB` identity and credential roots, apply reviewed migrations, and check
readiness. Do not bypass them with bare `wrangler deploy`.

On a machine that operates claimed QA lanes (one with a registry under
`~/.chickpea/environments`), the wrapper refuses a deploy that names no target.
Set `CHICKPEA_DEPLOY_TARGET=amber` or `cobalt` for a claimed lane, or
`CHICKPEA_DEPLOY_TARGET=production` to deploy the ordinary `wrangler.jsonc`
Worker on purpose. Self-hosters, Workers Builds, and `--dry-run` are unaffected.

The same deployment includes the public images in `assets/` using Cloudflare
Static Assets. No separate Worker or bucket is needed. Keep the generated
`ASSETS` binding and asset directory in the deployment configuration. These
files are public product images, not user uploads or document-processing code.

Record the account, Worker name, deployed version, traffic allocation, bindings,
and source commit. For a customer update, verify the serving version and
signed-in Admin. Send Slack test messages only when the user requests them.
Development and release QA follow their separately authorized live checks.

Cloudflare stores app/runtime state in Durable Objects as well as auth data in
D1. Backing up or restoring `AUTH_DB` alone does **not** back up or restore the
whole application. Chickpea does not currently provide a complete cross-store
snapshot/restore tool. Keep credential secrets recoverable and follow the
specific release's migration/recovery procedure; stop if it requires a recovery
capability you have not established. Read the [AUTH_DB contract](auth-db-deployment.md).

## Upgrade and compatibility policy

For routine Cloudflare updates, follow the
[coding-agent update guide](../../UPDATE_CHICKPEA_CLOUDFLARE.md). Preserve the
installation's live settings in the release checkout and run `npm run deploy`.
The `supportedOrigins` list and recovery requirements belong to the optional
[receipt-based updater](upgrading.md); they do not block ordinary updates.
Review required migrations and preserve existing data. Rollback support is not
a prerequisite for a forward update.

Before the first tagged release, older experimental schemas may be incompatible.
That is not permission to delete a production database. A disposable pre-release
installation may be recreated only when its operator explicitly accepts losing
its data.

The first release establishes the versioned baseline. During 0.x, releases may
change APIs, configuration, or schemas. Release notes must state supported
starting versions, required operator actions, migrations, and rollback limits.
There is no implied upgrade path from an unlisted experimental schema.

For Node upgrades:

1. Read the destination release notes and confirm the starting version is
   supported. Record the current source/version and deployment configuration.
2. Establish a tested recovery point using the stopped backup procedure above.
3. Rehearse on an isolated copy or approved disposable environment. Preserve
   state paths, the auth secret, encryption keys, and existing resource IDs.
4. Stop/drain traffic as required. Install/build the new checkout and restart
   the supervised service against the same state paths.
5. Verify sign-in and the serving version. Send Slack messages or run other
   product checks only when the user requests them.

Do not edit already-applied migration SQL: its digest is part of the auth
database contract. Add a forward migration and test both fresh creation and
upgrade from the preceding supported release. Reverting code does not undo a
schema migration or recover deleted data. Downgrade only when the release notes
declare it safe; otherwise use the tested full recovery procedure or a forward
fix. Never silently reset an incompatible database to make an upgrade pass.

## Build-time Node and Cloudflare runtimes

Cloudflare Workers Builds reads `.nvmrc`; an explicit `NODE_VERSION` build
variable should match its 24.20.0 pin. Inspect existing build overrides before
building a candidate. These are build settings, not Worker runtime variables.
See [Cloudflare's build image documentation](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/).

A Worker runs in workerd with its own `compatibility_date` and flags. Changing
Node does not change that runtime or remove artifact, workerd, or Slack acceptance.
See [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/).

The optional coding sandbox uses Cloudflare's `sandbox:0.12.4` container, whose
embedded Node 22.23.1 runs sandbox tooling, not the Chickpea host or build. Its
image tag must match `@cloudflare/sandbox`; leave this vendor-owned runtime alone
when updating Chickpea's Node pin. Validate SDK/image updates separately.

### Schedule account requirements during edits

A saved schedule revision cannot run until its account requirements have been
bound to that revision. Pause and resume retain the saved binding. An unbound
revision may mean an edit is still running or that binding failed; waiting alone
does not repair a failed edit. Retry the original durable action, or submit a
fresh edit declaring the exact required accounts (`requiredConnectionAccountIds`,
including `[]` for connection-free work). Use the intended accounts, not extra
accounts to bypass the check. This repairs the binding but preserves an existing
pause; resume only after the underlying failure is resolved.

A due run can encounter the short save-to-bind window and pause the schedule for
missing authority. A later successful bind intentionally does not clear a
`needs_attention` reference: the same state can represent other authority
failures. After binding has completed and the actor, Agent, destination and
connections are available, repair Channel schedule authority through the existing
authenticated Admin route
`POST /admin/api/agents/:id/schedules/:scheduleId/reassign`. The Runs as member
must be signed in as an Agent editor; supply their own `runsAsMembershipId` and
the current `expectedAuthorityRevision`. Omit account IDs to retain the existing
exact set, or explicitly supply its intended replacement. The route revalidates
authority and resumes only recognized authority-related pauses. It does not
repair an unbound saved revision, so complete the binding repair first.

For a private DM schedule, the owner can ask Chickpea to reassign its owning
Agent through the existing `reassign_routine_agent` operation, retaining the same
Agent if appropriate, then resume the schedule. Private schedules are excluded
from the Channel Admin repair route. Do not clear a pause or edit state records
directly to skip these checks.

Existing schedules retain their saved account requirements. Cloning requires
the source schedule's saved requirements; a legacy source without an authority
reference must be repaired before cloning. Unexpired pre-upgrade create/edit
confirmation receipts cannot supply the current account requirements. Request
a fresh create or edit instead; rejecting the old receipt does not change the
schedule. Deletion confirmations continue to work.
