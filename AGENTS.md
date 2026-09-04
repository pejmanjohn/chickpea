# Working on Chickpea

- Use a topic branch and a GitHub pull request by default. A maintainer may
  explicitly authorize a verified local worktree merge into root `main` and a
  direct push. Do not force-push `main`.
- Run tests and release verification locally. Do not add GitHub Actions workflows
  or require GitHub-hosted test results for merging. The one exception is
  `.github/workflows/publish-cli.yml`, which runs only on a `cli-v*` tag to
  publish `packages/cli` to npm; it is not a merge gate and never runs on push.
- Do not squash existing repository history, create release tags, or publish a
  release without an explicit request. A request to implement a change does not
  authorize a production deployment.
- Preserve unrelated changes. Keep private environment bindings, credentials,
  live transcripts, and working documents out of the public repository.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md). Run tests and builds serially in each
  checkout. Use isolated databases for tests; never reset an operator's state.
- For Cloudflare deployment use `npm run deploy` (the guarded wrapper), not bare
  `wrangler deploy`. Confirm the intended target before any live mutation.
- Report local checks and live acceptance separately. A source SHA, build, or
  deployment upload is not evidence of a real Slack reply.
- For repeated implementation/retest cycles against real Slack, start with an
  exclusive local Cloudflare Worker lane from
  [local Worker development](docs/runbooks/local-worker-development.md). Run
  `npm run dev:cf -- status --lane <lane>` before acting; it must identify the
  workerd runtime, HTTP Slack transport, immutable app/workspace pair, provider
  model, persistent state, public endpoint, and owning worktree. Local passes do
  not satisfy shared-gateway or deployed Amber/Cobalt acceptance.
- For Chickpea live Slack verification, invoke `$chickpea-live-verification`.
  A request to run it authorizes its declared QA actions and exact cleanup,
  including test messages, product approvals, and OAuth with registered test
  accounts. Do not request the same permission at every step. Use its mode and
  authorization boundaries; production/shared infrastructure are outside scope.
  If skill discovery is unavailable, read `qa/live/operator/SKILL.md` before
  acting. It points to the public catalog and runbook. Keep target coordinates,
  resolved aliases, journals, transcripts, screenshots, and evidence outside
  this repository.
- For runtime failures, unexplained behavior, or timing issues, consult existing
  evidence and [runtime observability](docs/runbooks/runtime-observability.md).
  Use `npm run diagnose -- --help` for a bounded request-to-trace lookup and
  preserve the first failure's private evidence before changing state or retrying.
  Use the owning terminal and Local Explorer for a local Worker. Diagnose on the
  deployed Worker when the question depends on its serving version, bindings,
  gateway route, credentials, Cloudflare telemetry, or due-time scheduling.
  Use Cloudflare API MCP (`cloudflare-api`) `search` then `execute` for bounded
  historical logs, invocations, traces, aggregate metrics, and read-only
  infrastructure inspection; prefer `dry: true` queries. Use Wrangler `tail`
  for authorized live reproductions, attached before the action and stopped
  afterward. Use the dashboard for visual traces or access fallback.
- Resolve the account, Worker, environment, and serving version before querying.
  MCP, Wrangler, and dashboard access are independent. Missing telemetry is not
  proof of product failure; Slack/Admin/provider readback remains acceptance.
  Keep logs and incident artifacts private. Use existing repository commands
  for local development/builds and the guarded wrapper for deployments.
