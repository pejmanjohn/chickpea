# Slack conversations: mentions, threads, DMs, replies, files

Docs: `/slack/conversations/`, `/slack/replies/`, `/slack/handles-and-channels/`, `/slack/troubleshooting/`. Record areas: `delivery`. Legacy contracts: LC-03.

## What it covers

- Addressing: an Agent's handle in a channel it holds an active grant for starts a turn. A top-level message that mentions no one, posts from apps and bots, and edits start nothing.
- Threads: the first Agent to reply owns the thread. Mention-free follow-ups and emoji reactions in it reach that Agent.
- A reply that names an Agent's handle in a thread nobody owns, for example under an alert, addresses that Agent like a root mention.
- Handoff: a person mentioning a different Agent in an owned thread hands it over in the open. The new owner needs its own grant and gets the newest 20 messages, up to 12,000 characters.
- Several handles in one channel message: each Agent answers in turn, up to six, and the first keeps the thread. In a DM, Chickpea asks for one Agent at a time.
- Refusals reach only the sender, for example `That Agent is not available here.` with the handles that are.
- DMs and App Home: who may DM an Agent follows where it is published. The Home tab's **Message** button opens a thread with `<Agent name> is ready.`; a DM naming no handle goes to `@Chickpea`.
- The thread keeps one conversation per Agent across turns and speakers, so a second person's follow-up sees the earlier exchange.
- A reply is one message under the Agent's name and avatar, ending with the footer `Agent name | model | Configure`. Up to six rows render as a Markdown table, a native table needs at least seven, and very long answers continue in follow-up messages.
- Streaming: the model may declare `stream_answer`, and only complete lines and finished words stream. Agents with connections or repositories stream only the final answer, after their last tool settles.
- Model-written `@here`, `@channel`, workspace and user-group mentions never notify anyone. Only the handles of Agents working in the channel render as live mentions.
- Files in: images, PDFs, text and Slack's document conversions, up to 4 files and 12 MiB per message, read-only. Files out: generated files appear as attachments inside the Agent's own reply.
- Block Kit: `ask_user`, `offer_actions` and `request_form` end the reply and wait for a click or submission; `present_cards`, `present_chart`, `present_details` and native tables decorate it. Workspace-change proposals carry **Approve** and **Cancel**.

## How a person reaches it

- Slack only: a channel root mention, a mention-free thread reply, a reaction in an owned thread, a DM, the App Home **Message** button, a file upload, or a button click.

## How to drive it on a lane

- The template's `routing` case covers a run-marked DM, a channel root mention and a mention-free follow-up in the same thread. Add handoff, files, streaming and Block Kit as their own cases with `--area delivery --proof slack --max-wait-ms 120000`, plus `--proof admin` when Agent state is read.
- Put the run marker in every request and use a fresh thread per case. Insert each mention with Slack's mention control and confirm the draft holds the mention token before sending.
- Handoff: let the first Agent answer, mention a second granted Agent in the thread, then send a plain follow-up and confirm the second Agent answers it.
- Streaming: use a fresh Agent with no saved memory and ask for a long direct prose answer. Do not write "do not use any tools", which suppresses the declaration.
- Files: upload a run-owned PNG or PDF in the thread and ask about it; for output, ask for a CSV and a PNG in one reply.
- Block Kit: ask a question with a few known options, answer by clicking as the requester, and click as a second signed-in actor when one is available.
- Cleanup: archive every run-owned Agent. Slack messages stay as residue; register them only when the case declares them, with `--ownership retain` and an exact `--expected-file`.

## Proof and gotchas

- Reply text does not prove the route. Check the sender name, avatar and footer on the exact message after a fresh load, and that the thread holds one terminal reply.
- A handoff to an Agent without a grant in the channel changes nothing: the owner keeps the thread and only the sender sees the refusal.
- Gateway lanes give the operator no Slack token. Pair the signed-in client view with finalization records from a bounded `npm run lane:tail` started before the action, and report the exact API readback as a gap.
- Slack web paints a final post in two passes, so a partial-then-full sample is not streaming proof. Use the tail's `Slack presentation finalized` record (offer, intent, accepted bytes).
- Check sender, file owner, footer and attachment separately. The file card names the bot even when the message sender is right; see [Slack message identity](../../../docs/runbooks/slack-message-identity.md).
- For a link fixture, ask for a standard Markdown link and assert its target. A model-written `<url|label>` showed up literally beside file cards in an earlier run.
- Block Kit bugs only live Slack found: a reply with two components kept only the last, a select inside an inline form was handled as a click, and a click retitled the thread. Check each.
- A non-requester click is refused privately, and a second click hears "Already answered by". Both need a second actor; ephemeral notices have no API readback.
- In a thread-memory probe, do not ask the Agent to keep a value private. It treats the thread as shared and withholds the value.
- An emulated mobile viewport is not the Slack mobile app. Phone checks of sender, avatar and attachments are for a person.
- Docs drift: the conversations and troubleshooting pages still call two handles a refusal and a handle inside an unowned thread ignored, and the replies page says Agents with connections never stream. Grade against the behaviour above and report the drift.
