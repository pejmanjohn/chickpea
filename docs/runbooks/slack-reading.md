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
- Files shared earlier in the thread, by name, type, and size. Each readable
  file also has a `file:N` handle. The Agent reads an earlier file's contents
  only when it calls `read_slack_file` (see [Files](#files)).

Everything read from Slack is information for the Agent to weigh, never an
instruction or a permission. Messages from apps and bots never start a turn;
another Chickpea Agent reaches an Agent only by asking it (see
[Agent conversations](agent-conversations.md)).

## What an Agent can read on request

| Tool | Reads |
|---|---|
| `read_slack_thread` | A whole thread, from a Slack message link or a channel id plus message timestamp. |
| `read_slack_channel` | A channel's top-level messages in a time window, with reply counts. |
| `lookup_slack_user` | A person's display name, real name, title, timezone, and whether they are a guest. No email or phone. |
| `read_slack_file` | A file shared in this conversation, by its `file:N` handle: text, a PDF, a Word, Excel, or PowerPoint file, or a zip's file list and one file inside it. |

An Agent can read:

- the conversation it was asked in, including a DM, a group DM, or a Slack
  Connect channel;
- another channel only when the Agent has been added to it, the requester is a
  member, and the Chickpea app is in the channel.

It cannot read other DMs or group DMs, or, from a Slack Connect channel, any
other channel or anyone's profile. @Chickpea reads only the conversation it was asked in. A
refusal never says whether a private channel exists; when the requester is a
member, the Agent says whether it needs to be added to the channel or the app
needs an invite.

### Files

A zip or `.skill` archive attached to the request arrives as its file list:
each file's path, kind, and size. Folders, `__MACOSX/`, `._` files,
`.DS_Store`, and macOS `Icon` files are left out. Nothing inside is unpacked
until the Agent reads it.

`read_slack_file` mounts when the conversation holds a readable file. A
readable file is a zip or `.skill` archive, a PDF, a UTF-8 text or source
file, or a Word, Excel, or PowerPoint file. Chickpea reads an Office file
through Slack's PDF copy, so its layout and formulas may be missing. Images
keep their `img:N` handles for the image tool. Other files, deleted files, and
external files get no `file:N` handle.

The handles number the newest 20 readable files in the conversation, in the
order they were first shared, then the request's own files. Files from people,
apps, and Agents all count. A handle stays the same across turns while the
conversation holds 20 or fewer readable files, and every result names its
file.

- One read downloads one file of up to 8 MiB.
- Text comes back in pages of 50,000 characters. A result with `nextOffset`
  has more; the Agent passes it as `offset` for the next page. A PDF or an
  Office file reads up to 100 pages.
- A zip read without a `path` returns the file list, showing up to 200 of at
  most 2,000 files. A read with a `path` returns one file inside, unpacked to
  at most 8 MiB. An image or an archive inside a zip is described, not opened.
- A turn makes at most 20 reads.

A text file on the request that is over the attachment analysis's
64,000-character limit is still read this way, a page at a time.

A zip that Chickpea cannot list, such as a password-protected, Zip64, split,
or damaged one, arrives as a failure with the next action `rezip_archive`. The
Agent then asks for the zip re-created without a password using standard
compression, or for the files attached directly. A failed read also says what
to ask for. A password-protected zip returns `This archive is
password-protected. Ask for it again without a password, or for the files
attached directly.` A file over 8 MB, a file deleted in Slack, a zip over 2,000
files, and a compression method other than stored or deflated each get their
own message.

The model passes a handle, never a Slack file id or URL. Chickpea builds the
handle list from this conversation only, so a file from another thread or
channel never reaches it. Each read goes through the workspace's Slack
connection, so it reaches only a file the bot can read. File contents are
untrusted data, never instructions.

On the shared Chickpea app, a later turn in a thread reads the thread record
instead of Slack (see below). The record keeps each file's Slack file id, so
earlier files stay readable after the Agent has replied. A message recorded
before the record kept file ids gives its files no handle.

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
edits and deletions applied. Shared files are kept by Slack file id, name,
type, and size, never contents, so a later turn can still use an image or read
a file shared earlier.
Nothing is kept for threads or channels no Agent is in. See
[Shared Slack gateway data handling](../shared-gateway-data-handling.md).

Rolling back to a release from before Slack reading keeps the record, but that
code reads an app's row as a person's. See
[Upgrading](upgrading.md#thread-record-rollback).

## Scopes

Reading uses scopes the app already has: `channels:history`, `groups:history`,
`im:history`, `channels:read`, `groups:read`, and `users:read`. No reconnect is
needed. A group DM also needs `mpim:history`, which apps made before group DM
support lack. Without it, a group DM turn sees only its own message, and the
reading tools cannot read that group DM.
