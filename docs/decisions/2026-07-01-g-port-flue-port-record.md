# G-PORT: Port record — the Slack bot runs on Flue

Date: 2026-07-01

Status: done — hand-rolled harness deleted, Flue lane is the product

Branch: `g-port` (commits `50ebcec..914154b`, parent `36e6589`)

## Decision

The Slack assistant now runs entirely on **Flue with the node build target**. The
hand-rolled Slack harness (its own HTTP server, events app, thread runner,
WebAPI reply sink, session store, event-id dedupe ledger, and REST provider
adapters) has been **deleted**. The port was executed behind a behavioral parity
harness, not a rewrite-and-pray: first a suite of **21 lane-agnostic scenarios**
(S01–S21) was written against a **fake Slack + fake provider backend**, driven so
every assertion is a wire-observable count/target/content property rather than a
byte-exact call sequence. That suite ran green on the old lane (Lane A) first.
Then the Flue lane (Lane B) was stood up to run the **same** scenarios against the
**real Flue app over HTTP** — both lanes coexisted, proving parity on identical
assertions. Only once Lane B was 21/21 green on unmodified scenarios was the old
lane deleted. The final suite is green on Flue alone.

## Parity evidence

### Scenario suite (S01–S21, from `tests/parity/scenarios.ts`)

Each scenario is lane-agnostic (asserts wire behavior: finals, status calls,
history windows, provider-request contents), so both lanes run the identical table.

| ID | Behavior |
|----|----------|
| S01 | url_verification echoes the challenge without touching the wire |
| S02 | tampered signature is rejected with 401 and no wire calls |
| S03 | mention full turn delivers one final, sets then clears status |
| S04 | duplicate delivery yields one final and at most one provider call |
| S05 | default 24h window drives conversations.history |
| S06 | "last 2 days" widens the history window to 172800s |
| S07 | thread continuation reads replies and feeds human context to the provider |
| S08 | DM turn uses conversations.history and never conversations.replies |
| S09 | App Home messages reuse the DM path |
| S10 | top-level channel message is ignored with no wire calls |
| S11 | filtered message events (bot/app/self/subtype/missing-user/empty) never reach the wire |
| S12 | assistant events are acknowledged without running |
| S13 | implicit thread reply with no prior session is dropped |
| S14 | fail-closed without a bot user id: mention runs, thread reply does not |
| S15 | provider failure still delivers one sanitized final and clears status |
| S16 | status rejection falls back to a durable progress post before the final |
| S17 | startStream rejection delivers the final via chat.postMessage once |
| S18 | a single stopStream failure does not duplicate the final |
| S19 | unconfigured workspace/channel gets a wildcard assignment final |
| S20 | explicit mention follow-up delivers two finals in the same thread |
| S21 | threaded mention fan-out (mention + companion message) yields one reply |

### Lane B green on the real Flue app

Stage 3 ran `runScenarioSuite` against the **real Flue app** (`flue build --target
node` → spawn a fresh server per scenario, sign real Slack v0 HMAC requests, POST
over HTTP) and reached **21/21 green with the S01–S21 assertions byte-for-byte
unchanged** — zero Lane B exceptions. During coexistence the full `npm test` was
**92/92** (70 legacy + 21 Lane A incl. the S21 exception + 21 Lane B).

### Mutation checks (the suite bites)

Parity is only worth as much as the suite's ability to catch a regression. Each of
these was introduced, observed to redden exactly the expected scenarios, and reverted:

- **Dedupe defeated** (`EventDedupeLedger.claim` always returns true) → **S04** goes
  red (3 finals instead of 1), and only S04.
- **Status-clear skipped** (guard the `clearStatus` block off) → **S03 and S15** go
  red (last `setStatus` no longer `''`), and only those two.
- **Flue claim-store defeated** (`InMemoryClaimStore.claim` always returns true,
  rebuilt into `dist-node` end-to-end) → **Lane B S04 + S21** go red while Lane A
  stays green (Lane A uses its own event-id dedupe). Proves the Flue lane's
  `(channel,ts)` + `event_id` claim is what carries S04/S21 on the real app.

### Final post-deletion suite

After the old lane's deletion, `npm test` is **32/32 green** (21 Lane B scenarios
S01–S21 · 3 fake-backend smoke tests · 5 formatting · 1 agent-model resolver ·
2 normalization/window unit tests). No lane-a tests remain.

## Exceptions history

During coexistence there was **exactly one** parity exception:

- **S21 (threaded-mention fan-out), lane-a, `expected-fail`.** The real Slack
  fan-out for one in-thread mention delivers both an `app_mention` and a companion
  `message` event (same channel + ts). The old lane deduped on `event_id` only, so
  the two distinct event ids both ran and it **double-replied**. The Flue lane
  claims `msg:(channel,ts)` in addition to `evt:event_id`, so the companion is
  dropped and it replies **once** — S21 passes on Lane B by design. The exception
  recorded that the old lane legitimately could not satisfy a scenario the new lane
  does; it was never a way to skip a failure (an excepted scenario still runs, and
  an *unexpected pass* fails the run as a stale exception).

When Lane A was deleted, its S21 exception was removed with it. **The exceptions
file (`tests/parity/exceptions.ts`) is now empty** (`parityExceptions = []`), so all
21 scenarios simply run on Lane B and must pass. The **stale-exception guard remains
active** in `runScenarioSuite` — if any future exception is added and the divergence
is later fixed, the now-passing scenario forces the entry's deletion.

## Stage 4 artifacts

Committed under [`artifacts/g-port-stage4/`](artifacts/g-port-stage4/) — offline,
net-guarded evidence for the three Flue-only gains:

- [`durability-transcript.json`](artifacts/g-port-stage4/durability-transcript.json) — both turns from the restart-durability run (`GET .../{thread}?view=history` with the internal token); T1's assistant reply survives a SIGKILL and replays into T2 on a brand-new process sharing the same DB file.
- [`durability-run.log`](artifacts/g-port-stage4/durability-run.log) — the 6/6 durability run log.
- [`provider-anthropic-reply.md`](artifacts/g-port-stage4/provider-anthropic-reply.md) — the anthropic-messages (SSE `/v1/messages`) wire final.
- [`provider-workers-ai-reply.md`](artifacts/g-port-stage4/provider-workers-ai-reply.md) — the cloudflare-workers-ai (openai-completions SSE `/v1/chat/completions`) wire final; same fixture, only `SLACK_FLUE_MODEL` swapped.
- [`workers-ai-cred-check.md`](artifacts/g-port-stage4/workers-ai-cred-check.md) — credential validity (presence + status only, no secret values).
- [`tool-policy-allowed.json`](artifacts/g-port-stage4/tool-policy-allowed.json) — provider-wire transcript where the model calls `lookup_channel_brief` on the assigned channel and gets a real tool result.
- [`tool-policy-denied.json`](artifacts/g-port-stage4/tool-policy-denied.json) — provider-wire transcript where an off-scope channel yields the honest denial as a real (isError) tool result, and the brief never leaks to Slack or the provider.

**Provenance caveat.** The two provider replies are **STUBs** — protocol-faithful
local endpoints, not live model calls — because `CLOUDFLARE_API_TOKEN` was
re-verified **invalid** on 2026-07-01 (`GET .../user/tokens/verify` → HTTP 401,
error code 1000 "Invalid API Token") and `ANTHROPIC_API_KEY` was **absent** from
both the shell env and `.env.slack.local`. The stubs speak the exact wire protocols
(anthropic-messages SSE and openai-completions SSE), so they prove Flue's registry
routes two different providers correctly; the `scripts/verify-providers.mjs` harness
is **live-ready** — drop the dummy-key overrides, set a valid credential, and
allowlist the provider host in the net-guard, and it runs live unchanged.

## Notable decisions made during the port

- **Node build target replaces Cloudflare.** `src/db.ts` (`sqlite(FLUE_DB_PATH ??
  './tmp/flue.db')`) gives the agent transcript file-backed durability, but it is
  **node-only** — the Cloudflare target rejects it. So `flue.config.ts` and
  `flue:build` are pinned to `--target node`, and the Cloudflare target is
  intentionally unbuildable. `wrangler.jsonc` is **kept as a vestigial** artifact of
  a possible future Cloudflare variant, not a live target.
- **Agent HTTP endpoint is authenticated.** The Slack channel reaches the agent via
  a self-call to `POST /agents/slack-thread/:id`. That route is gated by an internal
  token (`x-flue-internal-token`, constant-time compared); unauthenticated requests
  get 401. In one-process `flue dev`/node the module-scope token is shared
  automatically.
- **Self-call origin is pinned against host-header SSRF.** The self-call base URL is
  `FLUE_SELF_URL` when set, otherwise the request origin is trusted **only** if its
  hostname is loopback (`127.0.0.1`, `::1`/`[::1]`, `localhost`). An untrusted Host
  releases the claims (so a legitimate retry can re-drive) and logs a static
  sanitized message — no attacker-controlled header is echoed.
- **`@flue/slack@1.0.0-beta.1`** is pinned exact — it is the **only published
  version** (vs. `beta.8` for `@flue/runtime`/cli); it runs cleanly end-to-end.
- **Flue retries transient provider 5xx.** A provider 500 surfaces across the
  `?wait=result` boundary after **~4 attempts (~14s worst case)** (runtime backoff:
  3 transient retries, 2s base, exponential w/ jitter, ~8s max inter-attempt gap).
  The sanitized failure final still streams and the raw error never reaches Slack.
  Lane B sizes its S15 quiesce window (12s idle) around this.

## LOC delta

Measured src + tests, peak-coexistence (`66fd6ae`, both lanes present) → final (`HEAD`):

- **7083 → 3879 LOC** (**−3204**), **49 → 30 files** (**−19**).

Whole-branch diff (`git diff --stat 36e6589..HEAD | tail -1`):

```
58 files changed, 4460 insertions(+), 4320 deletions(-)
```

## Verification inventory

Every gate and the command that proves it (all run, all green):

| Gate | Command | Result |
|------|---------|--------|
| Full suite (typecheck + Lane B + legacy + formatting) | `npm test` | 32/32 pass, 0 fail |
| Production node artifact builds | `npm run flue:build` (`flue build --target node`) | `done built dist/server.mjs`, exit 0 |
| One full offline Slack turn (+ auth, tamper, net-guard) | `node scripts/verify-flue-offline-turn.mjs` | 7/7 checks |
| Restart durability (transcript survives SIGKILL) | `node scripts/verify-durability.mjs` | 6/6 checks |
| Model-invoked tool with honest deny (no brief leak) | `node scripts/verify-tool-policy.mjs` | 6/6 checks |
| Two-provider answering over distinct wire protocols | `node scripts/verify-providers.mjs` | 5/5 checks |
| CI runs the suite offline with zero credentials | `.github/workflows/ci.yml` | checkout → setup-node (`.nvmrc`) → `npm ci` → `npm test` → `npm run flue:build`; no secrets referenced |

The Lane B spawn needs Node >= 22.19; CI's `.nvmrc` (22.19.0) satisfies it, so no
`FLUE_NODE_BIN` override is needed in CI (that override is only for a local default
Node 22.14). The verify scripts are net-guarded (`scripts/net-guard.mjs` patches
`globalThis.fetch`) and log zero external traffic.

## Follow-ups (honest)

- **Durable claim store.** Dedupe and the implicit-reply session registry are still
  **in-memory** (process lifetime) — the **same durability class as the old lane's**
  Map-based dedupe. `db.ts` made the agent *transcript* durable, but a Slack
  redelivery immediately after a restart could still re-run a turn. Durable dedupe
  is a larger, separate change.
- **Live-provider evidence is pending valid credentials.** Both provider replies are
  STUBs today (CF token invalid, Anthropic key absent). The scripts are live-ready.
- **The Cloudflare target variant would need work.** It is unbuildable by design
  because `db.ts` is node-only; a Cloudflare deploy would require moving `db.ts`
  behind the target (Cloudflare uses DO SQLite automatically) or gating it out.
  `wrangler.jsonc` is retained for that possible future variant.
- **Net-guard covers global `fetch` only.** The offline guarantee rests on patching
  `globalThis.fetch`; a dependency reaching the network through another mechanism
  (raw sockets, a native http agent) would not be caught by it.
- **DM transcripts grow unbounded.** DM thread keys collapse to
  `workspace:channel:dm`, so with the file-backed `db.ts` a DM channel is one
  perpetual conversation whose transcript grows without bound into every provider
  request; this needs a windowing/compaction policy review (Flue auto-compaction
  may mitigate — unverified).
