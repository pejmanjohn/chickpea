# Slack message identity and attachment verification

Use this guide before changing Slack senders, avatars, file delivery, streaming,
message updates, or attribution footers. A selected Agent's identity is a
presentation contract that must survive the actual delivery path and a fresh
client load. An API success response cannot establish that contract.

## Check four separate surfaces

| Surface | What to verify | What it does not prove |
| --- | --- | --- |
| Message sender | Selected Agent name and avatar above the exact reply | File ownership or attachment access |
| File owner | Uploading identity on the native file card or file details | Which Agent authored the message |
| Footer | Correct Agent, model, Configure destination or Scheduled attribution; one compact context block | Sender identity |
| Attachment | File preview/card inside that reply, correct content, recipient access | Delivery under the selected Agent |

Files uploaded with an installation's bot token belong to that bot. Per-message
customization does not change file ownership. A bot-name caption on a file can
coexist with the correct Agent sender. Never rename the global bot profile to
fix one Agent's message: other Agents share that installation.

## Steering replies and the stop note

Stopping a run and checking on it (see [Slack steering](slack-steering.md))
add two senders:

| Message | Sender | Delivery path | Who sees it |
| --- | --- | --- | --- |
| Stop note | The thread's Agent, with its footer | The final-reply path. An open stream is sealed with the note after its partial answer, through `chat.stopStream` with `chunks` and the footer `blocks`, never `chat.update`. When Slack already halted the stream (its Stop button does), the partial answer stays and the note posts once as a fresh customized threaded reply. Otherwise it posts like any final. | Everyone in the thread |
| Chickpea's steering replies: check-in answers, `You can't stop this run.`, `This run had already finished…`, and the direct-message hints | The installation's bot, with no Agent persona and no footer | `chat.postEphemeral` with `thread_ts` in channels and group DMs; a threaded `chat.postMessage` in a one-to-one DM | Only the person it answers |

Verify the stop note's sender, avatar and footer on the exact message, with
API readback and fresh desktop and real phone views, for both a sealed stream
and a halted one. An ephemeral reply has no readback: `conversations.replies`
never returns it. Check it as the asker and confirm a second person in the
thread does not see it.

## An Agent with its own Slack app

An Owner can give one Agent its own Slack app in the customer's workspace.
The Agent then answers its direct messages, mentions of its bot, and clicks on
its own messages as that bot. Its replies post with the app's bot token under
the app's name and icon, with no `username` or `icon_url`: the app does not
ask for `chat:write.customize`. Files it uploads belong to its bot. When the
app is broken, the Agent's turn ends unavailable; it never falls back to
Chickpea's bot. Other Agents ask it by its bot user (`<@U…>`) instead of a user
group. Code lives in `src/slack/agent-apps/`.

### How it is turned on

Core serves the feature only when its host installs the port with
`configureAgentSlackApps` (`src/slack/agent-apps/host.ts`). Core never
installs it. A self-hosted install, direct or gateway, shows no control for it,
answers 404 on `/channels/slack/agent-apps/*` and on the Admin token page and
its API, and never reads an Agent app's secrets. The hosting service installs
the port on its staging deployment only, behind its own staging-only switch.

### What the Owner does

1. On the Agent's row in Chickpea's App Home, the Owner chooses **Give @handle
   its own Slack app**. Only Owners see the row.
2. The first time in a workspace, the button opens the Owner-only page
   `/admin/agents/<agentId>/slack-app`. In Slack, the Owner opens Your Apps,
   chooses Generate Token under Your App Configuration Tokens, picks the
   workspace, and pastes the Refresh Token. Chickpea rotates it once, refuses an
   access token or another workspace's token, and stores the new pair
   encrypted. Later Agents need only the click.
3. Chickpea disables the Agent's user group so the handle is free, creates the
   app without request URLs, records it, stores its secrets, adds the request
   URLs, sets the icon, and messages the Owner with **Allow** in Slack.
4. Allow opens Slack's consent screen; the link it starts is good for 15
   minutes. Chickpea exchanges the code with the app's own credentials. It
   undoes a grant from another person, workspace or app, or one missing a
   permission. A good grant makes the app live and sends the Owner to the
   Agent's messages.
5. A refused step messages the Owner with **Try again**. A sequence that
   stopped for two minutes shows **Finish setting up** in App Home. An unknown
   answer to the create call never retries by itself: the Owner deletes any
   app they do not recognize in Your Apps, then chooses Try again.

### Archive, uninstall, and tenant end

- Archiving the Agent uninstalls its app, deletes the app with the
  configuration token, and gives the handle back to the Agent's user group,
  disabled. Restoring the Agent brings the handle back. When Slack refuses the
  uninstall, the archive is refused too. Without a stored token, the app's
  definition stays and the Owner is told to delete it in Your Apps.
- When someone removes the app in Slack (`app_uninstalled`, or
  `tokens_revoked` naming its bot), only that Agent's app ends: its bot token
  is dropped and the Owner is told, and Allow adds it back. The workspace's
  installation and other Agents are unchanged.
- When a tenant ends, the host retires every Agent app before the workspace's
  own uninstall and records each outcome.

### The configuration token's limits

- Slack lets each person hold one configuration token per workspace. An Owner
  who builds their own Slack apps in that workspace should not paste it: their
  tools and Chickpea would keep replacing each other's token. Another Owner
  should do this step.
- The token can manage every app its person created in the workspace.
  Chickpea changes only the apps it creates for Agents.
- Chickpea cannot revoke the token: revoking the access token leaves the
  refresh token working. **Remove the configuration token** on the token page
  deletes Chickpea's copy only, and the Owner then deletes the token under Your
  App Configuration Tokens. Agent apps already created keep working; archiving
  one later leaves its definition for the Owner.
- When the stored refresh token is spent, the sequence stops and the Owner is
  asked to paste a new one.

## Verified protocol findings

These are observations from a controlled comparison on September 10, 2026 using
one installed bot, fixed synthetic CSV/PNG fixtures, and a selected Agent persona.
They establish protocol feasibility for the tested payloads, not a completed
production rollout or a guarantee about every Slack client/version.

| Method shape | Observed result |
| --- | --- |
| Native file completion that also publishes the answer | Attachment and answer appeared together, but desktop showed the installation's bot while mobile showed the selected Agent. |
| Ordinary customized post, followed by a plain update | Same reply retained the selected Agent, answer, and footer. |
| Private file completion, then a customized `chat.postMessage` containing the returned Slack permalink with unfurls enabled | CSV and PNG each appeared as a real attachment in one reply under the selected Agent. Web, desktop after full reload, and real phone screenshots agreed. The file-owner caption still named the bot. |
| Customized post followed by `chat.update` with only `channel`, `ts`, and `file_ids` | API returned success and file metadata recorded a share at that reply, but the tested UI displayed no attachment. Answer blocks remained while top-level fallback `text` became empty. |
| Customized stopped stream followed by that same file-ID update | Same missing-attachment result. Streaming did not fix it. |
| Customized post with an image block using `slack_file: { id }` | Chart rendered inside the Agent message on desktop and web. This establishes an image path, not generic file support. |

The follow-up protocol session also passed with CSV and PNG together in each
message, labeled `<permalink|filename>` links, and the production gateway's
ordinary-post serializer. It covered a channel thread, a DM thread, and a
top-level channel message with the Scheduled footer. Every case used classic
section blocks followed by one context footer, with both `unfurl_links` and
`unfurl_media` explicitly true. Fresh desktop, web, and real phone views agreed.
The signed-in recipient opened both files in web for each case; the phone
screenshots established presentation, not phone download behavior.

Prefer that tested shape for general file delivery. After implementation, a
separate deployed QA run on the same day verified actual Agent generation in a
channel thread and a DM thread, ten files in one reply, a mention-free follow-up,
and an honest missing-file response. Two actual one-time schedules delivered
CSV and PNG together, one at the channel root and one in the saved request
thread. Fresh desktop and signed-in web readbacks preserved the selected Agent
and the appropriate footer; the recipient opened the CSV and PNG files. Both
test schedules completed once and were removed afterward.

The real-phone evidence above belongs to the fixed protocol finalists. Do not
describe it as a phone test of every subsequent Agent-generated result. Likewise,
the top-level protocol message did not execute a schedule. Keep protocol and
Agent acceptance records separate, even when they establish the same method
shape. Do not implement an attachment-update architecture solely because Slack
accepted `file_ids`.

### A stream's mode is fixed when it starts

Verified on Cobalt on September 22, 2026 with exact-message
`conversations.replies` readback after each stop:

| Stream start | Terminal `chat.stopStream` | Result |
| --- | --- | --- |
| `markdown_text` | `chunks` (answer suffix) plus footer `blocks` | Rejected with `streaming_mode_mismatch`; nothing applied, and the reply stays at its streamed prefix |
| `chunks` (task card only) | `chunks` with a 10 KB markdown suffix and task update, plus footer `blocks` | Whole answer, task card, and footer stored; `streaming_state: completed` |
| `chunks` | `appendStream` chunks in three pieces, then `chunks` (task) plus `blocks` | Whole answer and footer stored |

Every stream, progressive append, and terminal stop therefore uses `chunks`.
Slack documents `blocks` as rendering after `chunks` on stop, and that held.
A stream opened in `markdown_text` mode by an earlier build still finalizes
through the existing recovery path: the rejected stop marks the stream
unknown, and the retry stops it without chunks and replaces the whole message
with `chat.update`. That replacement renders a bold title as plain text, and
it failed on retry for a 12,000-character answer. Treat it as recovery, not
the normal terminal path.

`chat.update` refused a first message of about 12,000 characters with
`msg_too_long` (Amber, September 25, 2026), although the same size posts or
streams. Its documented limit is 4,000 characters of `text`. Recovery
therefore keeps the replacement's first message within 4,000 characters,
ending at a boundary, and moves the rest of the answer to follow-up messages
(up to four after a recovery). The streamed prefix stays whole in it when it
fits. If Slack still refuses the replacement with a definite content error
(`msg_too_long`, `invalid_blocks`), recovery deletes the partial stream
message and posts the final fresh once. When a run's attempts are exhausted
and its failure notice cannot finish through the stuck presentation, the
notice posts fresh with a `client_msg_id` fixed per Run. The exact
`chat.update` threshold (text versus blocks) has not been measured.

A divergent-stream correction is the other `chat.update` replacement: when a
reattached attempt's final no longer starts with the streamed prefix (for
example, the model call re-ran after the isolate was lost), the stream is
stopped and its message replaced with the answer and a `_Corrected_` marker.
It uses the same bound and split as recovery, with room for the marker, and
the same fresh-post fallback on a definite content error.

### Message size is text plus a cost per header block

Measured on Violet on September 26, 2026 with direct `chat.postMessage`
probes (a `markdown` block, owner token) and one streamed reply:

| Probe | Result |
| --- | --- |
| One paragraph of 5,000 to 11,900 characters | Accepted (one `rich_text` block) |
| 20 header blocks plus prose | Largest accepted prose 10,563; refused from 10,625 (`msg_blocks_too_long`) |
| 40 header blocks plus prose | Largest accepted prose 7,875; refused from 7,954 |
| 49 headers plus a paragraph (50 blocks), or 50 headers | Accepted |
| 51, 60 or 100 header blocks | `invalid_blocks` |
| `chat.appendStream` | Accepted up to 62 rendered blocks; a later append refused at 61 headers plus 7,134 rendered characters |

A two-point fit gives: rendered characters plus about 100 per header block
must stay under about 13,200. The stream refusal fits the same bound.
Per-block overhead of code fences, tables, dividers and `rich_text` runs was
not measured.

Chickpea sizes every reply part and the streamed first message by that
shape: escaped characters (`&`, `<`, `>` count as their entities) plus 100
per header block, under the 12,000 markdown limit, and at most 40 rendered
blocks. The 40-block bound leaves room for the footer and a table, and keeps
the first message correctable with `chat.update`, which refuses more than 50
blocks. A continuation plan frozen before the header cost was counted
recomputes its first message without it, so it still ends where its stored
follow-ups begin.

### Streaming pace across concurrent threads

Slack rates `chat.appendStream` Tier 4 ("100+ per minute"). Tier limits count
per method, per workspace, per app, not per channel. Chickpea books append
slots per workspace in `slack_workspace_append_slots`: 100 a minute (one slot
every 600 ms) with a burst of 10. A stream books the next free slot in
arrival order and waits for it; it never stops streaming because the budget
is busy. While it waits, the text that arrives joins its next append, so many
concurrent streams append less often (about every N x 600 ms for N busy
streams) instead of freezing. Text that is not streamable yet (an unfinished
table row, an open link on the last line) keeps its slot for the next chunk
rather than booking another.

One append waits at most about 40 seconds: up to 20 seconds asking for a
slot, then a slot booked up to 20 seconds ahead. A slot further away is not
booked; that text waits for the stream's next chunk or the terminal. That
happens only past about 43 continuously busy streams in one workspace. A
reader that closes stops waiting within a second, so the terminal is never
held.

A Slack `ratelimited` answer sets a workspace cooldown. No slot is booked
inside it, and a stream whose slot came due during it checks again and waits
it out. The `Slack presentation finalized` record carries `appendBudget`
counts (deferrals, time waited, appends left to the terminal, and
`rateLimited` answers) whenever one of them is not zero.

Rollback and rollout: builds before this change used a one-token row per
workspace in `slack_workspace_append_budgets`. The booking no longer touches
that row except to copy a Slack cooldown into it, so a rollback streams as
before. While a rollout is in progress, an earlier Worker isolate calling a
newer state object receives `scheduled`, which it treats as a spent budget:
that one stream stops appending until its final, as before the change. A
continuation plan frozen with `headerOverhead` and then finalized by an
earlier build recomputes its first message without the header cost; for a
header-dense answer, that first message can end away from where the stored
follow-ups begin (rollback only).

### What streams before the answer ends

Each rewrite `canonicalSlackMarkdownText` makes stays on one line, reading
lines as redaction leaves them:

- Link sanitizing pairs `**` within a line, and it reads code the way
  mention neutralization does: a fence that has not closed runs to the end.
- No credential signature except PEM armor crosses a line break. An
  assignment's value sits on its name's line, so `NAME=` with the value on
  the next line redacts nothing unless the value matches a signature of its
  own.
- Mention neutralization pairs inline code and `<…>` within a line.

PEM armor goes with its line breaks, so the text around a block reads as one
line, and a block that has not closed runs to the end. So a line cannot
change once it ends, and `streamableSlackMarkdownPrefix` streams two things:

- Every complete line.
- On the line still being written, complete words (each ended by a space)
  before its first markup that has not closed and before any credential
  marker. Markup is `*`, a backtick, `<`, `[` or `|`.

Three kinds of markup count as closed: bold the link sanitizer keeps, a
closed inline code span, and a complete link. A `**URL**` span does not,
because the answer drops its stars.

The last word waits for the space or line break that ends it: `sk` may
still become `sk-proj-…`. A line with an open link, table row, `<…>`
reference or italic streams when it ends. An emphasis or link label that
continues onto a later line streams its opening literally until it closes;
whether Slack re-renders it when it closes is still to be confirmed live.

The function scans the text once per chunk, with no pass limit and no
give-up.

A safe prefix that no longer extends what Slack shows freezes the stream.
Only a formatter change between builds can cause that. Finalization then
continues the stream, or corrects it with `_Corrected_`. A correction logs
how many bytes had streamed and whether the answer redacts a credential
inside them.

### Broadcast and user-group mentions

Model-written text never notifies a channel, its active members, the
workspace, or a user group. Slack's documentation (read September 26, 2026)
covers only some of the paths a reply takes:

| Path | Used for | Documented behavior |
| --- | --- | --- |
| `markdown` block | Every final answer | Silent on mentions (observed below) |
| Streamed `markdown_text` chunk | Progressive and final streams | Silent on mentions (observed below) |
| mrkdwn section text | File replies, routine file deliveries, legacy work-checklist messages | Parses `<!here>`, `<!channel>`, `<!everyone>`, `<!subteam^ID>`; with the default `verbatim: false` it also auto-parses a plain `@here` and user-group handles |
| Top-level `text` | Fallback and notification text | Parses `<!here>` syntax; a plain `@here` only with `link_names=1`, which Chickpea never sets |

Every path is treated as parsing everything, so
`canonicalSlackMarkdownText` neutralizes every answer last, after link
sanitizing and credential redaction. `neutralizeSlackBroadcastMentions` in
`src/slack/message-format.ts` rewrites:

- `<!here>`, `<!channel>`, `<!everyone>` and `<!group>` in prose as
  `@here`-style words, and `<!subteam^ID|@ops>` as `@ops` (a bare ID reads
  `@user-group`). A U+2060 word joiner follows every `@`, and plain
  `@here`/`@channel`/`@everyone` get one too.
- The same tokens in code keep their characters with the joiner after `<`, so
  they read `<!here>` but no parser sees a special mention.
- File-reply mrkdwn gives every word-initial `@handle` in prose the joiner,
  because mrkdwn auto-parses user-group handles. Plain broadcast words in code
  there get it too, since Slack does not say whether auto-parsing skips code.
- An `_` run beside the word is emphasis, not part of it: `__@here__` and
  `_@here_` get the joiner, while `@channel_news` and `ops_@example.com` stay
  exact. In file-reply mrkdwn an `@` directly before markup (`@[here](…)`,
  `@**here**`), and a link label or image alt text ending in `@`, get it too,
  so markup cannot join an `@` to the next word. These forms were not probed;
  they follow the documented mrkdwn auto-parsing.
- The work-checklist and milestone-plan message renderers pass labels and
  details through `escapeMrkdwn`, so a classifier-written `@here` or `@handle`
  gets the joiner in both the mrkdwn section and the top-level `text`. Current
  turns only re-render checklist messages that older builds posted; new turns
  show these labels on the native task card (`task_update` chunks), which has
  not been probed for mention parsing.

One exception is deliberate: a reply may mention the Agents that work in its
Channel. For the handles of those teammates only, a plain `@handle` in prose
is delivered as a live `<!subteam^ID|@handle>`. Agent handles are zero-member
user groups, so the mention notifies nobody; it renders as a mention and asks
that Agent (see [Agent conversations](agent-conversations.md)). A user-group
mention the model wrote or copied, such as `<!subteam^ID>` quoted from a
Slack message, stays inert and reads as `@handle`, so quoting a message asks
nobody. Only the exact live form this renderer writes stays live when a reply
renders again. The thread record and an asked Agent's ask keep a delivered
reply as Slack returns it, with `<!subteam^ID>` and no label, so a model
never reads the live form. The built-in Chickpea asks
nobody, so every handle in its reply stays inert. Every other user group stays
inert, and code keeps its literal characters. A handle word changes only once
it is complete, so streamed prefixes stay prefixes of the final text.

User mentions (`<@U…>`), Channel links, `<!date^…>`, `<!DOCTYPE …>`, CDATA and
email addresses are unchanged. Streaming shows a word only once nothing
later can change how it neutralizes: a `<`, or a backtick that has not
closed, holds the rest of its line, and an `@` word waits for the space that
ends it (see [What streams before the answer ends](#what-streams-before-the-answer-ends)).
So each streamed prefix is a prefix of the neutralized final.

A stream opened by an earlier build that already showed a raw mention diverges
from the new final; the divergent-stream correction replaces it.

Protocol probe on Violet, September 26, 2026: a temporary probe build posted
synthetic text as the lane bot into the QA test user's DM, read each message
back with `conversations.replies`, and deleted all three. Stored results:

| Input | `markdown` block | `chunks` stream (start, append, stop) | mrkdwn section |
| --- | --- | --- | --- |
| `<!here>`, `<!channel>` in prose | `broadcast` element (live) | `broadcast` element (live) | Not sent raw |
| Plain `@here`, `@channel` in prose | Text | Text | `@here` rewritten to `<!here>` (live) |
| `<!here>` or `@here` in inline code or a fence | Code text | Code text | `` `@here` `` rewritten to `` `<!here>` `` |
| `<@U…>` | `user` element | `user` element | Not sent |
| `@⁠here`, `<⁠!here>` (joiner) | Text | Text | Text |

Slack therefore parses special mentions in markdown blocks and streams even
though the documentation is silent, which is what the neutralization closes.
The mrkdwn rewrite inside backticks is why file-reply code also gets the
joiner. The Agent had no memberless user group, so `<!subteam^ID>` and plain
user-group handles were not probed; they stay neutralized on the documented
mrkdwn behavior. This is protocol evidence, not Agent acceptance: no real
Agent reply containing a mention was graded.

### Public message readback is a projection

In the tested permalink replies, `conversations.replies` omitted `username`,
`icons`, and `subtype`, even though fresh desktop/web and mobile displayed the
selected Agent correctly. The native-completion controls omitted those same
fields but displayed the wrong sender on desktop. Missing public API fields
therefore did **not** establish that Slack had discarded all identity state.

Conversely, visible identity in a cached client does not prove durable identity.
Retain both the raw API evidence and the fresh client observations. When they
differ, report the difference; do not invent a storage or rendering explanation.

A bot-authored message can also omit `user`. For readback ownership checks, use
the installation's `auth.test` identity and verified `app_id`/`bot_id` as
appropriate; reject conflicting identity fields. Do not weaken file ownership
checks or accept an arbitrary bot simply because a message lacks `user`.

## Run a controlled comparison before rewriting delivery

1. Resolve the exact app/workspace, bot identity, recipient, destination, serving
   versions, and capabilities. An Admin login or read-only QA credential is not
   a bot write credential. Do not discover missing write/read methods after
   beginning the experiment.
2. Freeze a small matrix and fixed fixtures. Include a known-good sender control,
   a plain update, the actual streaming path, and candidate file paths. A normal
   looking reply is not evidence of which API produced it.
3. Keep the installed bot, persona, answer, and footer constant. Use a fresh file
   for each variant; prior shares can mask private-completion and access defects.
   Run the matrix on one frozen build without model calls or deployments between
   variants. Use a local Worker lane when suitable; gateway-specific behavior
   needs the actual gateway path.
4. For mutations, capture the same message before and after: exact request,
   response, subsequent message/file readback, and UI. Inspect full thread
   cardinality as well as the selected reply. Do not compare screenshots of
   different attempts as if they were one message.
5. Compare desktop app, a newly loaded web page, and the same permalink on a real
   phone for finalists. Reopening a thread in an already loaded client may reuse
   cached state. An emulated mobile viewport is not the mobile Slack app.
6. Choose the simplest path satisfying the whole contract, then validate it with
   multiple files, DM/thread/root destinations, and the scheduled footer. Test
   preview/download as the recipient; bot-side `files.info` alone is insufficient.
7. Only then implement and run one coordinated review/checkpoint plus real Agent
   acceptance. Include scheduled execution when changing scheduled delivery.
   Protocol probes, local mocks, uploaded versions, and routed Agent replies are
   different levels of evidence.

The fixed probe's attempt/observation budgets limit QA activity. They do not
justify introducing arbitrary execution time limits into production code.

## Capture evidence at each boundary

Keep credential-free request fields, serialization/content type, SDK version,
API result/error, request ID, channel/thread/reply timestamps, and file IDs.
Record identity fields, `text`, blocks, footer, file metadata and share
coordinates separately. Preserve the first failure before changing code or
retrying. Keep credentials, target coordinates, raw transcripts, screenshots,
and operator journals outside the public repository.

Check these boundaries independently:

- Tool arguments can be accepted by a type cast while an SDK helper drops them.
  Inspect the helper and the actual wire payload.
- A gateway can reject fields that Slack supports, require an otherwise optional
  destination, or use a different encoding. Exercise the production serializer;
  direct native API success does not prove the adapter.
- Upload bytes, private completion, recipient sharing, and visible presentation
  are distinct steps. Private completion must omit the destination. Never treat
  a completion intended to share publicly as a harmless staging operation.
- A share recorded at the correct timestamp does not necessarily create a
  visible file card; the file-ID experiments demonstrated that difference.
- Blocks and fallback `text` can diverge. Verify accessibility/notification text,
  exact filenames, code literals, long answers, tables, and the compact footer.
- Verify that a link fixture remains an active link after formatting. The
  ten-file Agent test rendered all ten file cards, but its model-written
  `<https://example.com|label>` reference appeared literally because the classic
  prose formatter escapes Slack control syntax. That test does not prove ten
  files alongside an active external link. Use a descriptive standard Markdown
  link for that variant, assert its actual `href`, and distinguish link access
  from preview generation. Do not infer a shared file/preview limit from the
  number of rendered cards alone.
- Permalinks can use a workspace subdomain. Validate Slack-owned URL structure
  and file identity without assuming the host is literally `slack.com`.
- Replay retained real response samples through offline validators. A mocked
  response can repeat the same wrong hostname assumption as the validator.
  Repairing a local evidence parser does not require repeating a completed
  Slack mutation; preserve and re-evaluate its original response.

For ambiguous completion or posting outcomes, persist the intent and reconcile
with readback. Do not post another message to learn whether the first succeeded.
An explicitly rejected action and an unknown outcome require different handling.
Retain existing persisted receipts during migrations and bind new file receipts
to the exact workspace, Agent, channel, and thread.

## Intent belongs to the Agent; delivery constraints belong to the host

Treat returning a file in the current reply like returning text. The Agent
interprets the current request in conversation, including revisions, typos,
other languages, and explicit requests to avoid attachments. Do not classify
that intent with verb/noun lists or add a second model call just to authorize
an attachment. A request such as "try generating a new ad" must not require
the word "attach"; "create a PNG but do not attach it" must not become permission
merely because it contains those words.

The host validates the current signal and enforces the mounted capabilities,
actor, destination, file limits, and durable delivery receipts. Quoted text,
attachment contents, tool output, and historical requests are context rather
than independent instructions. A legacy `explicitArtifactDeliveryIntent`
boolean is accepted only when reading old envelopes and is discarded.

Decide streaming from actual tool activity. A file-tool attempt excludes a
later streaming declaration, including after durable resume. If a file tool
starts while a declaration is pending, the declaration cannot acknowledge
success. A completed answer-only declaration still prevents later tool work.
Agents with connections or repositories get the final-answer form: they may
declare only after their last tool has settled, alone in that model step, and
only the following step's text streams. A declaration after a memory update or
workspace change is refused because the host can replace that draft at
delivery. Container Agents stay terminal-only while the Worker can replace
their draft.
When native progress is already visible, retire it before publishing the
combined file reply; preserve uncertainty if that cleanup cannot be confirmed.

Validate both layers: deterministic tests for protocol, concurrency, replay,
and destination binding; real-model cases for contextual requests, prohibitions,
and quoted instructions. A parser test that allows a tool does not prove the
Agent chooses correctly. Upload support also does not prove image-generation
or editing support: verify the actual renderer and source-asset access before
claiming an image was generated or a logo was preserved.

Image honesty follows the workspace's resolved image role, and the model-facing
wording comes from one builder, `buildArtifactToolsInstruction` in
`src/sandbox/artifact-tool.ts`, which every lane that mounts the artifact tools
renders. With no image model configured, the Agent says so first, points Owners
at Settings → Model providers (Default image model), offers only what it can
actually produce — an SVG mockup or copy — and never calls an SVG
a finished or edited image. With an image model configured, the Agent addresses
images already in the conversation by their per-turn `img:N` handles and never
by filename, link, or Slack file id; it calls the image tool at most once per
response and before any streamed-answer declaration; it reports the model the
result names rather than the model it assumed; and when the resolved model
cannot take image input it says it can generate but not edit before offering
generation. Every `attached: false` reason is stated as returned, an
unreadable thread image asks for a re-upload, and no failure is ever described
as an attached, generated, or edited image.

## Related implementation and verification guidance

Start with `src/slack/file-transport.ts`, `artifact-staging.ts`,
`artifact-receipts.ts`, `web-client-presenter.ts`, `agent-view-presentation.ts`,
and `src/routines/delivery.ts`. Inspect current source: these entrypoints can
change. Current receipt-based delivery privately completes files before posting
their validated permalinks in the selected Agent's final message. Persisted
legacy receipts and legacy assembly paths have separate compatibility behavior;
do not infer their behavior from the current path's acceptance.

Follow [runtime observability](runtime-observability.md) for first-failure
evidence and [the live verification workflow](../../qa/live/operator/SKILL.md)
for lane ownership, permissions, attended records, and exact cleanup.

Slack documents [private upload followed by permalink sharing](https://docs.slack.dev/tools/python-slack-sdk/tutorial/uploading-files/#sharing-a-file-within-a-channel),
[message customization and unfurls](https://docs.slack.dev/reference/methods/chat.postMessage/),
and [message update behavior](https://docs.slack.dev/reference/methods/chat.update/).
Use those contracts to design experiments; they do not replace client acceptance.
