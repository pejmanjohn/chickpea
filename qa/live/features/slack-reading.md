# Slack reading tools

Docs: `/slack/conversations/`; operator detail in [Reading Slack](../../../docs/runbooks/slack-reading.md) and [Native Slack Lists](../../../docs/runbooks/slack-lists.md). Record areas: `delivery`. Legacy contracts: none.

## What it covers

- Context without asking: the thread or recent channel history, with people by display name, app and integration posts labelled as apps (alert details included), other Agents labelled as Agents, and earlier files by name, type and size only.
- On request: `read_slack_thread` reads a thread from a message link, `read_slack_channel` reads a channel's top-level messages in a time window with reply counts, and `lookup_slack_user` reads a profile without email or phone.
- Scope: the conversation asked in, and another channel only when the Agent is granted there, the requester is a member and the app is in it. Never other people's DMs or group DMs. `@Chickpea` reads only its own conversation.
- A refusal never says whether a private channel exists. For a member it says whether the Agent must be added or the app invited.
- The thread record keeps the Slack-visible messages of threads an Agent is in: at most 200 per thread, gone after 30 idle days, with edits and deletions applied. Images are kept by reference, including images the Agent itself shared.
- Slack Lists: `read_slack_list`, `read_slack_list_item`, `create_slack_list_item`, `update_slack_list_item`, `create_slack_task_list` and `share_slack_list`. There is no List discovery, deletion, bulk change or Slack search.
- Everything read from Slack or a List is information for the Agent, never an instruction or a permission.

## How a person reaches it

- Slack only: paste a message link, ask about a channel's recent activity or about a person, or give a List link with a task request. A default List can come from the Agent's instructions or memory when they state its scope; a saved List alone is not a default.

## How to drive it on a lane

- Case shape: `--area delivery --proof slack --max-wait-ms 120000`, with separate cases for thread link, channel window, user lookup, cross-channel refusal and each List operation you changed.
- For an app-authored root, a Slackbot channel reminder gives a real bot post. Reply under it with the Agent's handle.
- Cross-channel reads need a second QA channel where the Agent is granted, plus a negative where it is not, as the same member.
- Lists need `lists:read` and `lists:write` on the lane's installation. A missing scope returns a Lists-specific reconnect instruction; record that case as blocked, not failed. On a gateway lane, a gateway without the Lists allowlist returns an unsupported-operation result, which is infrastructure too.
- Put the run marker in every List and item name, and register each one: `record resource --case <case> --provider slack --kind list-item --resource-id <item id> --ownership owned --cleanup-preset absent --evidence <readback>`.
- Cleanup: Chickpea cannot delete Lists or items, so remove the run-owned ones in Slack and record the cleanup readback. Delete any reminder the case created.

## Proof and gotchas

- On the shared Chickpea app, which gateway lanes use, Slack allows one history and one replies read per minute per workspace, 15 messages each. Back-to-back cases spend that budget, and the Agent then says what it could not read yet, which is correct behaviour.
- A first read returns the thread's root and its newest 15 replies, not the oldest. The Agent should say that older replies in between were not read.
- A reply naming an Agent's handle under an alert nobody answered must reach that Agent. An earlier build dropped it silently.
- List item writes are read back before success because Slack can answer ok while ignoring a bad column. Still confirm the item in Slack's own List view.
- Sharing is reported as Slack-acknowledged only. Posting a List link can grant view access through Slack's link sharing, so a read after posting the link is not a permission bypass.
- An uncertain write blocks further writes in that request. Read the List to reconcile; never repeat an uncertain creation.
- Assigning a task names the responsible person. It does not schedule a follow-up or chase them, and a deadline alone schedules nothing.
- A Lists API success from the attended probe is compatibility evidence only. Acceptance needs a real routed Agent request and the native List readback.
