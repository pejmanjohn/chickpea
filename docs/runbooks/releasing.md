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

Source hygiene runs before every merge, so a release does not discover it
late. `npm run verify:hygiene` takes about two seconds and needs no install,
build, or network; the tracked pre-push hook (`npm run hooks:install`) runs
it for every pushed commit. It checks the tracked manifest against the
public-source policy (forbidden roots, private `docs/` shapes, the exact
live-verifier inventory), that every tracked `docs/` file is deliberately
un-ignored in `.gitignore`, the private-name leak scan, that a `git archive`
of the commit reproduces every tracked byte, the release manifest and version
agreement, lockfile integrity hashes, package metadata, the authentication
export contract, and the npm pack manifest.

Start from a clean checkout of the exact candidate commit, with no private
environment files. Use the lockfile and run checks serially per checkout:

```sh
nvm install && nvm use
npm ci --strict-allow-scripts
npm audit --omit=dev
npm run verify:regression -- --mode release
```

Run the source gates once on Node 24.20.0 from `.nvmrc`. Node 24.x is the only
supported major, minimum 24.20.0. Update the single baseline for later patch or
security releases, then verify it once; do not retain a second runtime sweep.

The release command requires clean committed source without private environment
files. Its steps run cheapest and most likely to fail first, and the first
failure ends the run. The contract checks, the Node scheduler proof, and
cf-smoke run together after one shared Node build; the alarm-fallback cf-smoke
follows alone (it rebuilds the same Cloudflare artifact), and the export runs
last and alone:

| step | proves | typical |
| --- | --- | --- |
| `verify:hygiene` | source hygiene of committed HEAD (above) | 2 s |
| `build` | the Cloudflare artifact builds within the size budget | 3 s |
| `verify:node-scheduler-capability`, `evaluate:agent-authoring`, `evaluate:schedule-contract`, `verify:admin-ui` | authoring, schedule, and Admin contracts | 5 s |
| `verify:node-scheduler-offline` | Node schedules deliver once across restarts and crashes, including Flue's own 30 s crash-lease expiry (other modes expire the lease directly) | 35 s |
| `verify:cf-smoke` | both Cloudflare profiles build; the core profile runs in local workerd with the default thread-runner executor | 55 s |
| `verify:cf-smoke:alarm` | the same smoke with the `SLACK_TAG_TURN_EXECUTOR=alarm` emergency fallback | 55 s |
| `verify:oss-export` | the immutable archive installs from the lockfile with an empty npm cache, builds, passes the full root/CLI suite, the offline turn, durability, and provider checks, and a deployment dry run | 215 s |

The full suite runs exactly once per release, inside the export, where a pass is
the strongest evidence: no `.git`, no untracked files, no reused dependencies.
Do not add a second outer run. The export repeats hygiene on the archived
commit before installing anything. Its receipt covers the declared test
inventory and offline checks only after the whole export passes. Old receipts
do not acquire new coverage retroactively. Missing logs, source/configuration
drift, and unresolved failures still block completion.

The root test suite runs through `scripts/run-tests.mjs` under 8-way
concurrency: files that fail, or that end without reporting a single test,
are rerun once, alone. A file that passes alone is logged as
`RETRIED IN ISOLATION` and the run still passes; note it in the release notes.
A file that fails or stays silent twice, or more failing files than the
runner's concurrency, fails the run. Verification servers take loopback ports from a fixed range outside
the OS ephemeral range, locked per host under
`~/.chickpea/verification-host/ports/`; the offline durability harness still
retries a server start that lost its port to a foreign process. Neither retry
covers a test that fails the same way twice, so a repeat is a real failure to
fix, not a host race.

Use `--record <private-run.json>` for the existing skill's evidence notebook.
Passing an earlier commit does not validate new changes. Verify the actual merge
result before landing. The command never tags, publishes, or deploys a release.

Record the uncompressed ("Total Upload") size from the deployment dry run, not
the size of the repository or `node_modules`. Keep headroom below Cloudflare's
platform-wide 64 MiB Worker upload limit, per the budget in
`scripts/verify-worker-size.mjs`. A dynamic import still contributes its
uploaded chunk to that limit. Do not advertise a specific plan's compatibility
unless the actual release artifact fits its other limits (CPU time, request
volume, containers) and the relevant runtime checks pass.

## Dependency install policy

The pinned Node 24.20.0 baseline includes npm 11.19.0. Install with
`npm ci --strict-allow-scripts`. In npm 11.19, an uncovered dependency hook runs
with a warning unless strict mode is enabled. Root `allowScripts` records exact
package/version approvals and denials; the source export exercises strict mode.
When changing the lockfile, review the actual published hooks and update their
exact entries together. Keep the root Node version guard enabled separately.

| Locked hook | Decision | Reason |
| --- | --- | --- |
| esbuild 0.28.1 | Allow | Installs and validates the platform build binary. |
| workerd 1.20260815.1 | Allow | Installs and validates the local Worker runtime binary. |
| @google/genai 1.52.0 | Deny | Published preinstall only prints a no-op message. |
| core-js-pure 3.49.0 | Deny | Sponsorship banner and its temporary throttle file are not needed by the polyfills. |
| protobufjs 7.6.5 | Deny | Postinstall only warns about dependency version notation. |
| @mongodb-js/zstd 7.0.0 | Deny | just-bash 3.0.2 leaves native codecs disabled; avoid an unnecessary binary download and broken source-build fallback. |
| node-liblzma 2.2.0 | Deny | The same codec guard makes the native compiler/system-library setup unnecessary. |

Verify a clean install without saved approvals: required binary versions, a
build/local workerd run, protobuf serialization and polyfill imports, and
just-bash gzip tar behavior. XZ/Zstandard should retain their existing disabled
codec response rather than reaching a missing native addon. Do not infer that
a warning means a hook was skipped.

The current updater preserves immutable older source with a private npmrc
policy only for the exact reviewed v0.1.16 commit and manifest/lockfile digests.
That config format supports approvals but not denials, so all seven historical
hooks are explicitly reviewed and allowed there. The native hooks may fail as
optional dependencies; their codecs remain disabled. This retains the older
release's install behavior and is not a reason to enable those hooks in new
source. The historical liblzma source downloader can use ambient `GITHUB_TOKEN`
for GitHub API access. The updater preserves environment substitutions because
the selected registry configuration may also need those credentials.

An additional historical release needs its own source/digest and hook review.
Unknown identities fail before npm; do not add a runtime trust flag, edit the
retained source, or weaken clean-source verification. Policy coverage alone
never establishes upgrade compatibility or changes `supportedOrigins`.

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
reviewed recovery policy, and exact migration-content digests. A digest
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
| v0.1.22 | 1 | Node/ngrok candidate `f51d4ec`: shared-app installation, signed-in Admin, real Slack replies, managed restart, and crash recovery passed. The release preserves that runtime source. |
| v0.1.23 | 1 | Cobalt QA lane on `1dfcd57e` (Worker a1958ce6) plus local checks on the release commit: real Slack DM/mention/thread replies, Agent creation with one welcome, instruction proposal approved and read back in Admin, MCP door (instructions, prompts, `create_agent` links) and `/connect` verified; Codex/Claude Code OAuth logins passed. Shared gateway protocol 1 unchanged. |
| v0.1.24 | 1 | Cobalt QA lane on the merged performance tree (Worker ef876eef, PR #114) plus local checks on the release commit: real Slack mention routing with the bash tool (threaded replies), one-time schedules acknowledged and delivered to the channel at the due time, and the Admin Connections/boot journey (catalog paints in its final layout, no legacy gallery, single-fetch Agent switches) passed; full Node suite, local workerd smoke, and recorded offline checks passed. Shared gateway protocol 1 unchanged. |
| v0.1.25 | 1 | Amber QA lane on the merged browser tree (Worker versions 65052400, ca3e6afd, 03305a59, d0afd7cb) plus local checks on the release commit: public browsing with screenshot proof, website login sign-in on a real site, an approved data-changing step, and session recordings of 10.9 MB, 18.5 MB, and 79.2 MB (5 minutes 22 seconds) streamed to Slack through gateway upload tickets and shown in Slack's inline player on desktop and mobile; full Node suite, local workerd smoke, and recorded offline checks passed. Configuration digest updated for the additive website-login column; shared gateway protocol 1 gains two operations. |
| v0.1.26 | 1 | Cobalt QA lane on `4b0fa218` (Worker version f32c552a, sandbox profile) plus local checks on the release commit: the guarded `deploy:sandbox` passed its new R2 check on an R2-enabled account, kept the `BACKUP_BUCKET` binding, and brought the Container application to ready; Admin → Coding sandbox showed Installed but off with the Workers Paid and R2 note and no checkpoints-off line; a real channel mention received one threaded reply. The checkpoints-off path on an account without R2 is covered by local tests only. Shared gateway protocol 1 unchanged. |
| v0.1.27 | 1 | Violet QA lane (sandbox profile, Durable Object migration `v10`) on main `a172a05e` plus #194, #196 and #198 before their merge with the parallel-turns work (Worker versions 0c0769f0 and 9b56b3f0), plus earlier candidate builds for the other journeys: a 61-minute delegated `workspace_task` delivered one final answer with bot-authored commits and a draft PR while the working indicator showed rotating progress and channel mentions were answered in about 10 s; a same-source redeploy mid-task reset the coding worker's Sandbox Durable Object and the worker reconnected and finished; create/welcome/first-approve, instruction approval, a channel schedule, connector file attach with `connection_request`, two named workspaces, sandbox-off follow-up, and persistence across redeploys passed on earlier builds of the same work. The release also contains Durable Object migration `v11` and the per-thread runner groundwork (#182-#185, #187, #188, #190), which are pending the maintainer's final verification on a `v11` lane. Shared gateway protocol 1 unchanged. |

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
