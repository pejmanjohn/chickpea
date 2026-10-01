# Activity status

Docs: `/slack/replies/`; operator detail in [semantic activity status](../../../docs/runbooks/semantic-activity-status.md). Record areas: `activity`, `delivery`. Legacy contracts: none.

## What it covers

- While a turn works, Slack's native under-composer status shows the phase in fixed copy: `Thinking…` first, then tool phases such as `Checking Gmail…`, `Using a skill…`, `Running tests…`, `Checking memory…` and `Drafting the response…`. Unregistered work reads `Working on the request…`.
- Custom MCP and API connections and skills are named by their configured name, for example `Checking <connection name>…` or `Using the <skill name> skill…`. A name over 32 characters, with markup or shaped like a credential keeps the family copy (`Checking a connected service…`, `Using a skill…`).
- Managed connectors show their catalog label. Agent, repository, account and resource names stay generic.
- A coding task rotates its stage, step and milestones, for example `Running the test suite…`, `Step 2 of 3 · Code changes`, `Branch pushed` and `Next: opening the pull request`, with no clock.
- The line is at most 50 characters, refreshes about every 90 seconds, and never carries reasoning, tool arguments, results or customer-authored content.
- After five minutes without progress the line hands back to Slack's own indicator with its Stop button. The next real progress brings the text back.
- If Slack rejects the status, custom status stops for that turn and the answer still arrives. No progress message is ever posted, updated or deleted.
- The deployment switch `SLACK_TAG_SEMANTIC_ACTIVITY_STATUS=false` turns the custom line off, leaving Slack's generic processing state.

## How a person reaches it

- Slack only: any turn in a channel thread or a DM. There is nothing to configure in Admin.

## How to drive it on a lane

- Case shape: `--area activity --area delivery --proof slack --max-wait-ms 120000`, one case per family you changed (custom connection, skill, managed connector, coding task, unknown fallback).
- Give a run-owned Agent one custom connection and one skill, then ask a question that needs each. A public MCP server that needs no auth works as a run-owned connection.
- Add a connector-provided skill as its own case; those skills are mounted apart from the Agent's own skills.
- Watch the status over time in the lane browser, or capture the tab's websocket `ai_assistant_status` frames the way the [runner matrix](../operator/runner-matrix.md) page harness does. Keep only the status text.
- For first-status latency across many concurrent threads, run the scripted runner matrix instead of hand-driving.
- Cleanup: remove the run-owned connection and skill, then archive the Agent.

## Proof and gotchas

- A final screenshot proves nothing about the sequence. Record each observed phase in order with its time, and the clear after the final reply.
- The custom text and Slack's indicator never show together, so a Stop button that is missing while text shows is correct.
- Connector-provided skills still showed the generic copy on an earlier pass after the Agent's own skills were fixed. Check both kinds.
- One MCP call can read `Checking …`, then `Connecting to …`, then a review phase. That republish is known and not a failure.
- The model thinking without calling tools counts as no progress, so a long reasoning stretch can hand back to Slack's indicator.
- Cloud sessions reach Slack through a proxy that drops its websocket, so live status cannot be seen there. Run status cases from a lane daemon browser on the host instead.
- The docs replies page still lists `Checking a connected service…` for every custom connection. Named copy is current behaviour; report the docs drift.
- Activity telemetry (`[chickpea:activity]`) is content-free and cannot name a turn, so capture one turn per file when you use it as evidence.
- Accepting the full managed Gmail sequence uses the runbook's disposable-mailbox gate. Never run it against a real mailbox.
