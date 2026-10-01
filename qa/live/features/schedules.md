# Schedules

Docs: `/agents/schedules/`. Record areas: `routines`, `delivery`. Legacy contracts: LC-08, LC-09.

## What it covers

- Asking an Agent in a channel or its DM for one-time or recurring work. The word "schedule" is not needed, and create, edit, pause, resume, disable and run-now apply at once for an authorized requester.
- Recurring and wall-clock requests need an explicit time zone and are refused without one. "Tell me anything new" selects `post_on_change`; otherwise the policy is `post`.
- Deleting is never conversational: the Agent proposes one exact deletion and deletes only after `approve`.
- A channel result is an ordinary Agent message in the channel, or in the request's thread when asked there. A DM result returns to the origin DM thread with a completion header and a context line naming the schedule and run time.
- Every run rechecks the Agent, the channel grant, the Runs as member and each needed connection, and never reassigns work to someone else.
- Three accountable failures pause a schedule with one content-free notice. An ineligible creator or channel disables it, and a connection that is not ready moves it to Needs attention.
- Admin shows the Agent's Schedules tab (status, cadence, channel, next and last run, Pause, Resume, Delete) and Audit logs → Scheduled work with run history, revisions and audit events.
- Private DM schedules never appear in Admin lists or counts and are excluded from Usage. A viewer outside a private destination channel sees status and timing, with name and task restricted.
- Limits: 5 minutes between occurrences, 20 active per channel, 100 per deployment, 10 run-now starts per rolling day.
- In a DM an applied change gets a checkmark reaction; in a channel the Agent's reply is the acknowledgement.

## How a person reaches it

- Slack: ask the Agent where the work belongs, and name an existing schedule to change it.
- Admin: Agents → the Agent → Schedules for Pause, Resume and Delete. Audit logs has no nav button and is reached by its Admin path. Schedules are never created or edited in Admin.
- MCP: `inspect_routines` reads schedules. Saving, running, pausing and resuming apply at once; deleting needs confirmation.

## How to drive it on a lane

- Use a deployed Cloudflare lane. Node has no scheduler, and Local work or a simulated cron cannot prove due delivery.
- Use a disposable Agent attached to the QA channel, and the lane actor's DM with that Agent for the private cases.
- Channel request: "Every 5 minutes, time zone UTC, post exactly: CHANNEL RECUR <run marker>." Use DM RECUR in the DM, and a short relative delay ("check again in 5 minutes and tell me if anything changed") for the one-shot DM case.
- Case shape: `case-add --area routines --area delivery --proof slack --proof admin`, with `--max-wait-ms` sized to the due window (up to 3600000). Pause cases must observe one full cadence.
- Register the schedule as soon as you read its ID with `record resource` ([records.md](../operator/records.md)), adding `--kind schedule --ownership owned --cleanup-preset absent --stop-at <within two hours> --max-occurrences 2` to the case, provider, ID and evidence flags. Then record each occurrence.
- Stop at the occurrence budget, the deadline or the first failure. Pause or delete through the product and read the state back.
- After a model failure, run `npm run evaluate:schedule-contract` before another live retry. Schema acceptance, admission, persistence and due delivery are separate stages.
- Cleanup: delete the exact schedule ID through the product (approve the Slack proposal, or Delete in Admin) and read it back as absent. Never delete by name.

## Proof and gotchas

- A saved schedule or a deployed Worker is not delivery. A pass needs the acknowledgement, one due result in the expected place, and a delivered run in Admin. A second result, or one in another thread, fails.
- The acknowledgement must show the real next run, never "(Not set)", and must not ask for approval or for the word "schedule".
- Pause and resume need a real cadence in between: no occurrence while paused, exactly one after resume, and the saved cadence unchanged. Audit logs should show both revisions.
- Run-now gives one run and one delivery and leaves the next run time unchanged.
- Due posts have landed most of a minute after the due time. Size the observation window for that, and never shorten a duplicate-watch window to pass faster.
- Under `post_on_change` an unchanged run is a recorded no-op with nothing posted. Prove that silence from run history, not from an empty channel.
- Admin omission of a DM schedule proves privacy, not existence. Ask the Agent to list schedules in that DM, and check Admin as a separate Admin actor.
- The authority-loss variant needs a distinct registered actor declared as a `member` capability whose access may be suspended and restored; otherwise record it `blocked`. The DM schedule must reach disabled with no duplicate delivery.
- Archiving the Agent or suspending the Runs as member pauses its schedules. A missing connection fails the run with `connection_unavailable`.
- Read the due post exactly with `npm run lane:slack -- <alias> history <channel id> --since <due time>` (see [hosts.md](../operator/hosts.md#slack-evidence-on-gateway-lanes)). Without a readback token, use the signed-in client view plus an `npm run lane:tail` started before the due time.
- Run-now starts are capped at 10 per rolling day for the whole deployment, so plan run-now cases across the day.
