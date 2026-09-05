# Operating and upgrading Chickpea

This guide covers a single-host Node deployment and the existing Cloudflare
deployment wrapper. For first-time Slack setup, use [SETUP_AGENT.md](../../SETUP_AGENT.md).

## Production Node

Use Node 24.x, minimum 24.20.0, and one running Chickpea process per state directory.
Use the 24.20.0 baseline in `.nvmrc` for reproducible installs and verification.
Later Node 24 updates are supported; other majors are outside the support policy.

Node does not support scheduled execution or the coding sandbox. Use your own Slack
app: the Node shared-gateway path does not yet have Cloudflare's durable event
admission guarantee. See [gateway data handling](../shared-gateway-data-handling.md).

### Build a release

Check out the release tag you intend to run, then install its exact lockfile and
build the production entry point:

```sh
npm ci
npm run flue:build
```

The entry point is `dist/server.mjs`, not the Vite development server. Keep the
release checkout, its `node_modules`, `migrations/`, and `assets/` available at runtime.
The built server reads runtime environment variables; it does not automatically
load your development `.env` file.

### Persist state and secrets

Create a dedicated OS account, a private state directory such as
`/var/lib/chickpea`, and a protected runtime environment file such as
`/etc/chickpea/runtime.env`. Make the state directory writable only by that
account; use mode 0700 for the directory and 0600 for the environment file.
Do not put state inside a checkout that will be replaced during upgrades.

```dotenv
NODE_ENV=production
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
ExecStart=/usr/bin/node dist/server.mjs
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

The production entry point handles SIGTERM and waits for shutdown, with a
60-second internal deadline. Do not run several processes against these SQLite
files or use a network filesystem as a substitute for shared-state support.

Terminate HTTPS at a reverse proxy and forward to port 3000. The current entry
point exposes `PORT`, not a `HOST` environment setting, so use firewall/container
network rules to make the Node port unreachable from the public internet.
Preserve the public host and HTTPS scheme through the proxy, avoid request-body
logging, and configure streaming rather than buffering Slack-related responses.
Complete Slack setup using the exact HTTPS origin. Verify sign-in, a real Slack
reply, and state surviving a service restart before routing normal traffic.

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
and source commit. A successful upload is not acceptance: verify the signed-in
Admin and an actual Slack request routed through that deployment.

Cloudflare stores app/runtime state in Durable Objects as well as auth data in
D1. Backing up or restoring `AUTH_DB` alone does **not** back up or restore the
whole application. Chickpea does not currently provide a complete cross-store
snapshot/restore tool. Keep credential secrets recoverable and follow the
specific release's migration/recovery procedure; stop if it requires a recovery
capability you have not established. Read the [AUTH_DB contract](auth-db-deployment.md).

## Upgrade and compatibility policy

Before the first tagged release, older experimental schemas may be incompatible.
That is not permission to delete a production database. A disposable pre-release
installation may be recreated only when its operator explicitly accepts losing
its data.

The first release establishes the versioned baseline. During 0.x, releases may
change APIs, configuration, or schemas. Release notes must state supported
starting versions, required operator actions, migrations, and rollback limits.
There is no implied upgrade path from an unlisted experimental schema.

For each upgrade:

1. Read the destination release notes and confirm the starting version is
   supported. Record the current source/version and deployment configuration.
2. Establish a tested recovery point. For Node, use the stopped backup procedure
   above. For Cloudflare, follow the release-specific procedure for **all**
   affected stores, not just D1.
3. Rehearse on an isolated copy or approved disposable environment. Preserve
   state paths, the auth secret, encryption keys, and existing resource IDs.
4. Stop/drain traffic as required. On Node install/build the new checkout and
   restart the supervised service against the same state paths. On Cloudflare
   use the guarded deployment wrapper.
5. Verify sign-in, existing Agents/connections, a real Slack reply, and the
   relevant schedule/memory behavior before declaring success.

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
