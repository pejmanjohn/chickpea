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
   handle of another Agent it can ask here (see
   [Who may be asked](#who-may-be-asked)), that Agent gets a turn in the same
   thread. The mention renders as a live Slack mention of that Agent; Agent
   handles have no members, so it notifies nobody. Mentions inside code,
   email addresses, and URLs do not count, nor does a mention copied from a
   Slack message, for example in a quote. An Agent never asks itself. The
   built-in Chickpea never asks: it lists and describes Agents, so a handle in
   its reply is not a live mention and asks nobody.
2. **The asked Agent answers in the thread.** It sees the whole thread,
   including the asking Agent's message, and knows which Agent asked and which
   person started the exchange.
3. **The answer goes back to the thread's Agent.** An answer that asks
   nobody is handed back to the thread's own Agent, and it finishes the
   person's request with it. When the answer already covers the request, as
   with "How much was each charge?", it posts nothing more, so the person
   never reads the answer twice. This holds along a chain: when an asked
   Agent asks another, the last answer still comes back to the thread's
   Agent. An asked Agent that needs the answer itself asks to be mentioned,
   and the teammate then mentions it. A run that failed or was stopped hands
   nothing back.
4. **The thread stays with its Agent.** An ask never hands the thread over.
   Replies from people that mention nobody still go to the thread's own
   Agent. A person mentioning a different Agent still hands the thread over,
   as before.

Each user Agent is told which other Agents it can ask here and their
handles: in a Channel, the Agents granted there; in a direct message, the
Agents in that thread. It is also told when to ask: only when it needs a
teammate's answer, never in passing or to say thanks.

## Mentioning several Agents at once

A person can mention several Agents in one message, in a Channel or in a
direct message with Chickpea, for example
`@pm @design @eng what do you think of this idea?`. Each Agent answers in
turn, in the order the message named them, and each sees the answers before
its own. The first Agent keeps the thread: a later reply that mentions nobody
goes to it. The others answer as guests, as when an Agent asks them.

In a Channel, an Agent with its own Slack app is mentioned by its bot, and
that mention counts here like a handle. Chickpea's bot and the app's bot both
receive such a message, and either delivery routes it the same way: the
first to arrive admits every Agent it names, in order, and the other adds
nothing. If the first stops after admitting its first Agent, a later
delivery, or Slack's retry, admits the Agents it had not reached yet, each
once. A message whose first Agent's turn was never queued, such as a stop,
admits nobody later. A message that mentions only Agent-app bots is answered on those
apps' own deliveries. Without the host's Agent-app port (see
[How it is turned on](slack-message-identity.md#how-it-is-turned-on)) no app
is served, so its bot's mention addresses nobody, as before Agents had apps.

Every mentioned Agent must be available to that person where they wrote: in
a Channel, granted there; in a direct message, one they may use privately;
in a group DM, one everyone in the workspace may use (see
[In a group DM](#in-a-group-dm)).
If one is not, nobody answers and the person gets the usual note that the
Agent is not available here, once per message. In a Channel each Agent also
answers as its own bot, its app's or Chickpea's, so that bot must be in the
Channel. When it is not, nobody answers, and the person is told privately,
once, that the Agent isn't in the Channel yet. The note has no Add button,
because granting the Agent would not bring its bot in. Someone in the Channel
adds the missing bot in Slack, for example with `/invite`. One message
addresses at most
6 Agents. Approve, stop, and other commands in such a message apply to the
first Agent only. These answers are a person's request, so they do not count
toward the limit on asks between Agents, and only the person's message sets
the thread's title in Slack.

When the person asks the Agents to discuss something or go back and forth,
the last Agent ends its answer by mentioning the first. The first Agent then
keeps the discussion going by mentioning the teammate it wants to hear from
next, and each answer that mentions nobody comes back to it. Once the
discussion covers what the person asked, it says where they landed. Each
turn after the Agents' first answers is an ask and counts toward the limit
on asks, so a long discussion pauses until the person replies. An Agent
mentioned while its own answer to the message is still waiting gets no
second turn: the waiting turn reads the mention when it runs.

## Who may be asked

An ask is admitted like a message from the person whose message started the
exchange, in that thread:

- In a Channel, the asked Agent needs an active grant there, and the person
  must be a full member who is in the Channel. In a direct message, see
  [In a direct message](#in-a-direct-message), and in a group DM,
  [In a group DM](#in-a-group-dm).
- The asked Agent works with that person's access and its own connected
  accounts. The asking Agent's words cannot grant anything.
- Only people approve, stop, check in, or run memory and schedule commands.
  An Agent's message never counts as one of those, whatever it says.
- On a turn an ask started, every workspace change waits in one proposal
  covering everything the turn would write: scheduled work, memory, skills,
  undo, and Agent settings alike. The person approves it with the card's
  Approve button, or with a reply addressed to the Agent that proposed it,
  such as `@desk approve`. A reply that names no Agent goes to the thread's
  own Agent, so it approves only that Agent's proposals. A click on a guest's
  card goes to that guest.
- Asks happen only on the current runtime.

An ask that cannot be admitted, for example to an Agent without a grant in
the Channel, is not answered, and nothing is posted about it. The asking
Agent's list of teammates names only Agents it can reach.

## In a direct message

These Agents are in a thread of a person's direct message with Chickpea:

- The Agent that owns the thread.
- Every Agent that answered in the thread.
- Every Agent the person's message mentioned, once routing accepted that
  message. A mention in a message that was refused brings nobody in.

An Agent in the thread may ask only the others in it. An Agent the person
could use privately, but that is not in the thread, is not asked. Each Agent
is reached with the person's private access, checked at the time of each
turn: the same check as when the person mentions that Agent alone. The
thread's Agents are read from the thread's record, never stored with the
thread, and the list an Agent is told names only Agents already in the
thread, so no Agent's name reaches a person who cannot see it there.

Every answer is posted in the conversation, so only the people in it read
it. Each Agent has one memory across Channels and direct messages, so an
Agent that reads another Agent's answer is told not to save it to memory
unless the person asks, and a write it makes anyway waits for the person's
approval. An ask carries no request text from the person: a check that needs
the person's own words, such as a schedule change or a skill import, does not
take the asking Agent's words as theirs.

### The front desk

An untagged message at the root of a person's direct message with Chickpea
goes to Chickpea first. On that turn only, Chickpea is shown the Agents the
person may use privately. It is the same check as a mention. The list holds
each Agent's purpose, connection names, website login hosts, and skill
names. It stops at 12 Agents and 6,000 characters. It never holds
credentials, usernames, or another member's personal connections.

When one Agent fits, Chickpea calls `hand_off_to_agent`. The host, not the
model, decides whether the person must pick first. The host hands the
message over at once only to an Agent the person created, or to one that
answered them in this direct message in the last 7 days. Chickpea's reply
names that Agent. The host then admits the person's own message again for
that Agent, which takes the thread over. The requester, text, message ts and
files are the same as with a mention, and access is checked again at
admission.

For any other Agent, Chickpea's reply says that Agent can take the message,
and a card offers two buttons: that Agent and Chickpea. When several Agents
fit, the card has one button per Agent. Only the person's own click hands
the message over. When the message is too large for a card, the tool refuses
an Agent that needs a click, so Chickpea names it and suggests a mention. A
message is handed over at most once: the `msg:<channel>:<ts>:handoff` claim
allows one.

Group DMs, Channels, thread replies, and any message that mentions an Agent
keep the routing described above.

## In a group DM

A group DM is addressed like a Channel and decided like a direct message. An
Agent hears a message there only when it names the Agent's handle or
`@Chickpea`, or replies in a thread the Agent owns. A message that names no
Agent is people talking to each other, and no Agent reads it. Anyone in the
group DM may send the follow-up in an Agent's thread.

No grant applies to a group DM, and nothing records who may use an Agent
there. Its answer reaches everyone in it, so a user Agent answers in a group
DM only when everyone in the workspace may already use it privately: it has
been added to at least one public Channel. An Agent limited to its creator,
or to the people in its private Channels, never answers in a group DM, even
for its creator. The person who asked gets one private note:
`Only Agents everyone in this workspace can use answer in group DMs.` It has
no Add button, and Chickpea never adds an Agent to a group DM. Chickpea
itself answers any full member there, as in a direct message.

The rule covers every Agent one message names and every ask between Agents,
each checked for the person whose message started the exchange. The Agents
in a group DM thread are found as in a direct message. Guests, people from
another organization, and deactivated people are not answered. No Agent
answers in a group DM shared with another organization.

A mention at the root of a group DM reads the group's recent messages, as a
Channel mention does. Each Agent keeps its one memory there, as in a direct
message. Refusals, check-in answers, and the note that someone cannot stop a
run are ephemeral, as in a Channel: only the person who asked sees them.

A Slack app made before group DM support hears only `@Chickpea` in group DMs,
and reads none of their earlier messages: its Agents' handles and thread
replies there never arrive, and a bare `@Chickpea` in an Agent's thread takes
the thread over. [Group DMs](../../SETUP_AGENT.md#group-dms) in the setup
guide adds what such an app needs.

## Limits

- One message can ask at most 6 Agents, in the order it mentions them.
- A person's message can lead to at most 8 asks, however they chain, and
  each answer handed back counts as one. The next ask is not admitted; the
  Agent that tried to ask posts one line saying it is pausing, and the thread
  waits for a person. An answer that cannot be handed back at the limit
  stays in the thread without that line. Any new message from a
  person starts a fresh exchange.
- A person's stop in the thread holds asks that have not started yet, like
  any other queued message. A reply from a run someone stopped asks nobody.

Asked Agents run one at a time in the thread's queue, after the reply that
asked them. An ask reads the whole thread when it runs, so a teammate asked
after another sees the earlier answers.

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
It also has its own coding sandbox for the thread: its workspaces,
checkpoints and coding tasks never replace the owner's or another asked
Agent's. On the default `SlackThreadRunner` executor, a person's stop in the
thread reaches the coding tasks of whichever Agent's run it stopped. An
Agent that takes a thread over uses the thread's sandbox.

## Coordinating teammates

The thread's own Agent can split work across others: its reply gives each
teammate its own part, mentioning each once, and they answer one at a time in
that order. Each answer goes back to the coordinator, and it answers once when
it can: an Agent that already has a turn waiting in the thread for the same
exchange, not started yet, is not given another, and the waiting turn reads
every later answer too. It then gives the person one combined answer.
Splitting work across N teammates uses N asks, plus one for the answers going
back, of the 8 a person's message allows. An asked Agent that coordinates
others asks only the last one to mention it back, so that report comes after
every other answer.

## Logs

| Line | Meaning |
|---|---|
| `[chickpea] host-addressed turn not admitted: <reason>` | Routing refused the ask, for example `not_available` for an Agent without a grant, in a direct message one not in the thread, or in a group DM one not everyone in the workspace may use; `not_eligible` when admission could not authorize it. |
| `[chickpea] agent ask limit reached; exchange paused` | The exchange used its asks and the pause line was posted. |
| `[chickpea] agent ask was not admitted: <error>` | Admission failed after its retries. The asked Agent does not answer. |
| `[chickpea] agent ask dispatch failed: <name>` | The executor could not hand the reply's asks over. |
