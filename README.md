# Tag Team

Tag Team is a self-hosted, model-agnostic AI agent for Slack. It answers
`@`-mentions, threaded replies, and DMs in Slack: it verifies
the request signature, normalizes the event into a runnable turn, hydrates bounded
channel/thread context, and drives a durable
[Flue](https://www.npmjs.com/package/@flue/runtime) agent that streams a final reply
back into the thread. Per-channel assignments map a workspace + channel to a named
profile (instructions, model, allowed tools); an assignment-scoped
`lookup_channel_brief` tool is exposed to profiles that opt in. The Slack-visible
identity is still one install-wide bot; profile names appear in reply footers so
users can see which profile answered.

The product runs entirely on the **Flue lane**. The earlier hand-rolled harness has
been deleted; the behavior it encoded is preserved by a lane-agnostic parity suite
(`tests/parity/`) that now runs against the real Flue app (Lane B, 31 scenarios).

## Deploy on Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pejmanjohn/tag-team)

The fastest way to run Tag Team is your own Cloudflare account:

1. **Click the button.** Cloudflare clones this repo into your GitHub, provisions
   the Durable Objects, and prompts for one secret: `TAG_ADMIN_TOKEN` (generate it
   with `openssl rand -hex 32`).
2. **Log in.** Open `https://tag-team.<your-account>.workers.dev/admin?token=<your
   TAG_ADMIN_TOKEN>` — that sets the session cookie and strips the token from the
   URL. (Opening `/admin` without a valid session shows a token-entry form that
   does the same thing.)
3. **Click "Create your Slack app".** The first-run wizard deep-links Slack's app
   console with this repo's manifest, the events request URL already pointing at
   your worker. Install the app to your workspace. If Slack shows the request URL
   as unverified, click **Retry** on the app's Event Subscriptions page — the
   worker echoes the verification challenge even before you save credentials.
4. **Paste back the bot token and signing secret.** The wizard validates the token
   live (`auth.test`) and stores both in the worker's Durable Object state; env
   secrets (`wrangler secret put`) always take precedence if you set them later.

The first mention answers with **zero model keys**: on the Cloudflare target the
default model resolves to `@cf/zai-org/glm-5.2` through the Workers AI binding.
Add an `ANTHROPIC_API_KEY` secret to upgrade the default to Claude.

Pinned or default non-catalog `cloudflare/*` models (including the keyless
`@cf/zai-org/glm-5.2`) resolve through the binding with **no declared context
window**, so Flue's threshold auto-compaction is disabled and long DM transcripts
grow unbounded. Set `ANTHROPIC_API_KEY` (or pin a catalog model) for a bounded,
auto-compacting context.

Free-plan honesty: Workers AI allows ~10K Neurons/day and Durable Objects 100K row
writes/day — both are **hard errors** once exceeded, so a busy workspace needs a
paid plan (or an `ANTHROPIC_API_KEY`, which moves model spend off Workers AI).

Manual CLI path (same artifact the button deploys):

```bash
npm run flue:build:cf                    # flue build --target cloudflare -> dist-cf/ (parks src/db.ts)
npx wrangler deploy                      # picks up dist-cf via .wrangler/deploy/config.json
npx wrangler secret put TAG_ADMIN_TOKEN
```

Local Cloudflare dev loop:

```bash
npm run flue:build:cf
npx wrangler dev --config dist-cf/tag_team/wrangler.json --persist-to .wrangler-state
```

Keep `--persist-to` outside `dist-cf/` (as above): the build output is disposable
and a rebuild would otherwise wipe your local Durable Object state. Local dev
secrets live in a `.dev.vars` file next to the built `wrangler.json`
(`dist-cf/tag_team/.dev.vars`); `.dev.vars.example` documents the two that matter.
`npm run flue:build:cf` snapshots and restores that `.dev.vars` across rebuilds,
so re-running the build never deletes your local secrets.

## Architecture

- `src/app.ts` — Flue app entry: registers providers (`cloudflare-workers-ai`,
  optional `anthropic`, optional offline `local-stub`), mounts the fail-closed
  admin API, then mounts the Flue router.
- `src/channels/slack.ts` — Slack channel (`POST /channels/slack/events`): admission,
  duplicate-claiming, context hydration, and the in-process dispatch that drives the
  agent (`src/slack/agent-dispatch.ts`).
- `src/agents/slack-thread.ts` — durable agent (`POST /agents/slack-thread/:id`),
  gated by a shared internal token; resolves the assignment's model + tools.
- `src/slack/` — shared, lane-agnostic Slack modules kept verbatim from the contract:
  turn normalization, thread keys, context hydration/formatting, message rendering,
  presentation, claim store, credential resolution, internal auth.
- `src/admin/routes.ts` — token-gated runtime config CRUD API under `/admin/api/*`,
  including the first-run Slack-connection wizard endpoints.
- `src/config/` — seeded agents, assignments, channel briefs, assignment resolver,
  and the target-neutral state stores (SQLite on Node, a Durable Object on
  Cloudflare, selected by `src/config/state-backend.ts`).
- `src/cloudflare.ts` — the `TagStateStore` Durable Object hosting all app state on
  the Cloudflare target (config, snapshots, claims, thread registry, settings).
- `src/db.ts` — file-backed SQLite for the durable agent transcript (Node target;
  parked automatically during Cloudflare builds).

## Quickstart

Requires Node >= 22.19 (see `.nvmrc`).

```bash
# Populate .env (loaded automatically by flue dev/build), then:
flue dev --target node        # long-running dev server, default port 3583
```

Expose the port with a tunnel and point Slack's Events Request URL at
`https://<tunnel-host>/channels/slack/events`. See `docs/play-slack.md` for the full
real-Slack setup (scopes, event subscriptions, App Home, and the live checklist).

Bot identity is configured before install: `slack-app-manifest.json` owns the
Slack-visible app name, bot-user display name, and description, while
`src/config/identity.ts` points at the local avatar asset
(`assets/bot-avatar.png` by default). After setting those Slack console fields and
uploading the avatar, run `node scripts/verify-identity-live.mjs` with
`SLACK_BOT_TOKEN` set to verify the live name and icon state.

Build the deployable Node artifact:

```bash
npm run flue:build            # -> dist/server.mjs (flue build --target node)
```

The app is dual-target: the Node build above, or the Cloudflare Workers build
(`npm run flue:build:cf` → `dist-cf/`; see "Deploy on Cloudflare"). Both run the
same source — `src/config/state-backend.ts` picks SQLite or the Durable Object
state store at runtime.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET` | unless set via wizard | Verifies inbound Slack request signatures. Required unless configured through the `/admin` Slack-connection wizard; an env value takes precedence over the stored one. |
| `SLACK_BOT_TOKEN` | unless set via wizard | Bot token for outbound Slack Web API calls. Required unless configured through the `/admin` Slack-connection wizard; an env value takes precedence over the stored one. |
| `SLACK_BOT_USER_ID` | optional | Bot user id used to filter self/loop messages. If unset, taken from the `/admin` wizard (stored from `auth.test`) or resolved once via `auth.test`; an explicit empty string means "no bot user id" (fail-closed for message-family events). |
| `SLACK_API_URL` | optional | Override the Slack Web API base URL (offline/fake Slack). |
| `SLACK_TAG_PUBLIC_URL` | optional | Public base URL for Slack-visible `/admin` Configure links in reply footers and bot-invited channel onboarding. If unset, Slack shows a `Configure` label without a link. |
| `SLACK_TAG_MODEL` | optional | Fallback/override model specifier (`provider/model`). Used when the assigned agent has no explicit `model` and no live provider credentials — and, on the Cloudflare target, as an explicit operator override taken *ahead of* the keyless Workers AI binding default. |
| `SLACK_TAG_ALLOW_DMS` | optional | Direct messages are on by default; `false` makes the bot reachable only in channels. |
| `SLACK_TAG_UNASSIGNED_HINT` | optional | On by default: a mention in a channel with no enabled assignment posts one ephemeral hint (rate-limited per channel) to the mentioner linking to `/admin`. `false` disables the hint; the channel itself never sees anything either way. |
| `TAG_AGENT_API_TOKEN` | optional | Shared internal token gating `POST /agents/slack-thread/:id` for **external callers only** — the app's own agent dispatch is in-process and needs no configuration. Random per-process/per-isolate if unset (external calls then cannot authenticate). |
| `TAG_ADMIN_TOKEN` | optional | Bearer token for `/admin/api/*`. If unset, every `/admin/*` route returns 404. This is separate from `TAG_AGENT_API_TOKEN`. |
| `TAG_DB_PATH` | optional | SQLite path for the durable agent transcript. Default `./tmp/flue.db`; use `:memory:` for ephemeral runs. The default `tmp/**` path is ignored by `flue dev` watch mode. |
| `SLACK_STATE_DB_PATH` | optional | SQLite path for app-owned state: runtime agent config, channel assignments, durable dedupe claims, joined-thread registry, and per-thread config snapshots. Defaults to `<TAG_DB_PATH>.state`; a `:memory:` transcript DB implies a `:memory:` state store, so ephemeral runs stay fully ephemeral. The default sibling state DB and SQLite sidecars are also under the ignored `tmp/**` tree. |
| `LOCAL_STUB_URL` / `LOCAL_STUB_API_KEY` | optional | Register an offline `local-stub` provider speaking the OpenAI-completions wire protocol (`SLACK_TAG_MODEL=local-stub/<model>`). |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | optional | Credentials/base URL for the catalog `anthropic` provider. |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_WORKERS_AI_BASE_URL` | optional | Credentials/base URL for the `cloudflare-workers-ai` provider. |

`.env.example` lists the offline-safe defaults.

Upgrade note: `TAG_SELF_URL` (used by pre-in-process builds for the HTTP
self-call) is ignored now — agent dispatch is in-process and needs no self URL.
Remove it from your environment; the app logs a one-time warning if it is still
set.

Seeded starter profiles (no channel assignments — a fresh install's `/admin`
shows only your real channels):

- `Release Scribe` (`agent_release_scribe`) leads with a summary table and includes a fenced code/diff snippet for engineering updates.
- `Exec Brief` (`agent_exec_brief`) uses bold-led bullets, closes with `Next steps`, and avoids code. It is the `*/*` **direct-message default** — the profile that answers DMs and App Home.

Channels are **fail-closed** across both public and private channels (the bot
must be invited to a private channel for Slack to deliver its events): the bot
answers in a channel only where a profile is explicitly assigned (the `*/*`
wildcard is the DM default and does not apply to channels), so a fresh install
never replies in a channel it was merely invited to. When someone explicitly mentions the bot in an unassigned channel,
the channel still gets nothing — only the mentioner receives a single ephemeral
hint pointing at that channel's `/admin` page (`SLACK_TAG_UNASSIGNED_HINT=false`
turns this off). A Slack thread freezes the resolved profile, model, tools, and
instructions at its first durable turn; existing threads keep the config they
started with, while admin edits apply only to new threads. This write-once
snapshot also keeps later execution retries from re-reading a changed profile
mid-thread. Direct messages are on by default; set `SLACK_TAG_ALLOW_DMS=false`
to make the bot reachable only in channels.

Every final Slack reply includes a footer with the profile name, resolved model
label, and a Configure link to `/admin?agent=<id>` when `SLACK_TAG_PUBLIC_URL`
is set. When the bot itself is invited to a channel, it posts one non-threaded
onboarding message explaining that users should mention the bot to start a
thread, that it reads the thread and bounded recent context only when asked, and
that there is no passive monitoring.

Model selection is per agent:

1. `agent.model` from the runtime config store, when set.
2. The agent's Anthropic default when `ANTHROPIC_API_KEY` is present.
3. The agent's Workers AI default — keyless via the Workers AI **binding** on the
   Cloudflare target; on Node it needs `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` (REST provider).
4. `SLACK_TAG_MODEL` as the offline/dev fallback.

If none of those are available, agent initialization fails with an error naming
the missing env vars. Runtime agent and assignment config is seeded into the app
state DB once when that DB is empty; later edits made through `/admin/api/*`
apply to new Slack thread agent initializations without restarting the server.

## Tests and verification

```bash
# Full suite (typecheck + node --test). Lane B spawns the built Flue app.
# If your default node is older than 22.19, point the spawn at a newer binary:
FLUE_NODE_BIN=/path/to/node npm test
```

The suite includes the 31 parity scenarios on the Flue lane (Lane B), the
admin/config-store checks, identity checks, fake-Slack smoke tests, Slack
formatting, the agent model resolver, and the turn-normalization/history-window
unit tests. Set `TAG_REQUIRE_LOOPBACK=1` when parity must be proven, so a
loopback-denied environment fails instead of silently skipping Lane B.

Offline, net-guarded evidence scripts (run with Node >= 22.19 on `PATH`):

```bash
node scripts/verify-flue-offline-turn.mjs
node scripts/verify-agent-config.mjs
node scripts/verify-durability.mjs
node scripts/verify-tool-policy.mjs
node scripts/verify-providers.mjs
npm run verify:cf-smoke        # Cloudflare target end-to-end under wrangler dev (workerd)
```

Each spawns the real app against a fake Slack/provider backend and asserts zero
external network traffic (`scripts/net-guard.mjs`).

For live testing against real Slack without a public tunnel, `npm run
slack:bridge` forwards Socket Mode events to the local server with genuine v0
signatures — dev-only; see "Option B — Socket Mode bridge" in
`docs/play-slack.md`.

Live Slack app identity check:

```bash
SLACK_BOT_TOKEN="<bot-token>" node scripts/verify-identity-live.mjs
```

The identity verifier is the live Slack-app check: it calls Slack Web API
`auth.test` and `users.info`, compares the bot-user display name to
`slack-app-manifest.json`, and reports whether the avatar looks custom, default,
or unknown. The Slack app must include the `users:read` bot scope for that profile
read.

## More

- `docs/play-slack.md` — end-to-end real-Slack setup and the live verification checklist.
- `slack-app-manifest.json` + `assets/bot-avatar.png` — default Slack app identity
  values and avatar asset for fresh installs.
