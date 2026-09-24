# Coding sandbox deployment

Chickpea's default Cloudflare deployment is the **core deployment profile**. It does not
declare the Sandbox binding, build the Ubuntu-based coding image, or create a
Container application. This keeps first deploys small; normal Slack replies,
administration, GitHub browsing, and repository-aware model work do not depend
on a Container.

The coding sandbox is an optional Cloudflare-only feature for repository-backed
work that needs a real checkout, package installation, tests, or a development
server. Node installations continue to use the standard in-memory bash sandbox
and never receive host filesystem or host git/SSH access.

File attachments do not depend on this tier. Every sandbox mode mounts
`post_artifact` to attach a file the Agent wrote. Image generation uses the
workspace's configured image model. The container adds real
repository checkouts, package installation, and the Playwright screenshot recipe.

## Before installing

- The Cloudflare account must be on **Workers Paid**. Container application and
  image resources live in, and may incur costs on, the customer's account.
- An owner or admin must be signed in to Chickpea. Member sessions cannot read
  or change Sandbox settings.
- Connect the Chickpea GitHub App under **Settings → GitHub**, then grant at
  least one repository to an Agent. Installation can start before these are
  complete, but runtime enablement cannot.
- Expect the first Sandbox image build to take several minutes. Cloudflare must
  build and distribute the Ubuntu-based image before it can report ready.
- **R2** enabled on the Cloudflare account (the free tier is enough). The
  sandbox keeps workspace checkpoints in an R2 bucket that Wrangler creates on
  deploy, but Cloudflare refuses to create any bucket until R2 is enabled once
  in the dashboard. A [command-line deploy](#deploy-from-the-command-line) on
  an account without R2 still installs the sandbox with checkpoints off; a
  Workers Builds deploy fails until R2 is enabled.
- For a [command-line deploy](#deploy-from-the-command-line), the deploying
  machine needs a running Docker engine, and the Wrangler credential needs the
  Containers permission (`containers:write` for an OAuth login or profile,
  **Containers: Edit** for an API token). Workers Builds builds the image in
  Cloudflare's build environment instead.

No deploy-time secret is required. The Deploy to Cloudflare form has no
Chickpea credential fields; the Sandbox selector below is a non-secret build
variable.

The append-only `v3` Durable Object migration remains in both deployment
profiles for compatibility. Its dormant `Sandbox` namespace is not proof that
the coding tier is installed. **Installed** needs both the live Worker's
`SANDBOX` binding and a Container application attached to it. Chickpea checks
the second by waking one probe Durable Object, which starts no container. A
binding without a Container, which an interrupted deploy leaves behind, reports
**Redeploy required**.

## Install and redeploy

1. In Chickpea, open **Settings → Coding sandbox** and choose **Install coding
   sandbox**. Review the Workers Paid, build-time, and retained-infrastructure
   disclosure, then choose **Request installation**.
2. Chickpea now shows **Redeploy required** with step-by-step instructions. It
   records the request, but cannot use deployment authority that belongs to the
   customer's Cloudflare account. Confirm the account is on **Workers Paid**
   before continuing.
3. Redeploy with the Sandbox deployment profile, using the same method that
   deploys this installation. Admin preselects the method that built the
   running Worker: Cloudflare Workers Builds sets `WORKERS_CI=1` at build time,
   and any other build counts as a command deploy. Either choice can be
   switched on the page.

**Deployed with a command** (a local checkout, a release archive, or your own
CI). From the checkout you install and update from, run your usual deploy
command with `deploy` changed to `deploy:sandbox`, keeping every flag and
environment variable, for example `npm run deploy:sandbox` or
`npm run deploy:sandbox -- --profile <existing-profile>`. It needs Docker
running and the Containers permission; see
[Deploy from the command line](#deploy-from-the-command-line) for the
prerequisites, exact commands, and recovery.

**Cloudflare Git builds** (Workers Builds, including Deploy to Cloudflare
installs):

1. Open **Cloudflare dashboard → Workers & Pages → your Worker → Settings →
   Builds**.
2. Under **Build variables and secrets**, add the plain (non-secret) variable
   `CHICKPEA_DEPLOY_PROFILE` with the value `sandbox`.
3. Start a new build: push a commit to the connected repository, or retry the
   latest build from the Worker's **Deployments** page.

If the build finishes but **Check again** still reports **Redeploy required**,
push a new commit so Cloudflare runs a fresh build with the variable. Do not
treat a completed retry as proof that the new deployment profile was selected.

While the redeploy is outstanding, **Check again** reads the live deployment
without changing the request. **Cancel request** atomically clears both the
installation request and runtime enablement; it changes nothing in Cloudflare.
A later redeploy therefore cannot silently turn a canceled Sandbox on.

Keep the Sandbox profile for every later deployment: `npm run deploy:sandbox`,
or builds that keep `CHICKPEA_DEPLOY_PROFILE=sandbox`. Returning to the core
profile is a deliberate uninstall; see below.

## Deploy from the command line

Use this path when the installation is deployed from a checkout with
`npm run deploy`, not by Workers Builds. It replaces the dashboard
build-variable steps above.

### Prerequisites

- **Workers Paid** on the Cloudflare account that hosts the Worker.
- **R2 enabled** on the same account, for workspace checkpoints. In the
  Cloudflare dashboard, open **R2 Object Storage** and enable it; the free tier
  is enough. Do not create a bucket: Wrangler creates the checkpoint bucket for
  the `BACKUP_BUCKET` binding. Without R2 the command deploys the sandbox with
  checkpoints off (a coding thread clones its repository again after the
  container sleeps) and prints how to turn them on. An API token also needs
  **Workers R2 Storage: Edit**.
- **Docker running** on the deploying machine. The deploy builds the Ubuntu
  image locally and pushes it to Cloudflare's registry. Start Docker Desktop
  (or your engine) and wait until `docker info` succeeds.
- **The Containers permission** on the same Wrangler credential you normally
  deploy with:
  - Global login (`npx wrangler login`): its default scopes include
    `containers:write`. A login created with a narrower `--scopes` list may not.
  - Named auth profile (`--profile <name>`, or one bound with
    `wrangler auth activate`): a profile created with an explicit `--scopes`
    list often lacks `containers:write`. Re-authorize it in place with its
    existing scopes plus `containers:write`. Run this from the installation
    checkout:

    ```sh
    npx wrangler auth create <name> --scopes account:read user:read workers:write workers_scripts:write workers_tail:read d1:write ai:write containers:write
    ```

    List the profile's current scopes instead of copying this example; the
    deploy preflight prints the exact command with them. Do not include
    `offline_access`, because Wrangler adds it itself and rejects it as a
    scope. `wrangler login --profile <name>` is rejected; use
    `wrangler auth create`, which Wrangler marks experimental.
  - API token (`CLOUDFLARE_API_TOKEN`): add the account permission
    **Containers: Edit** to the token and keep its other permissions.

### Commands

Run the command you normally deploy with, changing only `deploy` to
`deploy:sandbox`. Keep every flag and environment variable. For example:

| Normal deploy | Sandbox deploy |
| --- | --- |
| `npm run deploy` | `npm run deploy:sandbox` |
| `npm run deploy -- --profile <name>` | `npm run deploy:sandbox -- --profile <name>` |
| `CHICKPEA_DEPLOY_TARGET=production npm run deploy -- --profile <name>` | `CHICKPEA_DEPLOY_TARGET=production npm run deploy:sandbox -- --profile <name>` |

Before it builds, migrates, or uploads anything, the command checks the
following. It stops with one actionable message per problem.

1. The Docker daemon is reachable.
2. The Sandbox base image (`docker.io/cloudflare/sandbox:<version>`) pulls. It
   retries three times, because the registry metadata fetch often times out
   (`DeadlineExceeded`) in the first minute after Docker starts.
3. The Wrangler credential can list Container applications. A missing scope
   prints the exact re-authorization command for the global login, the named
   profile, or the API token, whichever you deploy with.
4. Whether R2 is enabled on the account (`wrangler r2 bucket list` for the
   deploy's account). If Cloudflare reports R2 is not enabled (API error
   10042), the deploy continues without the `BACKUP_BUCKET` binding, so
   Wrangler does not try to create a bucket, and ends with one line saying
   checkpoints are off and how to turn them on: enable R2, then rerun the same
   command. Any other R2 failure, such as an API token without R2 permission,
   stops the deploy with nothing changed.

It then builds and pushes the image with `wrangler containers build --push`,
retrying a failed build. Only after that does it apply migrations and run
`wrangler deploy` against the pushed image, so Docker failures can no longer
happen after the new Worker version is live.

Later updates must keep using `npm run deploy:sandbox` with the same flags.
A plain `npm run deploy` against a Worker that has the `SANDBOX` binding is
refused. See [Disable, uninstall, or roll back](#disable-uninstall-or-roll-back)
to remove the sandbox on purpose.

### What success looks like

The command ends with the usual readiness check, then prints
`Container application <worker>-sandbox exists (state: …)`. A first rollout can
report a provisioning state for 15 minutes or more before it reaches `ready`.
`npx wrangler containers list` shows the current state. In Chickpea, choose **Check again**; the status becomes
**Installed but off**. The sandbox is still **off**: granting a repository to an
Agent does not use the Container until you choose **Enable coding sandbox**.
Continue with [Confirm readiness and enable](#confirm-readiness-and-enable).

### Recovering from a partial deploy

`wrangler deploy` activates the new Worker version at 100% traffic before it
creates or updates the Container application. If that last step fails, the
live Worker has the `SANDBOX` binding but no Container. Ordinary replies keep
working; Chickpea reports **Redeploy required**, and coding work cannot use the
sandbox. The command detects this and prints `PARTIAL SANDBOX DEPLOY` with two
exact choices:

1. Fix the reported error and rerun the same command. Migrations and the image
   push are safe to repeat.
2. Return to the version that served before the deploy:

   ```sh
   npx wrangler rollback <previous-version-id> --name <worker> [--profile <name>] --message "Undo partial sandbox deploy"
   ```

The same message appears if the deploy finishes but no Container application
named `<worker>-sandbox` exists.

If `wrangler deploy` fails before it uploads the Worker script, for example
while creating a new resource after the asset upload, the command prints
`SANDBOX DEPLOY STOPPED BEFORE THE WORKER UPLOAD` instead. The live Worker
version is unchanged, so no rollback is needed. Fix the reported error and
rerun the same command.

## Confirm readiness and enable

1. Wait for the Cloudflare build to finish. The first image build is expected
   to be noticeably slower than a core deployment.
2. Open **Cloudflare dashboard → Containers → Container applications**. Open
   this Worker's Sandbox application and confirm that the latest rollout is
   ready.
3. Return to Chickpea and choose **Check again**. The status should become
   **Installed but off**.
4. If prompted, use **Connect GitHub** and **Manage repository access** to
   satisfy the remaining prerequisites.
5. Choose **Enable coding sandbox**, confirm the readiness checkbox, and enable
   it. The checkbox is deliberate: a binding can exist while its first image
   rollout is still unavailable.
6. In a Slack Channel where an Agent with a repository grant is placed, start a
   new thread and ask Chickpea to clone the granted repository, **install its
   dependencies**, make a small change, run its tests, and report the result.
   Also request an ungranted repository once and verify that access is refused.
7. Treat the clone and the dependency install in step 6 as the load-bearing
   check, not a formality. Container egress is mediated by the Worker: the
   `Sandbox` class pairs `interceptHttps = true` with `enableInternet = false`
   (`src/cloudflare.ts`) so that HTTP and HTTPS are decided by the egress policy
   and no raw, unmediated network path is left beside it. That pairing is what
   Cloudflare's own outbound-interception guidance prescribes, but the allowed
   lanes depend on your account and image version resolving through the
   mediated path.

   If a clone or an install fails with a DNS or connection error **while
   ordinary Slack replies still work**, suspect that pairing before anything
   else: remove `enableInternet = false`, redeploy the sandbox profile, and
   retest. A passing install is the evidence that mediated egress covers the
   allowed lanes; record it, because it is the check that distinguishes a
   genuinely closed raw-egress path from a broken sandbox.

## What each status means

| Status | Meaning | Next action |
| --- | --- | --- |
| **Unsupported on Node** | This target cannot install the Cloudflare Container tier. | Use the standard in-memory bash sandbox, or deploy Chickpea to Cloudflare. |
| **Not installed in this deployment** | This is the slim core deployment profile and no install is pending. | Choose **Install coding sandbox** if the feature is needed. |
| **Redeploy required** | Chickpea saved the request, but the live Worker has no Sandbox binding yet, or it has the binding without a Container application (an interrupted deploy). | Redeploy with the Sandbox profile (`npm run deploy:sandbox` or the build variable), then choose **Check again**. |
| **Installed but off** | The binding and its Container application are live, but runtime use is disabled. | Complete GitHub/grant setup, verify the Container rollout, then enable. |
| **On** | The binding, stored runtime choice, GitHub App, and a repository grant are all ready. | Test a repository-backed request in Slack. |
| **On, setup required** | Runtime was previously enabled, but GitHub or repository access is now missing. | Follow the single prerequisite action shown; coding work remains unavailable until repaired. |

Errors and unchanged checks leave the last confirmed status on screen. Retry
only after reading the inline result; do not treat a button click as proof that
Cloudflare finished the deployment.

## Workspace lifetime and cost

Each Slack thread gets one coding workspace. It starts on the first command an
Agent runs and stays warm between turns, so a follow-up in the same thread
reuses the checkout instead of cloning again.

- **Warm window:** the container sleeps 30 minutes after the thread's last
  turn. Sleep wipes its disk and stops all billing. An idle `standard-1`
  container costs about $0.04 per hour while it waits.
- **Checkpoints:** after each turn, the workspace files (without dependency
  folders such as `node_modules` or `.venv`) are saved to the `BACKUP_BUCKET`
  R2 bucket. If the thread resumes within three days, a new container restores
  them. A checkpoint of a few hundred megabytes costs a fraction of a cent to
  keep for three days, and R2's free tier usually covers it. The Worker's
  maintenance cron deletes checkpoints older than three days every hour.
  Wrangler creates the bucket on the first Sandbox-profile deploy; without it,
  a resumed thread simply clones again.
- **Retirement:** the workspace and its checkpoint are discarded before the
  next turn if a different Agent takes over the thread or the Agent's
  repository grants change, so a checkout never outlives the access that
  created it.
- **Credentials:** GitHub access exists only while a turn runs. The turn's
  egress grants are revoked when it ends, even though the container stays up.
- **Scheduled work:** a routine run always starts a fresh workspace and
  destroys it when the run ends.
- **Monthly session cap:** counts workspace starts, not turns. Follow-ups that
  reuse a warm workspace do not count again.

Anything that must survive longer belongs on a pushed branch or pull request;
the Agent's workspace instructions say so.

## Commit author

Commits made in a coding workspace are authored as the connected GitHub App's
bot account, for example `chickpea-735adc[bot]`. GitHub shows that login with
the App's avatar (see below) and links it to the App. Chickpea looks up the bot account
after the App is connected, refreshes it daily (so renaming the App carries
over), and presets it in the workspace's global Git configuration each time the
workspace starts; no credential is written there. If the first lookup fails
(for example GitHub is unreachable), commits use the neutral
`Chickpea <chickpea@noreply.invalid>` identity until a later lookup succeeds.
Disconnecting the App forgets the cached bot account.

The name GitHub shows is the App's name, which is unique per install. GitHub
does not let an App set its logo at creation, and until one is uploaded the
bot's avatar is the avatar of the account that owns the App, so its commits
and pull requests look like that person's photo. To show the Chickpea mark,
an Owner of the App uploads it once under
**GitHub → Settings → Developer settings → GitHub Apps → (the App) → Display
information**; `assets/chickpea-avatars/install-default.png` in this
repository works.

## Disable, uninstall, or roll back

**Disable** in Chickpea is immediate. It stops selecting the coding sandbox for
new work, but deliberately leaves the Container application and image in
Cloudflare. Those retained resources may continue to exist or incur costs.

For a complete uninstall or rollback to the slim core deployment profile:

1. Choose **Disable** in Chickpea.
2. Select the core profile explicitly. The deploy refuses to remove a live
   sandbox by default. For Workers Builds, set `CHICKPEA_DEPLOY_PROFILE` to
   `core` under **Settings → Builds → Build variables and secrets**. For a command-line deploy,
   prefix your usual command, for example
   `CHICKPEA_DEPLOY_PROFILE=core npm run deploy -- --profile <name>`.
3. Start a new build, or run that command, to deploy the core deployment profile.
4. Verify ordinary Slack replies and Admin access on the core deployment.
5. Only after that verification, delete the retained Container application and
   image from Cloudflare, and the workspace checkpoint R2 bucket that Wrangler
   created for the `BACKUP_BUCKET` binding (**R2 → Buckets**).

This order preserves a working rollback and avoids deleting resources while a
live Worker may still reference them.

## Upgrading an older Sandbox beta

Before applying an update, choose the intended deployment profile explicitly:

- Keep `CHICKPEA_DEPLOY_PROFILE=sandbox` (or use `npm run deploy:sandbox`) to
  retain the binding across the upgrade.
- Set `CHICKPEA_DEPLOY_PROFILE=core` explicitly and deploy the core deployment
  profile to intentionally return to a slim Worker. An unset profile is refused
  while the live Worker has the binding. Stored enablement is ineffective without the binding; install
  again before trying to re-enable it.

Do not assume the default Deploy to Cloudflare button preserves beta-era
Container infrastructure. Its supported default is the slim core deployment profile.

## Troubleshooting

- **Check again still says Redeploy required:** for a command deploy, confirm
  you ran `npm run deploy:sandbox` (not `npm run deploy`) against this Worker
  and that it finished. For Git builds, confirm the variable is under **Build
  variables and secrets**, not a runtime variable or secret, and that the latest
  build started after you added it.
- **The build looks stuck:** the first Ubuntu image build can take several
  minutes. Inspect the Cloudflare build log and Container application rollout
  before retrying.
- **`Docker daemon is not reachable` or `DeadlineExceeded` fetching
  `cloudflare/sandbox` metadata:** start Docker, run
  `docker pull --platform linux/amd64 docker.io/cloudflare/sandbox:<version>`
  once it is up, then rerun the same `deploy:sandbox` command.
- **`You don't have 'containers:write' in your list of scopes`:** re-authorize
  as in [Prerequisites](#prerequisites); the preflight prints the exact
  command for your login.
- **Checkpoints are off, or API error 10042 (`Please enable R2 through the
  Cloudflare Dashboard`):** R2 is not enabled on the account. Enable it as in
  [Prerequisites](#prerequisites), then redeploy the same way. Admin →
  Settings → Coding sandbox says when checkpoints are off. A Workers Builds
  build that failed with 10042 did not change the live Worker.
- **`PARTIAL SANDBOX DEPLOY`:** follow
  [Recovering from a partial deploy](#recovering-from-a-partial-deploy).
- **Installed but enable is unavailable:** connect the GitHub App and grant at
  least one repository to an Agent. Chickpea intentionally refuses enablement
  when either prerequisite is missing.
- **On, setup required:** restore the exact GitHub or repository prerequisite
  linked by the page, or disable the runtime while access is being repaired.
- **Slack does not use the sandbox:** start a new root in a Channel where an
  Agent with a granted repository is placed. Deployment selection is not changed
  in the middle of an existing conversation.
- **Need a clean recovery:** follow the disable/core-redeploy/Slack-verification
  sequence above before deleting retained Cloudflare resources.
