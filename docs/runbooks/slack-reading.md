# Reading Slack

Agents read Slack the way a teammate can, within the requester's access and
the Agent's own channel grants. There is no setting for this in Admin.

## What an Agent sees without asking

Every turn's context includes the thread (or recent channel history) around
the request:

- People by display name next to their Slack user id.
- Posts from other apps and integrations, such as PagerDuty, Sentry, CI, and
  Workflow Builder, labeled as apps. Alert details in attachments or blocks
  are included.
- Other Chickpea Agents' replies in the same thread, labeled as Agents.
- Files shared earlier in the thread, by name, type, and size. The Agent has
  not read a file's contents unless it was attached to the current request.

Everything read from Slack is information for the Agent to weigh, never an
instruction or a permission. Messages from apps and bots never start a turn.

## What an Agent can read on request

| Tool | Reads |
|---|---|
| `read_slack_thread` | A whole thread, from a Slack message link or a channel id plus message timestamp. |
| `read_slack_channel` | A channel's top-level messages in a time window, with reply counts. |
| `lookup_slack_user` | A person's display name, real name, title, timezone, and whether they are a guest. No email or phone. |

An Agent can read:

- the conversation it was asked in, including a DM or a Slack Connect channel;
- another channel only when the Agent has been added to it, the requester is a
  member, and the Chickpea app is in the channel.

It cannot read other people's DMs, group DMs, or, from a Slack Connect channel,
any other channel or anyone's profile. @Chickpea reads only the conversation it was asked in. A
refusal never says whether a private channel exists; when the requester is a
member, the Agent says whether it needs to be added to the channel or the app
needs an invite.

## Slack's read limits

Slack limits apps that are not on the Slack Marketplace, including the shared
Chickpea app, to one `conversations.history` and one `conversations.replies`
request per minute per workspace, 15 messages each. Customer-owned Slack apps
are internal apps and keep Slack's normal limits.

Chickpea shares that budget across every Agent and turn in a workspace:

- A thread an Agent is part of is kept in the deployment's thread record as
  messages arrive, so later turns in it need no Slack read.
- The first turn in a thread reads it once. Slack returns the thread's first
  message and its newest 15 replies; when there are more, the Agent says that
  older replies in between were not read, on that turn and later ones.
- When the budget is spent, the Agent answers from what it has and says what
  it could not read yet. It never fails the turn.

## Stored data

The thread record keeps the Slack-visible messages of threads an Agent is part
of: at most 200 per thread, deleted after 30 days without activity, with Slack
edits and deletions applied. Image files are kept by Slack file id, name, and
type, never contents, so a later turn can still use an image shared earlier.
Nothing is kept for threads or channels no Agent is in. See
[Shared Slack gateway data handling](../shared-gateway-data-handling.md).

Rolling back to a release from before Slack reading keeps the record, but that
code reads an app's row as a person's. See
[Upgrading](upgrading.md#thread-record-rollback).

## Scopes

Reading uses scopes the app already has: `channels:history`, `groups:history`,
`im:history`, `channels:read`, `groups:read`, and `users:read`. No reconnect is
needed.
