# Memory

Docs: `/agents/memory/`. Record areas: `memory`. Legacy contracts: LC-07.

## What it covers

- One body of text and one revision per Agent, read on every turn in its DMs, App Home, every granted channel and every scheduled run. Another Agent, including base `@Chickpea`, never reads it.
- Slack commands after mentioning the Agent: `!memory`, `!memory help`, `!memory show memory`, `!remember <name> - <description>`, `!memory update memory - <description>`, and `!forget memory`, which points to the Admin Memory tab.
- Plain requests: the Agent's memory tool saves wording after "Remember:" verbatim, forgets named facts, and can capture a durable preference stated in ordinary conversation.
- A message that both asks a question and asks to remember gets the answer plus a first-person save confirmation. Forgetting or rewriting replaces the reply with the save summary, and forgetting gets a content-free confirmation.
- The Admin Memory tab is one editor with Discard and Save memory, for editors of that Agent. Saving an empty body is the delete, with no undo.
- Every write names its expected revision, and a stale write is refused rather than merged. A repeated Slack event returns the existing revision.
- Memory is advisory: it cannot grant authority or authorize a connector write. Credential-shaped text is refused with `memory_credential_rejected`.
- A channel write needs the Agent's grant there and verified Slack membership; a DM write needs an active member. Reading needs neither.
- Limits: 512 bytes of description and 8 KiB of body per Slack write, 64 KiB in total.

## How a person reaches it

- Slack: `!` commands or plain requests to the Agent in a granted channel, its DM or a thread.
- Admin: Agents → the Agent → Memory.
- MCP: `inspect_memory` returns the body and revision, and the `update_agent_memory` operation needs that revision as `expectedRevision`. A standalone memory edit applies directly.

## How to drive it on a lane

- Use a disposable Agent attached to the QA channel. Keep "remember" or "save" wording out of every prompt except the memory cases.
- Explicit: "Remember: the QA mascot is <run marker>." Then ask "What is the QA mascot?" in a fresh DM and in a fresh channel thread.
- Implicit: state one durable, non-sensitive response preference in ordinary conversation, then check that a fresh turn on another surface follows it.
- Conflict: keep an unsaved Memory draft in one Admin tab while another tab or Slack saves, then return to the draft.
- Forget: ask the Agent to forget the fact, or save an empty body in Admin, then ask again from both surfaces.
- Case shape: `case-add --area memory --proof slack --proof admin` (or `--proof mcp` with `inspect_memory`) and `--max-wait-ms 120000`.
- Cleanup: archive the disposable Agent (`--kind agent --cleanup-preset archived-agent`). On the fixtures Agent, restore the exact body with `--ownership restore` and keep revision numbers out of the expected file, because every write advances them.

## Proof and gotchas

- Recall in the same thread proves nothing, because thread history carries it. Proof is the body in the Memory tab or `inspect_memory`, plus recall in fresh conversations on both surfaces.
- An answer that seems to remember is not proof of storage, and silence after forget is not proof of deletion. Read the body.
- Keep raw memory bodies in private evidence only.
- Implicit capture must store one bounded preference, not incidental prose. Old memory-footer copy showing up in Slack fails the case.
- Answer plus remember must still answer the question. Use an exact sentence; an ambiguous "include this marker" prompt once failed for model reasons, not product ones.
- If memory changes between the read and delivery, the answer is dropped and a failure is posted. Do not edit memory while a case turn is running unless the case tests that.
- A stale write reads "That Agent memory changed before this action completed. Try again." in Slack, `revision_conflict` over MCP, and keeps the draft with Load latest in Admin.
- An Agent with saved memory is not eligible for progressive answer streaming, so streaming cases need an Agent with empty memory.
- Memory is not private: anyone who can address the Agent can print it. Keep markers short and plain so they never look like credentials.
