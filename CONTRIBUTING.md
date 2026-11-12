# Contributing to Chickpea

Chickpea is a self-hosted Slack agent. Small, focused contributions are welcome.
For a substantial feature or behavior change, open an issue first so we can
agree on the problem and scope. Report security vulnerabilities privately;
see [SECURITY.md](SECURITY.md).

## Local development

Use Node 24.x, minimum 24.22.1. `.nvmrc` pins 24.22.1 as the single
development, build, and verification baseline; both packages require
`>=24.22.1 <25`. Update that pin for future Node 24 patch/security releases
and verify the new baseline once. No other Node major is a routine test target.

```sh
nvm install && nvm use
npm ci
npm run dev
```

See [the setup guide](SETUP_AGENT.md) for local Slack configuration. Use your
own test workspace, credentials, and data. Never commit `.env`, `.dev.vars`,
SQLite databases, credential keyrings, setup links, or live test transcripts.
Production Node hosting is described in [the operations guide](docs/runbooks/operations.md).

## Pull requests

1. Fork the repository if you do not have push access. Create a topic branch
   from current `origin/main` (or `upstream/main` in your fork).
2. Make the change and add regression coverage for changed behavior. Keep
   unrelated refactors and generated-asset changes out of the PR.
3. Push the topic branch and open a GitHub pull request against `main`. Explain
   the problem, the change, and what you actually verified. Link the issue if
   there is one.
4. Record local verification results in the PR and resolve review feedback.
   Maintainers squash-merge on GitHub, then update their local `main` from origin.

Maintainers may instead merge a worktree into root `main`, verify the merged
result locally, and push directly. GitHub does not require a PR or hosted test
results; contributors without push access still use PRs. Agents need explicit
maintainer authorization for direct-main landing. Do not force-push `main`.
Merging or pushing does not deploy Chickpea or publish a release.

## Verification

Every plan starts with `npm run verify:hygiene`: source hygiene in about two
seconds with no install, build, or network. It checks the tracked manifest
against the public-source policy (forbidden roots, private `docs/` shapes,
the live-verifier inventory), that every tracked `docs/` file is deliberately
un-ignored in `.gitignore`, that the tracked `.mcp.json` defines only the lane
browser servers through `scripts/lane-browser.mjs`, the private-name leak
scan, that a `git archive` of the commit reproduces every tracked byte, the
release manifest and version agreement, lockfile integrity hashes, package
metadata, the authentication export contract, and the npm pack manifest. Run
it before every merge; install the tracked pre-push hook once so it runs for
each pushed commit:

```sh
npm run hooks:install
```

`verify:hygiene -- --working-tree` scans the index with working-tree bytes for
pre-commit iteration; `--revision SHA` scans any commit.

For iteration, `npm run verify:regression -- --plan` selects checks from the
branch and working changes. Run without `--plan` to execute them, or select
`--area routines` and other named areas explicitly. `--mode regression` runs
the fixed core checks; `--mode release` runs the full local sequence on clean
committed source. Hygiene, build, and the tests run first and in order; the
evaluators and process-level proofs after them (offline turn, durability,
Node scheduler, workerd) then run together on one shared Node build, each
with its own ports, state, and log. The Node scheduler proof is selected for
routine, Node-runtime, and dependency changes. A documentation-only change
runs hygiene alone. A checkout whose `node_modules` does not match
`package-lock.json` stops with `STALE_DEPENDENCIES` before any check runs.
These commands need no browser, live account, or OAuth.
Use `$chickpea-live-verification` for the corresponding real QA journeys.
Its private [run record](qa/live/operator/records.md) can also capture offline
checks with `verify:regression --record <private-run.json>`; every run executes
its checks, and release mode always executes its full checkpoint.

Run builds and tests **serially**: tests inspect generated artifacts, so a
concurrent build can make them read a partially written artifact.
Full suites, builds, and workerd groups also share the host's two reservation
slots for development and QA across checkouts, including deployment builds. Customer
installs and updates from published releases, with only local installation
settings changed, follow the [install guide](INSTALL_CHICKPEA_CLOUDFLARE.md) or
[update guide](UPDATE_CHICKPEA_CLOUDFLARE.md)
without these reservations, process inspection, or contributor test suites.
`verify:regression` acquires the reservation automatically. Wrap standalone groups
with `npm run verify:host -- COMMAND [ARG ...]`; see
[host coordination](qa/live/operator/host-checks.md). Focused unit checks can run
independently when they do not build artifacts or start heavy fixtures; test
passes and `npm run typecheck` take a shared CPU slot themselves, and other
CPU-heavy commands take one with `npm run verify:host -- --shared -- COMMAND`.
All verification runs locally. This repository does not use GitHub Actions
workflows or GitHub-hosted test runs, except the tag-triggered npm publish of
`packages/cli` (`.github/workflows/publish-cli.yml`), which is not a merge gate.

For iteration, choose the checks relevant to the change from this list. For a
stable committed candidate, use `verify:regression -- --mode release` once; it
runs the full suite and offline turn/durability/provider checks inside the clean
export, so do not also run those as a second outer release gate.

```sh
npm run verify:hygiene -- --working-tree
npm run build
TAG_DB_PATH=:memory: SLACK_STATE_DB_PATH=:memory: CHICKPEA_AUTH_DB_PATH=:memory: TAG_REQUIRE_LOOPBACK=1 npm test
npm run verify:admin-ui
DO_NOT_TRACK=1 node scripts/verify-flue-offline-turn.mjs
DO_NOT_TRACK=1 npm run verify:durability
DO_NOT_TRACK=1 npm run verify:providers
DO_NOT_TRACK=1 npm run verify:cf-smoke
DO_NOT_TRACK=1 npm run verify:cf-smoke:alarm
```

Each PR runs a fast check, typecheck, hygiene and the budgets
(`npm run verify:host -- --wait-ms 600000 npm run verify:budgets`, below). On a PR that touches
the management MCP program, the fast check is `npm run test:mcp`. In about 25
seconds it runs the program's tests: the management service and its MCP tools,
the cards' models and renders, test runs, the confirmations, previews and tool
policies behind them, and the Worker startup budget. It needs no host
reservation. A test file joins by its name (`tests/management-*`,
`tests/mcp-*`, `tests/test-run-*`, `tests/test-turn-*`), or by adding its path
to `scripts/test-mcp.mjs`. `npm run test:mcp -- --list` shows the selection. A
pattern that matches no file stops the run. A PR outside the program runs the
tests related to its change.

PRs merge in trains. A train is one or more PRs, each merged with `--no-ff`
onto current `origin/main`, in order, in a local worktree. The train's merged
tree gets the one full regression:

```sh
npm run verify:host -- --wait-ms 3600000 npm run verify:train
```

`verify:train` builds, checks both budgets for each merge, and runs the full
suite, so the tests that read a build (`tests/public-assets.test.ts`,
`tests/flue-v2-migration-contract.test.ts`) check this one. Each skips a
`dist-cf` built from another commit and says so.

The root test suite runs through `scripts/run-tests.mjs` under 8-way
concurrency, known-slow files first, with `tsc --noEmit` alongside; a type
error stops the pass. The CLI package's tests and `verify:regression`'s focused
test steps run through the same runner. A file that fails, or whose process
ends before all of its tests report (no test at all, no summary of its own, or
fewer tests than that summary counts), is rerun once alone; a file that then
passes is logged as `RETRIED IN ISOLATION`, and a file that fails or comes up
short twice fails the run. node:test itself passes any file whose process
exits 0. A file whose process starts and finishes no test for three minutes,
longer than any test may run, is logged as `HUNG` with the test it was
running and its processes, which the runner kills, so the file fails and
reruns alone instead of silencing the pass; one that still does not end stops
the pass. `verify:regression`'s focused test steps pass `--fail-on-retry`, so a
file that passes only alone fails the step there, and every step's receipt
and the run summary list each file a runner reran (`retries`). Local
verification servers take loopback ports from `scripts/lib/verification-ports.mjs`:
a fixed range outside the OS ephemeral range, locked per host under
`~/.chickpea/verification-host/ports/`, so the suite's own connections cannot
take a probed port back before a child binds it. Use it instead of probing
`listen(0)` when a test starts a server in a child process.

The PostgreSQL Better Auth backend tests start a disposable PostgreSQL 13+
server on a Unix socket, so the suite needs `initdb` and `postgres`. Set
`CHICKPEA_TEST_POSTGRES_BIN` to their directory if they are not found, or to
an empty value to skip those tests deliberately; otherwise they fail.

The offline verifiers use fake Slack/provider services and isolated local state.
They do not require production credentials. `verify:cf-smoke` builds both
Cloudflare profiles and runs the core profile in local workerd with the default
per-thread runner executor; it takes several minutes. `verify:cf-smoke:alarm`
repeats it with the `SLACK_TAG_TURN_EXECUTOR=alarm` emergency fallback so the
state store's alarm executor stays covered. Each run uses a free local port and its own disposable temporary state;
it does not reset an operator's local Worker state.

After committing the proposed source, run `npm run verify:oss-export`. It runs
hygiene on an archive of **HEAD**, not uncommitted edits, then installs from
the lockfile and runs the build, the full suite, the offline runtime checks,
and a deployment dry run inside that archive. Private working documents stay
outside the public export: `docs/` is default-denied in `.gitignore`, so adding
a public document means un-ignoring that exact file there (and listing it in
`package.json#files` if the npm package should carry it). Private roots such as
`docs/plans/` and private artifact shapes are refused by policy regardless, and
the leak scan denies private names, local user paths, tokens, and binaries.

Local automated checks cannot establish real Slack/provider acceptance.
Changes to setup, authority, delivery, or persistence also need the live checks
their [risk class](AGENTS.md#shipping-by-risk-class) names. Do not describe a build or
fake-backend result as live acceptance.

## Where things live

| Area | Source |
| --- | --- |
| Slack transport, delivery, attachments, avatars | `src/slack/` |
| Agent execution | `src/agents/` |
| File delivery and image generation tools | `src/sandbox/artifact-tool.ts`, `src/sandbox/image-tool.ts` |
| Admin pages and HTTP routes | `src/admin/` |
| Authentication and workspace identity | `src/auth/`, `src/identity/` |
| Connections and credentialed tools | `src/connections/` |
| Configuration, state, routines | `src/config/`, `src/state/`, `src/routines/` |
| Public images and runtime asset readers | `assets/`, `src/assets/` |
| Deployment and acceptance checks | `scripts/`, `tests/` |

Keep authorization checks at every state-changing boundary. Preserve the
content-free telemetry contract in [TELEMETRY.md](TELEMETRY.md). If a dependency
changes, include the lockfile and run `npm audit --omit=dev` and lockfile
verification. Do not edit generated files by hand; use their documented builder.

Keep public raster images in `assets/`, not base64 strings in TypeScript. The
Cloudflare build uploads that directory as Static Assets alongside the single
Worker. Node serves the explicit paths in `src/assets/public-assets.ts` from the
release checkout. Add new runtime images to that list and the source-export
binary allowlist. Use `npm run avatars:build` or `npm run brand:build` after
changing their source assets. PDF parsing remains server-side and is not a
public asset.

The Admin application's browser code lives in `assets/admin-ui/admin.js` and
`assets/admin-ui/admin.css`, served the same way. `src/admin/page.ts` renders
only the shell and a JSON config island the script reads at start-up. Static
Assets do not count toward the Worker size limit, so browser code must never
move back into a server template. `npm run build` fails when the uncompressed
Worker upload exceeds the budget in `scripts/verify-worker-size.mjs`; Cloudflare's
platform-wide limit is 64 MiB uncompressed across all plans.

Every Durable Object activation that starts an isolate loads the Worker's
static closure (the chunks its entry imports without `import()`) before its
constructor runs. Two budgets hold it: the source bytes of the repository
modules Worker startup loads (`tests/worker-startup-imports.test.ts`, in
`npm test` and `test:mcp`), and the built closure (`scripts/worker-closure.mjs`,
after a build). `npm run verify:budgets` builds and runs both.

- **Growth.** Both checks apply it: a change may add 16 KiB over its merge
  base. The closure check builds the base in a temporary export with this
  checkout's dependencies, so a dependency upgrade's own growth is not
  counted. A base that does not build fails the check with the build's
  output; when it cannot build with the checkout's dependencies, as on a
  train before an upgrade, `CHICKPEA_BUDGET_UNBUILDABLE_BASE=1` skips the
  changes that cannot be measured and checks the rest.
  A failure lists the modules that grew. When the growth is deliberate, add a
  commit trailer such as
  `Worker-Startup-Growth: 40 KiB, the connect route loads with every Agent` to
  the change; it raises that change's allowance to the size it names, at most
  128 KiB. Both checks print each change's growth and notes, and a PR that
  carries a note lists it in its description.
- **Startup-source ceiling.** A fixed total backstops the startup-source
  check; the built closure has no ceiling. It carries about 64 KiB of
  headroom, so parallel PRs do not collide on it. When a merge train fills
  it, set it once to the measured size plus 64 KiB. Lower it when a change
  shrinks startup.

With no CI to name a PR's base, both checks ask Git:
`git merge-base HEAD origin/main`, using `origin/main` as of the last
`git fetch origin main`. Both print the base. A branch is one change, measured
from that base to the working tree. On a train, each PR merged with `--no-ff`
is its own change, measured from its first parent, and so is each run of plain
commits between merges, such as the startup-source ceiling re-set. So a train
of PRs that each fit still passes. For a PR stacked on another branch, set
`CHICKPEA_BUDGET_BASE` to that branch; a ref with no merge base fails. A
checkout with no Git history or no `origin/main` skips the growth rule and
says so. `tests/worker-startup-imports.test.ts` also keeps the modules it lists
off Worker startup. Load code the reply path does not need with `import()`
where it is used.

Contributions are provided under the repository's [Apache-2.0 license](LICENSE).
Be respectful in issues and reviews; criticize the work, not the person.
