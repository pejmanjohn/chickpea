# Routines Runtime Spike

Decision record for implementation unit U1 in the 2026-07-27 routines plan.
Checked against `@flue/runtime` and `@flue/cli` 1.0.0-beta.8, Wrangler 4.103.0,
Node 24.16.0, and `@slack/web-api` 8.0.0-rc.1.

Run the hermetic gate with:

```sh
PATH=/path/to/node/bin:$PATH \
FLUE_NODE_BIN=/path/to/node/bin/node \
npm run verify:routines-runtime
```

## Proven runtime contract

- Flue's Cloudflare build composes an authored default `scheduled()` handler
  with its generated `fetch()` handler and preserves the static Cron Trigger,
  workflow Durable Object binding, and migration.
- A scheduled handler can call `invoke()` and receives a framework-generated
  `runId`. There is no caller-supplied workflow run ID in beta.8.
- The Workflow Agent initializer receives that `runId` as its `id`. It can use
  server-side `getRun(id)` to recover and validate the persisted occurrence
  input before the Action runs.
- `listRuns({ workflowName })` and `getRun(runId)` see admitted work from the
  scheduled handler. Local workerd observations were 7-39 ms; the regression
  gate permits up to five seconds and requires both inspection paths to agree.
- Omitting a Workflow `route` and `runs` export keeps the generated workflow
  admission and run-inspection HTTP routes at 404. The inline Agent also has no
  public route. Chickpea's authenticated product surfaces must remain the only
  routine/run inspection boundary.
- Flue beta.8 exposes no public run-history deletion or retention primitive.
  Chickpea's routine occurrence ledger is therefore the product-owned source
  for retention, redaction, and audit lifecycle; Flue history is correlated
  execution evidence, not the product database.
- Flue's prompt contract accepts an `AbortSignal`, tool contexts receive that
  signal, and Chickpea's Workers AI provider forwards a caller abort into the
  active binding request. The routine Workflow must construct one occurrence
  deadline signal and pass it to every prompt/tool/sandbox operation.
- The installed Slack client returns a channel/message timestamp on confirmed
  delivery, but `chat.postMessage` has no request-side `client_msg_id` field.
  With retries disabled, a timeout after the request is accepted is
  indistinguishable from a delivered response that was lost. Routine delivery
  must record `delivery_unknown`, must not post blindly again, and must expose
  the occurrence for operator reconciliation.

## Recurrence library decision

Two Workers-compatible IANA-timezone cron libraries were evaluated with the
same hourly, spring-forward, fall-back, and pathological-expression probes:

| Library | Version | Dependency shape | DST behavior | Decision |
| --- | --- | --- | --- | --- |
| Croner | 10.0.1 | 154,686 unpacked bytes, no dependencies | Spring gaps advance by the gap; fall folds run once at the first matching instant | Selected |
| cron-parser | 5.6.2 | 147,156 unpacked bytes plus Luxon (about 4.7 MB total) | Same observed behavior | Rejected for the first slice |

Both parsed the pathological probe in under 6 ms on Node 24. Croner gives the
required IANA timezone and next-occurrence semantics with a materially smaller
dependency graph. Chickpea pins 10.0.1 exactly and will wrap it behind its own
bounded parser/normalizer so the persisted schedule contract does not become a
third-party API.

The product contract uses these explicit policies:

- nonexistent local time: advance by the DST gap to the resulting valid local
  time;
- repeated local time: run once, at the first matching instant;
- schedules remain normalized cron plus an explicit IANA timezone;
- parser work is bounded before persistence and scheduler scans never accept
  unbounded user expressions directly.

## Architecture decision

Proceed with the plan's Cloudflare V1 architecture: one fixed one-minute Cron
Trigger scans product-owned persisted routine definitions and invokes one fresh
Flue Workflow for each claimed occurrence. This spike does not justify public
Flue routes, continuing Agent sessions, per-routine Durable Object alarms, or
Node scheduling parity.
