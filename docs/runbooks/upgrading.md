# Guided Cloudflare upgrades

The public [Cloudflare update guide](../../UPDATE_CHICKPEA_CLOUDFLARE.md) is the
coding-agent entry point. This runbook describes the updater's operating and
recovery boundaries.

Owners can open **Settings -> About & updates** to see the installed application
version and source commit, check published releases, review release notes, and
copy a coding-agent update prompt and, for a verified supported transition, its
updater command. The browser never holds Cloudflare deployment
credentials and does not install updates. Nothing updates automatically.

## Release and source selection

Run the updater from a clean checkout of the exact destination application
release. Application releases use `vX.Y.Z` tags. CLI tags, prereleases, drafts,
and `main` are not update destinations. Verify the tag commit, use the Node pin
from its `.nvmrc`, and install its lockfile with strict dependency-script policy.

The destination's `release.json` makes the compatibility decision. Its
`supportedOrigins` must include the exact installed application version, and
the serving source commit must match that official origin release. An empty
list permits no incoming update. An absent origin, unknown source, local source
change, incompatible storage generation, or unreviewed migration stops before
deployment. Matching digests alone do not establish support.

Apply intermediate application releases in order when their published metadata
defines the only supported route. Never infer a chain from version numbers.
Every transition needs its own published support and recovery evidence.

## Private target configuration

Resolve the live account, Worker, HTTPS origin, installed release and commit,
`AUTH_DB`, and resource identities from signed-in Admin, the private installation
receipt, and live Cloudflare inspection. A local checkout is not proof of the
serving target.

Inspect the saved targets under `~/.chickpea/upgrades/installations/` and reuse
an existing installation name only when its account, Worker, profile, Wrangler
login, origin, and live resource digest match the resolved deployment. Do not
edit a saved target.

When no saved target matches, configure an unused private installation name
once from the clean tooling checkout:

```sh
npm run upgrade -- --configure --installation <installation-name> --account <account-id> --worker <worker-name> --profile core --url https://<existing-origin>
```

Add `--wrangler-profile <login-name>` when the installation uses a named
Wrangler login. This login is distinct from Chickpea's `--profile core`. The
updater retains it for inspection, deployment, resume, and recovery from its
private temporary directories.

Configuration inspects the existing deployment and records its target and
resource digest. It creates no Worker, database, route, or deployment. The
updater refuses an installation name that already exists. A saved target that
does not match live state needs investigation, not editing or reconfiguration.
Use distinct installation names for distinct Workers. There is no safe target
fallback.

Keep the original installation receipt under `~/.chickpea/installs/`. It should
record the live coordinates, the source that was originally installed, and
later update receipts and source paths. Do not put credentials, recovery
capabilities, or private target details in the repository.

## Preflight

Run preflight before every transition:

```sh
npm run upgrade -- --installation <installation-name> --to <destination-release-tag> --preflight
```

The updater resolves immutable official release metadata, fetches clean origin
and destination source into a new private receipt directory, verifies both
checkouts, inspects the live Worker and `AUTH_DB` schema, checks configuration
and resources, installs dependencies under the reviewed script policy, and
builds the destination. The command prints the Worker, installed-to-destination
version transition, and absolute receipt path. Verify the saved target and live
inspection separately for the account, profile, Wrangler login, and origin.
Preflight does not deploy.

The release's `.nvmrc` is the exact Node build baseline. Use its supported npm
major. The runner rejects script suppression, conflicting script overrides,
uncovered dependency hooks, and unsupported npm. Dependency output stays out
of receipts and terminal reports because it may contain private registry URLs
or credentials. Preserve the named error code and Node/npm versions, correct
the reviewed configuration issue, then resume from the exact receipt. Do not
edit retained release source or run a blanket dependency approval.

The updater retains its source checkouts and dependencies beside the receipt.
It verifies retained source again before every retry or recovery. Missing,
partial, dirty, or replaced source stops before dependency scripts and
deployment.

## Deployment contract

Continue the successful preflight in an interactive terminal with its exact
receipt:

```sh
npm run upgrade -- --resume /absolute/path/printed/by/preflight/receipt.json
```

Review every displayed coordinate. Type the exact displayed Worker name only
when the account, Worker, profile, Wrangler login, origin, installed source,
destination source, and receipt match the requested installation.

Starting with `--installation <installation-name> --to
<destination-release-tag>` is a secondary shorthand. It creates a new receipt
and performs preparation before confirmation. Do not use it after a successful
preflight; resume the receipt already created by preflight.

Immediately before upload, the updater re-inspects the Worker and refuses
resource or identity drift. It preserves the existing `AUTH_DB`, Durable Object
identities, supported plain variables, opaque secret names, credentials, and
setup authority. It uploads a Worker version, checks the serving installation,
and activates that exact version at full traffic only after the guarded checks
pass.

The core update does not create resources, reinstall Slack, issue another setup
capability, apply schema changes, replace encryption keys, or synchronize
authored routes, domains, schedules, observability, logpush, and tail consumers.
Existing settings stay in place. Wrangler may synchronize service and
environment tags during upload.

The literal supported variable and resource rules live in
`scripts/lib/upgrade-installation.mjs`. Unknown bindings, variables, resource
classes, external Durable Object ownership, split traffic, missing authority,
changed identities, schema drift, and incompatible work storage fail closed.
Review unfamiliar configuration. Never delete it to make preflight pass.

If Cloudflare Builds or another system still deploys an old fork or branch,
disable that competing automatic writer before adopting guided updates. Keep
the old source and configuration. An unrelated later deploy can otherwise
replace a successful guarded update.

## Resume and recovery

The command prints an absolute private receipt path as soon as it begins an
attempt. Keep that exact `receipt.json` and its neighboring source directories.
A failed process may already have uploaded or activated code. Inspect the
serving version before deciding what to do.

Resume an interrupted attempt with the same destination tooling and exact
receipt:

```sh
npm run upgrade -- --resume /absolute/path/to/receipt.json
```

Resume re-inspects the serving Worker and recognizes only states recorded by
that receipt. It can reuse a verified completed upload. Otherwise it rebuilds
the verified retained source and asks for confirmation. A different deployment,
changed target, missing source, or incomplete download stops for investigation.
Do not start a second update to hide the first attempt.

When the user requests restoration and the release supports it, recover with
the same tooling and receipt:

```sh
npm run upgrade -- --recover /absolute/path/to/receipt.json
```

Recovery authenticates to the serving candidate when the declared transition
requires a delivery-mode handoff, restores eligible previous code with the same
resources and credentials, and verifies the recorded serving state. It works
without Admin only within that reviewed recovery contract. A raw Cloudflare
version rollback can leave Slack routed to a transport the old code cannot
receive, so it is not a substitute.

Recovery does not undo application writes, restore deleted data, or roll back
schemas. Cloudflare application state spans D1 and Durable Objects, and Chickpea
does not have a complete cross-store snapshot and restore command. A receipt is
recovery authority and deployment evidence, not a data backup. A transition
that changes state needs a separately reviewed migration and recovery procedure
before it can appear in `supportedOrigins`.

The v0.1.18 release contract declares no incoming guided upgrade paths. Its
v0.1.17 rehearsal upgraded successfully, but recovery to the immutable
published v0.1.17 code could not continue an existing timezone-bearing
conversation when it returned to a prior runtime plan. Candidate code cannot
make that previous-code recovery safe for future turns. The v0.1.16 path also
remains undeclared. Stop and request a reviewed path; no guided intermediate
path is currently declared.

## Acceptance and handoff

After success, verify the destination release and full source commit in
signed-in Admin. Send a real Slack request to an existing Agent and verify the
expected reply. Confirm known memory when it exists. If a connection exists,
exercise a harmless example with a read-only request. If a schedule exists,
check that it still has the same definition, destination, enabled state, and
next run, then observe its normal delivery or a harmless test when practical.
Report memory, connection, or schedule as not configured when none exists. An
optional item's absence does not fail an otherwise valid update. Readiness and
a Worker upload ID do not establish these product behaviors.

Update the private installation receipt with the serving application release
and commit, Cloudflare Worker version ID, exact update receipt, clean tooling
checkout, and retained destination source path. The original clone is now a
launcher and historical record. Point its private installation notes at the
retained source matching the live release, and use that source for later
troubleshooting. Never copy over customized or historical source.

Retain every receipt needed for resume, recovery, or investigation. After the
user decides a verified transition's recovery window is closed, they may remove
that receipt directory to reclaim disk space.

## Unsupported installations

An unversioned, unknown, or customized deployment is not an official release.
Setting a version variable in Cloudflare does not establish provenance. Preserve
its source, built artifact, serving Worker version, resource identities, schema,
configuration, and credential roots. Adoption requires a maintainer-reviewed
source and artifact comparison plus a populated disposable rehearsal. If that
evidence cannot establish compatibility, stop. There is no force, reset, or
recreate shortcut for an installation that contains user data.

Node-hosted Chickpea uses the stopped backup, install, and restart procedure in
[operations](operations.md). The Cloudflare updater does not update a Node
service. A Cloudflare coding sandbox also follows the separate
[sandbox deployment procedure](coding-sandbox-deployment.md) for its container
image; a core Worker update does not build or update that image.
