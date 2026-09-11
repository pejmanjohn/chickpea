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
When native progress is already visible, retire it before publishing the
combined file reply; preserve uncertainty if that cleanup cannot be confirmed.

Validate both layers: deterministic tests for protocol, concurrency, replay,
and destination binding; real-model cases for contextual requests, prohibitions,
and quoted instructions. A parser test that allows a tool does not prove the
Agent chooses correctly. Upload support also does not prove image-generation
or editing support: verify the actual renderer and source-asset access before
claiming an image was generated or a logo was preserved.

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
