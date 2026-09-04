# Runtime observability

Use this runbook for runtime failures, unexplained behavior, and timing issues,
including live verification. Start with retained evidence, not new diagnostics.
Logs explain causes; actual Slack/Admin/provider readback proves acceptance.
Successful actions do not require routine log inspection.

## Choose the tool and target

| Need | Tool |
| --- | --- |
| Historical events, invocations, traces, aggregate metrics, read-only infrastructure | Cloudflare API MCP `cloudflare-api`: discover with `search`, call with `execute` |
| Live logs during an authorized reproduction | Wrangler `tail`, attached before the action and stopped afterward |
| Visual trace waterfall or access fallback | Signed-in Cloudflare dashboard |
| Local development, builds, deployment | Existing repository commands; deployments only through `npm run deploy` |

MCP, Wrangler, and dashboard authorization are independent. An error in one
does not establish that the others are unavailable. Do not change credentials,
permissions, collection settings, or deployments to follow this runbook.
Keep the [environment claims and deployment fences](parallel-live-test-environments.md)
and [attended live workflow](../../qa/live/operator/SKILL.md).

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
4. Perform the single attributable action under the existing claim/UI lock.
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
