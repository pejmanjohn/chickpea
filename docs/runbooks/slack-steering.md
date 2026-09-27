# Slack steering

Operator notes for stopping a run and checking on it from Slack. This page
covers what people see, what a stop does to durable state, the logs an
operator reads, rollback, and turning on Slack's Stop button for the shared
Chickpea app.

This release covers stopping, check-ins, the status line, and a 👀 on
messages posted during a run. A message posted during a run still runs after
the current run, as its own turn, exactly as before. The running Agent does
not read it mid-run.

## Stopping a run

People stop a run in two ways:

- Press **Stop** on the thread's working indicator. Slack draws that button
  only for an app subscribed to the `agent_session_stopped` bot event (see
  [the shared app](#turn-on-the-stop-button-for-the-shared-app) and
  [customer-owned apps](#customer-owned-apps)).
- Reply with a stop phrase alone: `stop`, `stop it`, `stop now`, `stop that`,
  `stop please`, `please stop`, `stop it please`, `please stop it`,
  `stop running`, `stop working`, `stop run`, `stop the run`,
  `stop current run`, `stop the current run`, `stop agent`, `stop the agent`,
  `stop action`, `stop current action`, `cancel`, `cancel it`, `cancel that`,
  `cancel please`, `please cancel`, `abort`, `abort it`, `halt`, or
  `interrupt`.

The phrase must be the whole message. Case, surrounding whitespace, a leading
mention of the thread's Agent or `@Chickpea`, and trailing punctuation are
ignored, so `@Agent Stop please!` stops the run. `don't stop the migration
halfway` does not; it is an ordinary message. The list is English only
(`slackSteeringCommand` in `src/slack/interaction-intent.ts`). No model reads
a stop, so it reaches a stuck run.

A few cases keep another meaning:

- A browser step waiting for a person's `approve` or `stop` keeps its
  meaning. When that person replies a plain `stop` (or `stop.`), it declines
  the step and the run continues. The Stop button and every other stop phrase
  still stop the run.
- In a thread with nothing running, a stop phrase or check-in is an ordinary
  message to the Agent. A Stop press on an idle indicator moves the leftover
  Agent Session to `active` and does nothing else.
- In a direct message, a stop phrase or check-in at the top level (not in a
  thread) means the sender's one running conversation there. With none,
  Chickpea replies `Nothing is running for you here right now.` With several,
  it asks them to reply in the thread they mean.

Anyone who may talk to the thread's Agent there may stop its run. The Stop
button and a typed stop go through the same person and Agent-access checks
as a reply in that thread. A full workspace member without access gets a
private `You can't stop this run.` reply and the run continues. A guest or
Slack Connect user gets no stop-specific reply.

## What a stop does

1. **Record.** One state-store transaction stamps the run's turn with a stop
   record: the source (`typed` or `button`), the person who stopped it, the
   time, and a cutoff. The cutoff is the stop's own Slack timestamp (the
   typed message, or the Stop press event). The same transaction holds every
   other queued turn in the thread whose message was posted before the
   cutoff. A held turn cannot start. The stop is idempotent: a Stop press
   and a typed stop, or a second press, record one stop.
2. **Late messages.** A message posted before the cutoff that Slack delivers
   late is held too, until the stopped run's ending finishes. A message
   posted after the cutoff is an ordinary turn and runs once the stopped run
   has ended. Chickpea's gateway inbox orders a Stop press with the thread's
   messages, so a message posted before the press is admitted first.
3. **Abort.** The state store hands the stop to the thread's runner through a
   retrying outbox (1 second, doubling to 30 seconds). The runner aborts the
   Flue run from its saved dispatch. No model is called. The abort request is
   bounded at five seconds, and a thread's next turn waits for an abort in
   flight (up to that bound), so a late abort can never reach it. It then
   stops any coding job the run started, from the job's durable task record,
   and waits for the coding worker to confirm (up to about 14 seconds). A
   stop that reaches a turn that never started ends it before it dispatches.
4. **Ending.** The stopped ending drops the held turns and counts them.
   Their Runs settle `cancelled` and Chickpea removes its 👀 from their
   messages. The thread gets one stop note, the Agent Session moves to
   `active`, and the status line clears. The next turn in the thread carries
   a line telling the Agent who stopped the previous run, so it does not
   resume that work unless asked.

### The stop note

The note is fixed copy. It names the person who stopped the run, then lists
only what Chickpea can see:

- `Already done, not undone:` with each branch the run pushed and each pull
  request it opened, from the run's saved progress and its coding task
  records.
- `Coding work may still be winding down.` when a coding job's stop was not
  confirmed: its records could not be read, a job did not confirm, or the
  executor has no coding stop cascade (the alarm executor, below).
- `2 messages were not read and can be sent again.` for the dropped count.
  When the stopped turn had not started, its own message counts too.

There is no failure text and no replayed answer. If the run was streaming,
the note seals the open stream after the partial answer. If Slack already
halted the stream (its Stop button does this), the partial answer stays as
Slack shows it and the note posts as a new reply. Both post as the thread's
Agent with its footer; see [Slack message identity](slack-message-identity.md#steering-replies-and-the-stop-note).

### When the run finished first

If the run finished before the abort took effect, its answer posts as usual
and there is no stop note. The person who stopped it is told privately:
`This run had already finished, so there was nothing to stop.` The held
messages are released and run as ordinary follow-up turns. A stopped run that
ends any other way (a failure, a recovery) also releases its held messages,
so none is stranded.

## Checking on a run

A check-in is one of these, typed alone with the same matching as a stop:
`status`, `still working`, `are you still working`, `any update`,
`any updates`, `how's it going`. Other wordings are ordinary messages and wait
for the current run.

Chickpea answers, not the busy Agent. The answer reads the run's saved facts
and never touches or delays the run. No model is called:

```text
Still working on this.
• Current step: Running the test suite…
• No new progress for 10+ minutes
• Running for 1 hour 5 minutes
```

The time since progress is bucketed as `5+`, `10+`, `15+`, `30+` or `60+`
minutes; under five minutes the line reads `Last progress under 5 minutes
ago`. Without saved facts the answer is `Still working on this. Progress
details are not available right now.`, or `Queued. This hasn't started yet.`
for a run that has not started.

Only the asker sees it. In channels and group DMs it is an ephemeral message
in the thread. In a one-to-one DM it is an ordinary threaded reply, since only
the person and the Agent are there.

Thread runners keep the facts in their own storage, so a check-in answers
after an eviction. The Node relay and the alarm executor keep them in memory.
[Semantic activity status](semantic-activity-status.md#quiet-runs-and-check-ins)
defines progress and the facts.

## The status line and the Stop button

Slack shows either Chickpea's custom status text or its own working indicator
with the Stop button, never both. So:

- A run starts on Slack's working indicator, and Chickpea's status text
  replaces it within a few seconds.
- While work moves, the status text shows the current step. There is no Stop
  button then; a typed stop works at any time. With semantic status off, the
  working indicator and its Stop button show for the whole run.
- After five minutes without progress, the text gives way to Slack's working
  indicator and its Stop button. The next progress brings the text back.
- While the working indicator shows, the turn sends `processing` again at
  most every 45 minutes. Slack moves a session out of `processing` an hour
  after its last status, and the Stop button goes with it. The keepalive
  keeps the button on runs longer than an hour.

## Messages posted during a run

Each eligible message posted in the thread while its run is in progress gets
Chickpea's 👀 as soon as it arrives, before any model reads it. Stops,
check-ins, and a mention of a different Agent do not get one. The message then
runs as its own turn after the current run, and that turn removes the 👀 when
it finishes. A stop that drops the message removes it at once. Chickpea only
ever removes a 👀 it recorded adding.

## Node installations

Node installs behave the same: the stop phrases, the Stop button (through the
shared app's outbound connection or a customer-owned app's HTTP events),
check-ins, the status line, the 👀, and the stop note. The Node relay acts on
a stop in its own process: it aborts the run and runs the same ending. Node
has no coding sandbox, so there is no coding stop cascade. Run facts live in
memory and reset when the process restarts. Logs print to the process log.

## Operator view

The steering log lines and telemetry below are content-free: fixed tokens,
booleans and counts. They never carry message text, stop reasons, or Slack
user, channel, or workspace IDs.

| Signal | Where | Meaning |
| --- | --- | --- |
| `[chickpea] steering.admission` | Worker or Node log | A stop or check-in decided at admission. `outcome` is `stopped` (with `created: false` when it joined an existing stop), `check_in`, or `stop_refused` (someone without access, told privately). `source: button` marks the Stop button. |
| `[chickpea] steering.stop_button` | Worker or Node log | A Stop press that stopped nothing. `outcome` is `invalid` (unreadable event), `no_route` (not an Agent thread), `no_running_job`, or `not_allowed` (no access and not told, a guest for example). |
| `turn_latency` with `outcome: stopped` | Runtime event | A stopped run's ending (both lanes). |
| `thread_runner_alarm` field `dropped` | Runtime event, Cloudflare runners | Turns that stopped runs' endings dropped since the runner's previous record. |
| `run_completed` with `outcome: stopped` | [Product telemetry](../../TELEMETRY.md) | An anonymous stopped-run count. |

See [runtime observability](runtime-observability.md#turn-latency-and-relay-alarm-logs)
for the runtime events. Other records a stop leaves:

- The run's Work record settles `failed` with the safe failure code
  `run_stopped`. Dropped messages' Runs settle `cancelled`.
- Usage records a stopped run as `interrupted`, without token counts.
- `turn_jobs.stop_json` holds the stop record on the stopped turn (source,
  stopper, cutoff, time, and the ending with its outcome and count) and a
  `held`, `dropped` or `released` marker on each held turn. The runner keeps
  its side in `runner_stops`.

These warnings mean a step will retry on its own:
`stop notice delivery will retry`, `thread runner stop abort will retry`,
`thread runner coding stop will retry`, and `stopped ending will retry`.
`Slack Stop button intake failed` and `Stop button admission failed` mean a
press was not recorded; the person can press again or type `stop`. On the
shared gateway, the inbox retries a rate-limited or unreachable lookup
instead. `steering reply failed` means a private reply did not post.

Limits:

- With the emergency alarm executor (`SLACK_TAG_TURN_EXECUTOR=alarm`), the
  state store aborts the run in its own process. There is no coding stop
  cascade, so the note for a run that did coding work says it may still be
  winding down, and `thread_runner_alarm` reports no `dropped` count.
- Stops and check-ins see turns on the standard execution path only. A Run
  owned by the ledger canary in [agent runtime rollout](agent-runtime-rollout.md)
  is not stopped, and a stop phrase in its thread is an ordinary message.

## Rollback

Every durable change is additive. `turn_jobs` gains nullable columns
(`thread_key`, `message_ts`, `stop_json`, `stop_notice_at`) and
`stop_notice_attempts` with a default. Dropped turns keep the existing `done`
status. Presentations record a stop reason beside their existing terminal
states. Runners add `runner_stops` and run-fact columns on `runner_jobs`.
Coding task records live in the Sandbox Durable Object's storage. There is no
Durable Object migration and no schema-generation change.

Rolling back to the previous release is safe with one exception. While a stop
is still holding messages (usually a few seconds), the older release does not
know they are held and runs them as ordinary turns. A stop the runner had not
acted on yet is ignored, and that run continues. After a rollback, an app
subscribed to `agent_session_stopped` still shows the Stop button, but the
older release ignores the press, and a typed `stop` becomes an ordinary
message.

## Turn on the Stop button for the shared app

Shipping this release does not turn the button on for the shared Chickpea app.
A subscribed app shows the Stop button to every installation, and an
installation still on an older release would show a button that does nothing.
Until the shared app subscribes, its installations stop runs with a typed
stop, and setup and recovery checks pass without the event.

The maintainer turns it on after installations update:

1. List every active shared-app installation from the gateway's installation
   sessions. Confirm each one serves this release or a later one. If one
   cannot be confirmed, wait.
2. Add `agent_session_stopped` to the shared app manifest's bot events in the
   gateway repository, through that repository's normal review. The shared
   gateway protocol stays at version 1.
3. In the shared app's Slack settings, open **Event Subscriptions →
   Subscribe to bot events**, add `agent_session_stopped`, and save. The event
   needs only the `chat:write` permission the app already has, so there is
   nothing to reinstall.
4. On a QA lane that uses the shared app, press Stop on a real run and check
   the stop note (see [Live acceptance](#live-acceptance)).
5. Watch the `steering.stop_button` token, especially `no_route`, next to the
   `stopped` counts (`steering.admission` with `source: button`,
   `turn_latency` and `run_completed`). A press on an installation still on
   an older release logs nothing, so silence from one installation is not
   proof that its button works.
6. Re-record the QA lane installation baselines, following
   [environments](../../qa/live/operator/environments.md). Until then the
   lane preflight treats the event as optional.

To turn it off again, remove the subscription in the Slack settings and the
manifest line. Typed stops keep working.

## Customer-owned apps

An app created from this release's manifest is already subscribed. An app
created earlier keeps working without the event; its people stop runs by
typing. Its owner adds the event from [Slack's Stop button](../../SETUP_AGENT.md#slacks-stop-button).
Credential recovery never adds it. A local Worker lane's own app needs the
same step before the button can be tested there.

## Live acceptance

The release checklist decides go or no-go. Record steering's live evidence
with the release's acceptance evidence, as described in
[Releasing Chickpea](releasing.md). Run the checks through the
[live verification workflow](../../qa/live/operator/SKILL.md): coding cases
on a sandbox-profile lane, and the Stop button on a local Worker lane whose
app is subscribed. Keep evidence, transcripts and screenshots outside the
repository. Report local checks and live acceptance separately.

The live journeys:

- A teammate presses Stop while the Agent waits on a long coding job. The job
  stops without a model call, and one note names the teammate and the branch
  already pushed.
- `@Agent Stop please!` stops a run; `don't stop the migration halfway` does
  not.
- Two messages posted during a run are not acted on after a stop, and the note
  says two messages were not read.
- A person without access presses Stop. The run continues, and only that
  person sees why.
- A run quiet for more than five minutes shows Slack's working indicator and
  Stop button. `status` gets a private answer with the step, `10+` minutes
  without progress, and the run time, and the run continues.
- The person a browser step waits on replies `stop`: the step is declined and
  the run continues. A Stop press just after a run finishes leaves the answer,
  and only the presser hears that it had already finished.
- A Node install passes the stop and check-in cases.
- An app without the subscription still passes setup and recovery.

### Checks only a person can do

- The Stop button and the stop note in the Slack app on a real phone. An
  emulated mobile viewport is not the mobile app.
- A second person's view of the thread: check-in answers and access refusals
  must not appear for them. Slack's API never returns an ephemeral message,
  so there is no readback for it.
- The hand-over itself over time: status text while work moves, the working
  indicator and Stop button after five quiet minutes, text again on the next
  progress. A final screenshot does not show the sequence.
- The stop note's sender, avatar and footer after a fresh desktop load, and
  on the phone.
