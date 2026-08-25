# <img src="assets/chickpea-mark.svg" alt="" width="34" height="34"> Chickpea

**Self-hosted, model-agnostic Slack Agents with distinct handles, avatars, memory, connections, and schedules.**

Chickpea turns one Slack app into a team of clearly addressed Agents. Each Agent owns its name, instructions, model, tools, connection policy, repositories, Slack handle and avatar, memory, Channel grants, and schedules. A Channel grants reach; it does not create another personality or memory.

The base `@Chickpea` bot remains the installation entry point. Teammates can DM it, choose a specific Agent from App Home, mention an Agent handle such as `@support` in a granted Channel, or continue a thread that Agent already owns. Root Channel chatter without an explicit entry point is ignored.

Chickpea is built on [Flue](https://www.npmjs.com/package/@flue/runtime) and is MIT-licensed. The open-source deployment keeps its runtime, model traffic, configuration, memory, and connector credentials in infrastructure you operate. The optional shared Slack-app gateway is a private Chickpea-operated transport service; the customer-owned Slack app lane remains fully independent.

## Product model

- **Agent:** the only behavior boundary. It owns presentation, instructions, model, skills, repositories, connections, one shared memory, Channel grants, and schedules.
- **Slack installation:** one native `@Chickpea` bot that provides Events, DMs, App Home, and message delivery. It is transport, not a second kind of Agent.
- **Agent handle:** a zero-member Slack user group such as `@support`. Slack renders the mention; Chickpea routes it to the Agent and replies with that Agent's name and avatar.
- **Channel grant:** permission for one Agent to work in one Channel. Several Agents may be granted to the same Channel.
- **Thread route:** the Agent that owns a Slack thread. Any current Channel member may continue it; an explicit different Agent handle performs a visible handoff.
- **Connection account:** one reusable team or personal authorization. Agents bind to allowed accounts without copying credentials.

Publishing an Agent to a Channel grants that Channel's members access to the Agent's complete shared boundary, including its memory and configured capabilities. Use separate Agents when information or authority must remain isolated.

## Install

### Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pejmanjohn/chickpea)

1. Deploy Chickpea and open the private setup link.
2. Choose a Slack installation lane:
   - **Add to Slack:** installs the unlisted shared Chickpea app through the private gateway. No Slack configuration token, client secret, signing secret, public Events URL, or app-level token is required from the operator.
   - **Use your own Slack app:** creates and installs a customer-owned app from the reviewed manifest. The compact configuration-token path is primary; the illustrated manual manifest journey remains available as the fallback.
3. Sign in with Slack as the installer to become the first Chickpea Owner.
4. Choose an initial Channel, publish the Default Agent there, and send a real Slack mention.

The two OAuth jobs are intentionally separate. App installation grants bot scopes; browser sign-in requests `openid profile email` and binds the exact Slack workspace/user tuple. Email is retained as mutable contact information, never as the identity key.

The shared gateway is online-only by design. If a deployment is disconnected, Slack events are acknowledged and dropped rather than stored for replay. The gateway stores encrypted installation credentials and sanitized health metadata, but no Slack event payloads. A customer-owned app talks directly to the deployment and never loads the gateway client.

### Node

```bash
npm install
npm run setup:link -- https://your-chickpea.example
npm run dev
```

Use the generated private setup link, then follow the same Slack flow. Node state defaults to SQLite. Set `TAG_DB_PATH=:memory:` and `SLACK_STATE_DB_PATH=:memory:` only for disposable development.

## Slack experience

### DMs and App Home

The normal designated Default Agent answers direct messages to `@Chickpea`. App Home lists only Agents the member may discover: Agents they can edit and Agents granted to Channels they belong to. Selecting one opens an Agent-routed DM thread with that Agent's presentation and capabilities.

Guests and Slack Connect users may converse in a granted Channel, but they are not automatically provisioned as Chickpea members and cannot create Agents or personal connections.

### Agent handles and avatars

Every Agent has an editable handle and avatar. A generated avatar is assigned on creation from a Chickpea-specific visual theme and stable random seed; each new Agent receives a different variation. Uploading a replacement creates a new immutable avatar revision. The next reply uses the current Agent revision without rewriting old Slack messages.

Agent handles are Slack user groups. Publishing or editing a handle reconciles the group automatically. Slack may require a paid plan and may restrict user-group creation to Owners/Admins. When Slack blocks reconciliation, Chickpea keeps the Agent and shows the exact recovery:

1. A Slack Workspace Owner or Admin opens **Roles & permissions → Account types** at `slack.com/admin`.
2. Next to **Create and edit user groups**, choose **Edit permission**.
3. Add Members and save.
4. Return to the Agent and choose **Retry**.

On Enterprise Grid, an Org Owner changes the equivalent permission under **Organization settings → Roles & permissions**.

Reconnecting Slack cannot repair that policy, so Chickpea does not recommend it for this error.

### Channels and threads

- Publishing the first Agent to a public Channel joins the base bot automatically.
- Private Channels require a member to `/invite @Chickpea`; the grant remains pending until membership is verified.
- Mention `@Chickpea` to invoke the workspace's Default Agent. If that Agent is not granted there, Chickpea refuses and lists only Agents available in that Channel.
- Mention an Agent handle to invoke that Agent. Multiple Agent handles in one message are rejected as ambiguous.
- Reply in an Agent-owned thread without repeating the handle to continue with the same Agent.
- Mention another permitted Agent in the thread to hand it off.
- Unmentioned root messages never trigger classification, model spend, memory writes, or work.

Slack only sends user-group mention events to an app that can see the Channel. Chickpea can explain a denied grant when the base bot is present; it cannot answer where Slack sends no event.

## Admin experience

The authenticated Admin surface is Agent-first:

- **General:** name, description, instructions, model, lifecycle, and edit policy.
- **Slack:** handle, avatar, publication state, recovery status, and retry.
- **Channels:** many-to-many Channel grants and verified bot membership.
- **Connections:** team and personal connection accounts bound to the Agent.
- **Skills and repositories:** approved capabilities owned by the Agent.
- **Memory:** one editable Agent memory used in Channels, App Home, and DMs.
- **Schedules:** Agent-owned scheduled work with destination and explicit `Runs as` authority.

Any automatically provisioned full workspace member can create an Agent. By default, only its creator plus Chickpea Admins/Owners can edit it; the creator may expand editing to any workspace member. An editor may publish only to a Channel they currently belong to. Admin status does not bypass Slack Channel membership.

Channels remain visible as a secondary operational inventory, but they own no instructions, memory, personality, model, connection policy, or ambient-participation setting.

## Connections

The Agent screen is the conceptual home for connections, while credentials are normalized into reusable accounts:

- **Team account:** shared authorization such as the support team's Zendesk. Authorized editors can bind it to multiple Agents without reconnecting or seeing its secret.
- **Personal account:** an authorization owned by one Chickpea member, such as a work Gmail and a personal Gmail. At runtime, an Agent sees only the invoking member's eligible personal accounts.
- **Multiple accounts:** labels and purpose text distinguish accounts from the same provider. Clear language such as “use my work account” may select uniquely; otherwise the Agent asks.

Credentials never enter model context or ordinary tool arguments. OAuth continuations bind the provider, account owner, Agent, and interrupted Slack task. Revoking an account tombstones secret access and pauses dependent schedules.

Hosted and self-hosted deployments may delegate OAuth storage, refresh, and API execution to Composio. Chickpea still owns team/personal account selection, Agent capability limits, confirmation policy, validation during connection and reconnection, and the exact provider account used for every call. The curated catalog includes Gmail, Google Calendar, Google Drive, Google Sheets, Google Docs, Google Slides, Search Console, Google Analytics, Notion, HubSpot, Gong, Google Ads, and YouTube. All remain visible when Composio is not configured: a Chickpea owner or admin can open **Settings → Connectors**, add one Composio project key, and let Chickpea prepare the standard managed-auth defaults. Account sign-in opens in Composio's hosted UI and Chickpea detects completion by polling, so a self-hosted installation does not need a public OAuth callback URL. Native API/MCP connections remain available for custom services. New Notion connections use the managed path. Existing Native Notion records remain readable and editable so upgrades are non-destructive, but Native Notion is no longer offered in the connector catalog. See [the managed connector runbook](docs/runbooks/composio-managed-connectors.md).

Sentry and Intercom use their official hosted MCP servers and the generic Chickpea OAuth lifecycle. Sentry can be narrowed to one organization or organization/project; the resulting URL remains the OAuth resource and runtime endpoint. Intercom's hosted MCP currently supports only US-hosted workspaces, so Chickpea warns before authorization. Existing bearer-token accounts remain usable during an additive migration and are removed only by an explicit disconnect. Monday.com remains on its existing bearer-token preset for this release even though Monday now documents hosted MCP OAuth.

Minor reversible writes may proceed without confirmation. Consequential actions—sending a message or email, deleting a resource, publishing, or broad/bulk changes—normally require confirmation unless the saved Agent instructions explicitly authorize that action class. Conversation text, retrieved content, and tool output cannot expand authority.

## Agent authoring

Every interactive Chickpea Agent can load the same product-owned Agent-authoring guide. A routed user Agent may inspect and edit only itself, subject to the requester's existing edit permission. The base Chickpea Agent may create Agents and edit any Agent the requester is permitted to edit. Authenticated external MCP clients remain requester-scoped. Routine executions do not mount authoring behavior.

Exploration stays in conversation: no Agent, capability, Channel grant, or schedule is created while the role or workflow is still being shaped. The guide distinguishes identity, instructions, skills, memory, connections, repositories, schedules, model choice, Slack presence, Channel reach, and editing authority. Generated, inferred, compound, skill-bearing, capability, reach, scheduled, or destructive changes use an exact read-only proposal; only approval of that frozen proposal can apply it. An explicit reversible single-field edit may still use the direct path when policy permits.

The same guide is published to MCP clients at `chickpea://guide/agent-authoring/v1`. See the [workspace management MCP runbook](docs/runbooks/workspace-management-mcp.md) for authority and proposal semantics and the [Agent-authoring evaluation runbook](docs/runbooks/agent-authoring-evaluation.md) for the synthetic behavior corpus.

## Memory

An Agent has exactly one memory. The same current body can influence its DMs and every granted Channel. Authorized members may explicitly teach it, and the Agent may silently retain durable reusable context when appropriate. Agent editors can inspect, edit, or delete it in Admin.

Memory has no Channel partitions, private-user partitions, source metadata, timestamps, or version history. This keeps the product physics simple, but it has a real consequence: information learned in a private conversation may influence a later Channel answer. Use a separate Agent for an isolation boundary.

Memory is advisory, not policy. Current Agent instructions, live permissions, and verified connection/grant state win. Secrets, credentials, tokens, sensitive personal data, and untrusted quoted instructions are rejected.

## Schedules

Schedules belong to an Agent, choose a granted Slack destination, and record the creating member as **Runs as**. Each occurrence rechecks:

- Agent lifecycle and current Channel grant;
- creator membership and destination membership;
- required team and creator-personal connection accounts;
- current repository, egress, spend, and sandbox policy.

If authority disappears, future runs pause without silently selecting another person. Reassignment requires an explicit receipt and does not rewrite prior run ownership. Cloudflare supplies the production scheduler; Node retains inspection and shutdown controls but does not run timers.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `CHICKPEA_GATEWAY_URL` | optional | Shared-app gateway origin. Defaults to the Chickpea-operated service. Override only for a compatible private gateway. |
| `SLACK_SIGNING_SECRET` | customer-owned lane | Verify direct Events API requests. May be stored by setup instead of environment. |
| `SLACK_BOT_TOKEN` | customer-owned lane | Direct Slack Web API credential. May be stored by setup instead of environment. |
| `SLACK_BOT_USER_ID` | optional | Explicit self-filter ID; otherwise resolved from the installed app. |
| `SLACK_API_URL` | optional | Override Slack Web API for offline/fake Slack. |
| `SLACK_TAG_PUBLIC_URL` | optional | Public base URL for Slack-visible Configure links. |
| `SLACK_TAG_UNASSIGNED_HINT` | optional | `false` disables private recovery feedback when an explicit Channel invocation is unavailable. |
| `SLACK_TAG_WELCOME_ON_JOIN` | optional | `false` suppresses the one-time welcome after the base bot joins a granted Channel. |
| `SLACK_TAG_PROGRESSIVE_STREAMING` | optional | Default-on deployment kill switch for model-selected Slack answer streaming. Set to `false` to stop offering the capability on new turns; native task cards are unaffected. |
| `SLACK_TAG_MODEL` | optional | Offline/dev fallback `provider/model` for an unpinned Agent. |
| `CHICKPEA_AUTH_SECRET` | Cloudflare-managed; Node required | Stable internal signing authority. |
| `CHICKPEA_RECOVERY_TOKEN` | optional break glass | One short-lived repair capability; never a login credential. |
| `TAG_DB_PATH` | optional | Durable Flue transcript SQLite path. |
| `SLACK_STATE_DB_PATH` | optional | App-owned state SQLite path. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | optional | Enable corresponding model providers; keys may instead be stored in Settings. |
| `COMPOSIO_API_KEY` | optional | Deployment-managed alternative to adding the project key in **Settings → Connectors**. Keep it secret; it never enters a runtime plan or model context. After rotating it, an owner/admin must retry preparation in **Settings → Connectors** so Chickpea can re-inspect preserved accounts before resuming managed execution. |
| `CHICKPEA_COMPOSIO_CONFIGURATION_MODE` | optional | Set to `deployment` when the project key is supplied by deployment configuration. An owner/admin must run **Settings → Connectors → Prepare connector defaults** once after enabling or upgrading this mode; Admin cannot display, replace, or disable the key. |
| `COMPOSIO_WEBHOOK_SECRET` | optional | Speeds up expiry detection when a public webhook endpoint exists. Hostless installations poll authorization, validate the exact account while connecting, pin it on every execution, and require reconnection after a definitive authorization failure. |
| `COMPOSIO_{GMAIL,CALENDAR,DRIVE,SHEETS,DOCS,SLIDES,NOTION,HUBSPOT,GOOGLE_ADS,YOUTUBE}_{READ,WRITE}_AUTH_CONFIG_ID`, `COMPOSIO_{SEARCH_CONSOLE,ANALYTICS,GONG}_READ_AUTH_CONFIG_ID` | optional compatibility overrides | Pin existing auth configs for deployment-managed installations. Run **Prepare connector defaults** once after enabling or upgrading them; Chickpea then verifies each override against the active project and persists only safe IDs. Until then, existing accounts can execute but new managed sign-ins remain unavailable. Normal OSS setup creates or reuses deterministic defaults and does not ask the operator to copy these IDs. |
| `COMPOSIO_GOOGLE_ADS_ACCESS_LEVEL`, `COMPOSIO_GOOGLE_ADS_PERMISSIBLE_USE` | required with Google Ads | Declare the developer token's production approval as `basic` or `standard`, plus `reporting` or `ad_management`. Test/Explorer tokens and reporting-only write lanes stay unavailable. |
| `COMPOSIO_YOUTUBE_{GENERAL_DAILY_QUOTA_UNITS,SEARCH_DAILY_CALL_LIMIT,UPLOAD_DAILY_CALL_LIMIT}`, `COMPOSIO_YOUTUBE_QUOTA_AUDIT_APPROVED` | optional with YouTube | Reserve provider-wide daily budgets before dispatch. Defaults are 10,000 general units, 100 searches, and 100 uploads. Higher configured limits remain unavailable until the audit-approval flag is true. Composio's managed/default app may still have a shared upstream quota across users. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | optional | Enable REST Workers AI. Cloudflare deployments can also use the keyless binding provider. |

See [.env.example](.env.example) for the complete offline-safe environment surface.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run verify:slack-streaming-policy
npm run verify:admin-ui
npm run verify:cf-smoke
npm run verify:oss-export
```

`verify:slack-streaming-policy` validates the content-free model-decision fixture corpus. A
provider evaluation is deliberately separate and opt-in: run
`npm run verify:slack-streaming-policy:live -- --live --lane <lane> --model <id>` only when
quota use has been approved. It exercises the shipped `stream_answer` name, description,
instruction, and acknowledgement against clear positive, clear negative, and ambiguous Slack
requests under a reduced prompt and tool surface. Its paired timings are provider-boundary
proxies: they show whether the declaration round trip can beat terminal model completion, but
they do not include durable persistence or Slack transport. The command never calls Slack or
prints model output. Actual first-visible Slack latency remains a separate, approved disposable-
workspace launch gate. Re-run both checks for each supported model when the model, system
instruction, or tool protocol changes.

Upgrades intentionally ignore the removed workspace `nativeTasks` and `progressiveStreaming`
values for new turns. Native task cards become invariant. Operators that need progressive answer
delivery disabled during rollout must set `SLACK_TAG_PROGRESSIVE_STREAMING=false` before the
upgrade; the variable does not affect native task cards.

The repository includes parity fixtures for direct Slack transport and the shared-gateway protocol. Live Slack acceptance should use a disposable paid workspace to verify user-group policy, handle collisions, public auto-join, private invitation, App Home, avatar updates, archive, and restore.

## Good to know

- One deployment currently serves one Slack workspace.
- The shared gateway is private infrastructure; its implementation and Slack credentials are intentionally absent from this public repository.
- The gateway does not queue Slack event bodies while a deployment is offline.
- Updates are manual: the Cloudflare Deploy button clones this repository rather than creating a fork.
- Node durability is single-host SQLite. Multi-instance Node deployments require a shared state service.
- Cloudflare free-tier model and Durable Object limits are hard platform limits under load.
- The container coding sandbox and scheduled execution are Cloudflare-only; Node uses the standard in-memory execution path and no scheduler.
- This is a clean-slate pre-release schema. There is no migration or compatibility promise for earlier private databases.

## License

[MIT](LICENSE)
