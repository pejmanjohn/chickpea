# Releasing Chickpea

Releases are source tags and GitHub releases, not npm publications. Keep
`package.json` private. Use SemVer tags such as `v0.1.0` (not `v0.01`), matching
the package and lockfile versions. No first release is implied by these docs.

## Before the first release

- Land release preparation through a GitHub PR. Keep source changes, repository
  settings, live deployment, and release publication as separate actions.
- Confirm `main` requires the **Release checks** status, pull requests, resolved
  conversations, and no force pushes/deletions. A sole maintainer can use zero
  required approvals while still requiring PRs and checks.
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
npm ci
npm run verify:lockfile-integrity
npm audit --omit=dev
npm run build
TAG_DB_PATH=:memory: SLACK_STATE_DB_PATH=:memory: CHICKPEA_AUTH_DB_PATH=:memory: npm run test:ci
npm run verify:admin-ui
DO_NOT_TRACK=1 node scripts/verify-flue-offline-turn.mjs
DO_NOT_TRACK=1 npm run verify:durability
DO_NOT_TRACK=1 npm run verify:providers
DO_NOT_TRACK=1 npm run verify:cf-smoke
npm run verify:oss-export
```

CI runs minimum-Node and Node 24 checks, the immutable source-export gate, and
local workerd smoke. The source-export gate tests committed HEAD only. A green
run for an earlier commit does not validate new uncommitted changes.

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

After the source gates and attended acceptance pass, prepare a PR with matching
package/lockfile versions and release notes. Notes must cover prerequisites,
installation links, changes, known limitations, supported upgrade origins,
migrations, and recovery limits. For a 0.x release, state its experimental
status and whether GitHub's prerelease flag is appropriate.

Merge on GitHub, rerun/confirm checks on the final `main` commit, and obtain
explicit authorization to tag/publish that exact commit. Create the version tag
and GitHub release together. Verify that downloading its source archive follows
the documented install path. Publish no secrets or private acceptance evidence.
Do not move a published tag; issue a new version for corrections.
