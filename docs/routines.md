# Scheduled routines

Chickpea routines are confirmed, channel-owned scheduled requests. The first release supports arbitrary read and write tasks on Cloudflare; channel watches, GitHub subscriptions, inbound-event triggers, continuing Agent sessions, and a Node scheduler are not included.

## Product contract

- Creation and edits are conversational, but persistence always requires a deterministic preview plus `!routines confirm <token>` within 15 minutes.
- Exact list/show/pause/resume/disable/run/clone/delete controls do not use a model. Delete requires a second confirmation and scrubs the Chickpea-owned task and revision bodies.
- Every occurrence re-resolves current Slack membership, channel eligibility, assignment, profile/model, connections, shared credentials, repository grants, memory scope, egress policy, spend bounds, and sandbox availability before constructing an Agent or tools.
- This is the same current channel authority as a live tag. There is no second per-routine allow/deny matrix. Actor-personal credentials are never delegated to unattended work.
- Each occurrence is a fresh Flue Workflow run and fresh Agent identity. It does not reuse a Slack thread or a continuing Agent session.
- Results post once at the top level of the owning channel. An explicit no-op is silent; `post_on_change` is silent when its canonical change key has not changed.
- Scheduled Work in `/admin/audit-logs/scheduled-work` shows definitions, revisions, runs, run audit events, current target capability, model/usage/resource fields, safe access hashes and errors, Slack receipts, and Flue run IDs. It also provides pause, resume, disable, and confirmed delete controls.

Anyone who is currently a member of the owning channel may manage its routines. If the creator leaves the organization but remains a channel member, the routine can continue. If the creator leaves the channel, or the bot/channel/assignment becomes ineligible, the next run fails closed and disables the routine before any model or tool construction.

## Schedule and execution policy

Schedules are normalized to a five-field cron expression plus an explicit IANA time zone. An omitted zone is shown as UTC in the preview. The pinned scheduler library supplies IANA/DST behavior; previewed instants and persisted occurrence slots are the product contract. The minimum interval is one hour.

One fixed `* * * * *` Cloudflare Cron Trigger runs the heartbeat. The heartbeat finds due product definitions, atomically creates an occurrence, and calls Flue `invoke(...)`. Static Cloudflare Cron configuration never represents user-created schedules.

Downtime does not replay a burst of stale writes. Chickpea records aggregate missed slots, considers only the latest due slot, and skips work that is more than 15 minutes late. A second due slot while the same routine is active is recorded as skipped. A repeated heartbeat or idempotency-key replay cannot create a second occurrence for the same schedule slot.

Chickpea may retry only a proven pre-submission admission failure. An ambiguous `invoke(...)` result is reconciled from the persisted Workflow input before another submission. Once execution starts, general write work is not blindly retried. An unknown tool or Slack-delivery outcome pauses the routine immediately; three attributable failures pause it; current-access failures disable it. Slack delivery is one at-most-once attempt with a durable receipt.

## Hard bounds and retention

The committed release bounds are:

| Bound | Value |
| --- | ---: |
| Active routines | 100 per deployment, 20 per channel |
| Scheduled starts | 240 per rolling day |
| Run-now starts | 10 per rolling day |
| Short-window starts | 4 per rolling 15 minutes |
| Concurrent runs | 4 per deployment, 1 per routine |
| Minimum interval | 60 minutes |
| Admission grace and occurrence deadline | 15 minutes |
| Due claims | 25 per heartbeat |
| Chickpea run/audit metadata retention | 365 days |

These are one versioned deployment contract, exposed read-only in Scheduled Work. They are not another layer of per-routine configuration.

Deleting a routine immediately removes its saved task from the definition, revisions, and product-owned run snapshots. Body-free product run/audit metadata remains for up to 365 days. Slack messages, model-provider processing or logs, backups, and Flue's separate run history have their own retention and cannot be retracted by Chickpea.

## Enable, verify, and roll back

The committed `wrangler.jsonc` has `TAG_ROUTINES_ENABLED: "0"`. In that state the scheduled handler returns without a state scan, model call, or Slack work; definitions and Scheduled Work remain inspectable and can be paused, disabled, or deleted.

Before enabling, run the offline gates with Node 24:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node npm run typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node npm test
PATH=/opt/homebrew/opt/node@24/bin:$PATH FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node npm run build
PATH=/opt/homebrew/opt/node@24/bin:$PATH FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node npm run verify:routines-runtime
PATH=/opt/homebrew/opt/node@24/bin:$PATH FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node npm run verify:cf-smoke
PATH=/opt/homebrew/opt/node@24/bin:$PATH FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node npm run verify:admin-ui
PATH=/opt/homebrew/opt/node@24/bin:$PATH FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node npm run verify:durability
```

Then change the Cloudflare variable to `"1"`, rebuild, and deploy through `npm run deploy`. The deploy wrapper refuses an enabled artifact unless it finds exactly one heartbeat Cron, `TAG_STATE`, `FLUE_ROUTINE_WORKFLOW`, the composed scheduled handler, and the internal Agent route guards. It never runs a product-changing routine as a deploy epilogue.

The first live release still requires separately authorized acceptance in a fresh Slack channel with disposable targets: one read, one reversible write, one no-op, current-credential revocation, creator removal, forced admission/delivery failures, Scheduled Work/Flue linkage, and proof of no duplicate effect or post.

To stop unattended work, set `TAG_ROUTINES_ENABLED` back to `"0"` and deploy. Do not delete the Cron, Workflow binding, Durable Object state, or migrations as a rollback shortcut. The disabled handler performs no catch-up work, while operators retain inspection and shutdown controls.

## Troubleshooting

1. Open Scheduled Work and inspect the routine state, next fire, latest occurrence, failure class, safe error, delivery receipt, and Flue run ID.
2. For `creator_ineligible`, `channel_ineligible`, `assignment_missing`, `credential_unavailable`, or `access_denied`, repair current channel authority. Chickpea deliberately does not fall back to another credential.
3. For `admission_unknown`, inspect Flue run history for the occurrence ID before using run-now. Do not assume the Workflow was absent.
4. For `unknown_external_outcome` or `delivery_unknown`, inspect the external system or channel first. The routine is paused because the effect may already exist.
5. For `capacity_limited` or `slack_rate_limited`, inspect the visible occurrence and deployment bounds. Chickpea does not silently retry a write or Slack post.
6. Resume only after the cause and any ambiguous external effect are understood. Resume resets the attributable-failure streak; it does not erase run or audit history.

Heartbeat logs are deliberately body-free: stable event name, counts, maintenance totals, and duration only. They must never contain task text, prompts, channel content, credentials, model output, actor identifiers, or raw errors.
