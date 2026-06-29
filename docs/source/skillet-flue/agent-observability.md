# Agent Observability

Last updated: 2026-06-25

Skillet owns the hosted-agent observability layer. Cloudflare AI Gateway,
Workers logs, CMA dashboards, and future provider log APIs are corroborating
sources, not product session truth.

## Source of Truth

- `runtime_route` decides which hosted runtime owns a session. Missing rows mean
  legacy CMA.
- `chat_session` and `chat_message` are product transcript state. The admin
  report does not select `chat_message.content`.
- `session_usage_event` remains the usage and free-budget ledger.
- `session_turn_attempt`, `agent_model_call`,
  `agent_model_request_attempt`, `agent_observation_event`, and
  `external_request_evidence` are diagnostic ledgers.
- Cloudflare AI Gateway evidence is stored as external request evidence.
  Request and response payload endpoints are not used. New Cloudflare request
  attempts persist the emitted Gateway event id for exact log correlation.

## Admin Surfaces

Authenticated HTML:

```text
/admin/agent-observability?skill_id=office-hours&hours=24&limit=100
```

Authenticated JSON:

```text
/api/admin/agent-observability?skill_id=office-hours&hours=24&limit=100
```

Optional Gateway sync:

```bash
curl -X POST "https://skilletweb.com/api/admin/agent-observability/gateway-sync?skill_id=office-hours&hours=24" \
  -H "Authorization: Basic $ADMIN_BASIC_AUTH" \
  -H "Origin: https://skilletweb.com" \
  -H "x-skillet-admin-action: 1"
```

Scriptable report:

```bash
SKILLET_ADMIN_BASE_URL=https://skilletweb.com \
ADMIN_USER=... \
ADMIN_PASS=... \
node scripts/ops/agent-observability-report.mjs --sync-gateway
```

Use `--json` to print the full sanitized JSON report.

## Gateway Credentials

Set non-secret vars on `apps/web`:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_AI_GATEWAY_ID`

Set this Worker secret on `apps/web`:

- `CLOUDFLARE_AI_GATEWAY_READ_TOKEN`

The token should have Cloudflare AI Gateway logs read permission only. If any
of these values is missing, the report shows `unconfigured` Gateway
correlation and does not attempt dashboard fallback.

## Local Admin Verification

Workers Rate Limit bindings are not always callable in plain Next dev or
OpenNext preview. To visually verify this admin page on localhost under
`pnpm -C apps/web preview`, set the local-only Worker flag:

```bash
# apps/web/.dev.vars
SKILLET_LOCAL_ADMIN_RATE_LIMIT_STUB=1
```

For direct `next dev` checks, set the same flag in `apps/web/.env.local`
instead. The custom Worker entrypoint exposes `.dev.vars` bindings to
middleware during OpenNext/Wrangler preview, so the public alias is no longer
needed for that path.

The stub is accepted only for localhost hosts and only replaces
`RATE_LIMIT_ADMIN`; `ADMIN_USER`, `ADMIN_PASS`, and `AUDIT_HASH_SECRET` are
still required. Do not set this on a deployed Worker.

## Review Checklist

For a last-24h Office Hours audit:

1. Open `/admin/agent-observability?skill_id=office-hours&hours=24`.
2. Confirm session counts by runtime, model, provider, and policy bucket.
3. Review flags: `no response`, `malformed question`, `raw JSON`, `terminal
   error`, and `Gateway missing/unavailable/unconfigured`.
4. If Gateway credentials are configured, run the sync endpoint or script with
   `--sync-gateway`, then reload the report.
5. Drill into D1 only for flagged sessions. Use `chat_message.content` only
   when product debugging requires transcript review.

## Known Limits

- Gateway logs can lag behind Skillet writes. Missing Gateway evidence is not
  automatically a product failure.
- New Cloudflare request attempts correlate by the persisted Gateway event id.
  Older rows without `gateway_event_id` fall back to safe Gateway metadata such
  as `session_id`; if that returns multiple Gateway rows, evidence can be
  marked `ambiguous`.
- CMA sessions before `runtime_route` are reported as `cma` with
  `policyBucket=legacy_cma`.
- The current report is intentionally metadata-first. It surfaces health flags
  and safe ids, not full transcript bodies.
