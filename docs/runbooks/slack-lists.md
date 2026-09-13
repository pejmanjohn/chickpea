# Native Slack Lists

Chickpea Agents can read Lists and create, assign, edit, complete, and reopen
tasks during interactive Slack conversations. They can also create a named task
List and explicitly share it with a person or channel. These are native Agent
tools; there is no Lists configuration page in Admin.

## Selecting the destination

For an existing List, provide its Slack link:

> Add a task to <List link>: create the client report, assign it to @Pejman,
> and make it due Tuesday at 11am. Include the campaign results from this thread.

An ordinary instruction or memory can supply a default. Be explicit about scope:

> In #client-work (channel C123EXAMPLE), when I ask you to create or manage a
> task without naming another destination, use this Slack List: <List link>.
> This default applies only in #client-work. If I name Asana, Linear, another
> tool, or another List, use that destination instead.

A saved List identity alone is not a default. Chickpea asks for the destination
or link when it is missing; a message being in Slack does not select Slack Lists.
Remembering a default does not itself create a task.

Task assignment names the human responsible for the work. It does not ask the
Agent to perform that work, chase the assignee, or create a reminder. Deadlines
alone never schedule follow-up. Explicit task requests execute without the
Agent-configuration approval flow.

## Access and fields

The installed app's bot performs the operation. Chickpea rechecks the requester's
active Chickpea membership and the Agent's enabled state and channel grant before
each tool call. Slack channel membership is checked at turn admission, not again
during every tool call; Slack enforces the bot's
List access. Chickpea does not impersonate the requester or mirror personal List
permissions. Sharing a List with a channel where the bot is a member can provide
Can view or Can edit access. A denied operation never automatically joins a
channel or changes sharing. Sharing with a human is separate from assigning them
a task, and assignment does not guarantee they can open the List.

The Agent reads actual column IDs and types. Renamed task columns work. Context
and source links need an existing nonprimary text column; if there are several,
the Agent asks which one to use. A newly created task List includes Details.
Chickpea does not add columns to an existing List to force a task to fit.

An exact deadline uses the requester's Slack timezone unless another is supplied.
Chickpea stores the timestamp and a visible deadline line in task context because
Slack's date column may display only the day. A missing or repeated local time at
a daylight-saving transition requires clarification. Omitted update fields remain
unchanged; an explicit clear removes a field.
If multiple context columns contain generated deadline notes, remove the duplicate
notes in Slack before changing the deadline. The tools stop without writing.

## Installation and rollout

New manifests and OAuth requests include the bot scopes `lists:read` and
`lists:write`. Existing core-only installations remain healthy for ordinary chat.
To enable Lists on an existing own-app installation, the owner must update its
full Slack app manifest and reinstall through the existing setup flow. A URL-only
manifest repair must not add permissions. A missing scope produces a Lists-specific
instruction to reconnect; it does not disable chat or trigger personal OAuth.
Credential recovery preserves the existing feature grant. Enabling Lists is a
separate owner-authorized manifest update and normal Slack installation flow.

Shared-gateway installations require the gateway's six-method Lists allowlist
and its updated app scopes before reconnecting the Slack installation. Deploy
gateway support before the Chickpea capability, then update the app grant and
reconnect. Updating the shared gateway/app is a separate operator action. An old
gateway returns an unsupported-operation result. Rolling back Chickpea hides
the tools; native Lists and tasks remain in Slack. Do not revoke scopes globally
as part of a feature rollback.

## Operation limits and verification

The six tools are `read_slack_list`, `read_slack_list_item`,
`create_slack_list_item`, `update_slack_list_item`, `create_slack_task_list`, and
`share_slack_list`. There is no List discovery, deletion, bulk mutation, task
database, synchronization, or automatic monitoring.

Reads return one bounded page with a cursor. Each tool uses at most three Lists
API calls. Item writes are read back before success is reported: Slack can return
`ok: true` while silently ignoring an invalid column. Sharing is reported as
Slack-acknowledged, since these tools cannot independently inspect a recipient's
effective access. Native notification delivery is not verified or promised.

Writes are ordinary, non-replayed runtime tools. A content-free per-turn receipt
is committed before dispatch. An unknown result blocks further writes in that
request, even with changed arguments. Read the known List/item to reconcile;
do not repeat an uncertain creation. A new List whose response was lost before
its ID arrived cannot be discovered through these tools. Receipts expire with
their terminal turn; unresolved turns keep their receipts.

The attended learning probe in `qa/live/probes/slack-lists.ts` accepts only an
identified bot token, workspace, and synthetic fixtures. Keep its credentials,
receipts, native readbacks, and cleanup records private. Raw API success is
compatibility evidence; full acceptance also requires a real routed Agent request
and native Slack readback using `$chickpea-live-verification`.
