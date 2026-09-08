# Updating Chickpea

Owners can open **Settings → About & updates** to see the installed application
version, check for a release, review its notes, and copy an exact upgrade command.
The browser does not hold Cloudflare deployment credentials or install updates.
Nothing updates automatically. The CLI makes the final compatibility decision.

## First-time command setup

Use Node 24.20.0 from `.nvmrc`, Git, and your normal Cloudflare account access.
Download or clone the official `v0.1.8` source release into a dedicated tooling
directory, then run:

```sh
git clone --branch v0.1.8 --single-branch https://github.com/pejmanjohn/chickpea.git chickpea-upgrades
cd chickpea-upgrades
nvm install && nvm use
npm ci
npx wrangler login
npm run upgrade -- --configure --account YOUR_ACCOUNT_ID --worker YOUR_EXISTING_WORKER --profile core --url https://YOUR_CHICKPEA_HOST
```

v0.1.8 supports guided upgrades from v0.1.7. For older installations, use
current tooling to apply each intermediate release in order:
v0.1.0 → v0.1.1 → v0.1.2 → v0.1.3 → v0.1.4 → v0.1.5 → v0.1.6 → v0.1.7 → v0.1.8. Only the reviewed incoming version is accepted.
The v0.1.0 launcher predates fixes for custom Worker build paths and deployment
inspection. Keep the older tooling directory and its receipts for reference;
run upgrades and recovery from the current tooling directory. This changes the
launcher only; configuring it does not change the running installation.

For a named Wrangler login, add `--wrangler-profile NAME` to the configure
command. This is distinct from `--profile core`. The chosen login is retained
for inspection, deployment, resume, and recovery in temporary source directories.
Directory-bound Wrangler activation alone does not cover those directories.

Guided upgrades currently support the `core` profile only. Sandbox installations
require the existing [Sandbox deployment procedure](coding-sandbox-deployment.md);
version upload does not build or update their container image. The command
inspects the selected existing Worker and records its account, name, profile,
existing HTTPS origin, and resource identities privately under `~/.chickpea/upgrades/`. It never creates
a Worker or database. For multiple deployments, add `--installation NAME` to
configure and subsequent commands. There is no implicit fallback to `chickpea`.

If Cloudflare Builds still deploys on pushes to your old fork/branch, disable
that deployment trigger before switching to this process. Otherwise a later
push could silently replace the version installed by the upgrade command.
Keep the old source and configuration for investigation; do not delete them.

## Review and upgrade

Run the command from the tooling directory. The version below is illustrative;
copy the actual destination shown in Settings.

```sh
npm run upgrade -- --to v0.1.8 --preflight
npm run upgrade -- --to v0.1.8
```

The command verifies the exact immutable official GitHub release and tag commit,
fetches clean source privately, checks the installed release's identity and
declared compatibility, and builds with the lockfile. It shows the account,
Worker, profile, installed version, destination, and private receipt path.
Type the displayed Worker name to proceed. Preflight never deploys.

The first updater supports only explicitly reviewed transitions with unchanged
D1, Durable Object, identity, configuration, and work-storage migration content.
The initial release has no incoming supported origins. Equal digests alone are
insufficient: a destination must name the installed version in `supportedOrigins`
and its maintainer must have completed the populated upgrade/recovery test.

During deployment the wrapper checks the current Worker again, preserves its
AUTH_DB and Durable Object identities, supported plain variables, existing
secrets, and setup authority, and verifies readiness at the recorded origin. It uploads a Worker version, rechecks the serving installation, then activates that exact version at 100% traffic. It does not deploy triggers or synchronize authored observability, logpush, or tail consumers. Existing routes, domains, crons, and those settings remain in place. Wrangler may synchronize service and environment tags during version upload. It does not apply schema
changes, replace encryption keys, or print another setup link. A split deployment,
unknown binding/variable, missing authority, changed identity, or schema mismatch
stops the command. Review unsupported configuration explicitly; do not delete it
just to make preflight pass. Plaintext credentials must be moved to Cloudflare
secrets through your ordinary credential-management procedure first.

The literal supported-variable list is in
`scripts/lib/upgrade-installation.mjs`. It covers the documented Slack, gateway,
provider endpoint/credential-label, Composio, telemetry, and usage settings.
Secrets remain opaque names and are retained by the guarded deployment path.
Custom resource classes and external Durable Object ownership are unsupported. A release introducing new plain variables is refused before deployment; upgrade tooling must explicitly support that transition first.

After success, reload Settings, sign in, and send a real Slack request. Confirm
existing connections and any schedules you rely on. Readiness verifies deployment
activation; it cannot establish every application journey by itself.

## Interrupted update or recovery

Keep the printed receipt and its neighboring private source directories. They
contain target coordinates, configuration, and a recovery capability. They are not a data backup. Do not publish
them. The browser's separately previewed support report is safe to review/copy;
it omits those private deployment details and credentials.

```sh
npm run upgrade -- --resume /absolute/path/printed/by/the/command/receipt.json
npm run upgrade -- --recover /absolute/path/printed/by/the/command/receipt.json
```

Resume re-inspects the serving Worker. It accepts the recorded previous version
or a recorded destination upload; a different/unrecorded deployment stops for
investigation. A verified completed upload does not need another deployment.
Otherwise the command rebuilds the verified source and asks for confirmation.
If source download was interrupted before either checkout was verified, preserve
that incomplete receipt and start a new exact-version command.

For v0.1.8, run both upgrade and recovery from the v0.1.8 tooling checkout.
Older updaters reject this release's recovery policy before deployment. The new
updater registers a recovery capability during authenticated readiness and keeps
it in the private receipt. Before restoring v0.1.7, recovery authenticates to the
serving candidate and switches the gateway back to socket delivery. It requires a
healthy current-version socket before deploying the previous code. Recovery first
tries that hook even if HTTP readiness failed. If the recovery authority is
missing, it redeploys the retained candidate to register it and retries the hook;
successful HTTP activation is not a prerequisite for restoring socket delivery.
A new upgrade receipt explicitly restores HTTP delivery after a rollback; retrying
the recovery receipt keeps socket delivery. Deployment activation time and Worker
version establish ownership of transport changes. Both the installation and
gateway reject stale owners, so an older in-flight request cannot undo a newer
upgrade. Conflicting activation order fails closed.
An unavailable recovery endpoint
stops recovery before any downgrade. Preserve
the receipt and repair the candidate; a raw Cloudflare version rollback alone
can leave Slack routed to an HTTP endpoint that old code cannot receive.

Recover then deploys the retained previous release's code with the same resources
and credentials. It works independently of Admin. It is permitted only for this
unchanged-storage transition and a recognized recorded serving state. It does
not undo application writes, restore deleted data, or roll back schemas. A failure
after upload may already be serving new code; never infer the serving version
from the process exit code. If the upload ID was not recorded, inspect Cloudflare
and preserve evidence before attempting another deployment.

Cloudflare application state spans D1 and Durable Objects. Chickpea currently
has no complete cross-store snapshot/restore tool. Releases requiring state
migration need a separately designed and tested recovery procedure before this
updater can support them. See [operations](operations.md).

## Existing unversioned installations

An experimental deployment or unknown source is not automatically v0.1.0.
Setting `CHICKPEA_APP_VERSION` in the dashboard does not establish provenance.
The command refuses adoption without a serving source that matches the official
release and a compatible resource/schema inventory.

Preserve the current source, built artifact, Cloudflare serving version, complete
resource identities, schema inspection, and recoverable credential roots. Have
the maintainer compare the exact source/artifact against the reviewed release
and rehearse preservation on a populated disposable installation. Adopt through
the reviewed guarded deployment only after that evidence establishes
compatibility. If the source cannot be established, stop; there is no `--force`
or reset shortcut. Do not recreate a deployment containing data to obtain a
version label. A disposable installation may be replaced only with its
operator's separate authorization to lose that test data.

## Node installations and future browser updates

Node installations show version and release information but use the stopped
backup/install/restart procedure in [operations](operations.md). This Cloudflare
command does not update a Node service.

A future browser flow can reuse the release contract, preflight, and receipt
stages through a separately authorized deployment runner. No such runner,
Cloudflare Builds workflow, or browser deployment authorization is required or
enabled by this release.

## Local receipt storage

Each preflight or upgrade retains two source checkouts and their build dependencies. After verifying an upgrade and deciding that its code-recovery window is closed, you may remove that receipt directory to reclaim disk space. Keep any receipt still needed for retry, recovery, or investigation. A concurrent configuration edit can stop verification even if the newly deployed application is healthy; inspect the actual serving version before retrying.
