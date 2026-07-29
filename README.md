# <img src="assets/chickpea-mark.svg" alt="" width="34" height="34"> Chickpea

**Self-hosted, model-agnostic AI agent for Slack. One click to your own Cloudflare account — your first DM answers before you add a single model API key.**

Chickpea answers `@`-mentions, thread replies, and DMs in your workspace, and every channel can get its own profile: separate instructions and model, imported skills, approved MCP/API connections, and exact GitHub repository grants. Channels can retain explicit team memory and own scheduled work on Cloudflare, using the capabilities of their attached profile, all managed from a token-gated `/admin` page. It is built for teams that want an AI agent in Slack without routing messages, tokens, or model traffic through someone else's cloud: your Slack credentials live in your own Cloudflare Durable Object (or your own SQLite file), model calls go directly to the provider you pick, and this project hosts nothing. Built on [Flue](https://www.npmjs.com/package/@flue/runtime). MIT-licensed.

![The /admin page on a local install: a connected workspace, a channel with its attached profile, and per-channel instructions](assets/admin-page.png)

**Is this for you?** The hard constraints, up front (details under [Good to know](#good-to-know)):

- One deploy serves **one Slack workspace** — no multi-workspace OAuth distribution yet.
- On Cloudflare's free tier, the Workers AI and Durable Object daily caps are **hard errors** under load; adding a provider key and pinning profiles away from Workers AI moves model spend.
- `/admin` auth is a **bearer token**, not SSO.
- **Updates are manual**: the Deploy button clones this repo (it does not fork), so upgrading is a re-deploy. The open-source v1 release starts from a clean, consolidated schema; migrations added after that public baseline are append-only.
- **Durability is single-host** — multi-instance deployments would need a shared store first.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pejmanjohn/chickpea)

Button to first DM answer in four steps — expect one detour out to Slack's app console (step 3):

1. **Click the button.** Cloudflare clones this repo into your GitHub, provisions the Durable Objects, wires Workers Builds CI, and prompts for one secret: `TAG_ADMIN_TOKEN` (generate it with `openssl rand -hex 32`).
2. **Log in.** Open `https://chickpea.<your-account>.workers.dev/admin` and paste your `TAG_ADMIN_TOKEN` into the sign-in form. The form exchanges it in a POST body for an HttpOnly session cookie; the credential never enters the URL.
3. **Click "Create your Slack app".** The first-run wizard deep-links Slack's app console with this repo's manifest — the events request URL already points at your worker. Install the app to your workspace. If Slack shows the request URL as unverified, click **Retry** on Event Subscriptions: the worker echoes the verification challenge even before credentials are saved.
4. **Paste back the bot token and signing secret.** The wizard validates the token live against Slack `auth.test` and stores both in Durable Object state. Env secrets (`wrangler secret put`) always take precedence if you set them later.

The first DM answers with **zero model keys** on a fresh Cloudflare deploy: the seeded Default profile is explicitly pinned to [`cloudflare/@cf/zai-org/glm-5.2`](https://developers.cloudflare.com/workers-ai/models/glm-5.2/) through the Workers AI binding — that link is its Workers AI model page, so you can check availability on your plan before deploying. If the model errors on your account, the failure surfaces as one sanitized reply in the thread; pin any other model in `/admin`. Add an `ANTHROPIC_API_KEY` secret, or paste it in Settings, to make Claude models available in the picker; keys do not silently switch a pinned profile.

## What it does

### In Slack

- Answers `@`-mentions, thread replies (no re-mention needed), and DMs with one streamed reply in the thread — falling back gracefully to a single durable final message if Slack rejects the streaming APIs, never a duplicate.
- Fetches channel context only when asked, over a bounded prompt-derived window — no passive monitoring, ever.
- Runs saved channel routines on Cloudflare schedules, including read and write work, with the same current channel authority as a live `@`-mention.
- Keeps explicit, team-owned channel memory: members can remember, inspect, correct, merge, report, and irreversibly forget small Markdown notes that carry across Slack threads.
- Renders standard Markdown natively (tables, lists, blockquotes, fenced code/diff blocks) and signs every reply with the profile and model that answered.
- Absorbs Slack's duplicate retries while an event claim is held, so normal redelivery produces one final reply and one provider call. If the provider succeeds but Slack rejects final delivery, the claim is released so Slack can retry the event; that recovery can call the provider again.

<details>
<summary>The full behavioral contract</summary>

- Continues a thread without re-mentioning: once the bot has replied in a thread, later human replies keep the session going. The joined-thread registry is durable (it survives restarts and redeploys) and expires after 30 days of thread age.
- Answers DMs and App Home messages without mention syntax. On by default; `SLACK_TAG_ALLOW_DMS=false` makes it channels-only.
- Context windows are prompt-derived: a top-level mention like "summarize this week" pulls same-channel history over `today`, `yesterday`, `this week`, `last week`, `since Monday`, `last 2 days`; anything vague defaults to the last 24 hours. Thread reads cap at 50 human-authored messages, with bot and system replies filtered out.
- Shows an Assistant status line ("…is checking context", then named tool stages) and clears it when Slack accepts status updates. If Slack rejects streaming status, its durable progress post can remain alongside the final answer.
- The reply footer carries the profile name, the resolved model, and a Configure link into `/admin` when `SLACK_TAG_PUBLIC_URL` is set.
- Posts one onboarding message when invited to an assigned channel: mention `@Chickpea` to start a thread, context is read only on request, and there is no passive monitoring.

</details>

### Operator controls (`/admin`)

- A single self-contained admin page, gated by `TAG_ADMIN_TOKEN` — `Authorization: Bearer` for API callers or a POST-only token form that sets an HttpOnly session cookie.
- Reusable profiles: name, model, instructions, enabled skills, remote MCP and HTTP API connections with explicit approvals, exact repository grants, and an enable toggle. Disabling a profile blocks DMs and new channel threads; existing channel threads keep the frozen profile snapshot they started with.
- Skills can be imported by pasting any public `owner/repo`, GitHub URL, or skills.sh link. When the GitHub App is connected, the same field can also resolve App-accessible private repositories, and **Browse GitHub** can fill it from the connected installations without limiting public paste to repositories you own.
- Per-channel assignments: add a channel by workspace + channel ID, enable/disable it, swap the attached profile, or detach it. Per-channel instructions append to the profile's instructions in that channel only.
- Model pinning: a combobox showing concrete models grouped by the providers this install actually has configured. Any free-text `provider/model` specifier is accepted; unknown providers get a warning.
- A read-only Access summary showing the attached profile, install-wide Slack identity, and layered instructions. Advanced shows the resolved model, provider, and short config snapshot hash; the profile's Skills, Connections, and Repositories tabs show its capability grants.
- The first-run Slack connection wizard described above, followed by a live Slack overview that reads the installed bot's current name and avatar, links to the exact Slack settings page for changing them, tests or replaces stored credentials, and confirms disconnects. DM, unassigned-channel hint, and welcome-message behavior is configurable there; environment-managed values remain visibly read-only.
- Profile and channel edits apply to new threads without a restart; DMs deliberately track current configuration.
- Audit Logs > Scheduled Work starts with a compact, filterable routine inventory. Opening one routine separates its saved definition and controls from its Runs and Activity, including revisions, usage, safe failures, Slack receipts, and Flue run IDs. Audit Logs > Memory keeps the workspace/channel memory browser with generated `MEMORY.md` indexes, escaped file previews, optimistic editing, revision history, review resolution, and irreversible deletion. Network Events remains reserved.

### Channel memory

Channel memory is always available in eligible assigned Slack channels; there is no enable switch or environment flag. Creation is explicit but does not require rigid command syntax: direct phrases such as “Please remember that…” are accepted, while Chickpea does not silently save facts from normal conversation. Direct-message memory, past-session browsing, automatic curation, and vector search are intentionally deferred.

Use these commands in an admitted channel turn:

```text
Please remember that <what matters>
Please update the memory <slug> to say that <new guidance>
!memory
!remember <name> — <description>
<Markdown body on the next line>
!memory show <slug>
!memory update <slug> — <description>
<replacement body on the next line>
!memory merge <slug-a> <slug-b> as <name> — <description>
<merged body on the next line>
!memory report <channel-id>/<slug> <stale|incorrect|unsafe|unclear>
!forget <slug>
!forget confirm <one-time token>
```

Public-channel entries are grouped by their source channel, readable from eligible public channels workspace-wide, and editable conversationally only from their source channel. A private channel reads its own isolated generation plus workspace-public memory read-only, and writes only to that private generation. A private-to-public conversion seals the old private generation; later public turns do not read it. Slack Connect/shared channels, unresolved scope or actor identity, bots/apps, guests, foreign users, and failed live membership proof do not receive expanded memory access. DMs have no memory in this release.

Memory is advisory data, never policy. The prompt labels every entry untrusted and potentially stale; current profile instructions, the current Slack request, live repository/tool permissions, spend and egress limits, and fresh Slack scope checks always win. A changed scope or selected entry invalidates the delivery lease so stale model text is not posted.

The bounded defaults are 64 entries per source channel; 512 entries/1 MiB in the public workspace store; 128 entries/256 KiB in a private store; 512-byte descriptions; 8 KiB bodies; and at most 8 entries/8 KiB in a turn prompt. Ninety-day age marks an entry stale for ranking but does not delete it. Credential-like content is rejected. Mutation rate windows allow 30 actor changes and 120 channel changes per hour.

Canonical state is structured SQLite/Durable Object data projected deterministically as portable Markdown and an uncompressed tar export; the filesystem is not required. The generated `MEMORY.md` files are read-only. Import is previewed, path/hash checked, bounded, and applied atomically. Admin edits use expected versions and preserve a draft across conflicts.

`TAG_ADMIN_TOKEN` currently grants broad operator access to public and private retained memory, including view, edit, review, and delete in the admin UI. Deterministic export/import remain API-level portability and recovery capabilities rather than everyday admin controls. Forget/delete scrubs canonical entry and revision content and prevents it from being supplied again, while retaining body-free tombstones and audit facts. It cannot retract copies already present in Slack messages, model-provider processing/logs, prior exports, backups, or separate Flue transcripts; those systems keep their own retention controls.

### Routines and scheduled work (Cloudflare)

Routines are channel-owned recurring or one-time future requests. One clear natural-language request in an assigned channel creates or edits the scheduled work immediately; Chickpea replies with the normalized schedule, explicit time zone, saved task, output policy, and live-authority disclosure. Only irreversible deletion requires a second confirmation. The exact source Slack request is retained with each revision, and the normalized task is rejected if it adds an effect absent from that request or an inherited prior revision. A routine may read or write when its saved task asks it to: that saved request is the approval, using the same policy as a live tag, with no second per-routine permission matrix or token confirmation. Every occurrence re-resolves the creator's channel membership, the bot's channel access, the current profile/model, connections and shared credentials, repository grants, memory scope, egress policy, spend bounds, and sandbox availability. Saved tasks, memory, channel history, fetched content, and tool output are untrusted inputs and can narrow work but cannot grant new authority.

```text
Every weekday at 9am America/Los_Angeles, review open support requests, update the configured tracker, and post a summary here.
Tomorrow at 2pm America/Los_Angeles, post the launch report here.
Pause the routine "Support review".
!routines
!routines <#channel>
!routines show <id>
!routines pause <id>
!routines resume <id>
!routines disable <id>
!routines run <id>
!routines clone <id>
!routines delete <id>
!routines confirm <deletion token>
!routines cancel <deletion token>
```

Any current member of the owning channel can list, inspect, edit, pause, resume, disable, run, clone, or delete its routines. Natural-language management resolves an exact name only when that name appears in the current message; duplicate names produce an ambiguity response with stable IDs and make no change. The `!routines` ID commands remain the deterministic fallback. One-time jobs cannot be run-now or cloned; create another future job instead. Cross-channel listing first proves the requesting member and bot can access the mentioned channel and otherwise returns the same non-disclosing response as an unknown ID. Its result or failure is an ephemeral message in the invoking channel that only the requester can see. If the creator leaves the organization but remains a channel member, the routine can continue; if the creator is removed from the channel, Chickpea disables it before constructing an Agent or tools. A profile, connection, credential, repository, or policy change takes effect at the next occurrence without editing the routine. Actor-personal credentials are never delegated to unattended work.

The persisted schedule is either a five-field cron expression or one exact future local date/time, always paired with an explicit IANA time zone. People can use familiar phrases such as `10am PT` or `10am Pacific`; Chickpea normalizes those to an IANA zone before persistence. If the request omits a zone, Chickpea uses the requesting member's Slack profile zone when available and otherwise UTC, and shows the selected value in the receipt. Recurring schedules run no more often than every five minutes. Ambiguous fall-back times select the first instant; nonexistent spring-forward times are rejected instead of silently shifted. A fixed one-minute Cloudflare Cron Trigger finds due definitions and admits one independent Flue Workflow run per occurrence; it never reuses a Slack thread or continuing Agent session. Downtime does not burst catch-up work: Chickpea records missed recurring slots and considers only the latest slot, skips any work more than 15 minutes late, and skips an overlap while the same routine is active. A one-time job is claimed at most once and becomes `completed` after its terminal outcome, including a visible missed/skipped outcome. `post_on_change` routines suppress an unchanged result; an explicit no-op never posts.

Writes are not blindly retried after execution begins. A proven pre-submission admission failure may be retried inside its deadline; ambiguous Workflow admission is reconciled by persisted occurrence input. Slack delivery is one at-most-once attempt with a durable receipt. A delivery or tool outcome that may have succeeded but cannot be proven pauses the routine immediately for inspection. Three attributable failures pause it; live access failures disable it; infrastructure/capacity failures remain visible without pretending the saved task is bad. A successful occurrence resets the streak, and a deliberate resume resets it too. Terminal notices are sanitized and deduplicated.

The hard deployment defaults are 100 active routines, 20 per channel, 300 scheduled starts per routine per day, 600 scheduled starts per deployment per day, 10 run-now starts/day, 610 total starts per rolling day, eight starts per rolling 15 minutes, four concurrent runs deployment-wide, one active run per routine, a five-minute minimum recurring interval, a 15-minute admission grace/deadline, and 25 due claims per heartbeat. Recurring validation calculates the maximum rolling-day rate across 370 days; one-time jobs reserve only their single instant. Collision previews persist only the next three fires or 48 hours of five-minute fires and refresh as each slot advances. The eight-start rolling limit is enforced again transactionally when work is actually queued. Scheduled Work exposes these bounds, source-request provenance, completed one-time jobs, and occurrence history. Product-owned run and audit metadata is retained for 365 days; confirmed deletion immediately scrubs the saved task and source-request body from the routine revisions while retaining body-free hashes and audit facts. Slack messages, provider processing/logs, backups, and Flue's separate run history have their own retention and cannot be retracted by Chickpea.

The feature is Cloudflare-only for now and deploys **off by default**. Set `TAG_ROUTINES_ENABLED` to `"1"` in `wrangler.jsonc` and deploy only after the normal offline/workerd gates pass. The deploy wrapper refuses an enabled artifact unless the heartbeat Cron, `TAG_STATE`, routine Workflow binding, composed scheduled handler, and internal Agent route guards are all present. To roll back, set the flag to `"0"` and deploy: definitions and audit history remain inspectable and controllable, but no heartbeat scans, model calls, or Slack work run. Do not remove the Cron, Workflow binding, Durable Object state, or migrations as a rollback shortcut. Node honestly rejects create/edit/resume/run-now while retaining list/show/pause/disable/delete and Admin inspection; it does not start an in-process timer.

For troubleshooting, start in Audit Logs > Scheduled Work and inspect the safe failure class, Slack receipt, and Flue run ID. Repair current access for `creator_ineligible`, `channel_ineligible`, `assignment_missing`, `credential_unavailable`, or `access_denied`; Chickpea never falls back to another credential. Inspect Flue history before acting on `admission_unknown`, and inspect the external target before resuming `unknown_external_outcome` or `delivery_unknown`, because the write or post may already exist. Capacity and Slack-rate-limit failures remain visible and are not silently retried. Resume only after the cause is understood; it resets the failure streak without erasing history. Heartbeat logs contain stable event names, counts, maintenance totals, and duration only—never task text, prompts, channel content, credentials, model output, actor identifiers, or raw errors.

### Skills

Open a profile's Skills tab and choose **Import from URL**. The source field is always free-form: paste another person's public repository, a GitHub URL, or a skills.sh page, then choose **Find skills**. Use `owner/repo@skill` to select one skill in a large repository; scans inspect at most 40 skill directories.

If this deployment's GitHub App is connected, **Browse GitHub** searches its installations and includes private repositories. Choosing a result only fills the same editable `owner/repo` field. Pasting an exact private source works too when the App can access it, including when bounded discovery does not show it. Chickpea first tries the anonymous public path, then verifies private access against that exact repository and uses a short-lived, one-repository App token with Contents read permission. Personal access tokens and browser-supplied installation IDs are not used.

An import is a one-time snapshot, not a live link: the selected `SKILL.md` name, description, and instructions are copied into the profile draft, replace a same-named skill, and persist only when you save the profile. Those instructions may be sent to the profile's configured model when the skill is used. Scripts, assets, plugin manifests, and other repository files are not copied or executed.

Skill-source access is separate from runtime repository access. Importing from a repository does not add it to the profile's Repositories tab, and removing a runtime repository grant does not delete an already imported skill snapshot. Add a repository grant separately only when the profile itself should read or change that repository during a turn.

### Connections

Open a profile's Connections tab to add capabilities from the built-in gallery or configure a custom connection. The gallery includes OAuth and credential-based remote MCP services such as Linear, Atlassian, Notion, Sentry, Stripe, Cloudflare, Supabase, PostHog, and Airtable, plus direct API connections for Google Workspace, Asana, and Zendesk. Google Workspace uses one bring-your-own OAuth client and a shared authorization for the Gmail, Calendar, and Drive services you enable.

Connections are profile-scoped, while credentials, OAuth tokens, and dynamic client registrations are stored outside model-visible profile configuration. MCP servers expose only the tools approved for that profile. HTTP API connections are independently constrained to their configured hosts, path prefixes, and methods; credentials are injected only at the network boundary. A connection cannot widen the install's broader egress or side-effect policy.

OAuth connections surface their current identity and lifecycle state, including when reconnect is required. Changes apply to new Slack threads without restarting the app. Scheduled routine occurrences deliberately re-resolve the profile's current connections and shared credentials each time they run; Chickpea does not delegate actor-personal credentials to unattended work.

### Repositories

Connect GitHub once in Settings through the GitHub App manifest flow, the only supported authentication path for repository access and the coding sandbox. Then pick exactly which repositories each profile can use from its Repositories tab. On Cloudflare Workers, Chickpea mints down-scoped, short-lived App installation tokens per turn and injects them only at the coding sandbox egress boundary; credentials never enter agent instructions or the sandbox environment. The container coding tier requires Cloudflare Workers. Node and other non-Cloudflare installs keep the standard in-memory bash sandbox, with no host filesystem or host git/SSH credential access.

### Privacy and fail-closed guarantees

- Channels are fail-closed, public and private alike: the bot answers only where a profile is explicitly assigned. Being invited to a channel does nothing by itself.
- A mention in an unassigned channel posts nothing to the channel. The mentioner alone gets one rate-limited ephemeral hint linking to that channel's `/admin` page (`SLACK_TAG_UNASSIGNED_HINT=false` turns even that off).
- Every operational event is signature-verified; a tampered signature gets a 401 and no side effects. The one pre-setup exception is Slack's unsigned `url_verification` challenge, which is echoed before credentials exist so Retry works mid-setup.
- If `TAG_ADMIN_TOKEN` is unset, every `/admin` route returns 404 — the admin plane is invisible, not merely locked.
- Channel history is fetched per turn to build conversational context — there is no passive workspace-message index. Separately, explicit channel memory persists small team-authored notes, their revisions/audit envelope, scope lifecycle, and bounded selection epochs. Each participating thread also keeps its own agent transcript, dedupe claims, and config snapshot.
- A thread freezes its resolved profile, model, instructions, skills, MCP/API connection approvals, and repository grants at its first durable turn. Admin edits apply to new threads only; in-flight conversations keep the config they started with, even across retries or a later profile edit. DMs deliberately track current config instead.
- Failures degrade loudly, never silently: a provider error, an unresolvable model, or a context-read failure each still deliver one sanitized final reply and clear the status line.

### Models

- Anthropic, OpenAI, and OpenRouter are built-in providers. Add `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY` in Settings or as an environment secret to validate the key, populate that provider's model picker, and make it available to profiles.
- Workers AI has two runtime paths: the `cloudflare` provider uses the keyless Workers AI binding on Cloudflare, while `cloudflare-workers-ai` uses the REST API with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` on Node (or on Cloudflare when those separate REST credentials are supplied).
- `local-stub` is an offline/dev-only OpenAI-completions-compatible provider registered when `LOCAL_STUB_URL` is set.
- Each profile can pin its own model from `/admin`; the per-agent selection order is under Configuration below.
- The Slack-visible identity stays one install-wide bot (named `@Chickpea` by default). Channels > Slack reads its live Slack-owned name and avatar; the reply footer tells you which profile and model answered.

## Other ways to run it

### Cloudflare via CLI

Deploys the same artifact the button does:

```bash
npm run deploy                           # builds current source, then runs wrangler deploy
npx wrangler secret put TAG_ADMIN_TOKEN
```

`npm run deploy -- --skip-build` reuses an artifact you just produced with `npm run build`; the default always rebuilds so stale ignored output cannot be deployed accidentally.

### Self-host on any Node host

Requires Node >= 22.19 (see `.nvmrc`).

```bash
npm run flue:build                       # flue build --target node -> dist/server.mjs
```

Run `dist/server.mjs` on any host. State is file-backed SQLite. Expose the port with a tunnel or reverse proxy and point Slack's Events Request URL at `https://<host>/channels/slack/events`. Both targets run the same source — `src/config/state-backend.ts` picks SQLite or the Durable Object state store at runtime.

Scheduled routines are the one current capability-tier exception: Node can inspect and shut down existing routine state but cannot create, resume, run, or schedule it. A future persistent scheduler adapter can add another deployment target without changing the product-owned definition/run model.

### Local development

```bash
# Populate .env (auto-loaded by flue dev/build), then:
npx flue dev --target node               # dev server, default port 3583 (--port overrides)
```

Local Cloudflare dev loop, under real workerd:

```bash
npm run flue:build:cf
npx wrangler dev --config dist-cf/chickpea/wrangler.json --persist-to .wrangler-state
```

Keep `--persist-to` outside `dist-cf/`: the build output is disposable, and a rebuild would otherwise wipe your local Durable Object state. Local dev secrets live in `dist-cf/chickpea/.dev.vars` (`.dev.vars.example` documents them); `npm run flue:build:cf` snapshots and restores that file across rebuilds.

For live Slack testing without a public tunnel, enable Socket Mode in the Slack app, create an app-level `xapp-` token with `connections:write`, and put it in `SLACK_APP_TOKEN` alongside `SLACK_SIGNING_SECRET`. `npm run slack:bridge` reads `.env.slack.local` by default (or `--env <path>`) and forwards those events to the local server with genuine v0 signatures. This is dev-only: one bridge may consume events at a time, it acknowledges before local handling so Slack retry semantics are not exercised, and enabling Socket Mode pauses delivery to the HTTP Events Request URL.

### Bot identity

`slack-app-manifest.json` owns both the app name and the default bot display name ("Chickpea"), plus the description — the wizard's deep-link carries all of it, so a from-manifest install needs no manual field entry. Channels > Slack shows the live Slack-owned name and avatar, with **Refresh** and an exact **Change in Slack** link; profiles never change that install-wide identity. The avatar is the one manual setup step: upload `assets/bot-avatar.png` (referenced by `src/config/identity.ts`) under the app's Display Information, then verify the live name and icon:

```bash
SLACK_BOT_TOKEN="<bot-token>" node scripts/verify-identity-live.mjs
```

It calls `auth.test` and `users.info`, compares the display name to the manifest, and classifies the avatar as custom, default, or unknown. Requires the `users:read` bot scope.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET` | unless set via wizard | Verifies inbound Slack request signatures. An env value takes precedence over the wizard-stored one. |
| `SLACK_BOT_TOKEN` | unless set via wizard | Bot token for outbound Slack Web API calls. An env value takes precedence over the wizard-stored one. |
| `SLACK_BOT_USER_ID` | optional | Bot user id used to filter self/loop messages. If unset, taken from the wizard (stored from `auth.test`) or resolved once via `auth.test`. An explicit empty string means "no bot user id" — fail-closed for message-family events. |
| `SLACK_API_URL` | optional | Override the Slack Web API base URL (offline/fake Slack). |
| `SLACK_APP_TOKEN` | local bridge only | App-level `xapp-` token with `connections:write` used only by `npm run slack:bridge`; normal HTTP Events API deployments do not need it. |
| `SLACK_TAG_PUBLIC_URL` | optional | Public base URL for the `/admin` Configure links in reply footers and channel onboarding. If unset, Slack shows a plain `Configure` label without a link. |
| `SLACK_TAG_MODEL` | optional | Offline/dev fallback model specifier (`provider/model`) for an unpinned profile, mainly on the Node target. Pinned profiles always use their saved `agent.model`. |
| `SLACK_TAG_ALLOW_DMS` | optional | DMs are on by default; `false` makes the bot reachable only in channels. |
| `SLACK_TAG_UNASSIGNED_HINT` | optional | On by default: a mention in an unassigned channel sends the mentioner one rate-limited ephemeral hint linking to `/admin`. `false` disables the hint; the channel itself never sees anything either way. |
| `SLACK_TAG_WELCOME_ON_JOIN` | optional | On by default: when @Chickpea joins an already-assigned channel, Chickpea posts one short welcome. `false` suppresses it. |
| `TAG_AGENT_API_TOKEN` | optional | Shared internal token gating `POST /agents/slack-thread/:id` for external callers only — the app's own agent dispatch is in-process and needs no configuration. Unset is safe: the token falls back to a random per-process/per-isolate value, so the endpoint is closed to outsiders by default; set it only to authorize external callers deliberately. |
| `TAG_ADMIN_TOKEN` | optional | Bearer token for `/admin` and `/admin/api/*`. If unset, every `/admin/*` route returns 404. Separate from `TAG_AGENT_API_TOKEN`. |
| `TAG_ROUTINES_ENABLED` | Cloudflare only, optional | Deployment kill switch for scheduled routine admission. `"0"` (the committed default) performs no heartbeat state scan or unattended work; `"1"` enables the fixed Cloudflare heartbeat after the deploy wrapper validates its bindings and guards. Unsupported on Node. |
| `TAG_DB_PATH` | optional | SQLite path for the durable agent transcript. Default `./tmp/flue.db`; use `:memory:` for ephemeral runs. The default `tmp/**` path is ignored by `flue dev` watch mode. |
| `SLACK_STATE_DB_PATH` | optional | SQLite path for app-owned state: runtime config, assignments, dedupe claims, joined-thread registry, per-thread config snapshots. Defaults to `<TAG_DB_PATH>.state`; a `:memory:` transcript DB implies a `:memory:` state store, so ephemeral runs stay fully ephemeral. |
| `LOCAL_STUB_URL` / `LOCAL_STUB_API_KEY` | optional | Register the offline `local-stub` provider (OpenAI-completions wire; use `SLACK_TAG_MODEL=local-stub/<model>`). |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | optional | Enable the `anthropic` provider; `ANTHROPIC_BASE_URL` overrides its runtime inference endpoint. The key can instead be stored in Settings. |
| `OPENAI_API_KEY` | optional | Enable the built-in `openai` provider. The key can instead be stored in Settings. |
| `OPENROUTER_API_KEY` | optional | Enable the built-in `openrouter` provider. The key can instead be stored in Settings. |
| `<PROVIDER>_CREDENTIAL_ALIAS` / `<PROVIDER>_CREDENTIAL_EPOCH` | optional | Non-secret usage-reporting identity for environment-managed inference credentials. Increment the positive epoch when the underlying key rotates; if omitted, Usage reports rotation as unknown. `CHICKPEA_DEPLOYMENT_EPOCH` serves the keyless Workers AI binding. |
| `ANTHROPIC_API_URL` / `OPENAI_API_URL` / `OPENROUTER_API_URL` | optional | Override the vendor API roots used by `/admin` key validation and model discovery. These are catalog/validation endpoints, distinct from runtime inference overrides such as `ANTHROPIC_BASE_URL`. |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_WORKERS_AI_BASE_URL` | optional | Enable the REST `cloudflare-workers-ai` provider; the base URL controls runtime inference. Not required for the keyless `cloudflare` binding provider on Cloudflare. |
| `CLOUDFLARE_API_URL` | optional | Override the Cloudflare API root used by `/admin` Workers AI model discovery. |

`.env.example` lists the offline-safe defaults for the Node lane.

**Starter profile.** One seeded profile, `Default` — a neutral, general-purpose assistant with no channel assignments, so a fresh install's `/admin` shows only your real channels and first-run onboarding has no profile decision to make. `Default` answers DMs and App Home (it is the direct-message default) and is pre-selected for every new channel unless you pick another. Any additional profile you create in the Profiles modal starts from blank fields.

**Model selection, per agent:**

1. `agent.model` from the runtime config store. This explicit pin is the normal path and is never silently changed by provider keys.
2. `SLACK_TAG_MODEL` only when the profile is unpinned, as an offline/dev fallback.

If neither exists, initialization fails with an error that tells the operator to pin a model in `/admin`. Seed config is written once into an empty state DB; existing installs are not migrated. On first boot, Cloudflare seeds Default pinned to `cloudflare/@cf/zai-org/glm-5.2`; Node seeds Default unpinned so local operators pick a model or set the fallback.

## Good to know

- **GitHub is the distribution channel.** This repository is a deployable source project, not an npm library or CLI; `package.json` stays `private` to prevent accidental publication.
- **Free-tier caps are hard errors.** Workers AI allows ~10K Neurons/day and Durable Objects 100K row writes/day. A busy workspace needs a paid plan, or a provider key plus profile pins that move model spend off Workers AI.
- **The keyless model has no declared context window.** Non-catalog `cloudflare/*` models (including the default `@cf/zai-org/glm-5.2`) resolve through the binding without one, so threshold auto-compaction is disabled and long DM transcripts grow unbounded. Add a provider key and pin a catalog model, such as Claude or GPT, for bounded, auto-compacting context.
- **Single workspace.** One deploy serves one workspace via a bot token. There is no multi-workspace OAuth distribution yet.
- **`/admin` auth is a token.** A bearer token with a cookie session — no SSO. An optional Cloudflare Access layer is on the roadmap below.
- **The public v1 schema is a clean baseline.** Pre-open-source migration history was consolidated because there are no supported legacy upgrade targets; do not point v1 at a private/pre-release database expecting it to migrate. Migrations introduced after the public v1 baseline are append-only so supported public installs can carry state across later re-deploys.
- **Durability is single-host.** Dedupe, runtime config, thread registry, and snapshots are restart-durable — on one Durable Object or one SQLite file. Multi-instance deployments would need a shared store first.
- **No state backup/export on Cloudflare yet**, and the debug story is `wrangler tail`.
- **Memory export is not a full state backup.** The authenticated Memory API can export deterministic Markdown archives on Cloudflare and Node, but there is not yet a one-click backup for transcripts, config, claims, or every Durable Object table; the debug story remains `wrangler tail`.
- **The container coding sandbox is Cloudflare-only.** Node and other non-Cloudflare installs use the standard in-memory bash sandbox, not the container coding tier, and Chickpea never gives that sandbox the host filesystem or host git/SSH credentials.
- **Scheduled routines are Cloudflare-only and off by default.** Node retains inspection and shutdown controls but has no scheduler. Enabling on Cloudflare requires the committed Cron/Workflow/state seams, which `npm run deploy` validates before upload.
- **Connection authoring is trusted operator configuration.** Connections can be created only through token-gated `/admin`; use services you trust. MCP URLs must use HTTPS and pass hostname, literal-address, configured-origin, and same-origin redirect guards at save, test, and turn time. On Node, Chickpea resolves every request, rejects the full DNS answer set if any address is private or reserved, and pins the HTTPS connection to the validated public answers; redirect hops are revalidated. Workers expose no DNS-resolution API, so that lane retains the literal/hostname/origin/redirect guards and delegates address routing to the platform. HTTP API connections are separately scoped to exact hosts, path prefixes, and methods, with credentials injected only at the network boundary.

## Where this is heading

Direction, not commitment — open an issue if one of these matters to you; that is how they get ordered.

- **Optional Cloudflare Access for `/admin`.** In-worker verification of the `Cf-Access-Jwt-Assertion` JWT, skipping the token gate when configured. It has to be in-worker: a hostname-wide Access policy would block Slack's event webhooks.
- **A guided `npx chickpea deploy`.** The same artifact the button ships, driven from the terminal.
- **Multi-workspace Slack OAuth distribution**, so one deploy can serve several workspaces with per-workspace tokens.
- **Connection and network audit visibility.** The connection gallery, OAuth lifecycle, API scopes, and DNS-pinned Node transport have shipped; the reserved Network Events audit domain is the next place to expose connector, tool, and egress history without leaking credentials or payloads.
- **More OpenAI-compatible endpoints in the `/admin` model picker**, such as Ollama and self-hosted gateways. Anthropic, OpenAI, OpenRouter, and both Workers AI paths are already supported.
- **Usage visibility in `/admin`**: Workers AI Neuron and Durable Object write budgets, surfaced before the free-tier caps turn into errors.
- **State export/backup and a documented post-v1 upgrade path** — release tags plus a template-sync flow, backed by append-only public migrations.
- **Additional proactive triggers**, such as channel watches and GitHub subscriptions, behind the same product-owned routine/run/audit model. The current release supports explicit schedules only.

## Tests and verification

The behavior described above is a tested contract, not a description.

```bash
# Full suite: typecheck + node --test. The parity suite spawns the built app and drives it over HTTP.
# If your default node is older than 22.19, point the spawn at a newer binary:
FLUE_NODE_BIN=/path/to/node npm test
```

The parity suite covers signature checks, dedupe, streaming fallbacks, fail-closed admission, thread snapshots, explicit memory controls, routine parsing and authorization, schedule and admission policy, delivery leases, scope/lifecycle isolation, deterministic bounded prompt selection, and memory conversation epochs, alongside admin/config-store checks, identity checks, fake-Slack smoke tests, Slack formatting, the model resolver, and turn-normalization/history-window units. Set `TAG_REQUIRE_LOOPBACK=1` (what `npm run test:ci` does) so a loopback-denied environment fails instead of silently skipping the parity run.

Offline, net-guarded evidence scripts (run with Node >= 22.19 on `PATH`) spawn the real app against a fake Slack/provider backend and assert zero external network traffic (`scripts/net-guard.mjs`):

```bash
node scripts/verify-flue-offline-turn.mjs
node scripts/verify-agent-config.mjs
npm run verify:durability
npm run verify:providers
npm run verify:admin-ui
npm run verify:routines-runtime
npm run verify:cf-smoke
npm run verify:oss-export
```

`verify:admin-ui` exercises the authenticated admin plane, including the Scheduled Work inventory/detail/control flow and a real Memory scope/index, versioned edit conflict, and irreversible delete contract. `verify:routines-runtime` builds an isolated workerd fixture and verifies heartbeat Cron composition, RoutineStore atomicity, independent Flue Workflow admission, private route guards, and bounded run-history visibility. `verify:durability` proves transcript/config state plus memory and routine-definition/run replay across a file-backed SQLite restart. `verify:cf-smoke` builds the Cloudflare bundle and boots it under real workerd (`wrangler dev`), driving the full first-run story with no Slack credentials: seeding from the Durable Object store, fail-closed 401s before the wizard, wizard validation and persistence, signed Slack delivery, dedupe, Memory state across a workerd restart, routine Cron/Workflow/binding guards with the feature disabled, and tampered-signature rejection — with every outbound URL pointed at loopback.

`verify:oss-export` rehearses the committed GitHub source export in a clean scratch directory, runs its offline verification, and finishes with the real build-before-deploy entrypoint under `wrangler deploy --dry-run`.

`npm run verify:providers:live` is an explicit, credential-gated companion for maintainers. It runs each configured Anthropic, OpenAI, OpenRouter, or Workers AI lane against the real provider while Slack remains on the loopback fake and the network guard blocks every unapproved host. It prints pass/fail evidence to stdout and does not write model replies or internal provenance artifacts into the repository.

## Contributing

Issues and PRs welcome — the roadmap above is shaped by them. Run `npm test` before sending a PR (with `FLUE_NODE_BIN` if your default node is older than 22.19).

## License

MIT.

## More

- `slack-app-manifest.json` + `assets/bot-avatar.png` — the default Slack app identity
  for fresh installs. The manifest carries the scopes and event subscriptions the bot
  needs; the `/admin` wizard's "Create your Slack app" link applies it for you.
- `.env.example` / `.dev.vars.example` — offline-safe defaults for the Node and Cloudflare targets.
