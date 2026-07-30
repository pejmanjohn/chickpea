# Agent Runtime Rollout and Rollback

This runbook governs the channel-neutral Work ledger and durable interactive
driver. The foundation is safe to deploy with no Slack reply change when
`SLACK_TAG_LEDGER_CANARY_CHANNELS` is empty. Sessions becomes available to an
authenticated admin as a redacted view of canonical Runs; operator-originated
web sessions are not part of this release.

## Release position

- Slack is the only production client adapter.
- The Work ledger is canonical for product lifecycle and audit facts.
- Flue remains the execution engine and raw transcript/tool-history owner.
- Interactive execution defaults to `legacy`; the ledger driver is an internal
  exact-channel canary only.
- Routines retain their current Workflow coordinator and ship according to the
  separate `TAG_ROUTINES_ENABLED` gate, which remains off by default.
- Explicit Memory and Routine commands never enter the ledger canary.
- A profile with enabled MCP tools, API connections, or repositories is not
  canary-eligible until paired action receipts and finite attempt ceilings ship
  on every relevant execution path.
- Open internet egress or a non-empty installation domain allowlist also makes
  a Run ineligible; the selector fails closed to legacy when live egress policy
  cannot be read.

Do not describe an empty-selector deploy as a ledger-authority cutover. It is a
foundation/shadow release that preserves current Slack execution behavior.

## Immutable rollout facts

At every checkpoint record:

- git SHA, built Worker version/artifact digest, and compiled Flue patch digest;
- Work schema version, runtime (`node` or `cloudflare`), and authority epoch;
- workspace and exact canary channel IDs, plus resulting Binding and Run IDs;
- admission, execution, delivery, recovery, shadow-mismatch, Routine, and Usage
  counts before and after the checkpoint;
- Slack request message and reply timestamps without message bodies; and
- named release lead, migration verifier, privacy approver, Slack acceptance
  operator, and rollback owner. One person may fill several roles.

Message, prompt, tool, credential, private-channel, and model-reasoning bodies
do not belong in the evidence bundle.

## Gate 0: exact artifact, default off

Use Node 24 and the exact release source:

```bash
npm run typecheck
npm test
npm run verify:run-foundation
npm run verify:durability
npm run verify:admin-ui
npm run verify:cf-smoke
npm run deploy -- --dry-run
```

Confirm the built Worker config contains an empty
`SLACK_TAG_LEDGER_CANARY_CHANNELS`. Confirm Routines and experimental provider
lanes match their own release decisions. Save migration integrity output and
prove that the prior artifact can open a copy of migrated state before any
authority promotion.

Deploy the dual-lane artifact with the selector empty. Run fresh Slack checks
for a channel mention, thread continuation, DM/App Home if enabled, profile and
channel assignment, explicit Memory controls, Routine availability behavior,
artifact/tool behavior applicable to the selected profiles, and Admin Sessions.
This verifies production compatibility, not ledger authority.

## Gate 1: shadow soak

Keep the selector empty for at least 24 hours and 100 eligible events, including
deterministic load and fresh live Slack activity. Capture invariant snapshots at
start, +5 minutes, +1 hour, +4 hours, +24 hours, and checkpoint end.

Stop on any privacy leak, executable untrusted Admin content, duplicate reply or
execution, orphan/invalid ledger state, unexplained shadow mismatch, or missing
wake fact. A stopped checkpoint is not resumed by dismissing the error; fix it,
deploy a new exact artifact, and restart the checkpoint record.

## Gate 2: exact-channel authority canary

Use a dedicated internal channel with an assigned read-only profile. Obtain its
actual Slack workspace and channel IDs; labels are not accepted. Configure at
most 20 comma-separated pairs:

```text
SLACK_TAG_LEDGER_CANARY_CHANNELS=T123/C456,T123/C789
```

The deploy wrapper rejects malformed or oversized selectors and an artifact
without the durable driver seams. Do not canary a channel whose profile has an
enabled MCP tool, API connection, or repository. Do not use natural-language
Routine creation in a canary channel. Confirm installation egress is either
`off` or the default empty allowlist; open or domain-allowlisted egress stays on
legacy. The current canary intentionally bypasses that Slack pre-parser.
Explicit Memory and Routine commands continue on legacy.

Run at least 25 authoritative Runs for at least 24 hours. Verify one RunExecution
per model attempt, one delivered Slack response, persisted approved output and
rendered payload, correct Sessions authority/delivery display, no private body
in list/detail/audit/log output, restart recovery, and no cross-lane claiming.

## Selector rollback

Selector rollback always precedes binary rollback:

1. Deploy the same dual-lane artifact with the selector empty.
2. Verify new eligible turns are admitted with `execution_authority=legacy`.
3. Leave the artifact running while existing ledger-owned Runs drain under their
   immutable authority and epoch.
4. Disable new Routine scheduling/run-now admission, or use a separately proven
   compatibility-only Routine path, before measuring the drain.
5. Inspect Sessions/integrity evidence for queued, runnable, in-flight,
   `recovery_required`, unknown-delivery, or otherwise incompatible Runs.
6. Reconcile an ambiguous Run only from durable authoritative evidence. If that
   is impossible, use the authenticated same-origin quarantine action, recording
   the admin credential identity, claimed operator label, server-derived auth
   origin, and safe reason. Quarantine preserves ambiguity and never replays.

Clearing the selector does not cancel, duplicate, or transfer an existing Run.
Never deploy the prior binary merely because the additive schema is readable.

## Internal realm-wide promotion and external release

After a successful canary rollback rehearsal, select every eligible internal
channel explicitly and run at least 50 authoritative Runs for at least 24 hours.
If the installation has more than 20 eligible internal channels, the current
selector cannot represent realm-wide promotion; stop and implement a reviewed
realm selector rather than widening syntax ad hoc.

External release of ledger authority requires all shadow, canary, rollback, and
internal realm-wide records. Keep the compatibility lane and selector for at
least 72 stable hours after realm-wide/external promotion. Until those records
exist, ship the foundation with the selector empty and call the execution lane
legacy—not migrated, promoted, or realm-wide.

## Binary rollback gate

A prior binary may be deployed only when all of the following are zero:

- ledger-owned Runs that are queued, runnable, leased, or in flight;
- unresolved `recovery_required` Runs;
- unknown deliveries or action outcomes;
- unquarantined prior-binary-incompatible Runs; and
- Routine admissions that can race the drain.

The evidence bundle must show the exact migrated state used for the rehearsal.
Additive Work tables and audit observations remain; rollback never rewrites Run
authority or deletes evidence.

## Legacy removal

Removing legacy storage, queue handling, or selector controls is post-release
hardening. Start only after the 72-hour rollback window, zero hard-stop metrics,
and an explicit release-owner decision. A web client does not require legacy
removal; it should attach to the canonical submission/execution/output boundary
while Slack continues as its own adapter.
