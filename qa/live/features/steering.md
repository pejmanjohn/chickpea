# Steering: Stop, follow-ups, hand-back

Docs: `/slack/conversations/`; operator detail in [Slack steering](../../../docs/runbooks/slack-steering.md). Record areas: `delivery`. Legacy contracts: none.

## What it covers

- Stopping a run with Slack's **Stop** button, or with a stop phrase sent alone (`stop`, `stop please`, `cancel`, `abort`, `halt`, `interrupt` and the rest of the runbook's list). A leading mention and trailing punctuation are ignored; `don't stop the migration halfway` is an ordinary message.
- No model reads a stop, so it reaches a stuck run. Anyone who may talk to the thread's Agent may stop it.
- The stop note: fixed copy, posted as the thread's Agent, naming who stopped the run, what was already done (branches pushed, pull requests opened), whether coding work may still be winding down, and how many held messages were not read.
- Check-ins: `status`, `still working`, `any update` and the other listed phrases get a private fixed-copy answer with the current step, time since progress and run time. The run continues.
- Messages posted during a run get a 👀 at once and run as their own turn after the current one. A stop drops them and removes the 👀.
- Owned-thread follow-ups: every person's message in an Agent-owned thread that is not a stop, a check-in or a mention of another Agent is answered by that Agent and is never classified as ignorable. A pure acknowledgement may be answered with a reaction instead of text.
- Ask hand-back: an asked Agent's answer that asks nobody goes back to the thread's Agent, which finishes the request or replies exactly `NO_REPLY` and posts nothing when the answer already covers it.
- Refusals: a member without access gets a private `You can't stop this run.`; a guest gets no stop reply. A stop after the run finished tells only the presser `This run had already finished, so there was nothing to stop.`
- In a DM, a top-level stop or check-in means the sender's one running conversation there, or `Nothing is running for you here right now.`

## How a person reaches it

- Slack only: the Stop button on the thread's working indicator, a typed stop or check-in in the thread, a top-level stop in a DM, or any follow-up in an owned thread.

## How to drive it on a lane

- Use a run long enough to stop. The reference journey is a long coding task on a sandbox-profile lane; a time-compressed probe build may shorten the five-minute quiet window if it is graded as a probe and the clean candidate is redeployed.
- The Stop button needs the lane's Slack app subscribed to `agent_session_stopped`. Confirm that before grading the button; typed stops work without it.
- Give typed stop, button stop, check-in, held messages, refused access and hand-back their own case IDs, each `--area delivery --proof slack`. A declared long run may set `--max-wait-ms` up to 3600000.
- Held messages: post two messages during the run, then stop, and expect the note to say two messages were not read.
- Refused access and ephemeral invisibility need a second signed-in actor.
- Cleanup: archive the run-owned Agent, and close any test pull requests and delete any test branches the run created.

## Proof and gotchas

- Slack shows either the custom status text or its own indicator with Stop, never both. After the first few seconds the button returns only after five minutes without progress, labelled with the Agent's name, so a missing button while text shows is expected.
- Check-in answers and refusals are ephemeral in channels and Slack's API never returns them. Check them as the asker and confirm a second person does not see them.
- The "already finished" race is hard to hit from the UI: the final lands in one burst while a Slack-sent stop takes about a second. Record it as blocked rather than failed when it cannot be produced.
- After a stop, unfinished task rows must settle as skipped. A row reading "Something went wrong" is a product failure; an earlier run caught exactly that.
- A browser step waiting on the person's `approve` or `stop` takes a plain `stop` as declining the step, and the run continues. The Stop button still stops the run.
- Check the stop note's sender, avatar and footer on the exact message, for a sealed stream and for one Slack already halted.
- A silent hand-back posts nothing by design. Prove the turn ran from Admin's sessions API, where its terminal disposition is `no_op`, next to a healthy positive control.
- The thread's Agent sometimes restates the teammate's answer in one line instead of staying silent. That is an accepted known limit, not a failure.
- Do not probe owned-thread follow-ups with "thanks" or "ok" and expect text; a reaction is a valid answer.
- A bounded tail shows `steering.admission` and `steering.stop_button` lines with fixed tokens only, which separates a stop that was refused from one that never arrived.
