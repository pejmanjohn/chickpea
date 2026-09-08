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

No deploy-time secret is required. The Deploy to Cloudflare form has no
Chickpea credential fields; the Sandbox selector below is a non-secret build
variable.

The append-only `v3` Durable Object migration remains in both deployment
deployment profiles for compatibility. Its dormant `Sandbox` namespace is not proof that
the coding tier is installed; only the live Worker binding establishes the
**Installed** state.

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

A local or CI operator can select the same Sandbox deployment profile with:

```sh
npm run deploy:sandbox
```

While the redeploy is outstanding, **Check again** reads the live deployment
without changing the request. **Cancel request** atomically clears both the
installation request and runtime enablement. A later redeploy therefore cannot
silently turn a canceled Sandbox on.

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
| **Redeploy required** | Chickpea saved the request, but the live Worker has no Sandbox binding yet. | Complete the Cloudflare build-variable redeploy, then choose **Check again**. |
| **Installed but off** | The binding is live but runtime use is disabled. | Complete GitHub/grant setup, verify the Container rollout, then enable. |
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
2. Remove `CHICKPEA_DEPLOY_PROFILE` from **Settings → Builds → Variables**.
3. Retry the deployment, or run `npm run deploy`, to deploy the core deployment profile.
4. Verify ordinary Slack replies and Admin access on the core deployment.
5. Only after that verification, delete the retained Container application and
   image from Cloudflare.

This order preserves a working rollback and avoids deleting resources while a
live Worker may still reference them.

## Upgrading an older Sandbox beta

Before applying an update, choose the intended deployment profile explicitly:

- Keep `CHICKPEA_DEPLOY_PROFILE=sandbox` (or use `npm run deploy:sandbox`) to
  retain the binding across the upgrade.
- Remove the variable and deploy the core deployment profile to intentionally return to a
  slim Worker. Stored enablement is ineffective without the binding; install
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
