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
2. Chickpea now shows **Redeploy required**. It records the request, but cannot
   use deployment authority that belongs to the customer's Cloudflare account.
3. Open **Cloudflare dashboard → Workers & Pages → your Worker → Settings →
   Builds → Variables**.
4. Add the non-secret build variable `CHICKPEA_DEPLOY_PROFILE` with the value
   `sandbox`, then choose **Retry deployment**.

If Retry reuses the earlier core artifact, start a fresh dashboard build and
then use **Check again** in Chickpea. Do not treat a completed retry as proof
that the new deployment profile was selected.

A local or CI operator deploys the same Sandbox deployment profile from the
command line; see [Deploy from the command line](#deploy-from-the-command-line).

While the redeploy is outstanding, **Check again** reads the live deployment
without changing the request. **Cancel request** atomically clears both the
installation request and runtime enablement. A later redeploy therefore cannot
silently turn a canceled Sandbox on.

## Deploy from the command line

Use this path when the installation is deployed from a checkout with
`npm run deploy`, not by Workers Builds. It replaces the dashboard
build-variable steps above.

### Prerequisites

- **Workers Paid** on the Cloudflare account that hosts the Worker.
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
| **Redeploy required** | Chickpea saved the request, but the live Worker has no Sandbox binding yet, or it has the binding without a Container application (an interrupted deploy). | Complete the Cloudflare build-variable redeploy, then choose **Check again**. |
| **Installed but off** | The binding and its Container application are live, but runtime use is disabled. | Complete GitHub/grant setup, verify the Container rollout, then enable. |
| **On** | The binding, stored runtime choice, GitHub App, and a repository grant are all ready. | Test a repository-backed request in Slack. |
| **On, setup required** | Runtime was previously enabled, but GitHub or repository access is now missing. | Follow the single prerequisite action shown; coding work remains unavailable until repaired. |

Errors and unchanged checks leave the last confirmed status on screen. Retry
only after reading the inline result; do not treat a button click as proof that
Cloudflare finished the deployment.

## Disable, uninstall, or roll back

**Disable** in Chickpea is immediate. It stops selecting the coding sandbox for
new work, but deliberately leaves the Container application and image in
Cloudflare. Those retained resources may continue to exist or incur costs.

For a complete uninstall or rollback to the slim core deployment profile:

1. Choose **Disable** in Chickpea.
2. Select the core profile explicitly. The deploy refuses to remove a live
   sandbox by default. For Workers Builds, set `CHICKPEA_DEPLOY_PROFILE` to
   `core` under **Settings → Builds → Variables**. For a command-line deploy,
   prefix your usual command, for example
   `CHICKPEA_DEPLOY_PROFILE=core npm run deploy -- --profile <name>`.
3. Retry the deployment, or run that command, to deploy the core deployment profile.
4. Verify ordinary Slack replies and Admin access on the core deployment.
5. Only after that verification, delete the retained Container application and
   image from Cloudflare.

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

- **Check again still says Redeploy required:** confirm the variable is a
  **Builds → Variables** value, not a runtime secret, and confirm the latest
  deployment actually used value `sandbox`.
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
