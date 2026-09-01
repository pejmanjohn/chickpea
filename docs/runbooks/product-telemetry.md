# Product telemetry

Chickpea sends a small, content-free set of product events to a dedicated PostHog Cloud project. Telemetry is enabled by default so maintainers can measure adoption, but operators can disable it completely with `DO_NOT_TRACK=1` or `CHICKPEA_TELEMETRY_DISABLED=1`.

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

Only schema version `1` events in the closed telemetry event union are accepted. Every event includes `telemetry_environment`, which is one of `development`, `test`, `staging`, or `production`. Production measurement uses a dashboard-level `telemetry_environment = production` filter.

The allowed events are:

- `workspace_connected`
- `agent_created`
- `connection_ready`
- `schedule_created`
- `run_completed`
- `installation_active`

The dashboard and saved SQL insights use only event properties and `distinct_id`. Do not use PostHog Retention, Lifecycle, Stickiness, or person-cohort products because those depend on person profiles. App-version segmentation stays omitted until Chickpea exposes a real release version.

## Operating the kill switches

Use the narrowest appropriate control:

1. For one installation, set `DO_NOT_TRACK=1` or `CHICKPEA_TELEMETRY_DISABLED=1` and restart it. Telemetry becomes a total no-op: no identity creation, timers, network attempts, or telemetry logs.
2. For all installations, enable the paused match-all **Drop Events** transformation. Events are discarded before storage and do not count toward usage.
3. To invalidate every deployed client, reset the **Project token** under **Settings → Project → General**. This preserves project history but requires a Chickpea release with the replacement public token before telemetry resumes.

Do not delete the PostHog project as a rollback step.

## Integrity monitoring

The dashboard includes an integrity SQL insight that should return no rows:

```sql
SELECT event, count() AS n
FROM events
WHERE event NOT IN ('workspace_connected', 'agent_created', 'connection_ready',
                    'schedule_created', 'run_completed', 'installation_active')
   OR toInt(properties.schema_version) != 1
   OR properties.$process_person_profile != false
GROUP BY event
```

It is paired with a persons-count SQL insight:

```sql
SELECT count() AS persons_count
FROM persons
```

`persons_count` must remain zero. These insights detect contract violations after ingestion; they do not make a public token authoritative.

## Maintenance

- Dashboard owner: Chickpea telemetry maintainers.
- Review the event/property allowlist, identity derivation, PostHog access, privacy settings, transformations, and integrity monitors every quarter.
- Repeat the review before adding or changing any event or property.
- After changing the project token, update the compiled public token, run the telemetry contract tests, and verify one canary event before releasing.

