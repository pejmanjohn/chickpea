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

## Application release contract

`package.json`, both root version entries in `package-lock.json`, and
`release.json` must agree. Run `npm run verify:release` after updating them.
`release.json` records the storage generation, reviewed incoming versions,
previous-code recovery policy, and exact migration-content digests. A digest
change requires a compatibility/recovery decision; do not merely regenerate
digests to silence a failed gate. The first updater deliberately rejects any
changed storage chain, even if a maintainer accidentally lists the origin.

Application tags are `vX.Y.Z`. The separately published `chickpea-cli` package
has its own version and `cli-vX.Y.Z` publication workflow; it does not establish
the application's installed version. Keep all other tests/builds local.

Publish stable application releases with GitHub's immutable-release protection
enabled. The upgrade executor requires the release API's `immutable: true`, a
matching official tag, and the exact fetched commit before executing dependency
scripts. Attach complete notes before publishing. Do not mark a release
prerelease if it is intended for the stable updater. A correction needs a new
version; neither retagging nor replacing a published artifact is an update path.

Each subsequent supported transition must run the populated recipe in
`fixtures/upgrades/v0.1.0.json` on an existing disposable customer-path Worker,
including pre-upload interruption/retry and post-upload recovery. Retain the
baseline source and private before/after readbacks. Registered QA-lane checks
alone do not cover the ordinary customer wrapper path. The initial release
advertises `supportedOrigins: []` until an incoming transition has evidence.

The build embeds application version and commit from the source being built,
not the launcher checkout or an environment-supplied SHA. `.gitattributes`
substitutes the commit in Git source archives. Verify the downloaded archive's
identity as part of publication acceptance; the support report and product
telemetry use the same embedded identity.

### Shared gateway compatibility

The in-repository protocol constant is
`src/slack/gateway/protocol.ts:CHICKPEA_GATEWAY_PROTOCOL_VERSION`. Keep the
gateway implementation private. Record gateway compatibility alongside each
release's acceptance evidence:

| Application release | Required protocol | Acceptance evidence |
| --- | --- | --- |
| v0.1.0 candidate | 1 | Pending the candidate's live release run |

Run `npm run verify:gateway-live` against the explicitly selected approved
gateway, followed by real installation/Slack delivery on the candidate. The
command creates a short-lived claim; its result proves the handshake only.
Do not change the shared gateway's configuration as part of an application
release. Do not declare old deployments unsupported without a separately
announced compatibility change and migration path.

## One-time initial-history cut

This repository's initial cut is explicitly authorized to produce one public
root commit named **`initial version v0.1.0`**, archive previous history, and
retire the old public branches and `cli-v0.1.0` tag. This is a one-time release
operation, not a routine step for future releases. Preserve the published npm
CLI artifact and the source to which its retired tag pointed.

1. Complete the implementation PR/review and all source and attended acceptance
   gates. Coordinate other open branches/PRs and freeze pushes for the cut.
   Inventory remote refs, release/tag metadata, repository settings, and branch
   protection; retain the exact expected remote `main` SHA privately.
2. Create a private mirror and a `git bundle --all` archive containing all old
   refs, including the annotated CLI tag. Save GitHub release metadata beside
   it. Clone from the bundle into a different directory, run `git fsck --full`,
   compare every archived ref/object ID, and check out the CLI tag's source.
   Record checksums and restore evidence. An untested bundle is not sufficient.
3. Create the prospective root commit from the reviewed candidate's exact tree
   with `git commit-tree <tree>` and no parent. Use the exact message above.
   Keep all migration files/declarations and attribution unchanged. Check that
   the candidate/root tree IDs agree. Build and run the full release gate from
   a clean checkout of this prospective root, including embedded source identity
   and the source archive. Bind live evidence to this candidate according to
   the live-verification workflow; a changed tree invalidates prior evidence.
4. Immediately before replacing public history, re-read remote refs/protection
   and require the expected SHA. Temporarily change only the protection needed
   for this authorized cut; use an explicit expected-SHA force-with-lease for
   `main`. Restore protection immediately and verify it. Stop on any concurrent
   ref change. Never use an unqualified force push or disable unrelated controls.
5. Retire only the inventoried, archived old branches and old CLI tag/release
   reference. Preserve the archive and published npm package. Verify remote
   `main` has exactly one ancestor-inclusive commit, the expected message/tree,
   and the restored protection. Close or retarget obsolete PRs deliberately.
6. Create `v0.1.0` and its immutable GitHub release on that exact root. Verify
   the API/tag/commit, source archive build identity, installation guide, and
   Settings no-update/current states. Record the new canonical source SHA.

Tell existing contributors to retain local work and use a fresh clone/rebase
onto the new root; a normal pull cannot reconcile rewritten ancestry safely.
Old clones, forks, GitHub pull-request refs, and caches can retain old commits.
This operation simplifies public history and does not erase previously exposed
material. Never delete the private archive to imply otherwise.

The initial launcher refuses newly introduced plain Worker variables and resource classes before deployment. A transition requiring either needs a reviewed launcher update and explicit compatibility support first. The customer upgrade path uses version upload plus exact-version activation with a minimal configuration, preserving existing routes, domains, crons, observability, logpush, and tail consumers. Wrangler may synchronize service/environment tags. Guided upgrades support only the core profile until the Sandbox container-image path has explicit implementation and live acceptance. Verify this path on the disposable customer installation; an ordinary deployment does not prove it.
