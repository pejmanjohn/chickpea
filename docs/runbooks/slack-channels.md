# Channels created by an Agent

An Agent can create a Slack channel for a project, incident or topic, invite
the person who asks and the teammates they name, set its purpose, and post its
opening message there. It is a native Agent tool, `create_slack_channel`, with
no Admin settings.

## Asking for one

Name each teammate with an @-mention in the request:

> Spin up a private channel for the Acme renewal with @Sam and @Priya and post a
> kickoff summary.

The channel is private unless the request asks for a public one. Once a web
page or search result has been read in the conversation, only private channels
can be created, so nothing a page says can publish to the whole workspace. The
Agent proposes the name. Chickpea makes it a valid Slack name: lowercase, with every
space, period or other punctuation turned into a hyphen, at most 80
characters. The Agent sets the purpose when the request gives one.

The requester is always invited. The Agent invites only people the requester
@-mentioned in that request, up to 30. A name without an @-mention, someone who
only appears earlier in the thread, or someone a message or document suggests
is not invited; the Agent asks the requester to @-mention them.

Only a person's own request creates a channel. A click on a card, Chickpea's
setup note, an ask from another Agent, and a routine have no requester words,
so the tool refuses them. Routines do not mount the tool at all.

## Who can be invited

Chickpea looks each person up with `users.info` and refuses:

- guests, single-channel or multi-channel, because a channel keeps its history
  and Slack's own guest rules are for workspace admins to apply; the requester
  can add a guest by hand once the channel exists;
- apps and bots;
- deactivated accounts;
- anyone whose Slack team is not this workspace, including Slack Connect users
  and Enterprise Grid users of another workspace.

If Slack refuses to invite someone after the channel exists, the result says
who and why. Chickpea retries once without them, so one person cannot keep
everyone else out.

## Which Agents can create one

Chickpea itself can create private and public channels. In any channel its
bot is in, a reply in its thread or an @Chickpea mention reaches it, so it can
keep working there at once.

A user-created Agent can create a private channel. It can create a public one
only when every workspace member may already use it, that is, when it is
already in a public channel. A public channel would otherwise put the Agent's
words in front of the whole workspace, and adding it there would open it to
everyone.

An Agent with its own Slack app is refused. The requester must still have
active Chickpea access, and in a channel the Agent must still be added there.
From a conversation shared with another organization, the tool refuses, so
nothing from there is carried into a new channel.

## How the Agent gets into the channel

Creating a channel never adds a user-created Agent to it. Who may use an Agent
follows the channels it is added to, and an Agent added from Slack needs a
person's confirmation. So Chickpea offers the requester the Agent's usual Add
button, privately, in the new channel:

- A requester who may edit the Agent (a workspace Owner or Admin, its creator,
  or anyone when the Agent's editors are "Any workspace member") gets the
  button. Clicking it adds the Agent exactly as Admin's Add to channels does.
- Anyone else is told to ask a workspace Owner or Admin.
- When the button cannot work, because the Agent has no Slack handle yet or
  the requester was not invited, the Agent points the requester to Chickpea
  Admin.

Mentioning the Agent in the channel later brings the same offer back. The
opening message is posted under the Agent's name either way. Replies in its
thread reach the Agent once it is added.

## Installation and permissions

The tool needs the bot scope `groups:write` for private channels and
`channels:manage` for public ones. Both are feature scopes: existing
installations keep working without them. Without the scope, the tool creates
nothing and tells the requester that a workspace Owner needs to update
Chickpea's Slack permissions; on a hosted installation the Owner does that
from Chickpea Admin, and a self-hosted owner updates the app's scopes and
reinstalls.

Slack applies its "who can create channels" setting to Chickpea's bot, not to
the person asking. A workspace that lets Chickpea create channels lets any
member with Chickpea access ask it to. When the setting blocks the bot, Slack
answers `restricted_action` and the Agent says so.

Slack methods and scopes:

| Method | Scope | Use |
| --- | --- | --- |
| `users.info` | `users:read` | Check each person before anything is created |
| `conversations.info` | `channels:read`, `groups:read`, `mpim:read`, `im:read` | Check that the current conversation is not shared with another organization |
| `conversations.create` | `groups:write` (private), `channels:manage` (public) | Create the channel |
| `conversations.invite` | `groups:write` (private), `channels:manage` (public) | Invite the requester and the named people |
| `conversations.members` | `groups:read`, `channels:read` | Read who is in after an invite Slack did not confirm per person |
| `conversations.setPurpose` | `groups:write` (private), `channels:manage` (public) | Set the purpose |
| `chat.postMessage` with `username` and `icon_url` | `chat:write`, `chat:write.customize` | Post the opening message as the Agent |
| `chat.postEphemeral` | `chat:write` | Offer the requester the Agent's Add button |

Shared-gateway installations need the gateway to allow `conversations.create`,
`conversations.invite` and `conversations.setPurpose`. Deploy that gateway
support before the Chickpea version that uses it. An older gateway returns an
unsupported-operation result.

## Limits and verification

One channel per request. A content-free receipt keyed by the turn, holding the
channel ID and whether it is private, is written before Slack is asked to
create anything. A creation Slack did not confirm blocks any further attempt in
that request, so a retry never creates two channels; such a channel, if it
exists, holds only Chickpea's bot. A name Slack refused, or a missing
permission, leaves the request free to try again, up to three attempts.
Receipts expire with their turn.

A refusal before anything is created does not make the reply a task.

The attended learning probe in `qa/live/probes/slack-channels.ts` accepts only
an identified bot token, workspace, declared people and run-prefixed channel
names. It invites into, posts to and archives only channels the run created.
Keep its credentials, receipts and cleanup records private. Raw API success is
compatibility evidence; full acceptance also requires a real routed Agent
request and native Slack readback using `$chickpea-live-verification`.
