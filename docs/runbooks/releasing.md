# Releasing Chickpea

Releases are source tags and GitHub releases, not npm publications. Keep
`package.json` private. Use SemVer tags such as `v0.1.0` (not `v0.01`), matching
the package and lockfile versions. No first release is implied by these docs.

## Before the first release

- Land release preparation through a GitHub PR or a maintainer-authorized local
  worktree merge, verified in root `main` before pushing. Keep source changes,
  repository settings, live deployment, and release publication separate.
- Keep force pushes/deletions blocked on `main` and resolve conversations when
  using a PR. PRs are not a GitHub requirement; maintainers may push verified
  changes directly. Keep GitHub Actions disabled and do not require workflow
  status checks. Record local verification with the change or release evidence.
- Enable Dependabot alerts/security updates and private vulnerability reporting.
  Verify the public links in CONTRIBUTING and SECURITY work.
- Decide whether to retain history. Rewriting it is optional, not a security
  cleanup. If explicitly approved, preserve a private recovery copy and author
  attribution, resolve other branches/PRs, and coordinate fresh clones. Old
  public commits, forks, tags, and cached references may remain accessible;
  rotate any exposed credentials regardless of a rewrite.

## Source gates

Start from a clean checkout of the exact candidate commit, with no private
environment files. Use the lockfile and run checks serially per checkout:

```sh
nvm install && nvm use
npm ci
npm audit --omit=dev
npm run verify:regression -- --mode release
```

Run the source gates once on Node 24.20.0 from `.nvmrc`. Node 24.x is the only
supported major, minimum 24.20.0. Update the single baseline for later patch or
security releases, then verify it once; do not retain a second runtime sweep.

The release command requires clean committed source without private environment
files. It restores build artifacts and runs authoring, Admin, local workerd,
lockfile, and immutable source-export checks serially. The export installs from
the lockfile, builds HEAD, and runs the full root/CLI suite plus offline turn,
durability, and provider checks and a deployment dry run. Those checks run once
inside the export instead of again in the outer release sequence. Its receipt
covers the declared test inventory and offline checks only after the whole export
passes. Old receipts do not acquire new coverage retroactively. Missing logs,
source/configuration drift, and unresolved failures still block completion.

Use `--record <private-run.json>` for the existing skill's evidence notebook.
Passing an earlier commit does not validate new changes. Verify the actual merge
result before landing. The command never tags, publishes, or deploys a release.

Record the compressed upload size from the deployment dry run, not the size of
the repository or `node_modules`. Keep headroom below the advertised plan's
Worker limit. A dynamic import still contributes its uploaded chunk to that
limit. Do not advertise Free compatibility unless the actual release artifact
fits its limits and the relevant runtime checks pass.

## Attended acceptance

Choose an approved disposable deployment and Slack workspace first. Do not use
a production workspace or overwrite another task's environment implicitly.
Keep identities, bindings, secrets, and evidence outside the public repository.

- Install the exact candidate from a fresh public source checkout with no local
  private files. Exercise each advertised target/lane; identify any lane that
  was not tested rather than claiming general acceptance.
- Complete Slack installation, first-Owner sign-in, provider/model selection,
  and a real DM or mention that receives a reply from the candidate deployment.
- Confirm a second user cannot access Owner-only configuration or another
  Agent's personal connection. Check an approved connector flow if advertised.
- Restart/redeploy and confirm sign-in, existing state, and Slack delivery still
  work. Check retry/deduplication behavior without claiming exactly-once delivery.
- On Cloudflare, verify an approved schedule fires and stops when paused, and
  test the coding sandbox if that release advertises the optional profile.
- For subsequent releases, test the documented upgrade from the prior supported
  version and the stated recovery procedure. Do not replace upgrade testing
  with a fresh install.
- Remove only the fixtures/resources created for this acceptance run. Record
  the source commit, target/version, observed outcomes, limitations, and cleanup.

Fake-backend tests and local workerd establish deterministic coverage; they do
not replace this real Slack/Admin acceptance.

## Publish

After the source gates and attended acceptance pass, prepare matching
package/lockfile versions and release notes. Notes must cover prerequisites,
installation links, changes, known limitations, supported upgrade origins,
migrations, and recovery limits. For a 0.x release, state its experimental
status and whether GitHub's prerelease flag is appropriate.

Land through a PR or a maintainer-authorized local merge, rerun/confirm local
checks on the final `main` commit, and obtain
explicit authorization to tag/publish that exact commit. Create the version tag
and GitHub release together. Verify that downloading its source archive follows
the documented install path. Publish no secrets or private acceptance evidence.
Do not move a published tag; issue a new version for corrections.
