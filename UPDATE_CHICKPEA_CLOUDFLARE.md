# Update Chickpea on Cloudflare

Update the user's existing Chickpea installation to the latest stable application
release. Handle the terminal and browser work, preserve their settings and data,
and verify the deployed version and Admin access. Ask for help only when you need
missing account information, sign-in, or a decision about their custom changes.

Use the ordinary guarded `npm run deploy` command. The `supportedOrigins` list
belongs to the optional receipt-based `npm run upgrade` tool; an empty list does
not prevent a normal update. Rollback support is not an update prerequisite.
Do not edit release metadata to satisfy that tool or use it for this workflow.

An update does not include sending Slack messages or running Agents, connections,
or schedules as tests. Leave those checks to the user unless they request them.

## 1. Find the existing installation

Start in the user's Chickpea folder. Inspect its Git status, deployment config,
and any private installation notes. Match the configured Cloudflare account,
Worker, public URL, and `AUTH_DB` database ID to the live installation. Reuse its
Wrangler login or named profile. Preserve local edits and credentials.

Read the live deployment settings before changing source. Keep the existing
Worker and database names and IDs, resource bindings, non-secret variables,
routes, triggers, and other service settings. A local config can be older than
the live deployment. Secret values stay in Cloudflare; do not print or copy them.

## 2. Update the source and dependencies

Choose the latest stable application release from the
[official releases](https://github.com/pejmanjohn/chickpea/releases).
Ignore `cli-v*` releases, drafts, and prereleases. Fetch its exact tag and read
its release notes. Update the checkout to that release while preserving the
user's installation settings and unrelated local changes. Resolve any conflicts
without discarding their changes; use a separate checkout if needed.

This current guide governs the update workflow, including when the release's
older update instructions require the receipt tool or a supported-origin entry.
Use the selected release's Node pin, dependency and deploy commands, configuration
format, and migration steps. Select Node from `.nvmrc` using an available Node
manager, then install the release's lockfile dependencies.
For releases with the reviewed `allowScripts` policy, use:

```sh
npm ci --strict-allow-scripts
```

Keep the new release's code and migrations. Restore the installation's live
deployment settings in the authored `wrangler.jsonc`, including `account_id`,
Worker `name`, the `AUTH_DB` database name and ID, non-secret variables, and
service settings. Preserve resource identities while keeping the new release's
migrations, compatibility flags, and asset configuration. Do not copy old
application-version metadata over the new build identity or edit generated files.

Read any required migration steps. A missing `supportedOrigins` entry or a
changed source-file digest alone is not an incompatibility. Stop for a concrete
problem such as an unresolved target mismatch or a migration that would lose
data, and explain that problem rather than telling the user to wait indefinitely.

Some releases add a Durable Object migration; v0.1.27 adds one (`v10`) for
coding workers, on every installation. Once the deploy applies it, Cloudflare
refuses `wrangler rollback` and dashboard rollbacks to any version from before
that release. Recovery from a bad update then means deploying a newer or fixed
release forward. Tell the user this before deploying such a release.

## 3. Deploy to the same Worker

For the core Cloudflare deployment, run the release's guarded command from the
updated checkout:

```sh
npm run deploy
```

An installation with the optional coding sandbox must keep it. If Admin
**Settings → Coding sandbox** shows **Installed but off** or **On**, or the
deploy reports that the live Worker has the coding sandbox, deploy with
`npm run deploy:sandbox` and the same flags and environment variables described
below. For example, use
`CHICKPEA_DEPLOY_TARGET=production npm run deploy:sandbox -- --profile <existing-profile>`.
This needs Docker running and the `containers:write` permission. Since
v0.1.25 the sandbox also keeps workspace checkpoints in an R2 bucket that the
deploy creates itself, which needs R2 enabled on the Cloudflare account: open
**R2 Object Storage** in the Cloudflare dashboard and enable it (the free tier
is enough; do not create a bucket). If R2 is not enabled, the command still
updates the sandbox, with checkpoints off, and ends with a line saying how to
turn them on. See
[Deploy from the command line](docs/runbooks/coding-sandbox-deployment.md#deploy-from-the-command-line).
A plain `npm run deploy` refuses to replace a live sandbox, and the guided
`npm run upgrade` tool supports only core installations.

If the installation uses a named Wrangler login, use
`npm run deploy -- --profile <existing-profile>` instead. On a host with a
Chickpea QA registry, an ordinary customer target also needs
`CHICKPEA_DEPLOY_TARGET=production`; this selects the configured Worker and does
not create a new environment.

Let the command build, apply its reviewed migrations, and finish its deployment
readiness check. Preserve its target and database guards. Do not create another
Worker or database, rotate permanent auth or encryption secrets, or reinstall
Slack. The command may print a setup link; an existing installation continues
using its usual Admin sign-in and does not need onboarding again.

## 4. Verify and finish

Confirm Cloudflare serves the selected version. Open signed-in
**Settings -> About & updates** and check the application version and source
commit. Do not send a Slack test or invoke an Agent, connection, or schedule.

If deployment or verification fails, inspect the actual serving state and fix
the reported error. Preserve the existing resources and data; do not reset or
reinstall the application to make a check pass.

Update any existing private installation notes with the release and checkout
path. Tell the user which version is installed, whether deployment and Admin
checks passed, and where the local source lives. They can test Slack themselves
when convenient.
