# Slack canvases

Chickpea Agents can read Slack canvases as Markdown, create a canvas for a long
deliverable such as a report, a brief or a plan, and update a canvas later.
These are native Agent tools in interactive Slack conversations. There is no
canvas page in Admin.

## Reading

An Agent reads one of three canvases:

- This conversation's canvas, when no canvas or channel is named.
- Another channel's canvas, named by channel.
- A canvas named by its link.

Reading follows the same authority as reading a channel
([Reading Slack](slack-reading.md)). The current conversation's canvas is always
readable. Another channel's canvas needs the requester to be a member, the
Agent to be added to the channel, and the Chickpea app to be in it. A canvas
link is readable when Slack lists the canvas in a conversation that passes
these rules. `@Chickpea`, and any Agent in a conversation shared with another
organization, reads only the current conversation's canvas. A refusal does not
say whether a canvas exists.

The workspace app's bot reads the canvas, so Slack also decides what the bot
can view. A read returns about 24 KB of Markdown and an offset for the next
page.

## Creating

An Agent creates a canvas only when asked, and only in a channel. In a direct
message or group DM it says so and creates nothing.

- A channel without a canvas gets the new canvas as its channel canvas
  (`conversations.canvases.create`).
- A channel that already has one gets a new canvas added to the channel
  (`canvases.create` with the channel), which channel members can view and
  edit. It appears as a channel tab.

Chickpea does not call `canvases.access.set`. Slack requires a canvas link to
be shared with a channel before that call can change the channel's access.

On a free Slack plan, a channel can hold one canvas and standalone canvases
are not allowed. When the channel already has its canvas, the Agent says so,
creates nothing, and can offer to add to the channel's canvas instead.

## Updating

An Agent edits only two kinds of canvas: this conversation's canvas, and a
canvas the Chickpea app owns because it created it. The second kind must also
pass the reading rules above. A person's own canvas elsewhere is not edited.

An edit lands wherever the canvas is, so it must not carry this workspace's
content to another organization. Chickpea refuses an edit when Slack shows the
canvas in a conversation shared with another organization, or readable by an
external workspace, unless the current conversation is that shared one and the
canvas is its own. From a conversation shared with another organization, only
that conversation's own canvas is edited.

- **Append** adds Markdown at the end (`canvases.edit`, `insert_at_end`).
- **Replace a section** finds the one section that contains the given text
  (`canvases.sections.lookup`) and replaces it (`canvases.edit`, `replace`).
  A heading is its own section, separate from the text under it. No match or
  more than one match changes nothing.

Slack acknowledges an edit; Chickpea does not read the canvas back to compare
it. Deleting a canvas, renaming it, and changing who can access it are not
supported.

## Writes and limits

Canvas writes use the same per-request receipt as Slack Lists writes. A
confirmed identical write is not sent again. A write with an uncertain result
blocks further Lists and canvas writes in that request. Read the canvas to
reconcile; do not repeat an uncertain creation.

A write takes up to 100,000 characters of Markdown. Slack's own limit is 1 MiB
per change. Canvases take Markdown, not Block Kit. When Slack refuses the
Markdown, the tool returns Slack's reason so the Agent can correct it.

## Installation and rollout

The bot scopes are `canvases:read` and `canvases:write`. Both are feature
scopes: an installation without them keeps ordinary chat. A missing scope
returns this message, and nothing changes:

- Hosted: "This workspace has not given Chickpea the Slack canvas permissions
  yet. A Chickpea Owner can update them in Chickpea Admin. Ordinary chat can
  continue."
- Self-hosted: "This Slack installation needs the canvas read/write
  permissions. Its owner must update the app scopes and reinstall through the
  existing Slack setup flow. Ordinary chat can continue."

An Agent with its own Slack app still reads and writes canvases through the
workspace app, because Agent apps do not ask for the canvas scopes.

Shared-gateway installations need the gateway to allow `canvases.getContent`,
`canvases.sections.lookup`, `conversations.canvases.create`, `canvases.create`,
`canvases.edit` and `files.info`. Deploy that gateway support before the
Chickpea version that uses it. An older gateway returns an unsupported-operation
result.

## Verification

`tests/slack-canvases.test.ts` covers the tools against a fake Slack. The
attended probe in `qa/live/probes/slack-canvases.ts` accepts only an identified
bot token, its workspace, and declared fixture channels and canvases. It deletes
only run-owned canvases. Keep its credentials, receipts and readbacks private.

Save each receipt before its request goes out. After a restart, reconcile an
unfinished receipt before another write.

Use it to confirm the Slack facts the tools rest on:

1. `conversations.info` returns `properties.canvas.file_id` for a channel's
   canvas.
2. `files.info` on a canvas returns `permalink`, `title`, `user` (the bot user
   for a canvas the bot created) and the conversations it is in
   (`linked_channel_id`, `channels`, `groups`, `ims`).
3. `canvases.sections.lookup` accepts criteria with `contains_text` alone.
4. On a paid plan, `canvases.create` with `channel_id` in a channel that has a
   canvas succeeds, and a channel member can open the result.
5. On a free plan, the same call returns `free_team_canvas_tab_already_exists`.
6. `files.info` on a canvas posted in a Slack Connect channel lists that
   channel, or reports `external_workspaces_with_read_access` or
   `private_external_workspaces_with_read_access_count`.

Raw API success is compatibility evidence. Full acceptance also needs a real
routed Agent request and the canvas checked in Slack, using
`$chickpea-live-verification`.
