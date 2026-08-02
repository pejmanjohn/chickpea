# Flue 2 reset, rollout, and rollback

This runbook governs the prelaunch cutover from Flue beta state to Flue 2. The
reset is intentionally destructive only to four beta Flue Durable Object
namespaces. It does not authorize deployment by itself.

## Release position

- Flue is pinned to 2.0.0 and built through the supported Vite integrations.
- Slack turns and scheduled routines use app-owned envelope, receipt, and
  settlement checkpoints with keyed dispatch and reattachable reads.
- `TAG_STATE/TagStateStore`, `SANDBOX/Sandbox`, routine definitions, Work/Run,
  configuration, memory, and usage state are preserved.
- Beta Flue transcripts and workflow history are disposable and will not
  survive the v6 deployment.
- `TAG_ROUTINES_ENABLED` and `SLACK_TAG_LEDGER_CANARY_CHANNELS` remain off by
  default.

## Roles and evidence

Name a release lead, migration verifier, privacy verifier, Slack acceptance
operator, and rollback owner. Record the git SHA, built artifact digest,
Worker version, exact generated class/binding list, drain response, deployment
time, and acceptance timestamps. Evidence may contain opaque IDs and counts,
but never message, prompt, tool, credential, private-channel, or reasoning
bodies.

## Gate 0: local and artifact proof

Use the repository's Node 24 lane:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node npm test

PATH=/opt/homebrew/opt/node@24/bin:$PATH \
FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node npm run flue:build

PATH=/opt/homebrew/opt/node@24/bin:$PATH \
FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node npm run build

PATH=/opt/homebrew/opt/node@24/bin:$PATH \
FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node npm run verify:conversation-scale

PATH=/opt/homebrew/opt/node@24/bin:$PATH \
node scripts/deploy-with-epilogue.mjs --skip-build --preflight-only
```

Record the scale probe's 20- and 50-turn checkpoints with the release
evidence. The migration reference run grew the serialized history response
from 14,321 to 35,561 bytes (2.483x), the provider request from 4,905 to 9,645
bytes (1.966x), and a settled reattach read from 2.697 ms to 8.827 ms; the
bounded reply remained 147 bytes. Those timings are a local baseline, not an
SLO. Stop the release if the current run fails to complete 50 turns or shows a
materially different growth shape before proceeding to Cloudflare acceptance.

The preflight must show:

- fresh Slack, routine-intent, and routine-execution v2 agent classes;
- deletion of exactly `FlueRegistry`, `FlueSlackThreadAgent`,
  `FlueRoutineIntentAgent`, and `FlueRoutineWorkflow`;
- no deleted or renamed `TagStateStore`, `Sandbox`, or `ContainerProxy`;
- retained `TAG_STATE/TagStateStore` and `SANDBOX/Sandbox` bindings;
- no Workflow binding, explicit content-tracing disablement, and compatibility
  date at or above `2026-04-01`; and
- deployment through `.wrangler/deploy/config.json`, with no custom
  `--config` flag.

Flue's generated Cloudflare tracing is deliberately disabled rather than
content-redacted: Chickpea's app-owned `instrument()` observers retain only the
instance/submission correlation and bounded operational metadata needed for
recovery and usage attribution. Conversation content and secrets never enter
the tracing plane.

If the drain reports `recoveryRequiredTurnJobs`, inspect the bounded inventory
at `GET /admin/api/runtime/recovery-turns`. After reconciling the underlying
condition, explicitly terminalize a quarantined adapter row with
`POST /admin/api/runtime/recovery-turns/:id/resolve`, an `Idempotency-Key`
header, and `{ "confirm": "terminalize" }`. Cookie-authenticated calls must be
same-origin; bearer-authenticated operator calls remain suitable for scripts.

## Gate 1: drain the existing deployment

This gate is live and requires operator authorization. The authenticated drain
endpoint must already be present in the beta-compatible safety release.

```bash
CF_SMOKE_BASE_URL=https://<worker>.<subdomain>.workers.dev \
TAG_ADMIN_TOKEN=<token> \
npm run verify:cf-smoke -- --check-drain
```

Do not continue unless pending TurnJobs, Slack cleanup, active Runs, and
pending/running routine occurrences are all zero. Disable routine admission and
the ledger canary first if the drain does not converge. Do not delete rows or
invent a second drain mechanism to force zero.

## Gate 2: backup and retention decision

The beta Flue namespaces are deleted permanently by the v6 migration. Confirm
in writing that their test transcripts and workflow history are disposable.
Cloudflare Durable Object point-in-time recovery is not a substitute for an
application export after a namespace deletion.

If app-owned state matters, capture the available configuration, memory,
routine, Work/Run, and audit exports or screenshots before deployment. This
repository does not claim a complete one-click Cloudflare state backup. Stop if
the organization requires a restoration guarantee that the available exports
cannot meet.

## Gate 3: deploy the generated artifact

Deployment is an explicit operator action:

```bash
npm run deploy
```

Do not pass `--config`. The wrapper builds current source, validates the final
Vite redirect and destructive allowlist, then invokes Wrangler. Save the
Wrangler deployment/version output and reconcile its classes with the preflight
record.

## Gate 4: fresh-instance validation

Before enabling routines or a ledger canary:

1. Run the authenticated Cloudflare smoke against the approved target.
2. Confirm `/admin/api/agents` and the Slack connection state are healthy.
3. Admit one disposable Slack mention and confirm one v2 Slack instance, one
   durable receipt, one settlement, one Usage measurement, and one final.
4. Restart or otherwise exercise the recovery lane after receipt persistence;
   confirm `read()` reattaches without another dispatch.
5. Confirm the beta routes, workflow endpoints, and beta bindings do not exist.
6. Confirm logs and traces contain no supplied secret marker from model input,
   instructions, tool arguments, or tool output.

## Gate 5: Slack and routine acceptance

Capture the full timeline, not only the final thread:

- acknowledgment timing, thinking status, checklist creation/edits, final
  delivery, usage capture, status clearing, and acknowledgment cleanup;
- explicit mention, ignored ambient message, reaction-only result, provider
  failure, sandbox failure, and concurrent nearby turns;
- same-channel thread continuity without a notice;
- DM/App Home generation reset with exactly one continuity notice before its
  first new reply; and
- one disposable routine occurrence with one named result, one usage record,
  one delivery, and no workflow record.

Only after those checks may the operator separately consider setting
`TAG_ROUTINES_ENABLED=1` or selecting exact ledger-canary channels. Those are
product rollout decisions, not part of the Flue namespace reset.

## Rollback limits

Disabling `TAG_ROUTINES_ENABLED` and clearing
`SLACK_TAG_LEDGER_CANARY_CHANNELS` stop new admissions in those lanes while
existing owned work drains. A source rollback can restore application behavior,
but it cannot undelete beta Flue namespaces or restore their transcripts.

Do not deploy an older artifact whose configuration expects a deleted beta
class. If the v2 deployment is unhealthy, keep new admissions disabled, retain
the app-owned ledger for diagnosis, fix forward with the same three v2 class
identities, and rerun local, artifact, drain, and acceptance gates. Restoring a
backup to a different Worker name is a separate disaster-recovery operation and
must not be improvised during the cutover.
