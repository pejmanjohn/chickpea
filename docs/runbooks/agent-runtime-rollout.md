# Agent runtime rollout

This runbook controls two independent runtime changes:

- `SLACK_TAG_LEDGER_CANARY_CHANNELS` selects the channel-neutral durable Run driver for future eligible admissions in exact Channels.
- `CHICKPEA_LIVE_CHANNEL_CONFIG` controls whether future Channel events resolve current Agent/Channel configuration (`true`, the default) or restore write-once thread snapshots (`false`, emergency rollback).

Neither switch changes an already admitted TurnJob. Never use one switch to infer the state of the other.

## Before a canary

Run:

```sh
npm test
npm run flue:build:cf
npm run verify:run-foundation
npm run verify:durability
```

Record the artifact commit, deployment profile, exact test workspace/Channel, current Agent and Channel revisions, and the switch values. Use a disposable Channel and a reversible Agent edit. A live deployment or synthetic Slack/provider mutation requires explicit authorization.

## Live-configuration canary

Keep `CHICKPEA_LIVE_CHANNEL_CONFIG` unset. Start a response and hold the provider open. While it is in flight, edit the Agent instructions or add one harmless skill through Admin, Slack management, or MCP. Release the response, then send another message in the same Slack thread.

Acceptance evidence:

- the in-flight response and any retry retain their admitted harness/configuration revision;
- the next event resolves the new Agent and Channel revisions;
- reassignment rotates the Flue instance revision and rehydrates bounded Slack history;
- no fresh-context continuity notice is posted;
- disabled/deleted/unplaced targets fail closed on the next event; and
- `[chickpea:management]` telemetry contains only event tokens/counts, not workspace, Channel, actor, instruction, or message content.

Rollback by setting `CHICKPEA_LIVE_CHANNEL_CONFIG=false` and redeploying the same reviewed artifact. This affects only new Channel admissions: they use the retained write-once snapshot store. Already admitted TurnJobs continue with their frozen plan. Verify one new root and one existing root, then unset the variable and redeploy after the incident is understood.

## Ledger-driver canary

Set `SLACK_TAG_LEDGER_CANARY_CHANNELS` to at most 20 exact comma-separated `workspace/channel` pairs. Start with one Channel. The selection is fail-closed: an eligible selected admission must not fall back across authority lanes if canonical admission fails. Existing Runs keep their owner.

Agents with enabled MCP/API connections or repositories, explicit Memory/Routine commands, and installations with open/non-empty allowlisted egress stay on the established lane. Treat this as expected eligibility behavior, not a failed canary.

Acceptance evidence:

- one eligible mention admits to canonical Work/Run state and produces one visible Slack result;
- duplicate Slack delivery does not duplicate Work, provider execution, or final delivery;
- retry and process restart preserve the selected owner;
- delivery lease recovery finishes or safely requeues interrupted work; and
- clearing `SLACK_TAG_LEDGER_CANARY_CHANNELS` sends only future eligible admissions back to the established lane.

Keep the dual-lane artifact deployed until every ledger-owned Run has drained. Do not remove bindings or state classes as part of a traffic rollback.
