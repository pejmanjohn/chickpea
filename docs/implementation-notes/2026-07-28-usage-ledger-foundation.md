# Usage ledger foundation

Date: 2026-07-28

Plan: `docs/plans/2026-07-28-001-feat-usage-cost-observability-plan.md`

Unit: U1

## Contract

The ledger is additive, target-neutral SQLite logic shared by Node and the
singleton Cloudflare `TagStateStore`. It records one content-free operation at
admission and at most one immutable aggregate terminal measurement for that
operation. A terminal retry is idempotent only when every bounded accounting
field matches; a different replay fails with a typed conflict.

Missing response usage is stored as nullable values plus a normalized reason.
Direct messages retain only their opaque conversation ID and group under the
generic `Direct message` label. Prompts, result text, tool data, request IDs,
headers, and credentials have no fields in the domain or Admin responses.

The read-only Admin API supports a maximum 366-day range, at most ten values
per filter, one group at a time, 100 groups, and stable time/ID pagination.
Currency-compatible estimates are never summed across currencies.

## Capacity evidence

A local Node SQLite load probe created and terminalized 20,000 operations with
25 profiles, 100 channels, 20 routines, and two providers. Combined admission
plus terminal-write p95 was 0.240 ms (maximum 16.89 ms). One hundred indexed
30-day profile/channel rollups measured p95 77.72 ms (maximum 92.88 ms). Both
remain inside the U0 100 ms application budget on this checkout.

The local workerd smoke initializes the same schema in `TagStateStore`, queries
the empty Usage summary through the authenticated Worker/Admin/RPC path, and
already measured a representative heavier three-write transaction at p95
3.40 ms. This is local workerd evidence, not a deployed-Worker performance
claim. Deployed storage and realistic cardinality remain an explicit rollout
gate before enabling runtime recording or Admin Usage in production.

## Defaults used while the review checkpoint is unattended

- Accounting root: `installation` in storage and `Installation` in operator copy.
- Per-operation retention: 90 days; aggregate retention remains 13 months once
  materialized aggregates exist.
- Actor reporting: no per-user dimension; DMs stay generic.
- Monetary values: integer millionths of source currency; no FX conversion.
