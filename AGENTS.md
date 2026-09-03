# Working on Chickpea

- Use a topic branch and a GitHub pull request by default. A maintainer may
  explicitly authorize a verified local worktree merge into root `main` and a
  direct push. Do not force-push `main`.
- Run tests and release verification locally. Do not add GitHub Actions workflows
  or require GitHub-hosted test results for merging.
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
- For Chickpea live Slack verification, read `qa/live/operator/SKILL.md` before
  acting. It points to the public catalog and runbook. Keep target coordinates,
  resolved aliases, journals, transcripts, screenshots, and evidence outside
  this repository.
