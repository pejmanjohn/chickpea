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

A channel's canvases are its canvas tabs. Slack lists them in
`conversations.info` as `properties.tabs` entries with `type` `canvas`, and
Chickpea also takes `properties.canvas.file_id` if Slack sends it. When a
channel has one canvas tab, that tab is the channel's canvas. When it has
several, a read or an edit that names no canvas changes nothing and returns
each canvas's title and link. The Agent asks which one the requester means and
passes its link.

Reading follows the same authority as reading a channel
([Reading Slack](slack-reading.md)). The current conversation's canvases are
always readable, also by link, with no lookup first. A canvas that was only
posted in the conversation is not one of its canvases, and its link follows the
rules for other canvases. Another channel's canvas needs the requester to be a
member, the Agent to be added to the channel, and the Chickpea app to be in it.
A canvas link is readable when Slack lists the canvas in a conversation that
passes these rules. `@Chickpea`, and any Agent in a conversation shared with
another organization, reads only the current conversation's canvases. A
refusal does not say whether a canvas exists.

The workspace app's bot reads the canvas, so Slack also decides what the bot
can view. A read returns about 24 KB of Markdown and an offset for the next
page.

## Creating

An Agent creates a canvas only when asked, and only in a channel. In a direct
message or group DM it says so and creates nothing.

- A channel without a canvas tab gets the new canvas as its channel canvas
  (`conversations.canvases.create`).
- A channel that already has a canvas tab gets a new canvas added to the channel
  (`canvases.create` with the channel), which channel members can view and
  edit. It appears as a channel tab.

Chickpea does not call `canvases.access.set`. Slack requires a canvas link to
be shared with a channel before that call can change the channel's access.

On a free Slack plan, a channel can hold one canvas and standalone canvases
are not allowed. When the channel already has its canvas, the Agent says so,
creates nothing, and can offer to add to the channel's canvas instead.

## Updating

An Agent edits only two kinds of canvas: this conversation's canvases, and a
canvas the Chickpea app owns because it created it. The second kind must also
pass the reading rules above. A person's own canvas elsewhere is not edited.

An edit lands wherever the canvas is, so it must not carry content to an
organization that cannot read the current conversation. Chickpea refuses an
edit when Slack shows the canvas in a conversation shared with another
organization, or readable by an external workspace. From a conversation shared
with another organization, only that conversation's own canvases are edited,
and only when Slack lists them in no other conversation. A canvas in more than
eight conversations is not edited, because Chickpea cannot check them all.

From a conversation shared with another organization, a canvas link is refused
unless it is one of that conversation's own canvases, even when the canvas was posted
there: knowing where a canvas lives takes a lookup that could show whether it
exists.

One case is not yet checked. A shared conversation's own canvas that Slack
lists in no other conversation may still be shared directly with a person from
a third organization. Probe item 6 records what `files.info` reports for that.

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

Use it to confirm the Slack facts the tools rest on. A hosted check on a paid
workspace on 2026-11-05 observed facts 1 and 2 and part of 4. The others are
not yet observed.

1. Observed: `conversations.info` lists a channel's canvases only as
   `properties.tabs` entries with `type` `canvas` and `data.file_id`. It returned
   no `properties.canvas`, even right after `conversations.canvases.create` made
   the canvas.
2. Observed: `files.info` on a canvas returns `permalink`, `title`, `user` (the
   bot user for a canvas the bot created) and the conversations it is in
   (`channels`, `groups`, `ims`). For a canvas the bot created in an unshared
   channel, `channels` named that channel, `filetype` was `quip`, and there was
   no `linked_channel_id` and neither external-access field.
3. `canvases.sections.lookup` accepts criteria with `contains_text` alone.
4. On a paid plan, `canvases.create` with `channel_id` in a channel that has a
   canvas tab succeeds and adds a tab, and a channel member can open the result.
   Observed so far: a second `conversations.canvases.create` in such a channel
   also succeeded and added a second canvas tab, instead of returning
   `channel_canvas_already_exists`.
5. On a free plan, the same call returns `free_team_canvas_tab_already_exists`.
6. `files.info` on a canvas posted in a Slack Connect channel lists that
   channel, or reports `external_workspaces_with_read_access` or
   `private_external_workspaces_with_read_access_count`. Record both fields,
   and `conversations.info` `shared_team_ids`, for a Slack Connect channel's
   canvas before and after sharing it directly with a person from another
   organization.

Raw API success is compatibility evidence. Full acceptance also needs a real
routed Agent request and the canvas checked in Slack, using
`$chickpea-live-verification`.
