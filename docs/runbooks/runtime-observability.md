# Runtime observability

Use this runbook for runtime failures, unexplained behavior, and timing issues,
including live verification. Start with retained evidence, not new diagnostics.
Logs explain causes; actual Slack/Admin/provider readback proves acceptance.
Successful actions do not require routine log inspection.

## Diagnose one request

Use `npm run diagnose -- --help` to prepare a repeatable investigation from a
Slack **request** permalink or a Sessions Run ID. A reply permalink identifies a
different message. Scheduled Runs need their Run ID. Resolve the target first
as described below; the command does not claim, start, deploy, or mutate it.

```sh
npm run diagnose -- prepare --target amber \
  --account-id <resolved-account-id> --admin-origin https://<resolved-admin-host> \
  --slack-url https://<workspace>.slack.com/archives/<channel>/p<message-timestamp>
```

The registered target supplies the Worker and workspace. For another installation,
pass `--worker <exact-worker> --workspace <workspace-id>` instead of `--target`.
For the **owning local lane**, use those explicit coordinates with `--local
--admin-origin http://127.0.0.1:<port>` after checking `dev:cf status`. Local mode
queries Local Explorer; it does not use Cloudflare history. The loopback origin
must be the same Worker whose Admin session you read.

The command prints a private record directory and a content-free Sessions URL.
Read that URL through the existing authenticated Admin browser and save its JSON
outside Git. This endpoint has the same authorization and private-work exclusions
as Sessions. It does not read retained message bodies or configuration contents.
If the deployment predates the endpoint, the command can project an ordinary
Sessions response, but that older response lacks the Flue correlation references.

```sh
npm run diagnose -- query --record <private-record-directory> \
  --session <private-session-response.json>
```

`query` checks the Run and workspace, saves only the operational projection, and
creates a new private attempt directory every time. For hosted diagnosis, discover
the current API schema with Cloudflare MCP `search`, then pass the generated
`cloudflare-query.js` as `execute` code with the printed account ID. Save the
returned projected object at the printed report path. For local diagnosis, POST
the generated `local-query.json` to the printed loopback Local Explorer URL and
save its response there. Local rows are paired with the saved Sessions timeline;
zero rows or the 300-row cap means incomplete evidence, not a failed action.
Keep the original response private if it contains older Sessions content.

The helper joins opaque Flue submission references from the ledger to
`run.correlation` log events, then queries exact platform trace IDs. Management
and routine metrics are single structured console objects, so Cloudflare can
index their fields. The bridge contains only hashed instance/submission refs;
platform logs supply request/trace IDs. No prompt, tool arguments/results, or
new product analytics events are added. Historical reports also understand the
older prefixed JSON log format.

Without a retained bridge (older builds, missing ledger, or missing logs), keep
the correlation gap. An independently established trace can be passed to
`prepare --trace-id <trace-id>`; reports label it **operator supplied**, not
ledger verified. Use `query --no-session` only when Sessions is unavailable.
Use `--run-id <id> --from <UTC-Z> --to <UTC-Z>` when there is no permalink.
The default permalink window is one minute before through sixteen minutes after
the request; explicit windows may span at most thirty minutes. Query pagination
and trace counts are bounded; the report records coverage gaps and distinguishes
the current traffic version from versions observed on incident events. An early
failure before Run admission requires the ingress investigation below.

At the first failure, retain the existing verification record, these evidence
paths, expected versus observed behavior, actual model/build, and UTC window
before changing state or retrying. Record the hypothesis and changed variable
with the next attempt. Save Slack/Admin/provider readback and cleanup separately;
the diagnostic report does not grade acceptance. This preserves the first failure
without repeating broad log discovery during every retest.

## Choose the tool and target

| Need | Tool |
| --- | --- |
| Historical events, invocations, traces, aggregate metrics, read-only infrastructure | Cloudflare API MCP `cloudflare-api`: discover with `search`, call with `execute` |
| Live logs during an authorized reproduction | Wrangler `tail`, attached before the action and stopped afterward |
| Visual trace waterfall or access fallback | Signed-in Cloudflare dashboard |
| Local workerd runtime, requests, reloads, state | Owning `npm run dev:cf -- start` terminal and `/cdn-cgi/local/explorer` |
| Local builds and deployed mutation | Existing repository commands; deployments only through `npm run deploy` |

MCP, Wrangler, and dashboard authorization are independent. An error in one
does not establish that the others are unavailable. Do not change credentials,
permissions, collection settings, or deployments to follow this runbook.
Keep the [environment claims and deployment fences](parallel-live-test-environments.md)
and [attended live workflow](../../qa/live/operator/SKILL.md).

For a local lane, first run `npm run dev:cf -- status --lane <lane>` and verify
the workerd runtime, HTTP Slack transport, app/workspace IDs, state path,
endpoint, model, owning worktree, PID, and source SHA. Inspect the owning
terminal and Local Explorer, including its local observability API. Do not look
for local invocations in Cloudflare dashboard/MCP telemetry. Switch to the
deployed path below when the question involves a deployed serving version,
binding or credential, shared gateway, traffic allocation, Cloudflare telemetry,
or real scheduled due-time delivery. See
[local Worker development](local-worker-development.md).

Resolve the account, exact Worker name, environment, and serving version from
the private environment record and live deployment evidence. Do not infer them
from this checkout or the MCP default account. Discover the read-only
`GET /accounts/{account_id}/workers/scripts/{script_name}/deployments`,
`/versions/{version_id}`, and `/settings` endpoints with `search` as needed.
Inspect active traffic allocations, not just the newest uploaded version.
For old failures, use the version serving that request at that time. Include
the gateway or downstream Worker only when routing evidence places it in scope.
Project only needed metadata from settings; do not dump bindings or variables.

In the existing private record, keep the environment, account/Worker, serving
version and source/build reference, UTC start/end, Slack workspace/channel and
request timestamp or permalink, and available request/run/trace/span IDs.
Convert local UI times explicitly. Preserve the ID links across ingress, Agent
execution, tools, and delivery. Time proximity alone does not prove attribution.

## Historical events through MCP

First pass this JavaScript as `code` to `cloudflare-api.search`:

```js
async () => {
  const base = '/accounts/{account_id}/workers/observability/telemetry/';
  return ['keys', 'values', 'query'].map(name => {
    const op = spec.paths[base + name]?.post;
    return { path: base + name, summary: op?.summary,
      request: op?.requestBody?.content?.['application/json']?.schema };
  });
}
```

If the schema output is truncated, request just the needed properties. Verify
the response schema too before parsing it. These POSTs query data; `dry: true`
on `/query` executes without persisting results. It is not a syntax-only check
or a switch that makes arbitrary API mutations safe.

Use `execute` with an explicitly resolved `account_id`. Replace placeholders
below from the private record. Use the same bounded UTC window throughout.
`Date.parse` produces the API's Unix milliseconds, not seconds.

Discover field names and types with `POST .../telemetry/keys`, body
`{ from, to, limit: 50, keyNeedle: { value: 'version', matchCase: false } }`.
Repeat for the needed service, request, run, or trace key. Discover values with
`POST .../telemetry/values`, body
`{ timeframe: { from, to }, datasets: [], key, type, limit: 20 }`.
Use a verified Worker filter on these lookups once known. Keys uses top-level
`from`/`to`; values and query use `timeframe`. Do not assume a missing key/value
means there was no event outside this window or dataset.

Example `execute` code after verifying the service field and value:

```js
async () => {
  const account = '<resolved-account-id>';
  const worker = '<resolved-worker-name>';
  const from = Date.parse('<start-UTC-ISO8601>');
  const to = Date.parse('<end-UTC-ISO8601>');
  return cloudflare.request({
    method: 'POST',
    path: `/accounts/${account}/workers/observability/telemetry/query`,
    body: {
      queryId: 'runtime-investigation', dry: true, view: 'events',
      timeframe: { from, to }, limit: 30,
      parameters: { filterCombination: 'and', filters: [
        { key: '$metadata.service', type: 'string', operation: 'eq', value: worker }
      ] }
    }
  });
}
```

Add verified version and correlation-ID filters with their actual field types.
Inspect query execution status, limits, and pagination, not only HTTP success.
The events payload is `result.events.events`; its `fields` describes returned
fields. Keep raw results private. If more evidence is needed, page with the
documented cursor or narrow the window instead of dumping the account's logs.

## Correlated invocations and traces

Use the same `/query` body with `view: 'invocations'` to group events by request
ID, or `view: 'traces'` for trace summaries. Discover the request or trace field
and filter to an ID from the affected event. `result.invocations` is keyed by
request ID; `result.traces` contains summaries with `traceId` and timing.
Do not confuse the observability query's `result.run.id` with a Chickpea run ID.

Log and span version fields can differ. Discover them for the relevant data;
do not carry a log-only version filter into a trace query and interpret an empty
result as absence. Once a trace is identified, follow its parent/child spans,
including attributable downstream Workers with their own versions. A service
filter may omit those spans.

For a waterfall, open the matching Worker's Observability in the dashboard,
set the same UTC window, and use **View invocation** or **View trace** from the
matched event. Check UI timezone and filters when comparing API and dashboard
results. Inspect tool outcomes inside otherwise successful invocations: do not
filter only failed Worker invocations or HTTP errors.

## Aggregate queries

For a bounded count or latency breakdown, reuse the query with these body
fields, retaining the verified Worker/version filters in `parameters`:

```js
{
  view: 'calculations', dry: true, chartType: 'aggregate', limit: 10,
  parameters: {
    filters, filterCombination: 'and',
    calculations: [{ operator: 'count', alias: 'matching_events' }],
    groupBys: [{ type: 'string', value: '<verified-event-or-outcome-field>' }],
    orderBy: { value: 'matching_events', order: 'desc' }
  }
}
```

Keep `queryId` and `timeframe` from the original body. Counts above count matched
telemetry rows, not necessarily requests or tool calls. For request metrics,
first select the discovered invocation-event type; for latency add, for example,
`{ operator: 'p99', key: '<verified-duration-field>', keyType: 'number' }` and
record the unit. Read aggregates and sampling metadata, and label incomplete or
sampled results. Do not turn a sampled count into an exact delivery assertion.
The [Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/)
offers the corresponding visual filters and calculations.

## Bounded live capture

Use Wrangler's existing WebSocket client. MCP exposes tail-setup endpoints but
calling them alone does not consume a stream; do not build another client.

1. Check existing effects and cleanup before reproducing. Name the missing
   evidence, one authorized action, and a stop deadline, such as five minutes.
2. Verify the installed CLI with `npx wrangler tail --help`. Resolve the private
   account, Worker, serving version, and existing target config. Use an existing
   auth profile if required; never print credentials. From this repository:

   ```sh
   CLOUDFLARE_ACCOUNT_ID="$OBS_ACCOUNT_ID" npx wrangler tail "$OBS_WORKER" \
     --config "$OBS_WRANGLER_CONFIG" --version-id "$OBS_VERSION_ID" --format json
   ```

   The `OBS_*` variables are private operator inputs, not repository defaults.
   If the resolved config uses a named Wrangler environment, add its actual
   `--env` value; a Chickpea lane alias is not automatically a Wrangler env.
3. Confirm the client reports connection readiness for the intended Worker
   before the action. Retain the bounded terminal capture in the private run
   record. Avoid `--status error`, IP, or text filters that would hide successful
   invocations containing failed tools. `--search` matches log text, not a
   general trace query. Capture each evidenced Worker separately if necessary.
4. Perform the single attributable action under the existing environment claim,
   using the task's own browser tab.
   Stop with Ctrl-C after its outcome or the deadline, even if no event arrives;
   confirm the tail process exited. Do not leave capture running across OAuth
   waits. Record capture start/end, readiness, filters, sampling warnings, and
   gaps. Live capture does not backfill earlier events.
5. If tail authorization fails, use historical MCP or the dashboard where
   available and record the capture gap. Do not change permissions or replay
   an uncertain mutation. Finish actual UI readback and exact cleanup.

See [real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)
and [Wrangler tail](https://developers.cloudflare.com/workers/wrangler/commands/workers/#tail).

## Missing evidence and content boundaries

Before inferring absence, check effective log and trace collection/sampling
separately, current retention, account limits, query filters, pagination,
truncation, and capture gaps. Inspect `$workers.truncated` where available.
Collection enabled now does not backfill omitted history or guarantee complete
capture. A missing tool log does not prove that the tool was never called.
Consult current [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
and [Traces](https://developers.cloudflare.com/workers/observability/traces/)
documentation rather than assuming a fixed allowance or temporary access state.

Classify behavior as product, verifier, environment, or unknown separately from
telemetry gaps. Before adding diagnostics, state exactly what retained evidence
cannot establish. Start with existing structured errors and logging facilities;
preserve the content-free tracing configuration in [the runtime](../../src/cloudflare.ts)
and field allowlists in [management logging](../../src/management/telemetry.ts).
Do not log raw conversations, instructions, credentials, unrestricted arguments,
results, or arbitrary error text. This runbook grants no instrumentation authority.

Keep raw logs, account coordinates, activation/access details, incident records,
and screenshots outside the public repository and package. Redact before sharing.
Runtime observability is separate from [PostHog product analytics](../../TELEMETRY.md),
whose closed, anonymous event contract must not receive operational logs or IDs.

## Reading a bounded `wrangler tail`

`npx wrangler tail <worker> --format json` prints pretty-printed JSON objects
back to back, not one object per line. Split the capture on top-level braces
before filtering. Each object carries `entrypoint` (`TagStateStore` for the
state Durable Object), `logs[].message[]`, `exceptions[]`, and `outcome`.
Ignore `[chickpea:activity]` refresh, queue, and rate events when hunting a
stall; they fire on every poll.

A run that keeps logging `memory_metric {"event":"delivery_lease","outcome":"rejected"}`
every few seconds has not failed: it is waiting for the thread's delivery lease
held by another run or incarnation and will look like "Thinking…" in Slack.
Record the thread, its route owner, and the triggering message, then diagnose
from `src/slack/claim-store.ts` rather than resending the request.

## Turn latency and relay alarm logs

Five content-free events measure inbound delivery and turn scheduling. Each is one structured
console object with `component: "runtime"` and an `event` name, so Workers Logs
indexes its top-level fields. Values are non-negative integer milliseconds,
booleans, fixed tokens, or opaque references; no message text, Slack user or
channel IDs, settings keys or values, or error text. Emission never throws.

| `event` | Emitted | Fields |
| --- | --- | --- |
| `relay_alarm` | Once per `TagStateStore.alarm()` invocation (Cloudflare) | `outcome` (`idle`, `drained`, `threw`), `durationMs`, `jobsListed`, `groups`, `jobsRun`, `jobsSettled`, `jobsRetained`, `jobsCarried`, `longestJobMs`, `turnsMs`, `needsRetry`, `rearmed`, `yielded`, `jobsDispatched` |
| `thread_runner_alarm` | Once per `SlackThreadRunner.alarm()` invocation (Cloudflare) | `outcome` (`idle`, `drained`, `threw`), `jobs`, `ran`, `yielded`, `carried`, `durationMs` |
| `turn_latency` | Once per relay attempt of one turn (both lanes) | `turnRef`, `runRef`, `lane` (`cloudflare`, `node`), `executor` (`alarm`, `runner`, `node`), `attempt`, `outcome` (`returned`, `threw`), `firstWrite`, `final` (`delivered`, `deferred`, `none`), `admissionToStartMs`, `admissionToFirstWriteMs`, `admissionToFinalMs`, `receiptToAdmissionMs`, `receiptToFirstWriteMs`, `attemptMs` |
| `state_rpc` | Sampled calls from a `Cf*Store` proxy into `TagStateStore` | `method` (RPC name), `op` (request kind for `*Execute` RPCs), `ms`, `slow`, `ok`, `isolateCalls`, `isolateSlowCalls` |
| `gateway_delivery` | Once per authenticated gateway delivery at Worker admission (Cloudflare) | `transport` (`http`, `socket`), `deliveryKind` (`event`, `agent_selected`, `channel_agent_add`), `outcome` (`accepted`, `duplicate`, `rejected`, `failed`), `lagMs`, `slackLagMs`, `sessionPhase`, `sessionHealth`, `sessionAttempt`, `sessionGeneration`, `sessionAgeMs` |

- `relay_alarm.durationMs` is the whole invocation; `turnsMs` is the turn
  drain and `longestJobMs` the slowest single turn attempt in it. `jobsListed`
  is the first pending listing: up to 4 rows from each of up to 16 threads.
  The drain keeps admitting while turns run, so `groups` (distinct threads
  that ran) and `jobsRun` can exceed it. `jobsRetained` counts attempts left
  pending for a later alarm (a budget yield included), `jobsCarried` the turns
  still running at the 12-minute hard cap (they settle after this record), and
  `yielded` whether the 10-minute observation budget ended with work
  observing.
- Cloudflare turns run in per-thread `SlackThreadRunner` Durable Objects by
  default: the alarm hands each new turn to its thread's runner and returns,
  so on a default deployment `relay_alarm.jobsDispatched` counts those
  hand-offs, `jobsRun` stays 0 except for legacy rows (turns the alarm had
  already dispatched to Flue before the runner became the default, which it
  finishes itself), and `turn_latency` reports `executor: runner`. The
  `turn_jobs.executor` column records the owner (`alarm`, `handoff` until the
  runner confirms, `runner`); a runner's turns stay with it when the executor
  changes.
- Emergency fallback: the deploy variable `SLACK_TAG_TURN_EXECUTOR=alarm`
  (not a setting; `npm run deploy -- --var SLACK_TAG_TURN_EXECUTOR:alarm`)
  keeps new turns on the state store's alarm, as described above, with
  `turn_latency` reporting `executor: alarm` and `jobsDispatched` 0. Unset,
  `runner`, and unfamiliar values keep the default; the deploy preflight
  accepts only `runner`, `alarm`, or unset. A Worker without the
  `SLACK_THREAD_RUNNER` binding also runs turns on the alarm.
- `thread_runner_alarm` is logged by each thread runner. `jobs` is the
  unsettled jobs it held at the start, `ran` the turn attempts it ran. A
  runner observes a turn for at most 10 minutes per alarm, then `yielded` is
  true and it reattaches a second later; a yield is never an attempt. While a
  job runs its wake is kept 5 seconds ahead, so an evicted runner resumes
  from the turn row's receipt instead of dispatching again. After a deploy,
  a runner whose alarm handler was running on the old version resumes only
  when that handler returns (alarms never overlap per object): on Amber this
  took about 3 minutes, during which the turn shows its last status. `carried`
  counts turns still running at the 12-minute cap. Runner turns log
  `turn_latency` with `executor: runner`. The runner keeps the turn's Slack
  presentation in its own storage and repairs it itself; the state store's
  presentation copy is refreshed at lifecycle changes, and its repair sweep
  skips runner-owned turns.
- `turn_latency` measures from `turn_jobs.enqueued_at` (durable admission)
  and from `turn_jobs.received_at` (receipt). A gateway delivery becomes a turn
  row only when an alarm drains the gateway inbox, so while a long turn holds
  the alarm it waits before admission: `receiptToAdmissionMs` is that wait
  (receipt = the inbox's `accepted_at`) and `receiptToFirstWriteMs` is the
  user-facing first-status latency. For HTTP and Node admissions receipt equals
  admission. Rows admitted before this field existed omit the receipt fields.
  `firstWrite` names the first Slack effect the attempt saw acknowledged:
  `agent_session` (Agent View processing), `activity_status`, `reaction`,
  `stream`, or `final`. A durations field is absent when it cannot be measured,
  for example `admissionToFinalMs` on a `deferred` terminal. A retried turn logs
  one record per attempt. A durable recovery notice runs a second `runTurn` in
  the same attempt, so a turn can log two records with the same `attempt`
  (`outcome: threw`, then `returned`); for first-status latency use the record
  with the lowest `receiptToFirstWriteMs` (or `admissionToFirstWriteMs` when
  the receipt fields are absent).
  `runRef` equals the `Slack presentation finalized` record's `runRef`, and
  `turnRef` is a hash of the turn job ID. Thread follow-ups admitted without a
  run ID carry neither `runRef` nor `attempt`; group them by `turnRef`.
- `gateway_delivery` is logged when a delivery reaches admission: by
  `TagStateStore.receiveGatewayHttp` for HTTP push (after signature
  verification; challenges and rejected signatures log nothing) and by the
  `SlackGatewaySession` socket handler before it calls `admitGatewayDelivery`.
  `lagMs` (HTTP only) is receipt minus the gateway's signed `issuedAt` for that
  attempt; socket frames carry no gateway timestamp. `slackLagMs` is receipt
  minus the Slack event's `event_ts` (else the whole-second `event_time`), so a
  large `slackLagMs` with a small `lagMs` means the gateway itself received the
  event late (for example a Slack retry), while a large `lagMs` means the
  gateway held it. The `session*` fields (socket only) are the delivering
  runner's phase and checkpoint when the frame arrived: `sessionAgeMs` is time
  since that session became ready, and `sessionAttempt` the reconnect count.
  A late event on a session younger than its lag was not flushed when the
  session connected. Clock skew between Slack, the gateway, and Cloudflare is
  not corrected; a negative lag is logged as 0.
- `state_rpc` is logged by the calling isolate (a Flue agent Durable Object,
  CodingWorker, or the Worker), not by `TagStateStore`. Every call at or above
  250 ms, and every failed call, is logged with `slow`/`ok`; otherwise one call
  in 100 per isolate is logged as a baseline sample. The counters reset when the
  isolate restarts. Workers clocks advance only across I/O, so `ms` is the
  awaited RPC round trip including queueing in the singleton, not CPU time.
- A Slack turn on Cloudflare freezes a turn envelope when its dispatch is
  prepared: the Agent's liveness and repository grants, sandbox settings,
  OpenAI auth method, model catalog, GitHub App presence, and image model.
  The Agent and its coding workers fetch it once per turn
  (`method: 'slackTurnEnvelopeGet'`), so `configGetAgent` and reads of those
  settings should not appear from an agent isolate during such a turn.
  Secrets (provider keys, the GitHub App key, connector and OAuth tokens, the
  Browserbase key) and live authority checks are still read at use, and
  writes (usage, memory, reservations) still go to the singleton. A settings
  change or Agent disable made mid-turn applies from the next turn; a tool
  that fails on a frozen setting re-resolves it live once. Routine runs, Node
  installs, and turns dispatched before this existed read live throughout.

To query a deployed Worker, discover the `event` key with `/telemetry/keys`
(`keyNeedle: { value: 'event' }`), then filter the events query on it with
`{ key: '<verified event key>', type: 'string', operation: 'eq', value: 'turn_latency' }`
alongside the verified service filter. For a percentile, use a calculations
query with, for example, `{ operator: 'p95', key: '<verified admissionToFirstWriteMs key>', keyType: 'number' }`
grouped by `lane`. During a bounded live capture, `wrangler tail --search turn_latency`
(or `relay_alarm`, `thread_runner_alarm`, `state_rpc`, `gateway_delivery`) narrows the stream; `entrypoint` shows which
Durable Object logged a `state_rpc`. `npm run diagnose` does not project these
events; join them to a Run through `runRef` and the time window. On a Node
install the same objects print to the process log, for example
`{ component: 'runtime', event: 'turn_latency', ... }`; filter with
`grep "event: 'turn_latency'"`.
