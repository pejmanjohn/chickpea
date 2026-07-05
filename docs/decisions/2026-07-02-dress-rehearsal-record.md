# Dress rehearsal record — T7 (executed 2026-07-05)

Goal (from the launch plan): execute the complete demo storyboard once,
end-to-end, in a brand-new Slack workspace over a live tunnel; leave a written
shot list and an explicit go/descope call for every P1 beat.

Outcome: **one clean end-to-end run in a fresh single-member workspace over a
cloudflared quick tunnel. V1 and V5 both settled. Every P1 beat is GO** (one
with a workaround). Shot list: `docs/demo/shot-list.md`. Recording day needs no
exploration.

Setup facts (identifiers redacted per safety notes): fresh workspace created by
the operator; app created via **api.slack.com → "From a manifest"** with
`slack-app-manifest.json` (tunnel host substituted into `request_url`);
installed after operator confirmation. Server: `flue dev --target node --port
8789`, Anthropic live provider, admin API + UI behind `FLUE_ADMIN_TOKEN`.

## V1 — icon-URL heuristic: CONFIRMED

`scripts/verify-identity-live.mjs`, same fresh app, before vs after uploading
`assets/bot-avatar.png` (512×512 verified) in Basic Information:

- BEFORE: `FAIL icon - Slack stock avatar detected at
  https://secure.gravatar.com/avatar/<hash>.jpg?s=512&d=https%3A%2F%2Fa.slack-edge.com%2Fdf10d%2Fimg%2Favatars%2Fava_0016-512.png`
  — note the stock default arrives as a **gravatar URL with an
  `a.slack-edge.com/...img/avatars/...` fallback parameter**; the classifier
  handled that indirection correctly.
- AFTER: `PASS icon - custom Slack-hosted avatar detected at
  https://avatars.slack-edge.com/2026-07-05/<id>_512.png` → 2/2 blocking
  checks. The `avatars.slack-edge.com` = uploaded / `a.slack-edge.com` static
  path = stock heuristic holds on a fresh app.

## V5 — dual name fields: CONFIRMED

The manifest sets both `display_information.name` and
`features.bot_user.display_name`, so a from-manifest app needs **no manual
name-field work**. The name check (which compares the bot-user display name,
per the T2 review fix) passed immediately after install, and live messages
render the custom name + avatar (screenshots captured during the run; GIF
export `t7-dress-rehearsal-storyboard.gif`).

## T4 manifest live proof

"Create From manifest with zero manual scope/event additions" — verified: the
review step showed all 7 bot scopes; after creation the console had all 7
event subscriptions and App Home settings; nothing was added by hand. One
wrinkle: the creation-time URL challenge fails if the server isn't yet running
with THAT app's signing secret — expected; the Event Subscriptions **Retry**
button verified on the first click once the server had the new secret.

## Per-beat results (storyboard order)

| Beat | Result | Evidence / notes |
|------|--------|------------------|
| /admin add channel by ID | PASS | Rail updates instantly. Nit: Workspace ID prefills `T_DEMO`; must be corrected on camera. |
| Create profile in Tag-style modal | PASS | Model combobox lists runtime-detected providers with curated suggestions; picked `anthropic/claude-sonnet-4-6`. Caveat: the Cloudflare Workers AI suggestion appears because creds are set, but that token 401s — don't pick it on camera. |
| Attach + channel instructions + Access summary | PASS | Summary renders layered PROFILE → CHANNEL INSTRUCTIONS (highlighted) → RUNTIME → GUARDRAIL from the server resolver, plus snapshot hash + "new threads only". |
| Invite → onboarding message | PASS | `member_joined_channel` delivered on the fresh install (`channels:read` present from the manifest — the T8-era blocker is gone). Onboarding is **assignment-gated by design** (`src/channels/slack.ts` fail-closed comment): an unassigned channel gets no greeting — correct, and matches the fail-closed story. |
| Mention → live trace → markdown reply + footer | PASS | Trace observed live: immediate status, then `Running lookup_channel_brief`, then `is using anthropic/claude-sonnet-4-6` (thread-continuation turn), cleared on completion — no permanent progress lines anywhere. Reply blocks included a real `table` block, colored diff fence, headers; footer `Release Scribe \| anthropic/claude-sonnet-4-6 \| Configure` with a working tunnel link. Channel addendum visibly obeyed (Ship checklist present). |
| Second channel, different voice | PASS | Same install answered `#exec-updates` as Exec Brief: bold-led bullets, "Next steps", no code (addendum obeyed). Wrinkle: reply led with "No channel brief is configured for this channel" — honest tool degradation; for the video either configure a brief or ask a thread-grounded question. |
| Snapshot beat (edit → old thread frozen, new thread updated) | PASS (config layer, deterministic) / model-noisy on camera | The `agent_snapshots` table shows the old threads pinned to hash `8b292ae6…` (no marker) and the new thread on `473f8f94…` **containing the edited instructions**; hashes match what /admin displayed before/after the edit. The old thread's post-edit reply kept the old voice. BUT the cosmetic on-camera marker ("begin every reply with [v2-notes]") was ignored by claude-sonnet-4-6 even though it was in the new thread's frozen prompt — same class as the earlier ZEBRA incident. The plumbing is right; the beat's visibility depends on how loud the instruction change is. |
| Formatting smoke (play-slack §4 prompt) | PASS | Reply blocks: header, rich_text, table, divider, context; code fence, inline code, blockquote, link all present. |
| Negative: unassigned channel | PASS | Mention in an unassigned channel → no onboarding, no reply, server log `no assignment for turn: No enabled agent assignment for <workspace>/<channel>`. |
| Negative: duplicate retry | PASS (live) | Replayed the REAL `app_mention` (event id recovered from the `slack_claims` table) with a fresh valid signature and `x-slack-retry-num: 1` through the public tunnel → HTTP 200, thread count unchanged. Bad-signature probe → 401, so the 200 wasn't a rubber stamp. |

## Go / descope calls — P1 beats

- **Footer** — **GO.** Live-proven twice; model label is the real resolved
  model; Configure deep-links work when `SLACK_FLUE_PUBLIC_URL` is set.
- **Onboarding message** — **GO.** Fresh from-manifest install delivers
  `member_joined_channel`; message posts once, non-threaded, with the /admin
  channel link. Remember it only fires in assigned channels.
- **Second agent** — **GO.** Voice contrast is stark on camera; pre-seed the
  exec channel with a brief or a thread so the tool doesn't report "no brief".
- **Snapshot beat** — **GO with workaround.** Config layer proven
  deterministically (snapshot table + hashes + /admin display). On camera, use
  a dramatic instruction change (voice/persona-level, not a cosmetic tag), or
  show the /admin Snapshot hash flip as the proof; keep the storyboard's
  fallback (drop the beat) only if the louder edit still reads poorly in the
  take.

## Findings & fixes for day 3 (none block recording)

1. **`flue dev` + repo-local SQLite = reload loop.** The watcher sees every
   DB write and reloads forever (503s while reloading). Fix: `FLUE_DB_PATH`
   outside the repo. Worth a line in play-slack.md later.
2. **Stale dev servers steal the port** across sessions (IPv4/IPv6 split makes
   it confusing: curl hit a stale IPv4 listener while the tunnel reached the
   new IPv6 one). `pkill -f 'flue dev'` before bring-up.
3. **Seeded demo data on camera**: the `T_DEMO` assignments render in the rail
   alongside real channels and the seeded profile names collide with the ones
   the storyboard creates. Delete the seeded `T_DEMO` rows + seeded
   `agent_release_scribe` in prep (keep the `*/*` DM wildcard row and its
   agent).
4. **Workspace ID prefill** in Add-channel says `T_DEMO` — correct it on
   camera (or consider prefilling from the last real workspace seen).
5. **Assignment PUT requires `enabled`** — the admin API rejects a body
   without it (`invalid_request`); the UI always sends it, only relevant for
   curl demos.
6. **Trace visibility**: short turns show one named tool stage
   (`Running lookup_channel_brief`); the multi-stage arc is timing-dependent.
   Pick questions that require context gathering.
7. **Provider caveat**: Cloudflare Workers AI token still 401s
   (`verify-providers-live.mjs` 4/5); Anthropic is the default via precedence
   and passed live. Re-mint the CF token or avoid workers-ai models on camera.

## Teardown / follow-ups

- The rehearsal app's **signing secret was rotated after the run** (it had
  been revealed on-screen during automation; rotation invalidates any capture).
  The local env file was updated in place; next bring-up needs only the new
  tunnel URL.
- Rehearsal workspace is single-member and reusable as the recording
  workspace ("Acme Inc" reads fine on camera); scratch channels (`#bot-test`,
  defaults) should be hidden or cleaned before recording.
- Evidence kept locally (not committed): screen recording GIF (50-frame cap),
  screenshots, `/tmp/flue-rehearsal-server.log`.
