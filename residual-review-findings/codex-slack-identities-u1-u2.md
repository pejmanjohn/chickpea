# Slack identities U8 review residuals

Accepted for follow-up on 2026-08-05 while completing
`docs/plans/2026-08-01-002-feat-slack-identities-plan.md`.

Review run: `/tmp/compound-engineering-502/ce-code-review/20260803-112321-5de4bbe6`

The validated mechanical and correctness findings from that review were fixed
and verified. The items below require a separate architecture or scaling change
and are not required to combine Slack Identities with the landed Agent View
stack or to run the disposable Acme acceptance matrix.

## P1: make identity mutation audit persistence atomic

- Original location: `src/admin/routes.ts:3038`
- Finding: identity configuration can commit before its separately persisted
  audit record. An audit-store failure can therefore leave a successful
  mutation without the required event.
- Follow-up shape: introduce a store-level identity command/outbox that commits
  the configuration transition and audit intent atomically, then reconciles any
  credential-store work from that durable command state. Cover create, connect,
  verify, attach, DM change, cancel, and retire with injected audit failures.

## P1: remove identity-list N+1 reads and JSON job scans

- Original location: `src/admin/routes.ts:2967`
- Finding: the identity inventory performs per-identity Profile, DM handler,
  and pending-delivery reads; pending counts repeatedly inspect JSON job data.
- Follow-up shape: bulk-load Profiles and DM assignments, add a grouped pending
  count query, and evaluate persisting/indexing the resolved Slack identity on
  TurnJobs with an explicit migration and backfill plan.

## P1: bound Slack membership preflight concurrency

- Original location: `src/admin/routes.ts:4710`
- Finding: channel information and join calls run serially across every
  assignment, so latency grows linearly.
- Follow-up shape: add a small concurrency-limited pool with deterministic
  result ordering, deadline-bounded join calls, and preserved Slack rate-limit
  metadata. Validate behavior under slow responses and 429s before rollout.

## P2: purge expired setup callback bodies without later access

- Original location: `src/slack/identity-handshake.ts:92`
- Finding: expired raw callback envelopes self-purge when read, verified,
  cancelled, or replaced, but an inactive setup can retain one indefinitely.
- Follow-up shape: design a target-neutral retention scheduler or enumerable
  expiry index for both Cloudflare and Node. A Cloudflare-only cron sweep is
  insufficient because Node currently has no equivalent lifecycle and the
  Settings store cannot enumerate pending challenge keys.
