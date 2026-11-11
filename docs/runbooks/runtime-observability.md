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
Each management MCP message emits `mcp.request`, and a tool call refused on its
input schema emits `tool.validation_failure` with `surface: "mcp"`; see
[management MCP diagnostics](workspace-management-mcp.md#diagnostics-and-telemetry).

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

These content-free events measure inbound delivery and turn scheduling. Each is one structured
console object with `component: "runtime"` and an `event` name, so Workers Logs
indexes its top-level fields. Values are non-negative integer milliseconds,
booleans, fixed tokens, or opaque references; no message text, Slack user or
channel IDs, settings keys or values, or error text. Emission never throws.

| `event` | Emitted | Fields |
| --- | --- | --- |
| `relay_alarm` | Once per `TagStateStore.alarm()` invocation (Cloudflare) | `outcome` (`idle`, `drained`, `threw`), `durationMs`, `jobsListed`, `groups`, `jobsRun`, `jobsSettled`, `jobsRetained`, `jobsCarried`, `longestJobMs`, `turnsMs`, `needsRetry`, `rearmed`, `yielded`, `jobsDispatched`, `keepWarm`, and on an `idle` record its parts: `retentionMs`, `ledgerMs`, `cleanupsMs`, `repairsMs`, `scheduleMs`, `receiptsMs` |
| `thread_runner_alarm` | Once per `SlackThreadRunner.alarm()` invocation (Cloudflare) | `outcome` (`idle`, `drained`, `threw`), `jobs`, `ran`, `yielded`, `carried`, `dropped`, `durationMs` |
| `runner_boot` | Once per `SlackThreadRunner` activation (an instance constructed in memory), at the first call it serves (Cloudflare) | `firstMethod` (`wake` for the state store waking it at a delivery's receipt, `admit`, `alarm`, `stop`, `status`, `observedStatus`, `midRunReply`, `runFacts`, `presentationGet`, `presentationTransition`, or `host` for a host function), `cold` (the first runner its isolate constructed), `constructMs` (the constructor through its resume check), `constructToFirstCallMs`, and with `wake` or `admit`: `turnRef` and `sentToConstructMs` (the state store's send to the constructor's start) |
| `agent_boot` | Once per Flue agent object activation (a Slack thread's Agent, a routine run, a coding worker), at the first call it serves (Cloudflare) | `agentClass` (the generated Durable Object class), `firstMethod` (`wake` for the state store waking a thread's object as it hands the turn to its runner, or a runner waking it once the turn's plan froze, `stage` for a runner staging a turn's input, `fetch` for a Flue dispatch or read, `alarm`, or `host`), `cold` (the first agent object its isolate constructed), `constructMs`, `constructToFirstCallMs`, and with `wake` or `stage`: `turnRef` and `sentToConstructMs` (the sender's clock before it addressed the object, to the constructor's start) |
| `store_boot` | Once per `TagStateStore` activation, at the first RPC or alarm it serves (Cloudflare) | `firstMethod` (`rpc` or `alarm`), `cold` (the first state store its isolate constructed), `versionChanged` (this activation installed the schema: the first on its Worker version), `constructMs` (the constructor through its resume check), `constructToFirstCallMs` |
| `turn_latency` | Once per relay attempt of one turn (both lanes) | `turnRef`, `runRef`, `lane` (`cloudflare`, `node`), `executor` (`alarm`, `runner`, `node`), `attempt`, `modelToken` (see below), `outcome` (`returned`, `threw`, `stopped`: a stopped run's ending), `reason` (a thrown attempt only: why it ended without a final, `observation_yield`, `state_store_unavailable`, `reply_read_interrupted`, `recovery_required`, `agent_failure` or `other`; the next attempt's record counts it with `attempt` above 1), `firstWrite`, `final` (`delivered`, `deferred`, `none`), `admissionToStartMs`, `admissionToFirstWriteMs`, `admissionToFinalMs`, `receiptToAdmissionMs`, `receiptToFirstWriteMs`, `handoffMs` (a runner turn's first attempt: see below), `runnerWakeLeadMs` (a runner turn's first attempt, when the state store woke its runner at receipt: how long before the hand-off it sent the wake), `admissionStatusMs` (a runner turn's first attempt, when the state store tried to show its status before the hand-off: how long the hand-off waited for it; see below), `agentStageMs` (staging the turn's input beside the thread's Agent before dispatch, and loading the connector details its render reads: see below), `agentWakeLeadMs` (a Cloudflare turn whose Agent object was woken: how long before staging the wake was sent), `agentWakeSource` (with `agentWakeLeadMs`: `admission` or `plan`, which wake it counts from), `startToStageMs` (from the attempt's start to that staging's start: see below), `attemptMs`, `folded` (present when the turn took follow-ups: how many queued messages it read with its own), `foldedInformed` (of those, how many were a teammate's, read as information only), `read` (present when the turn replaced a mid-run 👀 with 👍: how many), `stalledReads` (present when a read of the reply had not answered after 10 s and a fresh read through a new route joined it: how many), `admissionToModelStartMs` and `receiptToModelStartMs` (to the moment the turn's first Flue dispatch is sent; absent on an attempt that sent none), `receiptToFinalMs`, `modelSteps`, `toolCalls` and `toolMs` (the model work the attempt's reply observation saw: see below), `firstAnswerText` (`stream`, `final`, `none`), `admissionToFirstAnswerTextMs`, `receiptToFirstAnswerTextMs`, `admissionToShadowAnswerTextMs`, `receiptToShadowAnswerTextMs`, `admissionToAnswerVisibleMs`, `receiptToAnswerVisibleMs` (see below) |
| `answer_release` | With `turn_latency`, when the attempt read its reply's response from the start of a step (both lanes) | `turnRef`, `runRef`, `attempt`, `modelToken`, `outcome` (`below_hold`, `released`, `retired`, `blocked`), `block`, `late`, `holdChars`, `releaseChars`, `releaseHoldMs`, `admissionToReleaseMs`, `receiptToReleaseMs`, `releaseToLateMs`, `toolSteps`, `answerSteps`, `preToolText1`, `preToolText100`, `preToolText200`, `preToolText300`, `preToolText400`, `preToolText600`, `preToolText800`, `finalAnswerChars`, `displayParts`, `keySetupParts`, `taskCardStream`, and with host release on `hostRelease` (`released`, `retired`, `corrected`, `below_hold`, `blocked`), `hostBlock`, `hostLate`, `retiredVisibleMs` (see below) |
| `turn_fold` | When the state store confirms that a running turn's model read messages sent while it worked (both lanes) | `turnRef`, `late` (how many messages this confirmation covers; each message is counted once), `informed` (of those, how many were a teammate's, read as information only), `turn` (of those, how many it read after a tool step rather than before its reply), `edits` (edits of messages it had already read, counted apart from `late`) |
| `turn_fold` (edit) | Once per delivery of a person's edit of a message (both lanes) | `op` (`edit_admission`), `outcome` (`admitted`, `already_admitted` for a redelivery, `no_live_turn`, `not_foldable`, `not_author`, `stale`, `unchanged`, `unsupported` for a state store without edit admission, or `failed` when admission threw and the delivery is retried) |
| `turn_fold` (coding job) | When a coding job's wait pauses for new messages, a later wait for it ends, or the Agent passes it guidance | `turnRef`, `op` (`coding_pause`, `coding_resume` or `coding_relay`), `outcome` (pause: `messages` or `unchecked`; resume: `completed`, `paused` or a failure reason; relay: `sent`, `finished`, `stopped` or `not_sent`) |
| `state_rpc` | Sampled calls from a `Cf*Store` proxy into `TagStateStore` | `method` (RPC name), `op` (request kind for `*Execute` RPCs), `ms`, `slow`, `ok`, `isolateCalls`, `isolateSlowCalls` |
| `state_rpc_summary` | Once per scope: a direct Slack delivery on Cloudflare (`slack_delivery`, from Core's handler to the end of its admission chain), or a relay attempt of one turn (`turn`) | `scope`, `turnRef` (`turn` only), `calls`, `rounds`, `totalMs`, `busyMs`, `failed`, `slowestMethod`, `slowestMs`, `spanMs`, `receiptToStartMs` (`slack_delivery` only), `path` (`slack_delivery` only: `store` when the state store admitted it in one call, `worker` when this Worker admitted it, `fallback` when the store could not take the call), `reason` (with `fallback`: the `state_rpc_fallback` reason), `callsBeforeModelStart`, `roundsBeforeModelStart`, `busyMsBeforeModelStart` (`turn` only: see below) |
| `slack_store_admission` | Once per Slack delivery a state store admits itself (`CHICKPEA_SLACK_ADMISSION=store`, Cloudflare) | `outcome` (`processed`, `refused`, `failed`), `reason` (with `refused`: `recovery_only`, `installation`), `turns` (the turns its canonical admissions committed; one admitted without one, such as an edit's or a legacy turn, is not counted), `rpcCalls` (calls the store made to itself over RPC while admitting: 0, or admission built a store from its env), `orderWaitMs` (the wait for its thread's earlier messages), `rateLimited` (Slack calls rate-limited while admitting; the store fails them at once instead of waiting out `Retry-After`), `receiptToStartMs`, `durationMs` (through the first status and the hand-off) |
| `state_rpc_fallback` | When a Worker's call to a state store method added in a later release rejects, and the Worker takes the older path once (`withStoreFallback`). A deploy leaves a store on its old code for up to 5 minutes, so `method_missing` is expected only then | `method` (the newer RPC), `reason` (`method_missing`: the store's code lacks it; `disconnected`: the store was replaced mid-call; `rejected`: any other rejection) |
| `model_step` | Once per model request an agent makes, logged by the object that makes it (both lanes) | `turnRef` (a Slack thread's request), `modelToken` (the model that served the request), `purpose` (`agent`, `compaction`, `compaction_prefix`), `outcome` (the provider's finish reason, such as `stop` or `toolUse`, or `error`), `durationMs`, `firstTokenMs`, `inputTokens`, `cachedInputTokens`, `cacheWriteTokens`, `outputTokens`, `toolCalls` |
| `gateway_delivery` | Once per authenticated gateway delivery at Worker admission (Cloudflare) | `transport` (`http`, `socket`), `deliveryKind` (`event`, `agent_selected`, `channel_agent_add`), `eventType` and `subtype` (Slack's event vocabulary), `outcome` (`accepted`, `duplicate`, `rejected`, `failed`, `filtered`), `lagMs`, `slackLagMs`, socket only: `source` (`store`, `recent`, `filter`), `filterReason`, `queueMs`, `admitMs`, `inFlight`, `sessionPhase`, `sessionHealth`, `sessionAttempt`, `sessionGeneration`, `sessionAgeMs` |
| `slack_read` | Once per Slack `conversations.history` or `conversations.replies` read for context or a read tool | `source` (`prefetch`, `tool`), `method` (`history`, `replies`), `outcome` (`ok`, `refused` by the shared read budget, `rate_limited`), `gated` (the shared app's one-a-minute budget applies), `limit`, `returned`, `includesRoot`, `reachesAnchor` (the page reached the triggering message), `hasCursor`, `order` (`oldest_first`, `newest_first`, `mixed`) |
| `interaction_judgment` | Once per guaranteed Slack turn (a DM or a mention) the turn judged itself, after its classifier settled (both lanes) | `turnRef`, `recordedBy` (`shortcut`, `clef`, `model`, `unrecorded`), `basis` (the recorded disposition), `basisMs`, `clef` (`read`, `unavailable`, `timeout`, `error`, `unparseable`, `skipped`), `clefMs`, `clefInputTokens` (Clef is platform infrastructure, so this is where its cost is counted), `clefChoice`, `clefTop`, `clefTextMass` (P(reply) + P(work)) and `clefMemory` (each in thousandths), `gate` (`dispatch`, `await_model`), `clefLate` (Clef would have dispatched but the model recorded first), `model` (the classifier's disposition), `modelFailed`, `modelMs`, `refinement` (after a Clef basis: `none`, `labels`, `disagreed`, `model_unavailable`), `agreed` (Clef's disposition equals the model's), and from Clef's separate management call (absent after a shortcut): `management` (`read`, `unavailable`, `timeout`, `error`, `unparseable`), `managementMs`, `managementInputTokens`, `managementTop` (its noul, in thousandths), `managementFired` (at or above 0.5, so the turn's first request mounts the workspace change tools) |

- `relay_alarm.durationMs` is the whole invocation; `turnsMs` is the turn
  drain and `longestJobMs` the slowest single turn attempt in it. `jobsListed`
  is the first pending listing: up to 4 rows from each of up to 16 threads.
  The drain keeps admitting while turns run, so `groups` (distinct threads
  that ran) and `jobsRun` can exceed it. `jobsRetained` counts attempts left
  pending for a later alarm (a budget yield included), `jobsCarried` the turns
  still running at the 12-minute hard cap (they settle after this record), and
  `yielded` whether the 10-minute observation budget ended with work
  observing.
- An `idle` record (no turn pending) also times each part of the firing:
  `retentionMs` is the management retention sweep (run at most every 5
  minutes per instance; 0 when skipped), then `ledgerMs`,
  `cleanupsMs` (0 when no cleanup was pending), `repairsMs`, `scheduleMs` and
  `receiptsMs` are the ledger-run, interaction-cleanup, presentation-repair,
  schedule-action and management-receipt drains, in that order. They sum to at
  most `durationMs`; the rest is admission, hand-offs and stop notices. A
  `drained` record has none of them: its drains run among its turns. On
  Cloudflare `Date.now()` does not advance during synchronous execution, so a
  part made of synchronous SQLite work reads 0 ms (and so does `durationMs`
  for a firing with no awaited work): the fields measure awaited work, such
  as a Slack call inside a drain.
- `keepWarm`: while a person has talked to the installation in the last 10
  minutes, the state store arms its alarm no later than 20 s ahead. The alarm
  alone does not keep the object in memory; a deployment that sets a
  [residency hold](operations.md#hold-a-conversations-objects-in-memory)
  does. Without one, the store leaves memory about 10 s after its last
  activity, and the next message waits up to about 2.4 s at ingress for its
  first state read. An idle firing inside those 10 minutes reports
  `keepWarm: true` and re-arms the tick; a due time earlier than the tick is
  kept. Expect up to
  three idle records a minute per installation during a conversation, and
  none once it has been quiet for 10 minutes. A store that starts cold reads
  the window from its newest turn row; an Agent's ask or a setup wake opens
  no window.
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
  counts turns still running at the 12-minute cap. `dropped` counts queued
  turns that stopped runs' endings dropped since the runner's previous
  record, each once however often its ending replays. Runner turns log
  `turn_latency` with `executor: runner`. The runner keeps the turn's Slack
  presentation in its own storage and repairs it itself; the state store's
  presentation copy is refreshed at lifecycle changes, and its repair sweep
  skips runner-owned turns.
- `runner_boot` and `turn_latency.handoffMs` split the wait between the
  state store handing a turn over and its runner starting it. `handoffMs` is
  the runner's `admit` start minus the state store's send time: it compares
  two objects' clocks, often in different locations, so it carries their
  skew, and a negative difference logs as 0. The runner keeps it in memory by
  turn and gives it to the first attempt it runs, so later attempts omit it.
  It is also absent when the runner was evicted or erased between `admit`
  and the turn's start, when that first try was put off before it ran (its
  Slack installation unavailable), and when either object runs a version
  without the field. Joined by `turnRef`, `runner_boot.sentToConstructMs` is
  the part of `handoffMs` before the runner's constructor: placing and
  activating the object, and for a `cold` one starting the isolate and
  evaluating the script. Workers clocks read 0 while a script evaluates and
  advance only on I/O, so script evaluation is not timed apart, and
  `constructMs` and `constructToFirstCallMs` read 0 unless the constructor's
  resume check reached storage. An `admit` with no `runner_boot` of its
  `turnRef` reached an instance already in memory.
- `turn_latency.runnerWakeLeadMs` is how long before handing a turn over
  the state store sent its runner a wake. The state store sends it at the
  delivery's receipt, without waiting, when the delivery can become a turn:
  a message that mentions the app, a DM, a top-level mention of one of the
  installation's Agents, or a reply in a thread an Agent owns. On the gateway
  the receipt is the state store's own; on a direct installation on
  Cloudflare the Worker that verified the delivery tells the state store of
  it (`noteSlackDelivery`) before admitting it over the store's RPCs, and the
  state store sends the wake from that note. On Node nothing is woken. The runner's
  activation overlaps the lead, so when the wake reached a runner not in
  memory, its `runner_boot` shows `firstMethod` `wake` (with the turn's
  `turnRef`), no `admit` boot follows, and `handoffMs` drops by up to the
  lead. Both ends are the state store's clock. The field is absent when no
  wake reached the runner's current activation within the minute before the
  hand-off: a reaction, a click, an evicted runner, or a thread whose owner
  changed (its wake reached the previous owner's runner). A wake that becomes
  no turn (a refused guest, a mention routing declines) costs one runner
  activation and stores nothing. A front desk hand-off wakes the Agent's
  runner at the decision: when Chickpea's run decides to hand its root DM to
  an Agent, its runner tells the state store (`noteFrontDeskHandoff`) before
  the line is posted, and the state store wakes the runner the takeover turn
  will be handed to (the thread's next owner incarnation) and keeps the
  decision time as that turn's receipt, so the takeover's `runnerWakeLeadMs`
  and `receiptToAdmissionMs` measure from the decision, about two seconds
  before its admission.
- `turn_latency.admissionStatusMs` is how long the state store's hand-off
  waited for the turn's opening status ("Thinking…" as its Agent), shown
  from the state store before a turn's first hand-off instead of at the
  runner's start. It is tried only on a turn that will dispatch (not one
  held or stopped, already dispatched, judged react_only, a command, an
  approval, or one whose Agent has no model), with a V3 presentation
  nothing was shown for yet, no other undelivered turn ahead of it in its
  conversation, and not for an Agent with its own Slack app. The wait is
  capped at 1.5 s (`ADMISSION_STATUS_CAP_MS`). When Slack acknowledged the
  status within it, the hand-off carries the presentation with the status
  shown, the runner makes no native start and no opening write, and
  `firstWrite` is `admission_status`: `receiptToFirstWriteMs` and
  `admissionToFirstWriteMs` then count to the state store's record of it
  (one clock with receipt and admission). Otherwise (the cap, a Slack
  failure, a write refused before any call by the thread fence or an
  unavailable projection, or a row that moved meanwhile) nothing is
  recorded and the runner shows the status as before; `admissionStatusMs`
  is present and `firstWrite` is the runner's. A status that lands after
  the cap shows until the runner's own writes replace it. The wait comes
  before the hand-off is sent, so `admissionToStartMs` and
  `runnerWakeLeadMs` include it and `handoffMs` does not. Absent on later
  attempts, on hand-offs made again, and from an older state store or
  runner.
- `turn_latency.agentStageMs` is the runner's wait to stage a turn's input
  beside its thread's Agent object, which also loads the connector details
  (tool descriptions and input schemas) the turn's managed connections need
  before the Agent renders: on a thread's first turn, or after the object was
  evicted, that wait includes activating the object. Joined by
  `turnRef`, `agent_boot.sentToConstructMs` is the part before the Agent
  object's constructor. A turn that dispatched nothing, and a retry that
  reused an earlier dispatch, omit `agentStageMs`.
- `turn_latency.agentWakeLeadMs` is how long before staging a Cloudflare
  turn its Agent object was sent a wake, without waiting for it. The state
  store sends it as it hands the turn to its runner, to the instance the
  turn's plan will name (derived as the freeze derives it, and recorded in
  the inventory first), unless it already knows the turn freezes no plan: a
  stop, a plan already frozen, a react_only judgment, a command or an
  approval. The hand-off carries that wake to the runner, and when the
  frozen plan names the same instance the turn sends no second wake:
  `agentWakeSource` is `admission` and the lead counts from the state
  store's send (two clocks). Otherwise the turn wakes the object once its
  plan froze, and `agentWakeSource` is `plan`: an older state store, an
  evicted runner, a wake older than a minute, or a plan that names another
  instance. The object's activation overlaps the lead, so when the wake
  reached an object not in memory, the turn's `agent_boot` shows
  `firstMethod` `wake` and no staging boot follows it, and `agentStageMs`
  drops by up to the lead. Whether that wake activated the object is the
  `agent_boot` record's to say (joined by `turnRef`): the turn never waits
  for it. A turn that froze no plan (a retry that restored one, a replay, a
  stopped turn, a command) or staged nothing omits both fields.
- `turn_latency.startToStageMs` is the attempt's own work before it stages
  that input: memory and the plan, the opening status, the judgment, the
  lease check, the thread's context read, the usage admission and the
  dispatch's preparation. The context read's Slack messages are read beside
  memory and the plan; the transcript's continuation, memory's visibility
  barrier and the people's names in it follow the plan. The installation's
  identity check and the start
  claim come before the attempt starts, in `admissionToStartMs`.
  `admissionToStartMs` plus `startToStageMs` plus `agentStageMs` is
  admission to the input staged. Present exactly when `agentStageMs` is.
- `turn_latency` measures from `turn_jobs.enqueued_at` (durable admission)
  and from `turn_jobs.received_at` (receipt). A gateway delivery becomes a turn
  row only when an alarm drains the gateway inbox, so while a long turn holds
  the alarm it waits before admission: `receiptToAdmissionMs` is that wait
  (receipt = the inbox's `accepted_at`) and `receiptToFirstWriteMs` is the
  user-facing first-status latency. A direct installation on Cloudflare is
  admitted by the Worker over the state store's RPCs: its receipt is the
  host's arrival time for the request when the host passes one
  (`withSlackArrival`), else the Worker's clock when Core's handler started.
  It is sent to the state store with the wake above (`noteSlackDelivery`), so
  `receiptToAdmissionMs` is the Worker's admission chain, including a host's
  own work before Core (a health gate) and a state store that boots for it. A front desk hand-off's turn (the takeover row)
  takes its receipt from Chickpea's decision (`noteFrontDeskHandoff`), so its
  receipt fields measure the takeover's own admission chain, not the person's
  message; keep such rows apart when aggregating first-status latency. For
  Node admissions receipt equals admission. Rows admitted before this field
  existed omit the receipt fields.
  `firstWrite` names the first Slack effect the attempt saw acknowledged:
  `admission_status` (the status the state store showed before the hand-off,
  above), `agent_session` (Agent View processing), `activity_status`,
  `reaction`, `stream`, or `final`. A durations field is absent when it cannot be measured,
  for example `admissionToFinalMs` on a `deferred` terminal. A retried turn logs
  one record per attempt. A durable recovery notice runs a second `runTurn` in
  the same attempt, so a turn can log two records with the same `attempt`
  (`outcome: threw`, then `returned`); for first-status latency use the record
  with the lowest `receiptToFirstWriteMs` (or `admissionToFirstWriteMs` when
  the receipt fields are absent).
  `runRef` equals the `Slack presentation finalized` record's `runRef`, and
  `turnRef` is a hash of the turn job ID. Thread follow-ups admitted without a
  run ID carry neither `runRef` nor `attempt`; group them by `turnRef`.
- `modelToken` on `turn_latency` and `answer_release` is the model the turn
  ran with, and on `model_step` the model that served that request (Flue's
  provider and model id joined by `/`). It is a token (`modelToken()` in
  `runtime-latency.ts`): the provider and model id lowercased, every other
  character `_`, cut to 64 characters. `anthropic/claude-opus-5.5` logs as
  `anthropic_claude_opus_5_5`. It is `unknown` when the turn had no model,
  such as one that waits for Model providers to be repaired. Group by it to
  read any of the three records per model.
- `turn_latency.firstAnswerText` names where the attempt first showed answer
  text: `stream` when Slack acknowledged a stream start carrying text, or the
  first text appended to a task-card stream; `final` when the terminal was
  delivered; `none` otherwise. A status, a reaction, a task card or a mid-run
  reply is not answer text. `receiptToFirstAnswerTextMs` is message to first
  answer text as the person saw it. `receiptToShadowAnswerTextMs` is the same
  measure had the host released the answer by the rule `answer_release`
  shadows: the earlier of the release and the answer Slack showed, and equal to
  `receiptToFirstAnswerTextMs` when the rule would not have released or would
  have retired its release. The release time is when the reader saw the text
  that crossed the hold, before the Slack call a real release would make.
  Compare the two over rows whose `final` is `delivered`: an attempt that
  delivered no terminal can carry the shadow time alone.
- `turn_latency.receiptToAnswerVisibleMs` (and `admissionToAnswerVisibleMs`)
  is message to the moment Slack acknowledged the terminal call that completes
  the reply's first message: the stream start that carries it, the stop that
  adds its rest, the update that replaces it, or the post. `receiptToFinalMs`
  is later: it also waits for the stream's stop, the reply's cards and the
  status clear. Both are absent on an attempt that showed no reply text of its
  own, such as one that replays a reply an earlier attempt delivered. On a row
  whose `firstAnswerText` is `final`, `receiptToFirstAnswerTextMs` equals
  `receiptToFinalMs`, so read this field for when the text showed.
- `answer_release` is a shadow of the host release rule
  (`src/slack/answer-release.ts`) and changes nothing in Slack. The rule
  releases a model step's text once its settled prefix (what
  `streamableSlackMarkdownPrefix` would stream, so the redaction hold applies)
  holds `holdChars` characters and no tool call has appeared in the step.
  `outcome` is `below_hold` when no step reached the hold, `released` when one
  did and nothing followed, `retired` when a tool call, a blocking data part or
  a reset followed the released text (`late`: `tool`, `presentation_tool` for a
  table, display or interactive tool, or a `block` token), and `blocked` when a
  blocking condition came before any release (`block`: `draft_replacing_tool`,
  `file_delivery`, `interactive_component`, `agent_creation`, or
  `conversation_reset` when a snapshot replaced the step boundaries). Nothing
  releases after a retirement. `releaseChars` is the settled length at the
  release, `releaseHoldMs` the time from the releasing step's first text to the
  release, and `releaseToLateMs` how long retired text would have shown.
  `toolSteps` counts model steps that called a tool and `answerSteps` steps
  that completed without one (more than one means the response continued after
  an answer). `preToolTextN` counts tool steps whose settled text before their
  first tool call reached N characters, so a reply retires at a hold of N when
  its `preToolTextN` is above 0. `finalAnswerChars` is the settled length of the
  last step that completed without a tool call: the reply would release at a
  hold of N, and keep its release, when it is N or more and `preToolTextN` is
  0. `displayParts` and `keySetupParts` count the
  display component (cards, chart, details) and key-setup data parts the
  response wrote. Neither blocks in the shadow, and the release keeps both
  terminal at first, so a `released` row with either above 0 is a reply it
  would not stream yet. `taskCardStream` is true when Slack accepted native
  task card rows on the reply's stream before its terminal: the stream opened
  as the card, or a milestone added rows to an open stream. The release does
  not stop and delete such a stream, since the card would go with it, so count
  its retirements apart. Lengths are counts only; no text is logged. A fault in
  the shadow logs no record for that attempt. On Cloudflare the reader polls
  the response (every 150 ms while chunks arrive, 750 ms once it is quiet) and
  reads a page's chunks at one time, so a `releaseHoldMs` or `releaseToLateMs`
  of 0 means both ends came in one page: such a retirement is one a release
  that waits for its page would never show. A reattached attempt reads its
  response again from the start, so its times are replay times: prefer
  `attempt` 1. Join it to `Slack presentation finalized` by `runRef` for the
  offer and policy outcome.
- With `CHICKPEA_SLACK_ANSWER_RELEASE=host` the host releases by the same rule,
  with the deployment's hold, and `answer_release` says what Slack saw in
  `hostRelease`: `released` (the answer streamed), `retired` (a tool call,
  another step, a reset or a blocking data part followed, and the host deleted
  the stream or it never reached Slack), `corrected` (one followed on a stream
  that carries the task card, which the final corrects instead), `below_hold`,
  or `blocked` (`hostBlock`: the shadow's tokens plus `display_component`,
  `key_setup`, `structured_output` for a data part outside the release's list,
  and `identity_conflict`). `hostLate` names what followed (the shadow's `late`
  tokens plus `step`). `retiredVisibleMs` is how long Slack showed retired text,
  from the acknowledgement of its first text to the deletion. It is absent
  when the text never reached Slack, and when Slack refused the stop or the
  delete: the text then stays until the final deletes it, and a
  `released answer retirement failed` warning marks the turn. Text the host
  retired is not the answer, so `turn_latency.firstAnswerText` is then the
  final's. The `Slack presentation finalized` record's `policyOutcome` for a
  host release is `host_released_` and the delivery outcome: `progressive`,
  `corrected`, `fallback` when the final posted fresh after a retirement
  (or after a stream Slack refused; `hostRelease` tells them apart), or
  `terminal_only` when no released text reached Slack before the final.
- `gateway_delivery` is logged when a delivery reaches admission: by
  `TagStateStore.receiveGatewayHttp` for HTTP push (after signature
  verification; challenges and rejected signatures log nothing) and by the
  `SlackGatewaySession` socket intake once the delivery's receipt is settled.
  The socket intake admits up to 6 deliveries at once, in arrival order within
  one Slack thread (a whole DM, a channel, or a user for events without a
  thread), and acknowledges each when its own admission returns. `source` is
  `store` for an `admitGatewayDelivery` call (`queueMs`: wait for the thread
  and a slot; `admitMs`: the call itself; `inFlight`: admissions already
  running), `recent` for a Slack retry of a delivery this session object
  admitted or was admitting in the last 5 minutes (answered `duplicate`
  without a store call), and `filter` for this app's own messages, own stream
  edits (`message_changed` of its own message), and own reactions (own means
  `user` is the bound bot user, or, with no `user`, `app_id` or
  `bot_profile.app_id` is the bound app, as on a persona `bot_message`), which are
  acknowledged without admission (`outcome: filtered`, `filterReason`
  `own_message`, `own_message_changed`, or `own_reaction`). `eventType` and
  `subtype` are Slack's fixed event names, never content. The session
  checkpoint is no longer written per delivery: only on a health or phase
  change, and for a heartbeat alone at most once a minute.
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
- Deploy readiness (`POST /internal/deployment/ready`, polled by `npm run
  deploy`) passes only after the new version's `SlackGatewaySession` is healthy
  and the gateway answers a `session.ping` on its socket within 5 s. Local
  session health trusts a silent socket until the 90 s heartbeat timeout, and
  the gateway answers only the socket it holds as the binding's authenticated
  session. The probe logs `component: "slack_gateway"`, `event:
  "session_confirmed"` or `"session_unconfirmed"` (`generation`,
  `versionId`); an unanswered probe also restarts the
  session, and the deploy prints `Still waiting: the Slack gateway did not
  answer on this version's session; reconnecting it.` HTTP delivery has no
  socket and is not probed.
- The three reply measures read from one `turn_latency` record, all from
  receipt: `receiptToFirstWriteMs` (first status), `receiptToModelStartMs`
  (model start: the turn's first Flue dispatch is about to be sent), and
  `receiptToFinalMs` (end to end). Model start is absent on an attempt that
  reattached to a dispatch an earlier attempt sent. `modelSteps` counts the
  model steps the attempt's reply observation saw start for its submission
  (Flue's per-step turn id), `toolCalls` its tool calls (an answer
  declaration excluded), and `toolMs` the tools' own reported durations
  summed; a reattached observation that begins with a snapshot sees only the
  later steps. `model_step`, joined by `turnRef`, is the full per-request
  record.
- `model_step` is logged in the object that runs the model (a Slack thread's
  Agent object on Cloudflare), from Flue's observations: `firstTokenMs` is
  from Flue's `turn_request` to the request's first streamed text, thinking or
  tool-call arguments, and `durationMs` is Flue's own duration for the
  request. `inputTokens` excludes the cached input `cachedInputTokens` counts,
  so the prompt cache's hit rate is `cachedInputTokens / (inputTokens +
  cachedInputTokens + cacheWriteTokens)`. Token fields are absent when the
  provider reported no usage. `toolCalls` counts the tool calls in that
  response. Only Slack thread requests carry `turnRef`.
- `store_boot` makes a state store that left memory visible: its time against
  a delivery's arrival is the boot the delivery waited for. No caller sends
  its clock to the store, so it has no `sentToConstructMs`; `cold` means the
  isolate's first state store, as for the runner.
- `state_rpc_summary` counts every state store call of its scope, timed at the
  caller, where `state_rpc` logs only slow or sampled calls. A round is a run
  of overlapping calls: one starts while none is in flight. `busyMs` is the
  time at least one call was in flight, and `totalMs` the sum of the calls'
  times. `slack_delivery` covers Core's direct handler and the admission
  chain it starts, and is logged when that chain ends (deliveries that start
  none log nothing); `receiptToStartMs` is the time before Core's handler
  started, which is the host's work when the receipt is the host's arrival.
  `turn` covers one attempt, logged right after its `turn_latency`; the
  `*BeforeModelStart` fields are the calls made before the dispatch was sent.
  A scope that made no call logs nothing, so a Node install logs none.
- `stalledReads` and `reason` show how a turn's Agent object recovered from
  an interruption. When the object is cut mid-run, a read the turn had in
  flight to it can stay unanswered for minutes while the run resumes on a new
  instance. A read that has not answered after 10 s is joined by a fresh read
  through a new stub, the first answer wins, and the reply arrives once the
  resumed run settles: `stalledReads` on a delivered attempt counts those
  reads. A fresh read that fails is dropped while another is still in flight.
  `stalledReads` times 10 s is about how long the attempt's reads went
  unanswered. Compare the end of that wait with the resumed instance's
  `agent_boot`: within about 10 s of it, a fresh stub reached the new instance
  while the old read hung; minutes past it, fresh reads hung too.
  `reason: reply_read_interrupted` on a thrown attempt means a read failed
  with no other in flight, and the next attempt reattaches to the same
  submission.
  Count retries as `turn_latency` records with `attempt` above 1, and read why
  from the `reason` of the attempt before each one.
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
(or `relay_alarm`, `thread_runner_alarm`, `state_rpc`, `state_rpc_summary`, `store_boot`, `model_step`, `gateway_delivery`) narrows the stream; `entrypoint` shows which
Durable Object logged a `state_rpc`. `npm run diagnose` does not project these
events; join them to a Run through `runRef` and the time window. On a Node
install the same objects print to the process log, for example
`{ component: 'runtime', event: 'turn_latency', ... }`; filter with
`grep "event: 'turn_latency'"`.

## Steering logs

Stops and check-ins decided at admission log one content-free line each, on
Cloudflare and Node alike. Neither carries message text, a stop reason, or a
Slack user, channel or workspace ID.

| Line | Fields |
| --- | --- |
| `[chickpea] steering.admission` | `outcome` (`stopped`, `check_in`, `stop_refused`, `check_in_refused`, `ended`, `unsettled`), `created` on `stopped` (`false` when the stop joined one already recorded), and `source: button` for Slack's Stop button (absent for a typed stop) |
| `[chickpea] steering.stop_button` | `outcome` for a Stop press that stopped nothing: `invalid` (unreadable event), `no_route` (not an Agent thread), `no_running_job`, or `not_allowed` (no access and not told) |

A stopped run's ending logs `turn_latency` with `outcome: stopped`. Filter a
bounded capture with `wrangler tail --search steering.` or, on Node,
`grep "steering\."`. See [Slack steering](slack-steering.md#operator-view)
for the retry warnings and the durable stop record.

## Agent app refusals

Each refusal Slack gives an Agent's own Slack app, or Chickpea's bot when it
invites that app's bot into a Channel (see
[Slack message identity](slack-message-identity.md#an-agent-with-its-own-slack-app)),
logs one structured `console.warn` object with `event:
"chickpea.agent_app.slack_refused"`. The Owner sees only the step's message,
and for `invite` nothing unless the fallback also leaves the bot out; this
line is for the operator. It carries no token, secret, or URL.

| Field | Value |
| --- | --- |
| `step` | `rotate` (configuration token), `release_handle`, `create`, `update` (adds the Request URLs), `icon`, `exchange` (the Allow callback), `uninstall`, `delete`, `invite` (Chickpea's bot inviting the app's bot into a Channel the Agent was added to) |
| `agentId`, `appId` | The Agent and its Slack app, or `null` before Slack names the app; `rotate` names neither |
| `channelId` | `invite` only: the Channel |
| `code` | Slack's error code, such as `invalid_manifest` or `ratelimited`. `invite` also logs `credentials_unavailable` when Chickpea's bot token cannot be read, so nothing was sent, and `failed` when Slack gave no answer |
| `errors` | Slack's `{ message, pointer }` list, as sent with `invalid_manifest`: at most five entries of 200 characters each, any URL replaced by `<url>`. A message that quotes one of the manifest's own strings, such as the Agent's name or description, is left out and only its `pointer` is logged |

Filter a bounded capture with `wrangler tail --search agent_app.slack_refused`.

## Deliveries that add no turn

A Slack event, or another delivery of the same message, that routing accepted
but whose turn was admitted already logs one structured `console.info` object
with `event: "chickpea.turn.not_admitted"`, `reason: "already_admitted"`, the
routed `agentId`, and `delivery`: `installation` (Chickpea's own app) or
`agent_app` (an Agent's own Slack app). Nothing is posted in Slack for it. One
line per Channel mention of Chickpea is expected, since Slack sends that
mention as two events. A line naming an Agent that never answered the message
points at routing: both deliveries of a message should admit the same turns.
Such a delivery of a message naming several Agents also admits any of the
others whose turn is not queued yet, so a delivery that stopped partway is
finished by the next one.
Filter a bounded capture with `wrangler tail --search turn.not_admitted`.

## Memory lease failures

A turn whose memory lease is refused ends with the generic notice that the
agent run failed before completion. Before posting it, Core logs one
structured `console.warn` object with `event: "chickpea.turn.agent_failure"`,
`reason: "memory_delivery_lease_rejected"`, the `agentId`, and `stage`:
`before_run` (refused before the model ran) or `after_run` (refused before the
answer was delivered). When the answer had begun streaming, the notice
replaces the streamed message, marked `_Corrected_`. The lease holds while
the Agent is enabled, the installation is not revoked, the bot delivering the
reply is the installation's or the Agent's own live app's, the Agent's memory
is unchanged since the turn read it, and, in a Channel, the Agent's grant
stands and both the person and that bot are members. A turn whose memory could not be
prepared is quarantined: its lease always fails, so its line says
`reason: "memory_quarantined"` instead, and the preceding `memory_metric`
line with event `quarantine` gives the cause. The turn's preceding
`memory_metric` lines show `delivery_lease` otherwise. Filter with
`wrangler tail --search agent_failure`.

## Agent schedule control rejections

When Admin pauses, resumes, or deletes an Agent's schedule and the routine
state refuses the action with a 400, the response carries only the error
code. Core also logs one structured `console.warn` object with `event:
"chickpea.admin.schedule_control_rejected"`, the `agentId`, `scheduleId`,
`action`, `code`, and `message`. The message is the routine state's fixed
explanation, such as `Routine confirmation is invalid.`, and never contains
schedule content. Stale versions (409) and missing schedules (404) are not
logged. Filter with `wrangler tail --search schedule_control_rejected`.

## Connection logs

MCP connector traffic and OAuth credential renewal each log one structured
console object per event, on Cloudflare and Node alike. Neither carries a
token, client id, URL, tool argument, result, or provider error text.

| `event` | Emitted | Fields |
| --- | --- | --- |
| `chickpea.mcp.http` | Once per HTTP request an Agent turn sends to an MCP server. A turn answers a Streamable HTTP connection's optional `GET` stream, and every `GET` until its tool listing completes, itself with 405, so those requests are neither sent nor logged; after the listing, a `GET` that resumes a tool call's stream is | `connectionId`, `authMode`, `rpcMethod`, `toolName` (tool calls only), `httpMethod`, `status`, `outcome` (`ok`, `stream_unavailable` for a 405 to the optional `GET` stream, `http_error`, `network_error`), `durationMs`, `requestBytes`, `responseBytes` |
| `chickpea.mcp.tools_missing` | Once per complete tool listing of a Streamable HTTP MCP connection that leaves out tools the Agent may use; the rest still mount. A listing completes at a page without a next cursor, or with one the client already sent | `connectionId`, `missing` (granted tool names the server no longer lists), `taskOnly` (granted tools it lists for task-based execution only, which Flue skips), `listedCount` (tools the server listed) |
| `chickpea.mcp.tools_list_refused` | Before a Streamable HTTP MCP connection fails because Chickpea could not narrow its tool listing to the Agent's tools. Until the listing completes, this covers every request's answer, `initialize` included; the matching `chickpea.mcp.http` line has `outcome: network_error` and the `rpcMethod` | `connectionId`, `reason`: `no-granted-tools` (none of the Agent's tools is listed), `no-tools-capability` (the server's `initialize` answer declares no tools), `status` or `content-type` (the answer is not a 200 JSON or event-stream body, such as a 202 that sends it elsewhere), `no-response` (the body holds no answer to this request), `response-id` (it holds an answer to another request, or one without an id), `batch`, `invalid-json`, `json-rpc` (an answer the MCP client would not read as one, such as an error without an integer `code` and a string `message`), `tool` (a malformed listing), `response-size` (over 8 MB), `response-deadline` (over 30 s), `rewrite` (Meta's account helper is listed twice). Never the server's text |
| `chickpea.oauth.refresh` | Once per OAuth credential renewal outcome (MCP and Google API connections) | `lane` (`mcp`, `api`), `connectionId`, `trigger` (`turn`, `admin`, `keepalive`, `unauthorized`), `outcome`, `reason`, `tokenDeleted`, `tokenAgeMs`, `durationMs` |
| `chickpea.oauth.keepalive` | Once per credential keep-alive sweep, every ten minutes from scheduled maintenance | `credentials` (ready OAuth connections checked), `due`, `renewed`, `unavailable`, `rejected`, `skipped` (another caller was renewing, or the connection changed meanwhile), `failed` (an unexpected error, also logged as a `[chickpea] OAuth keep-alive could not renew a credential` warning with its error code), `deferred` (left for the next sweep; the oldest credentials go first), `durationMs` |

`chickpea.oauth.refresh` outcomes:

- `refreshed`: the provider issued a new access token.
- `unavailable`: the renewal failed transiently (network, timeout, 5xx,
  `temporarily_unavailable`); the credential was kept for the next try.
- `rejected`: the provider refused the grant (`invalid_grant`,
  `unauthorized_client`, or `invalid_client` for a dynamically registered MCP
  client). The credential is deleted and the connection account moves to
  Needs attention with its dependent schedules paused.
- `expired`: an access-only credential passed its expiry and cannot be renewed.
- `missing`: a ready connection account has no stored credential. The account
  moves to Needs attention.

On later turns, an Agent bound to a team connection in Needs attention, or one
whose admin sign-in was started but not finished, is told which connection is
unavailable and says that an admin must reconnect it in Admin. A personal
connection instead offers the member a reconnect link.

`reason` is the provider's registered OAuth error code, `http_<status>` when
the provider sent none, `network` or `timeout` for a failed request,
`invalid_response` for an unusable token response, or `other` for an
unrecognized code (the MCP lane reports unrecognized codes as `server_error`). `tokenAgeMs` is the time since the credential was issued or
last renewed; a `rejected` line with a large `tokenAgeMs` after a quiet period
points to an expired refresh token. An account that was reconnected or renewed
concurrently is never demoted by a late report.

The keep-alive sweep runs as its own scheduled duty, alongside Work
maintenance rather than inside it, and renews any credential with a refresh token and an expiring
access token once it has gone eight hours without renewal, including while the
connection is unused, because some providers expire refresh tokens after as
little as a day of inactivity. It renews at most ten credentials per sweep. A
failed renewal keeps the credential and is retried on each sweep for an hour,
then hourly, until it succeeds or the provider rejects it.

When an MCP server answers `401` to an OAuth connection's current access token,
the one retry the MCP client makes renews that credential first, with trigger
`unauthorized`, so a grant revoked before its expiry is classified at once
instead of failing until the token expires. A credential issued within the last
minute is not renewed this way, and each runtime renews a given credential this
way at most once a minute.
