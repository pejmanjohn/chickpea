# Play With Tag

This is the smallest real Slack loop, driven by the Flue lane with `flue dev --target node`. The agent's model is selected from the runtime agent config first, then live provider credentials, then `SLACK_TAG_MODEL` as an offline/development fallback. For offline runs, point it at a local stub with `LOCAL_STUB_URL` and `SLACK_TAG_MODEL=local-stub/<model>`.

## 1. Create a Slack app

Create a Slack app at `https://api.slack.com/apps`.

Add bot scopes:

- `app_mentions:read`
- `chat:write`
- `assistant:write`
- `channels:history` (new for public-channel thread continuation and explicit top-level mention context)
- `channels:read` (required for Slack to deliver `member_joined_channel`, which drives the channel onboarding disclosure)
- `groups:history` (private-channel thread continuation and explicit mention context, when the bot is invited)
- `groups:read` (private-channel metadata, the private-channel counterpart to `channels:read`)
- `im:history` (new for direct-message replies and DM thread context)
- `users:read` (required by `scripts/verify-identity-live.mjs` to verify the bot name and avatar)

Enable Slack's Agents & AI Apps surface for the app when the workspace allows it. This makes Slack eligible to render Assistant status, working indicators, and message streams. Slack-owned visual chrome such as the purple app-name flash is not directly configurable by this codebase; verify the actual rendering in the Slack client after the app is configured.

Enable App Home messages for DM playtests:

- turn on the App Home Messages tab;
- allow users to send messages to the app.

In the manifest this is `features.app_home.messages_tab_enabled: true` and `features.app_home.messages_tab_read_only_enabled: false`. If the Slack DM composer says "Sending messages to this app has been turned off", this setting is missing or stale.

Do not install the app yet. Set the bot identity first, then install.

## 2. Set the bot identity

The Slack-visible name and description live in `slack-app-manifest.json`, not in
runtime config. Keep these fields aligned before installing:

- `display_information.name` — the app display name.
- `display_information.description` — the app description.
- `features.bot_user.display_name` — the bot-user display name users see on messages.

The avatar asset path lives in `src/config/identity.ts` and defaults to
`assets/bot-avatar.png`. Replace that PNG if you want a custom avatar; if you move
the file, update `avatarPath` in `src/config/identity.ts`.

In the Slack app console, open **Basic Information → Display Information**:

- set the app name to `display_information.name`;
- set the app description to `display_information.description`;
- upload `assets/bot-avatar.png` as the app icon.

Then open **App Home** and set the bot-user display name to
`features.bot_user.display_name`. This is a separate Slack field from the app name;
keep both names identical unless you intentionally want different app and message
labels.

Install the app to the workspace, then copy:

- Signing Secret
- Bot User OAuth Token

Run the identity verifier before continuing:

```bash
SLACK_BOT_TOKEN="<bot-token>" node scripts/verify-identity-live.mjs
```

## 3. Run the local server

```bash
export SLACK_SIGNING_SECRET="..."
export SLACK_BOT_TOKEN="<bot-token>"
export SLACK_BOT_USER_ID="U..." # optional; resolved via Slack auth.test if omitted
export TAG_ADMIN_TOKEN="<long-random-admin-token>" # optional; enables /admin/api/*
export SLACK_TAG_PUBLIC_URL="https://<your-tunnel-host>" # optional; enables Slack Configure links
# Default provider: the seeded Cloudflare Workers AI model.
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
# Or set the offline fallback model directly, for example:
# export SLACK_TAG_MODEL="anthropic/claude-haiku-4-5"
# export ANTHROPIC_API_KEY="..."
flue dev --target node --port 8789
```

`flue dev` is a long-running watch-mode dev server (default port 3583; `--port` overrides). It loads `.env` from the project root by default; pass `--env <path>` to select another env file, and shell-exported values always win. See the full env-var table in `README.md`.

By default, the durable transcript DB is `./tmp/flue.db` and the app-owned
state DB is `<TAG_DB_PATH>.state`; `flue.config.ts` ignores `tmp/**` during
watch mode, so SQLite writes and `-wal`/`-shm` sidecars do not reload the dev
server. Keep using `TAG_DB_PATH` and `SLACK_STATE_DB_PATH` when you want an
explicit self-hosted location, or `TAG_DB_PATH=:memory:` for ephemeral
offline/parity runs.

The server exposes:

- `POST /channels/slack/events` — the Slack Events endpoint.
- `POST /agents/slack-thread/:id` — the durable agent, gated by the shared internal token (`TAG_AGENT_API_TOKEN`); the channel makes this self-call, you do not call it directly.
- `/admin/api/*` — runtime agent and assignment CRUD, gated by `TAG_ADMIN_TOKEN`. If `TAG_ADMIN_TOKEN` is unset, `/admin/*` returns 404. Do not reuse `TAG_AGENT_API_TOKEN` for this surface.

After verifying the request signature, the Slack channel returns a fast HTTP acknowledgement and then runs the turn (context hydration, agent prompt, final delivery) as detached work, so Slack is acknowledged before the reply is produced.

## 4. Get Slack events to the local server

Two options. Option A is what production HTTP delivery looks like and is the
one to use for anything you want to claim as verified end-to-end behavior;
Option B is a development convenience when a public tunnel is unavailable or
unwanted.

### Option A — public tunnel (matches production delivery)

Use a tunnel, for example:

```bash
cloudflared tunnel --url http://localhost:8789
```

Set Slack Events Request URL to:

```text
https://<your-tunnel-host>/channels/slack/events
```

Slack should verify the URL challenge.

### Option B — Socket Mode bridge (dev only, no tunnel)

`scripts/slack-socket-bridge.mjs` opens a Socket Mode WebSocket to Slack,
receives the same Events API envelopes, re-signs each one with the signing
secret exactly as Slack's HTTP delivery would, and POSTs it to the local
server — which verifies the v0 signature and cannot tell the difference.

Setup (one-time, in the Slack app console — pause for operator confirmation):

1. **Socket Mode → Enable Socket Mode.** While enabled, Slack delivers events
   over the socket INSTEAD of the HTTP Request URL — flip it back off to
   return to tunnel/production delivery.
2. **Basic Information → App-Level Tokens → Generate** a token with the
   `connections:write` scope. Export it as `SLACK_APP_TOKEN` (an `xapp-`
   token; keep it in an ignored local env file, never committed).

Run it next to the server (reads `.env.slack.local` by default; shell values
win; pass `--env <path>` for another file; `PORT` selects the local target):

```bash
npm run slack:bridge          # or: node scripts/slack-socket-bridge.mjs --env .env.slack.local
```

Expect `bridge: connected, forwarding events to http://127.0.0.1:<port>/...`,
then one `bridge: forwarded event=… -> HTTP 200` line per event.

Known limits (why this is dev-only):

- One Socket Mode consumer at a time — a second bridge or another socket
  client steals events from the first.
- The bridge acks every envelope immediately, so Slack-side retry semantics
  are NOT exercised — test duplicate-retry behavior over HTTP (Option A) or
  with the offline verify scripts.
- `url_verification` challenges never happen over the socket, so the Request
  URL stays unverified until you use Option A.

Subscribe to bot event:

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.app_home`
- `member_joined_channel`
- `assistant_thread_started`
- `assistant_thread_context_changed`

The new `message.channels`, `message.im`, `message.app_home`, and `member_joined_channel` subscriptions require reinstalling the app after the events/scopes are added. Reinstall or reload Slack if the App Home Messages tab changes after the initial install. Pause for operator confirmation before changing live Slack app scopes, App Home DM settings, event subscriptions, or reinstall state. Adding `users:read` for identity verification also requires reinstalling the app.

`SLACK_BOT_USER_ID` is required before generic `message.*` events are admitted. If it is not configured, the Slack channel resolves it once on the first event via Slack `auth.test`. If that lookup fails, it falls closed: message events are still acknowledged, but runnable thread/DM turns are ignored with `missing_bot_user_id` so an app-authored Slack message cannot start a reply loop.

## 5. Try it in Slack

Invite the bot to a channel, then mention it:

```text
@Tag please use channel context and draft an exec summary
```

Expected behavior:

- immediate Assistant status such as `Tag Demo is checking context` where Slack renders Assistant status for the surface;
- one non-threaded channel onboarding message when the bot itself is invited, explaining that users mention the bot to start a thread, it reads the thread and bounded recent context only when asked, and there is no passive monitoring;
- transient safe loading/status text during approved tool work, such as channel-context gathering;
- no permanent progress lines such as `Gathering channel context` should remain in the thread after the final answer;
- streamed final reply from the assigned profile when Slack accepts the streaming APIs;
- fallback final threaded reply when status or streaming is unavailable;
- fallback final replies use Slack `markdown` blocks, so standard Markdown like `**bold**`, links, lists, blockquotes, tables, and fenced code should render instead of appearing literally;
- every final reply carries a footer with the profile name, resolved model label, and a `Configure` link when `SLACK_TAG_PUBLIC_URL` is set;
- duplicate Slack retries are acknowledged without duplicate posts;
- a mention in a channel with NO enabled assignment stays fail-closed — the channel gets nothing — but the mentioner alone receives one ephemeral hint (rate-limited per channel) linking to that channel's `/admin` page; set `SLACK_TAG_UNASSIGNED_HINT=false` to disable the hint entirely.

Response defaults in this slice:

- Channel starts still require an explicit `@Tag` mention.
- Once the bot has replied in a public channel thread during the current process lifetime, later human replies in that same Slack thread can continue the session without another mention when `SLACK_BOT_USER_ID` is configured.
- Direct messages and App Home messages respond without mention syntax when `SLACK_BOT_USER_ID` is configured.
- Top-level public-channel messages without a mention are acknowledged and ignored.
- Bot-authored messages, self messages, message subtypes such as edits/deletes, missing-user events, and empty messages are ignored before provider work.

Context defaults:

- Runnable channel-thread turns fetch active thread context with `conversations.replies`, capped to 50 human-authored messages and filtered to remove bot/system replies.
- Runnable root DM and App Home turns fetch bounded direct-conversation history with `conversations.history`; threaded DM/App Home replies fetch the active thread with `conversations.replies`.
- First-time mentions into an existing Slack thread use the same bounded thread read.
- Explicit top-level channel mentions fetch bounded same-channel history with `conversations.history`: `latest` is the mention timestamp, `limit` is 50, and `oldest` comes from a clear prompt window such as `today`, `yesterday`, `this week`, `last week`, `since Monday`, or `last 2 days`. If the prompt is vague, such as `what do you think?`, V1 uses the previous 24 hours.
- Mention-free channel-thread replies and ignored top-level non-mentions do not fetch broad channel history with `conversations.history`.
- The `lookup_channel_brief` tool returns the assigned channel's configured brief, composed from what `/admin` actually holds for it: the channel name, the assigned profile (name and description), and the channel instructions. The curated `T_DEMO` briefs in `src/config/seed.ts` remain as an extra leading layer for the offline fixtures only.

For a formatting smoke, mention the bot with a prompt like:

```text
@Tag channel context formatting smoke: reply with a short heading, **bold text**, a bullet list, a link, a blockquote, inline code, a fenced code block, and a tiny markdown table.
```

The checked-in seed data is the fresh-install starter config:

- app name: `Tag Demo`;
- provider: `workers-ai`;
- Workers AI model: `@cf/zai-org/glm-5.2`;
- starter profile: `agent_release_scribe` (`Release Scribe`), which leads with a summary table and includes a fenced code/diff snippet;
- starter profile: `agent_exec_brief` (`Exec Brief`), which uses bold-led bullets, closes with `Next steps`, and avoids code;
- direct-message default: `*/* -> agent_exec_brief` (the profile that answers DMs and App Home — it is NOT a channel catch-all; channels are fail-closed and the wildcard never applies to them).

Set `SLACK_TAG_PUBLIC_URL` to the same public base URL Slack can reach for this
server. Reply footers link to `/admin?agent=<id>` and channel onboarding links to
`/admin?channel=<channel-id>`; when it is unset, Slack shows `Configure` as a
plain label.

Runtime agent config and assignments live in the app state SQLite DB (`SLACK_STATE_DB_PATH`, defaulting to `<TAG_DB_PATH>.state`). On an empty DB, `src/config/seed.ts` is copied in once; after that, edit agents and assignments through `/admin/api/*`. New Slack thread agent initializations read the current store without restarting the server. Do not commit private workspace IDs, private channel names, tokens, or customer-specific channel briefs to public docs. Channels are fail-closed, so a fresh install does not answer in any channel until you assign your own channels in `/admin`; the `*/*` row only governs DMs. Set `SLACK_TAG_ALLOW_DMS=false` to disable direct messages entirely.

Model precedence for each agent is:

1. `agent.model` in the runtime config store.
2. The agent's Anthropic default when `ANTHROPIC_API_KEY` is present.
3. The agent's Workers AI default when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are present.
4. `SLACK_TAG_MODEL` as the offline/dev fallback.

## 6. Live verification checklist

After the operator confirms and applies the new scopes/events:

- Channel start: mention the bot in the playtest channel; expect Assistant status and exactly one final thread reply.
- Public thread continuation: reply in that same thread without mentioning the bot; expect exactly one bot reply in the same thread. This only proves process-local joined-thread memory; restart-durable continuation is not claimed.
- Thread visibility: tag the bot into a thread that already has earlier human messages; ask it to summarize or refer to those messages; expect the answer to reflect bounded thread context.
- Top-level mention visibility: post several recent channel messages, then top-level mention the bot with `what do you think?`; expect the answer to use recent bounded channel context. Repeat with `last 2 days` or `since Monday` to verify prompt-derived windows.
- DM/App Home: send the bot a DM or App Home message without mention syntax; expect exactly one reply in that conversation. If the composer says sending messages is turned off, enable writable App Home messages first.
- Top-level ambient negative: post a public-channel message without mentioning the bot; expect no bot reply.
- Loop negative: after the bot replies in a thread or DM, confirm its own Slack message event does not trigger a second provider call or reply.
- Duplicate safety: replay the same signed fixture locally and confirm only the first event posts.

Rollback: remove `message.channels`, `message.im`, and `message.app_home` subscriptions, or revoke the new `channels:history` and `im:history` scopes and reinstall the app. Existing `app_mention` behavior remains the conservative channel-start path.

## Safety Notes

- Do not paste Slack tokens into chat, docs, tests, or fixtures.
- Redact Signing Secret, Bot User OAuth Token, app-level tokens, and request headers before capturing screenshots or logs.
- Pause for confirmation before enabling Agents & AI Apps, adding OAuth scopes, changing event subscriptions, or reinstalling the Slack app.
- Keep `.env` and `.dev.vars` uncommitted.
- Keep `TAG_ADMIN_TOKEN` separate from `TAG_AGENT_API_TOKEN`; the admin API must fail closed when the admin token is unset.
- For offline work, drive the app through a local stub provider (`LOCAL_STUB_URL` + `SLACK_TAG_MODEL=local-stub/<model>`), as the `scripts/verify-*.mjs` evidence scripts do — no external network.
- Use a live provider (`cloudflare-workers-ai` via `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`, or `anthropic` via `ANTHROPIC_API_KEY`) only from an ignored local env file.
- If a Cloudflare API token gets `401` from Workers AI, it lacks the Workers AI permission. Mint a dashboard API token (My Profile → API Tokens) that includes Workers AI, and store it only in ignored local env files. `npx wrangler auth token` does NOT work for this — verified 2026-07-02: wrangler's OAuth token gets 401 on both `/ai/run/*` and `/ai/v1/chat/completions`.
- Treat Slack formatting as an adapter contract: providers should emit concise standard Markdown, and `src/slack/message-format.ts` decides how to post it to Slack.
- Treat Slack history as per-turn ephemeral provider context in this prototype. Do not persist raw Slack messages beyond existing telemetry/degradation metadata.
- Duplicate suppression, runtime agent config, assignments, and mention-free channel-thread continuation are restart-durable on a single host (SQLite-backed app state, `SLACK_STATE_DB_PATH`). Multi-instance or serverless-horizontal deployments still need a shared store and single-owner routing per agent instance before those guarantees are production-grade.
