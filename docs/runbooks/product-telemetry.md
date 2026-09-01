# Product telemetry

Chickpea sends a small, content-free set of product events to a dedicated PostHog Cloud project. Telemetry is enabled by default so maintainers can measure adoption, but operators can disable it completely with `DO_NOT_TRACK=1` or `CHICKPEA_DISABLE_TELEMETRY=1`.

## PostHog project

- Organization: `Chickpea`
- Project: `Chickpea` (project ID `589233`)
- Region: US Cloud
- Ingest origin: `https://us.i.posthog.com`
- Access: organization membership is the project boundary on the free plan. Keep membership limited to Chickpea telemetry maintainers; the organization currently has one owner and no other members.
- Public ingestion token: compiled into Chickpea's telemetry transport. It is a write-only project token, not a secret.

Never put a PostHog personal API key in source, Worker variables, test fixtures, logs, or documentation. Maintainer automation that needs read access must use a separately managed credential outside this repository.

## Privacy controls

The PostHog project has these controls configured:

- **Settings → Project → Privacy → Discard client IP data** is enabled.
- **Data → Transformations → GeoIP** is paused.
- **Data → Transformations → Drop Events** exists with no event matcher and is paused. With no matcher it applies to every event when enabled, so it is the fastest maintainer-side ingestion kill switch.
- Person profiles are disabled per event with `$process_person_profile: false`. The telemetry integrity monitor checks that the persons table remains empty.

The application contract is stricter than the PostHog project controls. Events never include Slack workspace IDs, channel IDs, user IDs, Agent IDs, connection IDs, schedule IDs, URLs, headers, tokens, prompts, messages, tool arguments, tool results, or error text. Installation identity is a random local UUID, and child identities are deterministic hashes derived from it.

## Event and environment contract

Only schema version `1` events in the closed telemetry event union are accepted. Every event includes `telemetry_environment`, which is one of `development`, `test`, or `production`. Production measurement uses a dashboard-level `telemetry_environment = production` filter.

The allowed events are:

- `workspace_connected`
- `agent_created`
- `connection_ready`
- `schedule_created`
- `run_completed`
- `installation_active`

The dashboard and saved SQL insights use only event properties and `distinct_id`. Do not use PostHog Retention, Lifecycle, Stickiness, or person-cohort products because those depend on person profiles. App-version segmentation stays omitted until Chickpea exposes a real release version.

## Measurement assets

- Dashboard: [Chickpea product telemetry](https://us.posthog.com/project/589233/dashboard/2055665)
- Owner: Chickpea telemetry maintainers in the dedicated one-member organization.
- Dashboard filter: `telemetry_environment = production`, persisted at dashboard level and repeated inside every product SQL query.
- Schema filter: `schema_version = 1` inside every product SQL query.
- Calendar: UTC. Seven- and 30-day windows use complete UTC days; weekly retention uses the two most recent complete Monday-starting UTC weeks.
- Activation/customization cohort window: newly connected installations in the trailing 30 complete UTC days, with first-ever connection bounded by the telemetry launch timestamp.

The nine product definitions and two stop signals are saved as SQL insights:

| Tile | Saved insight | Contract |
|---|---|---|
| Active installations | [`VMreJUAk`](https://us.posthog.com/project/589233/insights/VMreJUAk) | Unique installations with a daily snapshot in the trailing seven complete UTC days. |
| Newly connected installations | [`Wv9NcocK`](https://us.posthog.com/project/589233/insights/Wv9NcocK) | Unique installations whose first connection falls in the trailing 30 complete UTC days. |
| Seven-day activation | [`IrGWtxDv`](https://us.posthog.com/project/589233/insights/IrGWtxDv) | Successful interactive run within seven days of first connection, on the same `workspace_key`. |
| Agent customization | [`LPJrPInM`](https://us.posthog.com/project/589233/insights/LPJrPInM) | Agent creation within the activation window, plus successful-run share on user-created Agents. |
| Connection adoption | [`K3UknfOR`](https://us.posthog.com/project/589233/insights/K3UknfOR) | Latest snapshot among seven-day active installations has `ready_connection_count != '0'`. |
| Schedule adoption | [`ffE9jOk4`](https://us.posthog.com/project/589233/insights/ffE9jOk4) | Latest snapshot among seven-day active installations has `enabled_schedule_count != '0'`. |
| Human-active installations | [`PiWd0OzO`](https://us.posthog.com/project/589233/insights/PiWd0OzO) | Unique installations with an interactive run in the trailing seven complete UTC days. |
| Weekly return rate | [`261Eszzf`](https://us.posthog.com/project/589233/insights/261Eszzf) | Earlier-week human-active installations returning in the next complete week, plus any-activity comparison. |
| Run volume and outcome | [`PrAANXBD`](https://us.posthog.com/project/589233/insights/PrAANXBD) | Runs and installations by runtime, trigger, Agent origin, and outcome over 30 complete UTC days. |
| Event/property integrity | [`O00bXoaW`](https://us.posthog.com/project/589233/insights/O00bXoaW) | Must return no rows for the exact six-name, schema-v1, person-disabled, per-event property allowlist. |
| Person profiles | [`dLr1LmyE`](https://us.posthog.com/project/589233/insights/dLr1LmyE) | Must remain zero. |

The product tiles are deliberately SQL insights. PostHog's person-based Retention, Lifecycle, Stickiness, and cohort products are not valid substitutes for these anonymous `distinct_id` definitions.

## Operating the kill switches

Use the narrowest appropriate control:

1. For one installation, set `DO_NOT_TRACK=1` or `CHICKPEA_DISABLE_TELEMETRY=1` and restart it. Telemetry becomes a total no-op: no identity creation, timers, network attempts, or telemetry logs.
2. For all installations, enable the paused match-all **Drop Events** transformation. Events are discarded before storage and do not count toward usage.
3. To invalidate every deployed client, reset the **Project token** under **Settings → Project → General**. This preserves project history but requires a Chickpea release with the replacement public token before telemetry resumes.

Do not delete the PostHog project as a rollback step.

## Integrity monitoring

The dashboard includes an integrity SQL insight that should return no rows. Its saved query additionally compares `JSONExtractKeys(properties)` with the exact per-event property allowlist:

```sql
SELECT event, count() AS n
FROM events
WHERE timestamp >= toDateTime('2026-09-01 00:00:00')
  AND (event NOT IN ('workspace_connected', 'agent_created', 'connection_ready',
                    'schedule_created', 'run_completed', 'installation_active')
   OR toInt(properties.schema_version) != 1
   OR properties.$process_person_profile != false)
GROUP BY event
```

It is paired with a persons-count SQL insight:

```sql
SELECT count() AS persons_count
FROM persons
```

`persons_count` must remain zero. These insights detect contract violations after ingestion; they do not make a public token authoritative.

## Acceptance record

### 2026-09-01 — Node ingestion canary

- Source: the production telemetry client from this branch with an in-memory settings/config store and `telemetry_environment = test`.
- Ingest response: HTTP 200 from `https://us.i.posthog.com/batch`.
- Stored events: one `workspace_connected` and its same-batch `installation_active`, sharing the test installation identity and timestamp.
- Stored contract: both events report `schema_version = 1`, `runtime_target = node`, `telemetry_environment = test`, and `$geoip_disable = true`. The snapshot contains only the four count buckets and global fields.
- Privacy result: `persons_count = 0`; `$ip` and `$geoip_country_code` are absent; the project reports `anonymize_ips = true`; the exact-property integrity query returns no rows.
- Dashboard result: all nine product queries and both stop signals compiled and refreshed. The persisted dashboard filter is `telemetry_environment = production`, so the test canary does not affect product metrics.

### 2026-09-01 — Cloudflare/Admin/Slack canary

- Deployment: disposable Worker `chickpea-agent-first-disposable`, version `2ab5b182-86cb-48c6-806f-a65f339c49fe`, serving 100% of traffic with the expected production bindings and `CHICKPEA_TELEMETRY_ENVIRONMENT=test`.
- Admin proof: the signed-in Admin created `Telemetry Canary Sep 1` (`telemetry-canary-sep1`); the API returned HTTP 201 and the Agent appeared in inventory.
- Slack proof: a real DM asked the canary Agent to reply with an exact phrase. Chickpea returned `telemetry canary ok` and identified the serving model as `openai/gpt-5.6-terra`.
- Stored creation events: PostHog received `agent_created` and the same-batch `installation_active` at `2026-09-01T21:30:09.601Z`.
- Stored run event: PostHog received `run_completed` at `2026-09-01T21:34:55.123Z` with `trigger = interactive`, `outcome = succeeded`, and `agent_origin = user_created`.
- Identity result: all three events share one random installation `distinct_id`; the creation and run events use the same pseudonymous `workspace_key` and `agent_key`. No source Slack or Chickpea identifiers are present.
- Privacy result: all three events report `schema_version = 1`, `runtime_target = cloudflare`, `telemetry_environment = test`, `$process_person_profile = false`, and `$geoip_disable = true`. The integrity query returns no rows and `persons_count = 0`.
- Dashboard result: the production-filtered product tiles remain at zero, so the canary does not affect adoption reporting.

### 2026-09-01 — Test-process isolation

- The live PostHog inspection revealed privacy-safe `development` events from local integration tests that exercised default-on Node runtime composition without a mocked telemetry boundary.
- The repository-wide test command now sets `DO_NOT_TRACK=1`. Only telemetry-specific tests explicitly opt back in, and every such test uses a mocked fetch transport.
- A follow-up targeted run produced no additional `development` events in PostHog. This prevents ordinary local and CI test runs from consuming telemetry quota or distorting development observations.

The one-hour and 24-hour checks verify bounded event volume, the exact event/property allowlist, zero person profiles, and absent IP/GeoIP enrichment after the canary.

## Maintenance

- Dashboard owner: Chickpea telemetry maintainers.
- Review the event/property allowlist, identity derivation, PostHog access, privacy settings, transformations, and integrity monitors every quarter.
- Repeat the review before adding or changing any event or property.
- After changing the project token, update the compiled public token, run the telemetry contract tests, and verify one canary event before releasing.
