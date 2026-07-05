# Demo shot list — 90-second launch video

Written from the 2026-07-05 dress rehearsal (see
`docs/decisions/2026-07-02-dress-rehearsal-record.md`). Every shot below was
executed end-to-end in a fresh workspace before this list was written. Timings
are from the rehearsal: a full agent turn (mention → final reply) takes 9–20s
with `anthropic/claude-sonnet-4-6`, so the recording plan interleaves shots
rather than waiting on camera.

## Pre-flight (day of recording, ~30 min, off camera)

1. `npm test` green; node >= 22.19 (`FLUE_NODE_BIN` if the default is older).
2. Start the tunnel FIRST (quick-tunnel URLs change every run):
   `cloudflared tunnel --url http://localhost:8789` → note `https://<host>`.
3. Start the server with **the state DB outside the repo** — `flue dev`
   watches the tree and a repo-local SQLite DB causes an endless reload loop:
   `FLUE_DB_PATH=/tmp/flue-demo.db` (plus `.state` sibling, created
   automatically). Also export: real Slack creds for the demo app,
   `FLUE_ADMIN_TOKEN`, `FLUE_SELF_URL=http://127.0.0.1:8789`,
   `SLACK_FLUE_PUBLIC_URL=https://<tunnel-host>` (the footer Configure links
   are real on camera only if this is set).
4. Slack console → the demo app → Event Subscriptions → update the Request URL
   to the new tunnel host → must show **Verified**.
5. `node scripts/verify-identity-live.mjs` → 2/2 PASS (name + custom icon).
6. `node scripts/verify-providers-live.mjs` → anthropic PASS. Do NOT pick a
   `cloudflare-workers-ai/*` model anywhere on camera unless the CF token has
   been re-minted with Workers AI permission (the current one 401s).
7. Clean demo state: delete the seeded `T_DEMO/*` assignments and the seeded
   `agent_release_scribe` via `/admin` (keep the `*/*` DM wildcard row and
   `agent_exec_brief`), so the rail shows only real channels and the Profiles
   modal has no name collision with the profile created on camera.
8. Slack client: **light theme** to match the light /admin page; hide the
   test/scratch channels from the sidebar; close the "enable notifications"
   banner; 125–150% zoom per the admin-ui evidence.
9. Channels `#eng-releases` and `#exec-updates` exist; bot NOT yet a member;
   1–2 realistic context messages already posted in `#eng-releases` (e.g. the
   auth-service staging update) so the first answer has real material.
10. `/admin?token=<FLUE_ADMIN_TOKEN>` opened once in the recording browser
    (sets the cookie and strips the token from the URL).

## Shots

| # | Surface | Action | Exact prompt / input | Expected on screen | Duration |
|---|---------|--------|----------------------|--------------------|----------|
| 1 | /admin | Click **+ Add channel**; fix Workspace ID (it prefills `T_DEMO`), paste channel ID from the Slack URL, name `eng-releases`, **Add** | — | Channel appears in rail, channel page opens | 0–10s |
| 2 | /admin | **Manage profiles → + New profile**: name `Release Scribe`, model picker → select `anthropic/claude-sonnet-4-6`, description; Instructions tab → paste profile instructions; **Done** | Instructions: "You are Release Scribe, the engineering release-notes profile… compact summary table… fenced code or diff snippet… name owners and versions, skip pleasantries." | Tag-style modal; combobox shows runtime-detected providers | 10–18s |
| 3 | /admin | **Change** profile on `#eng-releases` → select Release Scribe → **Attach**; type channel instructions; **Save changes** | Channel instructions: "In #eng-releases, close every answer with a short 'Ship checklist' of 2-3 concrete items." | Access summary re-resolves: profile, explicit model, layered PROFILE → CHANNEL INSTRUCTIONS (highlighted) → RUNTIME → GUARDRAIL, snapshot hash | 18–25s |
| 4 | Slack `#eng-releases` | Type `@Flue Assistant` (Return to select the token!), short invite line, send; click Slackbot's **Add Them** | `joining us for release notes duty` | Bot joins; **onboarding message** posts: "Mention @Flue Assistant to start a thread… no passive monitoring… Configure" | 25–33s |
| 5 | Slack `#eng-releases` | Mention with the real question | `@Flue Assistant draft the auth-service 2.1 release notes for the payments team, based on this channel's recent updates` | Status line appears immediately, changes to `Running lookup_channel_brief`, then clears; threaded reply with **rendered table block, key-changes bullets, colored diff code block, Ship checklist**, footer `Release Scribe \| anthropic/claude-sonnet-4-6 \| Configure` | 33–52s (turn ≈ 15s — cut to the reply) |
| 6 | Slack `#exec-updates` | Same invite dance, then mention | `@Flue Assistant what does the auth-service 2.1 release mean for the business?` | Same install, completely different voice: bold-led bullets, risk framing, "Next steps", **no code**; footer shows `Exec Brief` | 52–65s |
| 7 | /admin + Slack | Edit Release Scribe instructions (make a LOUD change — see record §snapshot-beat), Save; reply (no mention) in the old thread; then fresh mention in the channel | Old thread: unchanged voice (frozen snapshot). New thread: new behavior. Optionally show the Access summary "Snapshot … new threads only" hash changing | 65–78s |
| 8 | Repo card | Static end card | — | GitHub URL + "built by extending Cloudflare's Flue framework" + seam names (defineAgent, defineTool, registerProvider) | 78–90s |

## Gotchas that will eat a take

- **Mentions**: type `@Flue Assist`, wait for the autocomplete, press **Return
  to select the token**, THEN type the message. Typing the full name with a
  trailing space often produces dead text — no `app_mention`, bot stays silent.
- **Second name field**: the manifest sets both the app name and the bot-user
  display name; if either is edited in the console later, re-run
  `verify-identity-live.mjs` (messages render the App Home bot display name).
- The exec-channel answer opens with "No channel brief is configured" if the
  `lookup_channel_brief` tool has nothing for that channel — either accept the
  honest degradation or ask a thread-grounded question instead.
- Instruction-following is a noisy live signal: cosmetic markers ("start every
  reply with X") get ignored by the model even when the config layer is
  correct. For shot 7 use a dramatic voice change, not a tag.
- The `#social`-style negative (mention in an unassigned channel → silence +
  `no assignment for turn` in the server log) is proven but does NOT belong in
  the 90s cut; keep it for the README/verification section.
- Duplicate-retry safety is proven offline and live (signed replay of a real
  event id → single reply); nothing to show on camera.
