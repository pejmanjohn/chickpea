# Routine usage capture

Implemented for the usage observability rollout on 2026-07-28.

- Routine occurrence IDs are the usage work-instance IDs. A Flue Workflow run supplies the execution ID, so persistence retries remain idempotent and a distinct execution can be retained if work genuinely runs again.
- Admission occurs after live authority is resolved and the routine run begins, but before Agent construction or model work. It freezes the routine definition, profile, named channel, requested model/provider, and opaque credential epoch.
- Success and no-op outcomes record aggregate response usage when Flue reports non-zero input/output/total units. Model failures, deadlines, and cold-Workflow interruption use explicit unknown reasons rather than zero.
- Existing routine input/output/cache/model-registry fields remain compatibility fields. New runs link to their usage-ledger operation and carry `usage_ledger` provenance plus completeness; historical rows default to `legacy_routine` and explicitly lack provider/credential provenance.
- Scheduled Work Admin detail reads the linked ledger when available and labels missing linked or legacy-only data instead of treating the older model-registry estimate as reconciled spend.
- Routine telemetry uses the same fail-open persistence budget and one bounded repair attempt as interactive turns. `USAGE_RUNTIME_RECORDING` controls both paths.
