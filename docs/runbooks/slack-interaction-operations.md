# Slack interaction operations

Use this runbook when validating or diagnosing ambient participation, reaction-only replies, work acknowledgments, editable checklists, or teammate-added reaction input.

## What to inspect

Slack is the user-visible surface, but it is not the complete acceptance record:

- The authenticated **Session inspection API** under `/admin/api/sessions` shows each promoted interaction's Run status, delivery method/reference, execution history, and recovery state. A reaction-only response is a delivered session even though no text message exists.
- **Usage** in `/admin` records `interaction_classification` separately from `interactive_turn`. Promoted classifier usage links to the canonical Run; ignored ambient/reaction decisions retain only body-free assignment attribution.
- **Worker logs** carry sanitized warnings for reaction, checklist, heartbeat, cleanup, and Usage persistence failures. They never include the candidate message body, raw Slack errors, provider errors, commands, or credentials.
- **Slack itself** proves exact targeting, ordering, one mutable checklist, generic `is thinking...` liveness, and acknowledgment cleanup.

For a promoted case, record the Slack permalink, Run ID, terminal disposition, delivery method/reference, and matching Usage operation. For an ignored ambient case, verify through the Session API that no Run exists for the message and that any classifier Usage record has no Run ID or message content.

## Healthy signals

- A complex request adds `:eyes:` before posting exactly one checklist; checklist updates reuse one timestamp; a written result arrives; the checklist finalizes; and Chickpea removes only the acknowledgment it created.
- A pure agreement, confirmation, seen acknowledgment, or appreciation settles through `slack_reaction_add` with no main-agent execution or text response.
- A human `reaction_added` event is classified once against the target and bounded thread context. Chickpea-authored and bot-authored reactions stop before classification.
- A long quiet wait refreshes the same checklist about once per minute. The heartbeat stops before terminal finalization and never keeps a completed turn alive.
- Channel/thread mention-only changes take effect immediately at the correct scope; direct mentions remain guaranteed.

## Safe log filters

Filter Worker logs for these stable, content-free warnings:

- `Slack work acknowledgment failed`
- `Slack work checklist post failed`
- `Slack work checklist heartbeat failed`
- `Slack work checklist heartbeat drain timed out`
- `Slack work checklist finalization failed`
- `Slack work acknowledgment cleanup failed`
- `Slack interaction cleanup retry failed`
- `usage` together with `timed_out` or `persistence`

Repeated Usage persistence timeouts mean Slack delivery may still be healthy, but the acceptance record is incomplete. Check the matching Session and Usage operation before retrying the user-visible interaction; never duplicate a Slack result merely to repair telemetry.

## Recovery checks

1. Confirm the Session has one terminal delivery and note its delivery reference.
2. Confirm the latest RunExecution is terminal when a full agent ran. Reaction-only responses intentionally have no main-agent execution.
3. Confirm matching redacted Usage exists for the classifier and, when applicable, the interactive turn.
4. If an acknowledgment or checklist remains stale after delivery, inspect the matching delivery reference and content-free cleanup warning. The repair lane must update only adapter artifacts and must not re-enter final delivery.
5. If Slack reports `invalid_name`, verify the next semantic fallback was attempted. If reaction scope is missing, substantive work must still end in words; a reaction-only response may use its fixed one-line fallback.
6. If the TurnJob has an envelope but no receipt, repeat only the exact keyed dispatch. If it has a receipt, reattach `read()` without dispatch. If it has a settlement, run delivery repair without reading or dispatching.
7. A local reader timeout is resumable. Abort the Flue instance only after the app-owned deadline or an authorized cancellation; an abort is not proof that no tool ran.

## Flue 2 continuity checks

- Channel threads adopt a compatible runtime-plan revision silently. Verify the next TurnJob records the new plan while the Slack thread receives no reset notice.
- DM and App Home plan changes start a fresh Flue generation. Verify one continuity notice is checkpointed and delivered before the first reply, including after a delivery retry.
- Credential rotation alone must not create a new generation or notice. Credentials resolve through the live provider/MCP seam on each submission.
- Never place TurnJob IDs, Run IDs, receipts, credentials, or private runtime policy in status text, checklists, tool-visible messages, or other model-visible delivery signals.

## Rollback and isolation

- Set `SLACK_TAG_AMBIENT_PARTICIPATION=false` for an installation-wide mention-only rollback without changing channel settings or capabilities.
- Set one Channel to **Mention only** in `/admin` for a narrower rollback.
- A direct, membership-verified Slack instruction may quiet or re-enable one channel or thread. Ambient candidates and inbound reactions cannot change participation state.
- Do not remove reaction scopes as a rollback mechanism. Missing scopes degrade safely, but they also remove acknowledgment and reaction-only behavior.
