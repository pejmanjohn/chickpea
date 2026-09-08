# Semantic activity status

This runbook covers the closed semantic activity contract, its content-free
telemetry, and the disposable Slack/Gmail acceptance gate. It does not grant
authority to deploy, connect an account, send Slack traffic, or run a live
connector. Obtain explicit authority before the live procedure.

## Product and transport contract

New Slack turns use only Slack's native under-composer status:

- When semantic status is enabled, Chickpea writes the same bounded phrase to
  `status` and the one-entry `loading_messages` field of
  `assistant.threads.setStatus`.
- When semantic status is disabled, Chickpea emits no custom semantic
  projection. Slack's generic Agent Session `processing` lifecycle remains the
  only progress surface when it is available.
- A native-status rejection latches custom status off for that turn. It does
  not post, update, or delete an app-owned progress message and cannot block the
  final reply.
- Previously persisted message projections may update or delete only their
  exact stored coordinate for recovery. They are never selected for new work.
- A truthful phase refreshes at about 90 seconds so it does not expire at
  Slack's two-minute boundary. Ownership fencing and the shared installation
  budget can drop a cosmetic refresh; they never delay the answer.

Slack currently describes
[`assistant.threads.setStatus`](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/)
as a compatibility bridge. Agent Sessions provide generic lifecycle states but
no equivalent custom semantic copy. Treat removal or contract change as a
product compatibility risk. Review Slack's current platform contract, scopes,
expiry, persona behavior, and
[replacement guidance](https://docs.slack.dev/changelog/2026/08/20/agent-updates/)
on **2026-12-01**, then either keep the bridge or deliberately sunset to
lifecycle-only behavior. Do not add a message fallback during that review.

## How semantic copy is added

The runtime never asks a model to narrate progress. A tool owner supplies a
closed descriptor containing an operation, target family, safe object noun,
effect, lifecycle role, and trust tier. The deterministic narrator turns that
descriptor plus a real start or terminal event into copy.

When adding a first-party capability:

1. Put its descriptor next to the authoritative capability or tool definition.
   Reuse the enums in `src/activity/semantic.ts`; do not add arbitrary prose.
2. For a managed connector, derive the product-controlled label, operation,
   object, and effect from the immutable managed catalog. Optional overrides
   may select only another closed operation or object.
3. Use an invocation-owner fact only when the owner already validates the input
   and tool identity alone cannot select the closed operation. Only the enum
   and a granted descriptor reference may leave that owner.
4. Keep customer-authored Agent, skill, repository, MCP/API connection, account,
   and resource names generic by family. Never promote display names, paths,
   arguments, or result fields into the descriptor.
5. Add tests for start, successful review, failure or ambiguity, and the
   unregistered-tool fallback. A new built-in or managed action must be covered
   at its definition site; Slack must not grow a parallel tool-name mapping.

The fixed unknown fallback is intentional. If a descriptor is missing,
untrusted, malformed, or not granted by the active RuntimePlan, improve the
owner/catalog registration instead of extracting a name from runtime content.

## Telemetry boundary

`src/activity/telemetry.ts` is the only semantic activity telemetry schema.
Records use the `[chickpea:activity]` prefix and contain only:

- schema version;
- closed semantic family and phase;
- queue layer and disposition;
- native or legacy-recovery surface;
- transport, clear, refresh, and shared-rate outcomes;
- completed work family, outcome, and measured duration;
- booleans and durations clamped to five minutes.

The emitter drops unknown fields and open-ended strings. It never records
rendered labels or status text, Slack/workspace/user/channel/account
coordinates, durable run or tool-call IDs, deterministic hashes of those IDs,
tool names, arguments, results, raw errors, prompts, provider content,
customer-authored names, or secrets. No submission token is currently emitted.
As a result, disposable evidence must isolate one acceptance run per capture
instead of correlating production users.

Run the privacy and behavior checks with:

```bash
npm run typecheck
node --test --import tsx \
  tests/activity-telemetry.test.ts \
  tests/activity-status.test.ts \
  tests/activity-lifecycle.test.ts \
  tests/status-registry.test.ts \
  tests/status-relay.test.ts \
  tests/web-client-presenter.test.ts \
  tests/run-turn-heartbeat.test.ts \
  tests/semantic-activity-live-verifier.test.ts
```

## Disposable acceptance gate

Do not run this section against a real mailbox or ordinary Slack workspace.
The cold operator needs explicit deploy and live-run authority, a disposable
Chickpea version, a disposable Slack workspace/channel, and a disposable Gmail
mailbox containing only synthetic seeded messages.

### Prepare

1. Record the currently serving disposable version and the exact restoration
   command without placing a version ID in semantic telemetry.
2. Seed the disposable mailbox with innocuous synthetic messages. Confirm no
   personal, company, customer, or production mail is present.
3. Connect Gmail read-only and verify the admitted RuntimePlan grants the real
   managed Gmail search capability. Do not enable a write capability.
4. Configure capture to retain only `[chickpea:activity]` events. Do not export
   general application logs for this proof.
5. Crop screen capture to Slack's native status region before recording. Slack
   identity, prompt text, final reply, thread content, and connector results
   must remain outside the captured region.

### Observe normal timing

1. Submit one read-only question that requires the real managed Gmail search
   tool. Do not add a sleep, dwell, or pacing change to product code.
2. Watch the status while the turn is active. A final thread screenshot is not
   evidence of the sequence.
3. Save this turn's fixed-schema events in its own file. The verifier derives
   eligibility from a managed-connector `activity.work` duration of at least
   one second and matches specificity to an acknowledged native
   `managed_connector`/`working` transport event. Do not combine turns.
4. Collect at least ten isolated eligible turns. At least 90% must acknowledge
   the specific managed-connector phase. Fast ineligible turns may coalesce,
   but do not put them in the eligible capture set or count them as failures.
5. Run a no-tool control whose answer mentions email but uses supplied context.
   It must not produce or display managed Gmail work.

### Exercise diagnostic phases

Use the deterministic test/diagnostic harness to separate real lifecycle
milestones long enough to observe them without changing production dwell
behavior. Require this order over time:

1. `Thinking…`
2. `Checking Gmail…`
3. `Reviewing Gmail messages…`
4. `Drafting the response…`
5. final reply, then acknowledged clear

The managed Gmail tool event, not the wording of the question or answer, must
produce the Gmail phases. A trace with only thinking or drafting fails.
Deliberately paced diagnostic traces cannot count toward the normal-timing 90%
gate.

Where the disposable transport harness can reject native status safely, also
prove that the turn keeps generic Agent Session processing, creates no progress
message, and still delivers the final answer. A bounded synthetic phase held
beyond 90 seconds should acknowledge a refresh; a superseded phase must not.

### Restore and verify offline

1. Stop the cropped capture. Export only the fixed-schema activity events and
   reject any record with an extra field.
2. Audit Slack transport calls and record a count of zero activity-path
   `chat.postMessage`, `chat.update`, and `chat.delete` calls for the new turns.
3. Restore the previously serving disposable version and verify it is healthy.
4. Delete the raw screen recording immediately. Retain only cropped/redacted
   native-status-region evidence, the content-free event stream, and the
   following content-free manifest:

```json
{
  "syntheticMailbox": true,
  "readOnlyQuery": true,
  "unmodifiedTiming": true,
  "diagnosticTrace": true,
  "progressMessageCalls": 0,
  "priorVersionRestored": true,
  "rawCaptureDeleted": true
}
```

Validate the isolated normal-timing streams, diagnostic stream, and manifest
after restoration. Repeat `--normal-events` once per eligible turn (ten or
more); the verifier derives both counts and the ratio from those files:

```bash
node scripts/verify-semantic-activity-status-live.mjs \
  --normal-events /path/to/normal-turn-01.jsonl \
  --normal-events /path/to/normal-turn-02.jsonl \
  --normal-events /path/to/normal-turn-03.jsonl \
  --normal-events /path/to/normal-turn-04.jsonl \
  --normal-events /path/to/normal-turn-05.jsonl \
  --normal-events /path/to/normal-turn-06.jsonl \
  --normal-events /path/to/normal-turn-07.jsonl \
  --normal-events /path/to/normal-turn-08.jsonl \
  --normal-events /path/to/normal-turn-09.jsonl \
  --normal-events /path/to/normal-turn-10.jsonl \
  --diagnostic-events /path/to/diagnostic-turn.jsonl \
  --manifest /path/to/content-free-manifest.json
```

The verifier performs no network calls. It rejects unknown event/manifest
fields, legacy-message activity, a missing managed/native/clear proof, an
unrelated transport acknowledgement, an incomplete ordered diagnostic
sequence, operator-supplied count fields, any progress-message call, an
unrestored version, retained raw capture, and a derived normal-timing ratio
below 90%.

## Release evidence

The feature is not live-accepted until an authorized disposable run supplies
all of the following:

- normal-timing eligible-turn measurement at or above 90%;
- an over-time diagnostic sequence including real Gmail start and settlement;
- no-tool, native-rejection, and long-refresh controls where safely available;
- zero new-run progress-message calls;
- fixed-schema events with no content or durable coordinates;
- cropped/redacted status-region evidence only;
- raw capture deletion and verified restoration of the prior version.

Automated tests and a correct final Gmail answer are necessary but do not prove
the changing native status experience.
