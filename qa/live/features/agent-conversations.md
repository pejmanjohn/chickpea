# Agent conversations

Docs: `/slack/conversations/`; operator detail in [Agent conversations](../../../docs/runbooks/agent-conversations.md). Record areas: `agents`, `delivery`. Legacy contracts: none.

## What it covers

- An ask: when an Agent's delivered reply mentions the handle of another Agent that can work in the channel, that Agent answers in the same thread. The mention renders live but notifies nobody.
- Mentions inside code, email addresses and URLs do not ask, nor does a mention an Agent copies from a Slack message, for example in a block quote. An Agent never asks itself.
- The built-in Chickpea never asks. Its reply to "list my Agents" names their handles without live mentions, and none of those Agents answers.
- The asked Agent sees the whole thread and knows who asked and which person started the exchange.
- The thread stays with its own Agent. An answer that asks nobody is handed back to it, and it finishes the request or ends silently when the answer already covers it (see [steering.md](steering.md)).
- Group turns: a person who mentions several Agents in one channel message or DM gets an answer from each, in the order named, and the first keeps the thread. Asked to go back and forth, the Agents continue through the first Agent until the request is covered or the ask limit pauses them.
- Coordination: the thread's Agent can split work, mentioning each teammate once, and give one combined answer after they reply.
- Limits: one message asks at most 6 Agents, and one person's message leads to at most 8 asks however they chain. At the limit the asking Agent posts one pause line and the thread waits for a person.
- Authority: an ask is admitted like a message from the person who started the exchange. The asked Agent uses that person's access and its own accounts, and only people approve, stop, check in, or run memory and schedule commands.
- Schedules and memory on an ask: "ask @finance, then schedule a weekly check" and "find out from @finance and remember it" each end with a proposal and an Approve card on the hand-back; one click (or "approve") saves it. A guest's own proposal gets its own card, and clicking it reaches that guest.
- Asks happen in channel threads and in DM threads. In a DM an Agent asks only the Agents in that thread: its own Agent, Agents that answered there, and Agents the person's message mentioned, each one the person may use privately. An ask to an Agent without a grant in the channel, or in a DM to one not in the thread, is not answered and nothing is posted.

## How a person reaches it

- Slack only: ask an Agent something that needs a teammate, or mention several Agents in one channel message or DM. There is no Admin setting.

## How to drive it on a lane

- Create two or three disposable run-marked Agents, each granted to the lane's QA channel, whose instructions make the split natural (one holds a fact the other needs).
- Give each journey its own case: a single ask with hand-back, a group mention, a group mention in the QA user's DM with the app that asks for a back-and-forth, a coordinator split, an ask to an Agent without a grant, and the ask limit.
- Case shape: `--area agents --area delivery --proof slack --proof admin`. Size `--max-wait-ms` for the chain, since asked Agents run one at a time after the asking reply.
- Cleanup: archive every run-owned Agent (`--cleanup-preset archived-agent`); the thread's messages are retained residue.

## Proof and gotchas

- Every Agent posts as the app's one bot user. Check each answer's sender, avatar and footer, and the order of answers.
- The person should never read the same answer twice, so a silent ending by the thread's Agent is a pass. Prove the silent turn ran from Admin's sessions API (`no_op`).
- To prove Chickpea's listing asks nobody, list in a channel where run Agents are granted, check its reply's blocks hold no `usergroup` element, read the thread again at least two minutes later, and confirm Admin's sessions API shows only Chickpea's run. Pair it with an ask between two run Agents as the positive control.
- An occasional one-line restatement by the thread's Agent after a hand-back is an accepted known limit.
- Whether an Agent asks at all is a model choice. Grade it on the lane's configured model, separately from host behaviour such as admission, hand-back and limits. Earlier prompt-only fixes for this flow were unreliable, which is why the hand-back is host-side.
- An ask that is not admitted is silent by design. Pair it with a healthy positive control and the `[chickpea] host-addressed turn not admitted` line in a bounded tail started before the action.
- Asks are admitted only after the asking reply is recorded as delivered. If that reply failed, no ask follows.
- A person's stop in the thread holds asks that have not started, and a stopped run asks nobody.
- An Agent with live Slack threads cannot be deleted. Archive it.
