# Contributing to Chickpea

Chickpea is a self-hosted Slack agent. Small, focused contributions are welcome.
For a substantial feature or behavior change, open an issue first so we can
agree on the problem and scope. Report security vulnerabilities privately;
see [SECURITY.md](SECURITY.md).

## Local development

Use Node 24.x, minimum 24.20.0. `.nvmrc` pins 24.20.0 as the single
development, build, and verification baseline; both packages require
`>=24.20.0 <25`. Update that pin for future Node 24 patch/security releases
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

For iteration, `npm run verify:regression -- --plan` selects checks from the
branch and working changes. Run without `--plan` to execute them, or select
`--area routines` and other named areas explicitly. `--mode regression` runs
the fixed core checks; `--mode release` runs the full local sequence on clean
committed source. These commands need no browser, live account, or OAuth.
Use `$chickpea-live-verification` for the corresponding real QA journeys.
Its private [run record](qa/live/operator/records.md) can also capture offline
checks with `verify:regression --record <private-run.json>`. Add `--reuse` only
for unchanged repeats; release mode always executes its full checkpoint.

Run builds and tests **serially**: tests inspect generated artifacts, so a
concurrent build can make them read a partially written artifact.
Full suites, builds, and workerd groups also share one host reservation across
worktrees. `verify:regression` acquires it automatically. Wrap standalone groups
with `npm run verify:host -- COMMAND [ARG ...]`; see
[host coordination](qa/live/operator/host-checks.md). Focused unit checks can run
independently when they do not build artifacts or start heavy fixtures.
All verification runs locally. This repository does not use GitHub Actions
workflows or GitHub-hosted test runs, except the tag-triggered npm publish of
`packages/cli` (`.github/workflows/publish-cli.yml`), which is not a merge gate.

For iteration, choose the checks relevant to the change from this list. For a
stable committed candidate, use `verify:regression -- --mode release` once; it
runs the full suite and offline turn/durability/provider checks inside the clean
export, so do not also run those as a second outer release gate.

```sh
npm run build
TAG_DB_PATH=:memory: SLACK_STATE_DB_PATH=:memory: CHICKPEA_AUTH_DB_PATH=:memory: TAG_REQUIRE_LOOPBACK=1 npm test
npm run verify:admin-ui
DO_NOT_TRACK=1 node scripts/verify-flue-offline-turn.mjs
DO_NOT_TRACK=1 npm run verify:durability
DO_NOT_TRACK=1 npm run verify:providers
DO_NOT_TRACK=1 npm run verify:cf-smoke
npm run verify:lockfile-integrity
```

The offline verifiers use fake Slack/provider services and isolated local state.
They do not require production credentials. `verify:cf-smoke` builds both
Cloudflare profiles and runs the core profile in local workerd; it takes several
minutes. Each run uses a free local port and its own disposable temporary state;
it does not reset an operator's local Worker state.

After committing the proposed source, run `npm run verify:oss-export`. It checks
an archive of **HEAD**, not uncommitted edits, installs from the lockfile, and
runs tests, offline runtime checks, and a deployment dry run in a temporary
directory. Private working documents must stay outside the public export;
adding a public document requires updating the explicit export allowlist.

Local automated checks cannot establish real Slack/provider acceptance.
Changes to setup, authority, delivery, or persistence also need the relevant
attended checks from the [release checklist](docs/runbooks/releasing.md). Do not describe a build or
fake-backend result as live acceptance.

## Where things live

| Area | Source |
| --- | --- |
| Slack transport, delivery, attachments, avatars | `src/slack/` |
| Agent execution | `src/agents/` |
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
move back into a server template. `npm run build` fails when the compressed
Worker exceeds the budget in `scripts/verify-worker-size.mjs`; the Workers Free
plan caps a Worker at 3 MiB compressed.

Contributions are provided under the repository's [Apache-2.0 license](LICENSE).
Be respectful in issues and reviews; criticize the work, not the person.
