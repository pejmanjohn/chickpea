# slack-flue

A Slack bot built on the [Flue](https://www.npmjs.com/package/@flue/runtime) agent
runtime. It answers `@`-mentions, threaded replies, and DMs in Slack: it verifies
the request signature, normalizes the event into a runnable turn, hydrates bounded
channel/thread context, and drives a durable Flue agent that streams a final reply
back into the thread. Per-channel assignments map a workspace + channel to a named
profile (instructions, model, allowed tools); an assignment-scoped
`lookup_channel_brief` tool is exposed to profiles that opt in. The Slack-visible
identity is still one install-wide bot; profile names appear in reply footers so
users can see which profile answered.

The product runs entirely on the **Flue lane**. The earlier hand-rolled harness has
been deleted; the behavior it encoded is preserved by a lane-agnostic parity suite
(`tests/parity/`) that now runs against the real Flue app (Lane B, 31 scenarios).

## Architecture

- `src/app.ts` — Flue app entry: registers providers (`cloudflare-workers-ai`,
  optional `anthropic`, optional offline `local-stub`), mounts the fail-closed
  admin API, then mounts the Flue router.
- `src/channels/slack.ts` — Slack channel (`POST /channels/slack/events`): admission,
  duplicate-claiming, context hydration, and the self-call that drives the agent.
- `src/agents/slack-thread.ts` — durable agent (`POST /agents/slack-thread/:id`),
  gated by a shared internal token; resolves the assignment's model + tools.
- `src/slack/` — shared, lane-agnostic Slack modules kept verbatim from the contract:
  turn normalization, thread keys, context hydration/formatting, message rendering,
  presentation, claim store, internal auth.
- `src/admin/routes.ts` — token-gated runtime config CRUD API under `/admin/api/*`.
- `src/config/` — seeded agents, assignments, channel briefs, assignment resolver,
  and the SQLite-backed runtime config store.
- `src/db.ts` — file-backed SQLite for the durable agent transcript (Node target).

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

The Node target is the deploy target. `wrangler.jsonc` and the Cloudflare build path
are vestigial and intentionally unbuildable (a custom `src/db.ts` is Node-only).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET` | yes | Verifies inbound Slack request signatures. |
| `SLACK_BOT_TOKEN` | yes | Bot token for outbound Slack Web API calls. |
| `SLACK_BOT_USER_ID` | optional | Bot user id used to filter self/loop messages. If unset, resolved once via `auth.test`; an explicit empty string means "no bot user id" (fail-closed for message-family events). |
| `SLACK_API_URL` | optional | Override the Slack Web API base URL (offline/fake Slack). |
| `SLACK_FLUE_PUBLIC_URL` | optional | Public base URL for Slack-visible `/admin` Configure links in reply footers and bot-invited channel onboarding. If unset, Slack shows a `Configure` label without a link. |
| `SLACK_FLUE_MODEL` | optional | Offline/development fallback model specifier (`provider/model`) used only when the assigned agent has no explicit `model` and live provider credentials are absent. |
| `FLUE_SELF_URL` | optional | Explicit base URL for the app's self-call to its agent endpoint. Without it, only loopback origins are trusted (Slack signatures do not cover `Host`). |
| `FLUE_AGENT_API_TOKEN` | optional | Shared internal token gating `POST /agents/slack-thread/:id`. Random per-process if unset. |
| `FLUE_ADMIN_TOKEN` | optional | Bearer token for `/admin/api/*`. If unset, every `/admin/*` route returns 404. This is separate from `FLUE_AGENT_API_TOKEN`. |
| `FLUE_DB_PATH` | optional | SQLite path for the durable agent transcript. Default `./tmp/flue.db`; use `:memory:` for ephemeral runs. The default `tmp/**` path is ignored by `flue dev` watch mode. |
| `SLACK_STATE_DB_PATH` | optional | SQLite path for app-owned state: runtime agent config, channel assignments, durable dedupe claims, joined-thread registry, and per-thread config snapshots. Defaults to `<FLUE_DB_PATH>.state`; a `:memory:` transcript DB implies a `:memory:` state store, so ephemeral runs stay fully ephemeral. The default sibling state DB and SQLite sidecars are also under the ignored `tmp/**` tree. |
| `LOCAL_STUB_URL` / `LOCAL_STUB_API_KEY` | optional | Register an offline `local-stub` provider speaking the OpenAI-completions wire protocol (`SLACK_FLUE_MODEL=local-stub/<model>`). |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | optional | Credentials/base URL for the catalog `anthropic` provider. |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_WORKERS_AI_BASE_URL` | optional | Credentials/base URL for the `cloudflare-workers-ai` provider. |

`.env.example` lists the offline-safe defaults.

Seeded demo profiles:

- `Release Scribe` (`agent_release_scribe`) is assigned to `T_DEMO/C_ENG`; it leads with a summary table and includes a fenced code/diff snippet for engineering demos.
- `Exec Brief` (`agent_exec_brief`) is assigned to `T_DEMO/C_EXEC`; it uses bold-led bullets, closes with `Next steps`, and avoids code. It is also the `*/*` **direct-message default** — the profile that answers DMs and App Home.

Channels are **fail-closed**: the bot answers in a channel only where a profile
is explicitly assigned (the `*/*` wildcard is the DM default and does not apply
to channels), so a fresh install never replies in a channel it was merely
invited to. A Slack thread freezes the resolved profile, model, tools, and
instructions at its first durable turn; existing threads keep the config they
started with, while admin edits apply only to new threads. This write-once
snapshot also keeps later execution retries from re-reading a changed profile
mid-thread. Direct messages are on by default; set `SLACK_FLUE_ALLOW_DMS=false`
to make the bot reachable only in channels.

Every final Slack reply includes a footer with the profile name, resolved model
label, and a Configure link to `/admin?agent=<id>` when `SLACK_FLUE_PUBLIC_URL`
is set. When the bot itself is invited to a channel, it posts one non-threaded
onboarding message explaining that users should mention the bot to start a
thread, that it reads the thread and bounded recent context only when asked, and
that there is no passive monitoring.

Model selection is per agent:

1. `agent.model` from the runtime config store, when set.
2. The agent's Anthropic default when `ANTHROPIC_API_KEY` is present.
3. The agent's Workers AI default when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are present.
4. `SLACK_FLUE_MODEL` as the offline/dev fallback.

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
unit tests. Set `FLUE_REQUIRE_LOOPBACK=1` when parity must be proven, so a
loopback-denied environment fails instead of silently skipping Lane B.

Offline, net-guarded evidence scripts (run with Node >= 22.19 on `PATH`):

```bash
node scripts/verify-flue-offline-turn.mjs
node scripts/verify-agent-config.mjs
node scripts/verify-durability.mjs
node scripts/verify-tool-policy.mjs
node scripts/verify-providers.mjs
```

Each spawns the real app against a fake Slack/provider backend and asserts zero
external network traffic (`scripts/net-guard.mjs`).

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
