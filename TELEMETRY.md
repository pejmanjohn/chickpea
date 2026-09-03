# Product telemetry

Chickpea sends a small set of anonymous product events from self-hosted deployments. This document is the complete account of what is sent, what is deliberately not sent, why collection exists, and how to turn it off.

Telemetry is enabled by default. Chickpea is normally operated outside infrastructure its maintainers can observe, so these events provide the minimum signal needed to understand whether the project is growing, whether installations reach a successful run, whether connections and schedules are adopted, and whether installations return. Telemetry is advisory only: it is never used for billing, entitlements, security decisions, reliability alerts, or customer-facing state.

## What every event sends

Every event has:

- `distinct_id`: a random UUID representing one Chickpea installation.
- `timestamp`: the UTC time when Chickpea attempted delivery.
- `schema_version`: currently `1`.
- `runtime_target`: `cloudflare` or `node`.
- `app_version`: the Chickpea package version compiled into that release; the current pre-release package reports `0.0.0`.
- `telemetry_environment`: `production`, `development`, or `test`.
- `$process_person_profile: false`: tells PostHog not to create or update a person profile.
- `$geoip_disable: true`: tells PostHog not to derive location from the request IP.

`workspace_key` and `agent_key`, where present, are installation-local pseudonyms. They are the first 16 bytes of a domain-separated HMAC-SHA-256 value encoded as base64url. They let maintainers associate anonymous milestones within one installation without sending a Slack workspace ID or Chickpea Agent ID. They cannot be compared across installations.

## Complete event catalog

This table is exhaustive. Chickpea has no browser autocapture, session recording, exception capture, or catch-all event API.

| Event | Event-specific properties | Meaning |
|---|---|---|
| `workspace_connected` | `workspace_key`; `transport_mode` (`direct` or `gateway`) | A Slack workspace first reached a healthy connected state through the customer-owned app lane or shared gateway lane. |
| `agent_created` | `workspace_key`; `agent_key`; `surface` (`admin`, `slack`, `mcp`, or `other`) | A user-created Agent was committed. The seeded Default Agent does not emit this event. |
| `connection_ready` | `workspace_key`; `agent_key`; `connection_kind` (`managed`, `mcp`, or `api`); `owner_kind` (`team` or `member`); `surface` (`admin`, `slack`, `mcp`, or `other`) | A connected account first became ready for use. It does not identify the provider, toolkit, account, or owner. |
| `schedule_created` | `workspace_key`; `agent_key`; `cadence_kind` (`one_time` or `recurring`); `destination_kind` (`channel` or `direct_thread`) | A new schedule and its Agent authority binding were committed. It does not include the task, expression, time zone, destination, or recipient. |
| `run_completed` | `workspace_key`; `agent_key`; `agent_origin` (`seeded` or `user_created`); `trigger_kind` (`interactive` or `scheduled`); `outcome` (`succeeded`, `no_op`, or `failed`) | A customer-visible interactive delivery or a scheduled-run settlement reached a terminal state. It does not include output, duration, token use, model, failure class, or error text. |
| `installation_active` | `workspace_count`; `user_agent_count`; `ready_connection_count`; `enabled_schedule_count` | A coarse installation snapshot appended to at most one meaningful event per UTC day. Every count is reduced to `0`, `1`, `2_4`, or `5_plus` before delivery. |

Unknown event names and properties are discarded by a closed runtime allowlist. Arbitrary enum values are reduced to a documented safe fallback rather than forwarded. Adding or changing an event or property requires an allowlist change, contract tests, and an update to this file in the same reviewed change.

## What is never sent

- No Slack messages, prompts, instructions, memory, attachments, transcripts, or model input or output.
- No tool names, tool arguments, tool results, code, repository contents, schedule tasks, connection data, or connector provider names.
- No error messages, stack traces, HTTP response bodies, operational logs, performance timings, token counts, or model names.
- No Slack workspace, channel, user, user-group, message, or thread IDs; no Chickpea Agent, connection, schedule, or run IDs.
- No names, email addresses, usernames, organization names, hostnames, URLs, IP-derived location, headers, tokens, credentials, or secrets.
- No browser events, page views, clicks, session recordings, cookies, device fingerprint, or person profiles.

## Anonymous installation identity

On the first eligible event, Chickpea creates a random UUID and a random 32-byte HMAC key and stores them in the deployment's existing app-settings store under `telemetry.identity.v1`. Neither value is derived from a machine, Slack account, network, hostname, or customer data. The UUID becomes `distinct_id`; the HMAC key remains local and is used only to create the workspace and Agent pseudonyms described above.

The active-day marker is stored separately under `telemetry.active_day.v1`. It contains only the last claimed UTC date. The day is claimed atomically before inventory reads, so concurrent activity cannot create duplicate daily snapshots. Delivery is deliberately best-effort: a failed snapshot is not retried.

Deleting `telemetry.identity.v1` while telemetry is disabled resets the anonymous identity; the next eligible event creates an unrelated UUID and pseudonym key. Also delete `telemetry.active_day.v1` if the installation should be eligible for a fresh snapshot on the same UTC day. Deleting or recreating all deployment state has the same effect. Existing events already stored by PostHog are not linked to the new identity and are not deleted by a local reset.

## Opting out

Set either environment variable to `1`, `true`, or `yes`, case-insensitively:

- `DO_NOT_TRACK`: the common cross-tool opt-out.
- `CHICKPEA_DISABLE_TELEMETRY`: Chickpea product telemetry only.

Restart the deployment after changing its environment. On Node, set the variable in the process or service environment. On Cloudflare, add it as a Worker variable or with `npx wrangler secret put DO_NOT_TRACK`.

Opting out is total. The telemetry composition returns a no-op before reading or creating identity state, reading adoption inventory, generating randomness, starting a timer, making a network request, or writing a telemetry log. Nothing is buffered for later delivery.

`CHICKPEA_TELEMETRY_ENVIRONMENT` may be set to `production`, `development`, or `test`. It labels events; it does not disable them. Cloudflare defaults to `production`, Node defaults to `development`, and an unsupported value cannot enter the production measurement set.

## Delivery and network metadata

Chickpea sends an HTTPS `POST` to the fixed PostHog US Cloud endpoint `https://us.i.posthog.com/batch`. The public project token compiled into the client grants ingestion only; it is not a secret and cannot read project data.

Each product outcome is sent immediately in a batch containing that event and, when the daily gate is won, one `installation_active` event. A request is limited to 32 KiB, has a five-second deadline, follows no redirects, reads no response body, and is never retried. Failures are swallowed and cannot change an HTTP response, Slack acknowledgement, Agent result, state transition, retry decision, or scheduled-run outcome.

Like any HTTPS request, the network peer receives ordinary connection metadata such as the source IP, TLS and HTTP metadata, timing, and approximate request size. The Chickpea PostHog project is configured to discard source IP data. GeoIP enrichment is disabled both on each event and through the project's transformation settings. Network intermediaries selected by the operator or hosting platform may still process ordinary transport metadata under their own policies.

## Enforcement

The privacy boundary is structural:

- A closed discriminated event union and per-event serializer rebuild each payload from an explicit property allowlist.
- Raw local workspace and Agent IDs exist only long enough to compute installation-local HMAC pseudonyms.
- Product hooks run only after committed milestones or terminal settlements; operational log and exception records are not telemetry inputs.
- The PostHog client has a fixed HTTPS origin and public write-only token, with no runtime destination override in production composition.
- Contract tests inject raw IDs, prompts, URLs, tokens, errors, and unknown fields and assert that none reaches the serialized request.
- Maintained analytics query only the six documented names, schema version `1`, and the production environment. Integrity checks flag unknown names or person profiles; they detect public-token abuse but are not treated as a security control.

For the implementation, see [`src/telemetry/events.ts`](src/telemetry/events.ts), [`src/telemetry/identity.ts`](src/telemetry/identity.ts), and [`src/telemetry/client.ts`](src/telemetry/client.ts).
