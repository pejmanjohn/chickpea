# Agent conversations

Agents can ask each other things in Slack the way people do: one Agent
mentions another's handle in its reply, and the other answers in the same
thread. Everyone in the thread sees the whole exchange. There is no setting
for this in Admin.

## How an ask works

Someone asks `@support` in `#billing` whether a refund is allowed. Support
needs a number only Finance has, so its reply says:

> Checking the charge history. @finance what did we bill order 4821 in Q3?

1. **The mention is the ask.** When an Agent's delivered reply mentions the
   handle of another Agent that can work in the Channel, that Agent gets a
   turn in the same thread. The mention renders as a live Slack mention of
   that Agent; Agent handles have no members, so it notifies nobody. Mentions inside code, email addresses, and URLs
   do not count, and an Agent never asks itself.
2. **The asked Agent answers in the thread.** It sees the whole thread,
   including the asking Agent's message, and knows which Agent asked and which
   person started the exchange. If the asking Agent needs the answer to
   continue, the asked Agent mentions it back, and the asking Agent picks the
   answer up on its next turn.
3. **The thread stays with its Agent.** An ask never hands the thread over.
   Replies from people that mention nobody still go to the thread's own
   Agent. A person mentioning a different Agent still hands the thread over,
   as before.

Each Agent is told which other Agents work in the Channel and their handles,
and when to ask: only when it needs a teammate's answer, never in passing or
to say thanks.

## Mentioning several Agents at once

A person can mention several Agents in one message, for example
`@pm @design @eng what do you think of this idea?`. Each Agent answers in
turn, in the order the message named them, and each sees the answers before
its own. The first Agent keeps the thread: a later reply that mentions nobody
goes to it. The others answer as guests, as when an Agent asks them.

Every mentioned Agent must be available to that person in the Channel. If one
is not, nobody answers and the person gets the usual private note that the
Agent is not available here. One message addresses at most 6 Agents. Approve,
stop, and other commands in such a message apply to the first Agent only.
These answers are a person's request, so they do not count toward the limit
on asks between Agents.

## Who may be asked

An ask is admitted like a message from the person whose message started the
exchange, in that thread:

- The asked Agent needs an active grant in the Channel, and the person must
  be a full member who is in the Channel.
- The asked Agent works with that person's access and its own connected
  accounts. The asking Agent's words cannot grant anything.
- Only people approve, stop, check in, or run memory and schedule commands.
  An Agent's message never counts as one of those, whatever it says.
- Asks happen only in Channel threads on the current runtime. A DM has one
  Agent, and Agents never ask each other there.

An ask that cannot be admitted, for example to an Agent without a grant in
the Channel, is not answered, and nothing is posted about it. The asking
Agent's list of teammates names only Agents it can reach.

## Limits

- One message can ask at most 6 Agents, in the order it mentions them.
- A person's message can lead to at most 8 asks, however they chain. The
  next ask is not admitted; the Agent that tried to ask posts one line saying
  it is pausing, and the thread waits for a person. Any new message from a
  person starts a fresh exchange.
- A person's stop in the thread holds asks that have not started yet, like
  any other queued message. A reply from a run someone stopped asks nobody.

Asked Agents run one at a time in the thread's queue, after the reply that
asked them, so each one sees what came before it.

## Where it runs

Slack never delivers an ask: every Agent posts as the Chickpea app's one bot
user, and messages from apps and bots never start a turn. The deployment
admits asks itself from each delivered reply, after the reply is recorded as
delivered:

- Cloudflare admits them where the turn ran: in the thread's
  `SlackThreadRunner` (the default executor), or in the state store for a
  turn its legacy alarm executor ran.
- Node admits them in the process that ran the turn.

An asked Agent keeps its own transcript of the thread, apart from the
thread's own Agent, so answering an ask never resets the owner's transcript.
It shares the thread's coding sandbox, as an Agent that takes a thread over
does today.

## Logs

| Line | Meaning |
|---|---|
| `[chickpea] agent ask not admitted: <reason>` | Routing refused the ask, for example `not_available` for an Agent without a grant, or `not_eligible` when admission could not authorize it. |
| `[chickpea] agent ask limit reached; exchange paused` | The exchange used its asks and the pause line was posted. |
| `[chickpea] agent ask was not admitted: <error>` | Admission failed after its retries. The asked Agent does not answer. |
| `[chickpea] agent ask dispatch failed: <name>` | The executor could not hand the reply's asks over. |
