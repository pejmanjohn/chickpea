# Scheduled work in Slack

Chickpea supports one-time and recurring work in Slack Channels and one-to-one DMs. A clear request such as “Check this again in 5 minutes and tell me anything new” is sufficient; it does not need the word “schedule” and does not require a separate approval.

## Execution model

Standalone schedule requests use the Flue `manage_scheduled_work` durable tool. The tool records its application call with `step.do`, while the state owner derives an idempotency key from the trusted Slack turn and normalized action. The state owner persists a schedule-action ledger entry before applying the shared schedule command. An interrupted or retryable action is reclaimed by the Durable Object alarm and converges on one terminal `applied` or `failed` result.

The application routine store remains the source of truth for cadence, authorization, ownership, and occurrence state. Cloudflare Cron wakes the application scheduler. When an occurrence is admitted, it dispatches a structured Flue `schedule` signal to the Routine Agent. The signal carries the prepared prompt in its body and bounded, code-readable routine and destination identifiers in trusted attributes. Persisted V1 dispatch envelopes remain readable; new admissions use V2.

This division deliberately uses Flue for durable Agent tool execution and structured Agent delivery without adding a second schedule store or replacing application Cron with an Agent SDK timer.

## Slack behavior

- Create, edit, pause, resume, disable, and run-now actions apply immediately when authorized. Natural-language deletion is deliberately excluded from `manage_scheduled_work`: the Agent first inspects routines, proposes one exact `delete_routine` operation with its current version, and deletes only after the requester confirms. Agent reassignment also retains its existing confirmation rule.
- Existing-work actions inspect the scoped routine list first. Ambiguous names must be disambiguated before mutation.
- A user Agent can own and manage only its own scheduled work. Chickpea can administer an eligible user Agent's schedules in the same one-to-one DM, but Chickpea never becomes the schedule owner.
- DM destinations, requester identity, acting Agent, and thread coordinates come from the trusted Slack delivery. Model arguments cannot supply or replace them.
- Group-DM scheduled work is unsupported.
- One-time and recurring results return to the stored origin thread. Repeated recurring failures pause the work and produce one content-free notice at the DM root so failure cannot remain invisible.

## Acknowledgements and recovery

The schedule mutation never calls Slack synchronously. Settlement records acknowledgement intent in the existing outbox and arms the state-owner alarm:

- Applied DM work gets a content-free checkmark reaction on the requesting message. Channel success remains owned by the Agent's normal reply.
- A recovering action can post a pending acknowledgement, followed by one terminal result.
- A permanent failure reports that no active change was made. If authority binding fails after the routine record is saved, the result includes the durable safe state (`pending authority`, `paused`, or `disabled`) rather than claiming success or returning an unknown outcome.
- Slack acknowledgement failure does not roll back a committed schedule. The outbox retries delivery independently and idempotently.

Result delivery retries only an explicit Slack rate limit within the occurrence deadline. Timeouts, connection loss, incomplete responses, and receipt-persistence ambiguity are never retried because doing so could post the same private result twice.

## Privacy boundary

Private DM schedules stay in Slack. Shared Admin Schedules APIs filter for Channel destinations before ordering, pagination, counts, and serialization. Private routine definitions, owners, timestamps, health, runs, events, sessions, usage, and control surfaces are absent. The Agent Schedules tab shows only the static note that DM schedules are not displayed there.

This is an omission boundary, not redaction after retrieval. It prevents private schedule existence from affecting shared counts or pagination.

## Target behavior and operations

Cloudflare is the supported scheduling target. The Node target exposes the same conversational tool but fails closed with `routines_unavailable_on_target`; it must not create an action or imply that work was scheduled.

There is no private-DM scheduling feature flag. Cloudflare readiness requires the schedule-action ledger, state-owner RPC, alarm recovery path, one heartbeat Cron Trigger, and management outbox. Operators should treat a successful build or deployment as structural evidence only. Live acceptance still requires a fresh Slack request, visible acknowledgement, due-time delivery in the same thread, DM-level management, and confirmation that shared Admin surfaces omit the private work.

Relevant Flue references: [Schedules](https://flueframework.com/docs/guide/schedules/), [Durability](https://flueframework.com/docs/guide/durability/), and [Tools](https://flueframework.com/docs/guide/tools/).
