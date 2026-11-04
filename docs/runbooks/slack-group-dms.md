# Group DMs started by an Agent

An Agent can start a Slack group DM with the person who asks and the teammates
they name, post its opening message there, and keep working in that group DM.
It is a native Agent tool, `start_slack_group_dm`, with no Admin settings.

## Asking for one

Name each teammate with an @-mention in the request:

> Loop in @Sam and @Priya on this in a group DM and summarize where we landed.

The requester is always a member. The Agent adds only people the requester
@-mentioned in that request, so a name without an @-mention, someone who only
appears earlier in the thread, or someone a message or document suggests is
not added; the Agent asks the requester to @-mention them. A group DM holds the
app and eight people, so a request can add one to seven teammates.

Only a person's own request names anyone. A click on a card, Chickpea's setup
note, an ask from another Agent, and a routine have no requester words, so the
tool refuses them. Routines do not mount the tool at all.

## Who can be added

Chickpea looks each person up with `users.info`, by the same rule the people
lookup uses, and refuses:

- apps and bots;
- deactivated accounts;
- anyone whose Slack team is not this workspace: Slack Connect and external
  users, and Enterprise Grid users of another workspace, since Slack marks
  every Grid user alike whichever organization they belong to.

Guests of the workspace can be added. Slack still applies its own rules on who
may share a group DM.

## Which Agents can start one

The opening message and every later answer in the group DM reach everyone in
it, so the rule is the one that already decides who answers in a group DM:
only an Agent every workspace member may use (one placed in a public Channel),
and @Chickpea. An Agent with private use only is refused.

The Agent posts through Chickpea's bot under its own name and avatar, as it
does elsewhere. An Agent with its own Slack app is refused: its bot has no
group DM permission.

The requester must still have active Chickpea access, and in a Channel the
Agent must still be added there, as for the Lists tools. From a conversation
shared with another organization, the tool refuses, so nothing from there is
carried into a new conversation. A DM counts as the app's own, unshared, when
Slack will not describe it without `im:read`, as the reading tools hold.

## Replies

Chickpea stores the opening message as the start of an Agent thread. A reply in
that thread reaches the Agent without a mention, as a reply in any Agent's
thread does. A top-level message in the group DM reaches it only when it
mentions the Agent.

## Installation and permissions

The tool needs the bot scope `mpim:write`. It is a feature scope: existing
installations keep working without it. Without it, the tool posts nothing and
tells the requester that a workspace Owner needs to update Chickpea's Slack
permissions; on a hosted installation the Owner does that from Chickpea
Admin, and a self-hosted owner updates the app's scopes and reinstalls.

Slack methods and scopes:

| Method | Scope | Use |
| --- | --- | --- |
| `users.info` | `users:read` | Check each person before anything is opened |
| `conversations.info` | `channels:read`, `groups:read`, `mpim:read`, `im:read` | Check that the current conversation is not shared with another organization |
| `conversations.open` with several users | `mpim:write` | Open the group DM |
| `chat.postMessage` with `username` and `icon_url` | `chat:write`, `chat:write.customize` | Post the opening message as the Agent |

A shared gateway already allows these methods; its app needs `mpim:write`.

## Limits and verification

One group DM per request. A content-free receipt keyed by the turn is written
before the opening message is posted. A post Slack did not confirm blocks any
further attempt in that request, so a retry never posts twice; a post Slack
refused, or a missing permission, leaves the request free to try again.
Receipts expire with their turn.

A refusal before anything is posted does not make the reply a task.
