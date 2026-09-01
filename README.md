<p align="center">
  <img src="assets/chickpea-mark.png" alt="" width="96" height="96">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/chickpea-wordmark-512-dark.png">
    <img src="assets/chickpea-wordmark-512.png" alt="Chickpea" height="56">
  </picture>
</p>

<p align="center">
  <strong>AI teammates in Slack that answer questions, take on tasks, and use the accounts you give them — running on infrastructure you own.</strong>
</p>

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-555555.svg?labelColor=333333&color=2EA44F)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.19-555555?labelColor=333333&color=339933)](https://nodejs.org)
[![Runs on](https://img.shields.io/badge/Runs_on-Cloudflare_Workers_or_Node-555555?labelColor=333333&color=F38020)](#install)
[![Built on Flue](https://img.shields.io/badge/Built_on-Flue-555555?labelColor=333333&color=DDA126)](https://flueframework.com)

<br />

**Deploy it**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pejmanjohn/chickpea)

<sub><em>or run it on your own box — full steps in <a href="#node">Install</a></em></sub>

<br />

[Why it exists](#why-chickpea-exists) · [Features](#what-your-workspace-gets) · [How it works](#how-it-works) · [Run it from Slack](#run-it-from-slack) · [Security](#security-model) · [Install](#install) · [Good to know](#good-to-know) · [FAQ](#faq)

</div>

Chickpea gives your team AI coworkers in Slack. You address them by name. `@support` answers the billing question in the channel where someone asked it. `@revops` pulls the numbers every Monday morning without being asked twice. `@oncall` reads the repo before it answers. Each one has its own instructions, its own memory, its own connected accounts, and its own list of channels it's allowed to work in. You set all of that up by asking, in Slack.

The difference is where they work. Chickpea is MIT-licensed and you deploy it yourself, to your own Cloudflare account or your own server, pointed at whichever model provider you want. Two optional exceptions, both yours to decline: the shared Slack gateway, and Composio if you want managed connectors instead of wiring OAuth yourself. Both are [explained below](#security-model).

And Chickpea doesn't roll its own agent machinery. Every Agent runs on [Flue](https://flueframework.com), the open agent framework built by the Astro team at Cloudflare on top of **Pi**, the open agent harness behind OpenClaw. More on that in [How It Works](#how-it-works).

---

## Why Chickpea Exists

Your team already uses AI all day, one person at a time in a private tab. The answers never make it back to anyone else. Ask in the channel instead:

> **`@growth`** which pages lost impressions in Search Console last month?

`@growth` checks Search Console, cross-references Google Analytics, and answers in the thread. `@sales` pulls the recurring objections out of this week's Gong calls. `@eng` names the top new Sentry issue since Friday's deploy. `@ops` reads the quarterly deck in Drive and takes questions on it. Ask any of them to update a HubSpot record or move something on your Google Calendar and they confirm with you first. Everyone in the channel sees the answer, and anyone can pick it up later without starting over.

The hosted versions of this idea work at the vendor: their infrastructure, their model, their roadmap. Good products, and for a lot of teams that trade is fine. For the rest, the alternative has mostly been nothing.

Chickpea is that alternative, and it's MIT-licensed. Deploy it to your own Cloudflare account or your own Node host, and point each Agent at whichever model provider you want. Each Agent keeps its own memory, its own connected accounts, and its own list of channels. The support Agent can't read finance's inbox, because nobody ever gave it to them. Need isolation? Make another Agent. That is the whole mental model.

---

## What Your Workspace Gets

| Feature | What it does | |
|---|---|---|
| **Addressable Agents** | Each Agent gets a real Slack handle (a zero-member user group like `@support`), a distinct generated avatar, and its own name on every reply. | |
| **Agent memory** | One memory per Agent, shared across its DMs and every granted channel, editable and deletable in Admin. | [Details](#memory) |
| **Connection accounts** | Team accounts and personal accounts, each owned permanently by one Agent: 35 connector presets (13 managed on a single Composio key, 22 more over hosted MCP or direct API), and native API and MCP for anything custom. | [Details](#connections-and-authority) |
| **Model choice** | Anthropic, OpenAI, OpenRouter, Cloudflare Workers AI, or a ChatGPT subscription, pinned per Agent. | [Details](#models-and-providers) |
| **Skills** | Paste a GitHub repo or `skills.sh` link in Admin, or hand the link to an Agent in Slack; either way Chickpea reads the `SKILL.md` files and shows exactly which skills it found before importing. | |
| **Repositories** | Grant GitHub repositories to an Agent through the Chickpea GitHub App (Settings → GitHub). Access uses short-lived installation tokens scoped to the granted repositories. | |
| **Coding sandbox** | Optional Cloudflare container tier for work needing a real checkout, package installation, tests, or a dev server. | [Details](#coding-sandbox) |
| **Schedules** | Agent-owned recurring or one-time work, set up conversationally in Slack, delivered to a granted channel or a private DM thread. | [Details](#schedules) |
| **Run it from Slack** | Create Agents, install skills, set schedules, edit memory, and start connector setup by asking, with consequential changes gated behind an approval. The same surface is an MCP server, so any MCP client you already use can drive it too. | [Details](#run-it-from-slack) |
| **Slack-native answers** | Progressive streaming for long replies, adaptive tables (prose, inline Markdown, or a native sortable Slack table) when the data earns one, and task cards for multi-step work. | |
| **Live activity status** | Slack's native under-composer status shows real phases as they happen: `Checking Gmail…`, `Drafting the response…`. | |

---

## How It Works

Six nouns, and you know the system.

- **Agent** — the only behavior boundary. Presentation, instructions, model, skills, repositories, connections, one memory, channel grants, schedules.
- **Slack installation** — one native `@Chickpea` bot providing Events, DMs, App Home, and delivery. It is transport, not a second kind of Agent.
- **Agent handle** — a zero-member Slack user group. Slack renders the mention, Chickpea routes it and replies as that Agent.
- **Channel grant** — permission for one Agent to work in one channel. Many Agents may share a channel.
- **Thread route** — the Agent that owns a thread. Any current channel member may continue it.
- **Connection account** — one team or personal authorization, belonging permanently to one Agent.

Publishing an Agent to a channel gives that channel's members its complete boundary. Think about that before you publish.

**Built on battle-tested layers.** Chickpea deliberately doesn't reinvent the hard parts. The agent runtime is [Flue](https://flueframework.com) ([`@flue/runtime`](https://www.npmjs.com/package/@flue/runtime)), the Apache-licensed open agent framework from the [Astro](https://astro.build) team, now part of Cloudflare: durable sessions that survive crashes and restarts, persistent state, subagents, tools, skills, and MCP, written once and deployed to Cloudflare Workers or Node against any model provider. Flue runs on **Pi**, the open agent harness that powers OpenClaw. And production deploys sit on Cloudflare's own platform primitives — Workers, Durable Objects, D1, Workers AI — not custom infrastructure. Chickpea is the layer those foundations don't provide: the Slack product, the authority model, the admin surface, and the deployment story.

---

## Slack Experience

Mention `@Chickpea` for the workspace default Agent, or an Agent handle like `@support` for that one. Two Agent handles in one message are rejected as ambiguous; Chickpea will not guess.

Publishing the first Agent to a public channel joins the base bot automatically. Private channels need someone to `/invite @Chickpea` first, and the grant stays pending until membership is verified.

Who can DM an Agent follows from where it's published: publish to a public channel and any workspace member can DM it, keep it only in private channels and only those members can, leave it unpublished and it stays creator-only.

**Root chatter is ignored.** A message that doesn't mention anyone never triggers classification, model spend, memory writes, or work. Chickpea is not sitting in your channels forming opinions.

Chickpea reads images, PDFs, UTF-8 text and source files, and Slack's generated previews for docs, slides, and sheets. Attachment turns are read-only: file contents can inform an answer but cannot authorize a tool or a change.

<details>
<summary><strong>If Slack blocks user-group creation</strong></summary>

Agent handles are Slack user groups, which some plans restrict. If Slack blocks the group, Chickpea keeps the Agent and shows the exact fix:

1. A Workspace Owner or Admin opens **Roles & permissions → Account types** at `slack.com/admin`.
2. Next to **Create and edit user groups**, choose **Edit permission**.
3. Add Members and save.
4. Return to the Agent and choose **Retry**.

On Enterprise Grid it's the equivalent setting under **Organization settings → Roles & permissions**. Reconnecting Slack cannot repair a policy, so Chickpea won't suggest it.

</details>

<details>
<summary><strong>Attachment limits</strong></summary>

Per turn: 4 files, 8 MiB each, 12 MiB total, 100 PDF pages, 32,000 characters per file and 48,000 total. Images use Slack's bounded thumbnails when available. Anything over a limit, or without a safe conversion, gets a file-specific next action instead of a quiet partial read. Slack installations predating the `files:read` scope must reconnect once.

</details>

---

## Connections and Authority

Every connection belongs to one Agent for its lifetime. A **team account** is shared authority the Agent's editors manage, like the support team's Zendesk. A **personal account** belongs to one member inside one Agent, like your work Gmail, and runtime use requires both that Agent's connection and your identity. Authorizing the same external account for a second Agent creates a separate connection with its own consent.

**Credentials never enter model context or the tool arguments the model writes.** The model picks a connection by ID; the runtime resolves the secret at the moment of the call and injects it at egress. An interrupted OAuth flow resumes bound to the provider, the account owner, the Agent, and the exact Slack task it left. Disconnecting revokes that one connection, tombstones secret access, and retires it from dependent schedules.

Minor reversible writes may proceed without confirmation. Consequential ones (sending a message or email, deleting, publishing, broad or bulk changes) require confirmation unless the saved Agent instructions explicitly authorize that class of action. **Conversation cannot expand authority:** no message text and no API response can talk an Agent into more than it was given.

What you can connect:

<table>
  <tr>
    <th colspan="5" align="left">Managed · one Composio key</th>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/gmail" width="14" height="14" alt=""> Gmail</td>
    <td><img src="https://cdn.simpleicons.org/googlecalendar" width="14" height="14" alt=""> Google Calendar</td>
    <td><img src="https://cdn.simpleicons.org/googledrive" width="14" height="14" alt=""> Google Drive</td>
    <td><img src="https://cdn.simpleicons.org/googlesheets" width="14" height="14" alt=""> Google Sheets</td>
    <td><img src="https://cdn.simpleicons.org/googledocs" width="14" height="14" alt=""> Google Docs</td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/googleslides" width="14" height="14" alt=""> Google Slides</td>
    <td><img src="https://cdn.simpleicons.org/googlesearchconsole" width="14" height="14" alt=""> Search Console</td>
    <td><img src="https://cdn.simpleicons.org/googleanalytics" width="14" height="14" alt=""> Google Analytics</td>
    <td><img src="https://cdn.simpleicons.org/notion/000000/ffffff" width="14" height="14" alt=""> Notion</td>
    <td><img src="https://cdn.simpleicons.org/hubspot" width="14" height="14" alt=""> HubSpot</td>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/googleads" width="14" height="14" alt=""> Google Ads</td>
    <td><img src="https://cdn.simpleicons.org/youtube" width="14" height="14" alt=""> YouTube</td>
    <td>Gong</td>
    <td colspan="2"></td>
  </tr>
  <tr>
    <th colspan="5" align="left">Presets · the vendor's hosted MCP server, with OAuth or an API key</th>
  </tr>
  <tr>
    <td>Ahrefs</td>
    <td><img src="https://cdn.simpleicons.org/airtable" width="14" height="14" alt=""> Airtable</td>
    <td><img src="https://cdn.simpleicons.org/atlassian" width="14" height="14" alt=""> Atlassian</td>
    <td><img src="https://cdn.simpleicons.org/cloudflare" width="14" height="14" alt=""> Cloudflare</td>
    <td>Exa</td>
  </tr>
  <tr>
    <td>Firecrawl</td>
    <td>Fireflies</td>
    <td>Gamma</td>
    <td>Granola</td>
    <td><img src="https://cdn.simpleicons.org/huggingface" width="14" height="14" alt=""> Hugging Face</td>
  </tr>
  <tr>
    <td>incident.io</td>
    <td><img src="https://cdn.simpleicons.org/intercom/000000/ffffff" width="14" height="14" alt=""> Intercom</td>
    <td><img src="https://cdn.simpleicons.org/linear" width="14" height="14" alt=""> Linear</td>
    <td>LunarCrush</td>
    <td>Monday.com</td>
  </tr>
  <tr>
    <td>Neon</td>
    <td><img src="https://cdn.simpleicons.org/posthog" width="14" height="14" alt=""> PostHog</td>
    <td><img src="https://cdn.simpleicons.org/sentry/362D59/ffffff" width="14" height="14" alt=""> Sentry</td>
    <td><img src="https://cdn.simpleicons.org/stripe" width="14" height="14" alt=""> Stripe</td>
    <td><img src="https://cdn.simpleicons.org/supabase" width="14" height="14" alt=""> Supabase</td>
  </tr>
  <tr>
    <th colspan="5" align="left">Presets · direct HTTP API</th>
  </tr>
  <tr>
    <td><img src="https://cdn.simpleicons.org/asana" width="14" height="14" alt=""> Asana</td>
    <td><img src="https://cdn.simpleicons.org/zendesk/03363D/ffffff" width="14" height="14" alt=""> Zendesk</td>
    <td colspan="3"></td>
  </tr>
  <tr>
    <th colspan="5" align="left">Native · bring your own</th>
  </tr>
  <tr>
    <td colspan="5">Any service with an HTTP API or a remote MCP server. Bearer tokens and custom headers supported.</td>
  </tr>
</table>

<sub>Gmail, Google Calendar, and Google Drive can also connect through your own Google Cloud OAuth client instead of Composio.</sub>

Managed connectors run through one Composio project key, added under **Settings → Connectors**. Sign-in happens in Composio's hosted UI and Chickpea polls for completion, so a self-hosted install needs no public OAuth callback URL. Opting in means Composio holds OAuth storage, refresh, and API execution for those accounts; Chickpea still owns account selection, capability limits, confirmation policy, and the exact provider account used on every call. See the [managed connector runbook](docs/runbooks/composio-managed-connectors.md).

---

## Run It From Slack

You don't open the admin panel to add a teammate. You ask for one.

> **`@Chickpea`** make me a support agent that answers billing questions and knows our refund policy

It creates the Agent, gives it a handle and an avatar, and publishes it to a channel you name. Everything after that stays in Slack too. Hand an Agent a GitHub link and it reads the `SKILL.md` files and shows you which skills it found before importing any of them. Tell it to check in every Monday and it saves the schedule. Ask it to update its memory, archive an Agent, or publish to another channel you're in, and it does. Ask it to connect a service and it hands back a secure Chickpea link, because OAuth sign-in finishes in the browser. Admin is still there for the setup that isn't day-to-day: the Composio project key, the GitHub App, the coding sandbox install.

The base Chickpea Agent can create Agents and edit any Agent you're permitted to edit. A routed Agent can inspect and edit only itself, still bound by your permissions. Anything it inferred rather than you stated, and anything touching what an Agent can do, where it can go, or what gets deleted, arrives as a frozen read-only proposal. Nothing applies until you approve it. Simple reversible single-field edits skip the ceremony.

The same management surface is an MCP server, so any MCP client you already use can drive Chickpea too, scoped to that requester's permissions and held to the same approvals. The authoring guide is published at `chickpea://guide/agent-authoring/v1`. See the [workspace management MCP runbook](docs/runbooks/workspace-management-mcp.md) for authority and proposal semantics.

---

## Memory

One memory per Agent, no partitions. The same body informs its DMs and every granted channel.

That simplicity has a real consequence worth stating plainly: **something learned in a private conversation can influence a later channel answer.** If you need an isolation boundary, use a separate Agent. Memory is not it.

Memory is advisory, never policy. Live instructions, current permissions, and verified grant state win. Secrets, tokens, sensitive personal data, and untrusted quoted instructions are rejected on the way in.

---

## Schedules

Schedules belong to an Agent, target a granted Slack destination or a private DM thread, and record their creator as **Runs as**. Ask for one in Slack and the Agent sets it up.

Every run rechecks the whole chain: is the Agent alive, does it still have the channel, is the creator still a member, do the required connections still work, does policy still allow it. If authority disappears, future runs pause. Chickpea never silently reassigns work to someone else. Cloudflare supplies the production scheduler; Node keeps inspection and shutdown controls but runs no timers.

---

## Models and Providers

Bring your own: **Anthropic**, **OpenAI**, **OpenRouter**, or **Cloudflare Workers AI**. Cloudflare deploys can use the keyless binding provider and skip the API token entirely. Keys go in environment variables or in Settings, whichever you prefer.

You can also connect a **ChatGPT subscription** in Settings and use it as a model lane alongside API keys. The model catalog marks which models are reachable through the subscription and which need a key.

Every Agent can be pinned to its own model. A cheap fast model for triage, a strong one for the Agent that writes.

---

## Coding Sandbox

The default Cloudflare deploy is the **core profile**: no container, no image build, small and fast. Normal Slack replies, administration, GitHub browsing, and repository-aware model work need none of it.

Install the coding sandbox when an Agent needs a real checkout, package installation, tests, or a dev server. Open **Settings → Coding sandbox**, request installation, redeploy. It requires **Workers Paid**, since the container application and Ubuntu-based image live in, and may incur costs on, your Cloudflare account, and the first image build takes several minutes. Node installations always use the standard in-memory bash sandbox and never touch the host filesystem or host git and SSH. Full procedure in the [coding sandbox runbook](docs/runbooks/coding-sandbox-deployment.md).

---

## Security Model

The short version of why this shape is safer than the alternatives:

- **No ambient listening.** Unmentioned root messages never trigger classification, model spend, memory writes, or work. There is no "read the channel and decide if you're needed" mode.
- **Credentials never reach the model.** Never in model context, never in the tool arguments the model writes. The model picks a connection by ID; the runtime resolves the secret at the moment of the call and injects it at egress.
- **Conversation cannot expand authority.** Authority comes from stored grants and saved instructions, read from stored state and re-checked at the moment of each use, never from anything produced during the turn. Message text, retrieved content, and tool output are data, never permission.
- **Confirmation for consequential actions**, unless saved Agent instructions explicitly authorize that class.
- **Per-Agent isolation.** Connections, memory, skills, repositories, and reach all stop at the Agent. Nothing is reused across Agents implicitly.
- **Slack OIDC is the only human sign-in.** No passwords. The first installer becomes the first Owner, bound to an exact workspace and user tuple. Email is mutable contact information, never the identity key. See [authentication](docs/authentication.md).
- **An editor may publish only to a channel they belong to.** Chickpea Admin status does not bypass Slack channel membership.
- **Self-hosted state.** Runtime, model traffic, configuration, memory, and connector credentials stay in infrastructure you operate. The exception is opting into Composio-managed connectors, which delegates OAuth storage, refresh, and API execution for those accounts to Composio. Native API and MCP connections keep their credentials with you.

The other exception is the optional shared Slack-app gateway, which exists so you can skip Slack app configuration entirely. It stores encrypted installation credentials and sanitized health metadata, and **no Slack event payloads**. It is online-only: when your deployment is offline, events are acknowledged and dropped rather than stored for replay. If you'd rather it not exist in your path, pick the customer-owned Slack app lane, which talks directly to your deployment and never loads the gateway client.

---

## Install

### Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pejmanjohn/chickpea)

Deploy, then open the private setup link and pick a Slack lane:

- **Add to Slack** installs the unlisted shared Chickpea app through the private gateway. No configuration token, client secret, signing secret, public Events URL, or app-level token required from you.
- **Use your own Slack app** creates and installs a customer-owned app from the reviewed manifest. The compact configuration-token path is primary, with the illustrated manual manifest journey as fallback. Step-by-step in [SETUP_AGENT.md](SETUP_AGENT.md).

Setup then runs four steps: connect Slack, choose a provider, choose a model, and try it. The last step has you message Chickpea in Slack. A real reply is the proof.

App installation and browser sign-in are deliberately two different OAuth jobs. Installation grants bot scopes; sign-in requests `openid profile email` and binds you as the first Owner.

Uses Cloudflare Workers, Durable Objects, D1, and Workers AI.

### Node

Requires Node **>=22.19.0**.

```bash
git clone https://github.com/pejmanjohn/chickpea && cd chickpea
npm install

# 32 random bytes, stable across restarts
export CHICKPEA_AUTH_SECRET=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')

npm run setup:link -- https://your-chickpea.example
```

`setup:link` takes the URL your deployment will answer on and prints three things: a `CHICKPEA_SETUP_CAPABILITY_DIGEST`, a `CHICKPEA_SETUP_CAPABILITY_ISSUED_AT`, and the private setup link itself. Export the first two:

```bash
export CHICKPEA_SETUP_CAPABILITY_DIGEST=...
export CHICKPEA_SETUP_CAPABILITY_ISSUED_AT=...

npm run dev
```

Then open the private link and follow the same Slack flow as above.

State defaults to SQLite. Set `TAG_DB_PATH=:memory:` and `SLACK_STATE_DB_PATH=:memory:` only for disposable development.

### Configuration

Chickpea is offline-safe by default. Left unset, most variables take a local path. These are the ones worth knowing:

| Variable | When | Purpose |
|---|---|---|
| `CHICKPEA_AUTH_SECRET` | required on Node, managed on Cloudflare | Stable internal signing authority. |
| `SLACK_SIGNING_SECRET` | customer-owned Slack lane | Verifies direct Events API requests. Setup can store it instead. |
| `SLACK_BOT_TOKEN` | customer-owned Slack lane | Direct Slack Web API credential. Setup can store it instead. |
| `CHICKPEA_GATEWAY_URL` | optional | Shared-app gateway origin. Defaults to the Chickpea-operated service; override only for a compatible private gateway. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | optional | Enable the matching provider. Can be stored in Settings instead. |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | optional | Enable REST Workers AI. Cloudflare deploys can use the keyless binding provider instead. |
| `COMPOSIO_API_KEY` | optional | Deployment-managed alternative to adding the project key in **Settings → Connectors**. Never enters a runtime plan or model context. |
| `TAG_DB_PATH` / `SLACK_STATE_DB_PATH` | optional, Node | SQLite paths for durable transcripts and app-owned state. |
| `CHICKPEA_RECOVERY_TOKEN` | optional break-glass | One short-lived repair capability. Never a login credential. |

The full surface, including per-connector Composio auth config IDs and the Google Ads and YouTube quota and policy assertions, is documented in [.env.example](.env.example), with setup procedures in the [managed connector runbook](docs/runbooks/composio-managed-connectors.md) and repair steps in the [Slack auth recovery runbook](docs/runbooks/slack-auth-recovery.md).

---

## Good to Know

- One deployment currently serves one Slack workspace.
- The shared gateway is private infrastructure. Its implementation and Slack credentials are intentionally absent from this public repository, and it does not queue Slack event bodies while your deployment is offline.
- Updates are manual. The Cloudflare Deploy button clones this repository rather than forking it.
- Node durability is single-host SQLite. Multi-instance Node needs a shared state service.
- Cloudflare free-tier model and Durable Object limits are hard platform limits under load.
- The coding sandbox and scheduled execution are Cloudflare-only. Node uses the in-memory execution path and no scheduler.
- This is a clean-slate pre-release schema. There is no migration or compatibility promise for earlier databases.

---

## FAQ

**"Why not just run one bot with every tool connected?"**
Because then every channel that bot is in has every credential that bot holds, and everything it learns anywhere it can say anywhere. Agents exist so you can put a wall between support's Zendesk and finance's spreadsheets without running a second deployment.

**"What does this cost to run?"**
Chickpea itself is MIT-licensed with no per-seat pricing and no metering. You pay your model provider directly, whether that's an API key or a ChatGPT subscription. Workers, Durable Objects, D1, and Workers AI usage runs in your own Cloudflare account under whatever plan you're on, and the optional coding sandbox requires Workers Paid. Running on your own Node host, the infrastructure bill is whatever that host costs you.

**"How do I see what an Agent actually did?"**
Most of it is already visible: work happens in Slack threads, in the open, under the Agent's own name. In Admin, the Memory tab shows exactly what an Agent retained (and lets you edit or delete it), and the Schedules tab shows status, last run, next run, and a run-history and activity inspector for scheduled work. Be aware of the deliberate gap: activity telemetry is fixed-schema and content-free by design, and Admin has no searchable conversation archive. The conversation itself lives in Slack and in your deployment's transcript store.

**"What is Flue?"**
The open agent framework Chickpea is built on ([`@flue/runtime`](https://www.npmjs.com/package/@flue/runtime) · [flueframework.com](https://flueframework.com) · [github.com/withastro/flue](https://github.com/withastro/flue)). Flue comes from the Astro team, now part of Cloudflare, is Apache-2.0 licensed, and provides the programmable TypeScript harness: durable sessions, persistent state, subagents, tools, skills, and MCP. It runs on Pi, the open agent harness behind OpenClaw. Chickpea is the Slack product on top: the authority model, the admin surface, and the deployment story.

---

## Development

```bash
npm install
npm test                    # typecheck + node --test over tests/
npm run dev                 # local Node lane
npm run build               # Cloudflare build
```

Targeted checks worth knowing:

```bash
npm run verify:admin-ui
npm run verify:cf-smoke
npm run verify:providers
npm run verify:management-mcp
npm run verify:oss-export
```

Node **>=22.19.0** is pinned in `.nvmrc`. Several `verify:*:live` variants exist for provider- and Slack-touching evaluations; they are opt-in because they spend real quota. Live Slack acceptance should run against a disposable paid workspace so user-group policy, handle collisions, public auto-join, private invitation, App Home, avatar updates, archive, and restore all get exercised for real.

---

## License

[MIT](LICENSE) — use it, fork it, run it for your company, sell what you build on it.
