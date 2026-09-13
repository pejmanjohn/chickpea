# Update Chickpea on Cloudflare

You are the updating agent. Carry out this workflow with terminal and browser
or computer-use tools. Start in the Chickpea folder the user opened, but do not
assume that folder matches the code running on Cloudflare. Inspect the private
installation receipt and the live Worker before choosing a target or source.

Update the existing Cloudflare core installation to the newest stable Chickpea
application release that explicitly supports its installed release. Preserve
the existing Cloudflare account, Worker, D1 database, Durable Objects, routes,
domains, triggers, credentials, Slack identity, configuration, application
data, Agents, memory, connections, and schedules. Finish with a real Slack
reply, signed-in Admin, and checks of the existing behavior the user relies on.

This guide covers Chickpea running on Cloudflare Workers with the `core`
deployment profile. Node.js on the user's computer runs the update tools. It
does not change a Node-hosted Chickpea service. A Cloudflare installation with
the optional coding sandbox needs the separate sandbox procedure for its
container image; do not treat this core update as a sandbox update.

## How to run this update

Apply this guide only when the user asks to update an existing installation. A
request to read or edit the guide does not authorize a deployment. The update
request includes live inspection, local preflight, the guarded update against
the resolved Worker, its ordinary interactive confirmation, and the acceptance
checks below. Type the displayed Worker name at the confirmation prompt after
you verify every displayed coordinate. Do not ask the user to repeat that
authorization. Honor any separate approval required by your tools.

Use the tools you have. Keep credentials, target coordinates, private receipts,
logs, Slack content, and screenshots with private data out of the repository
and public reports. Ask the user to take over for passwords, one-time codes,
passkeys, CAPTCHA, billing changes, or another step that requires their
presence. Keep the exact page or terminal ready and resume afterward.

Do not run setup again, create another Worker or database, reinstall the Slack
app, claim a new Owner, rotate credentials, or change providers to make an
update pass. Do not replace the guarded updater with `git pull` and deploy,
bare Wrangler, a dashboard upload, edited release metadata, removed bindings,
or a force flag. If no supported path exists, leave the working installation
alone and report the exact blocker.

## 1. Identify the installation

Inspect the current folder before changing it:

```sh
pwd
git remote -v
git status --short
git describe --tags --always
git rev-parse HEAD
```

Preserve local changes. The folder may be the original installation checkout,
an old release, a fork with custom code, or an unrelated clone. It is evidence,
not proof of the live target. Do not pull, switch branches, install dependencies,
or deploy from it yet.

Find the private installation receipt created during setup, normally under
`~/.chickpea/installs/`. Read it locally and keep its contents private. It should
name the source checkout and commit, Cloudflare account ID, Worker name, `core`
profile, public HTTPS origin, D1 identity, Slack workspace and app, and installed
application release. If several receipts or Workers could match, ask the user
which installation to update before any mutation.

Open signed-in **Settings -> About & updates** for the receipt's public origin.
Record the installed application release and full source commit. Inspect the
same account and Worker with Wrangler, using the named login from the receipt
when one exists. Confirm the serving version, public origin, `AUTH_DB`, and
resource identities agree with both Admin and the receipt. A local clone,
Worker name, or successful login alone does not establish the target.

Stop if you cannot establish one exact account, Worker, origin, installed
release, source commit, and database identity. Preserve an unknown, unversioned,
or customized installation for investigation. Do not assign it a release label
or overwrite it with official source.

Before deployment, record a safe baseline in the private receipt for an
existing Agent. If memory, connections, or schedules are configured, choose
harmless meaningful examples with your best judgment. Record the schedule's
definition, destination, enabled state, and next run without copying private
content into public notes. Do not stop for another routine choice.

## 2. Select clean update tooling

List the official published releases and choose the newest stable application
release with a tag shaped like `vX.Y.Z` that supports the installed version.
Ignore `cli-v*` tags, prereleases, drafts, and the `main` branch. Read the
destination release notes and its `release.json`. The installed version must
appear in `supportedOrigins`. Follow documented intermediate releases in order
when the newest release does not support a direct transition.

Verify that GitHub marks the selected release immutable, then resolve its exact
tag commit and read the manifest at that commit. Verify the installed release
against its own immutable official tag too. Do this before running dependency
or build commands from the selected source.

Do not claim that a release supports this installation until its published
metadata says so. An empty `supportedOrigins`, an absent origin, or unknown
source means there is no guarded update path from that source. Report this and
stop. Do not use a fresh-install path as an update workaround.

Create a separate clean checkout for the selected destination's tools. Keep it
outside the original project folder and away from other repositories. Replace
the placeholders before running:

```sh
git clone --branch <destination-release-tag> --single-branch https://github.com/pejmanjohn/chickpea.git chickpea-upgrades-<destination-release-tag>
cd chickpea-upgrades-<destination-release-tag>
git rev-parse HEAD
git status --short
nvm install
nvm use
node --version
npm --version
npm ci --strict-allow-scripts
```

Verify `HEAD` matches the official tag commit and the checkout is clean. Use
the exact Node version from this release's `.nvmrc` and its supported npm major.
An existing compatible Node manager is fine. Do not replace the user's global
Node. Keep strict dependency script policy. If it refuses a dependency, preserve
the error and resolve the release's reviewed policy. Do not approve every script,
disable scripts, or edit the immutable release checkout.

Keep this tooling checkout and the updater's private source directories until
the user no longer needs retry or recovery. The original folder is not the
source of truth after an update. The retained source matching the serving
release is the source to use for later troubleshooting and updates.

## 3. Configure and preflight the exact target

Authenticate Wrangler from the clean tooling checkout. Reuse the named Wrangler
login recorded for this installation. Otherwise use the user's normal login and
verify the selected account:

```sh
npx --no-install wrangler auth list
npx --no-install wrangler whoami
```

Create or activate a named login only when needed. Do not infer account access
from another checkout. Inspect the saved installation targets under
`~/.chickpea/upgrades/installations/` without editing them. Reuse an existing
installation name only when every saved coordinate and its live resource digest
match the resolved deployment.

If no saved target matches, choose an unused short private installation name
and configure it once with the verified live coordinates:

```sh
npm run upgrade -- --configure --installation <installation-name> --account <account-id> --worker <existing-worker-name> --profile core --url https://<existing-origin> --wrangler-profile <wrangler-login>
```

Omit `--wrangler-profile` when Wrangler uses the intended default login.
`--profile core` is Chickpea's deployment profile, not a Wrangler login. The
configure command inspects the existing Worker and records its target privately.
It does not deploy or create resources. It refuses an installation name that
already exists. If the saved target does not match live state, stop and
investigate. Do not overwrite, edit, or reconfigure that alias for convenience.

If Cloudflare Builds or another system can deploy the old fork or branch,
identify that competing writer before updating. Disable its automatic deploy
only with the user's authorization, or stop and explain why it could overwrite
the guarded update. Preserve the old checkout and configuration.

Run preflight for one supported destination at a time:

```sh
npm run upgrade -- --installation <installation-name> --to <destination-release-tag> --preflight
```

Before running, verify the saved target and live inspection contain the intended
account, Worker, profile, Wrangler login, and origin. Preflight prints the Worker,
installed-to-destination version transition, and absolute private receipt path.
Confirm those values match. It downloads and builds verified release source
without deploying. Keep the exact receipt and neighboring `previous` and
`destination` directories. If preflight reports unknown source, customization,
changed resources, unsupported configuration, storage mismatch, dependency
policy failure, or an unsupported origin, stop. Preserve the first failure and
do not weaken the check.

## 4. Run the guarded update

Continue the successful preflight as the same operation. Use an interactive
terminal and the exact receipt path it printed:

```sh
npm run upgrade -- --resume /absolute/path/printed/by/preflight/receipt.json
```

Review the displayed account, Worker, profile, Wrangler login, origin, serving
release and commit, destination release and commit, and private receipt. If they
match the user's requested installation, type the exact displayed Worker name.
If any value differs, decline the prompt and investigate.

A fresh `--installation <installation-name> --to <destination-release-tag>`
command is a secondary shorthand that starts a new receipt and performs its own
preparation before confirmation. Do not use it after a successful preflight;
resume that preflight receipt instead.

The updater must retain the existing supported resources, credentials, setup
authority, configuration, and data. Let it refuse anything outside its reviewed
contract. Do not delete an unfamiliar variable or binding to get past preflight.
A failed command may already have uploaded or activated code, so inspect the
live serving version before retrying.

If the update stops, use only the exact absolute receipt printed by that run:

```sh
npm run upgrade -- --resume /absolute/path/to/receipt.json
```

Resume rechecks the target and retained source. Do not start a second update to
replace an interrupted one. If the user asks to restore the previous eligible
code, use the same receipt and selected tooling checkout:

```sh
npm run upgrade -- --recover /absolute/path/to/receipt.json
```

Choose resume or recovery for the actual serving state. Do not run both in
sequence. Recovery is available only when the release declares and verifies
that path. It restores eligible previous code. It does not undo application
writes, restore deleted data, roll back schemas, or replace a data backup. If
recovery refuses, preserve the installation and receipt for investigation.

## 5. Verify the installed result

First confirm Cloudflare serves the destination release at the recorded origin.
Then reload signed-in **Settings -> About & updates** and verify the application
release and full source commit. An upload ID, traffic percentage, readiness
response, or unsigned Admin page does not prove the complete update.

Use the existing Slack installation and its existing data. Choose harmless,
meaningful existing examples with your best judgment, then check:

- Send a real request to an existing Agent in a channel or DM where it already
  works. Verify the reply arrives from the expected Chickpea app and Agent.
- In signed-in Admin, confirm the existing Agent remains. If it has known memory,
  confirm that memory remains. Otherwise report that no memory is configured.
- If a connection exists, exercise one with a read-only request and verify its
  result. Otherwise report that no connection is configured.
- If a schedule exists, confirm it remains enabled with the same destination and
  next run. When practical, observe its next normal delivery or run a harmless
  test without changing the schedule definition. Otherwise report that no
  schedule is configured.

Investigate any mismatch against the live target and exact request. Do not
create replacement Agents, memory, connections, or schedules to make acceptance
pass. Keep Slack messages and private account data out of public artifacts.

## 6. Retain the right source and receipts

Update the private installation receipt with the new application release and
commit, Cloudflare serving version ID, absolute update receipt path, selected
tooling checkout, and absolute retained `destination` source path. Record only
verified values and no secrets.

The folder where the user started may now contain older source. Leave a plain
pointer in its private installation notes to the absolute retained source that
matches the live release. Tell the user to open that retained source for future
troubleshooting or updates. Do not copy the new source over the old checkout,
discard local customizations, or present the old folder as current.

Report the installed application release and commit, Worker and public Admin
origin, completed Slack/Admin/data checks, retained source path, installation
receipt path, and exact update receipt path. If any required check remains
blocked, name it and do not call the update complete.
