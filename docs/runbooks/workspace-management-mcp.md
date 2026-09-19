# Workspace management MCP

This runbook covers Chickpea's requester-bound workspace control plane: the public MCP used by coding agents and the matching Flue tools available to Chickpea in Slack. Both are adapters over `WorkspaceManagementService`; neither owns separate permissions or mutation rules.

## What is exposed

The deployment publishes an OAuth-protected MCP at `https://<chickpea-origin>/mcp`, protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`, and authorization-server metadata through Better Auth under `/api/auth`. The product scope is `chickpea:workspace`.

The authorization server also supports `offline_access` for renewable client
sessions. Clients request `chickpea:workspace offline_access` during registration
and authorization to receive a refresh token. Protected-resource metadata and
the MCP permission check still use only `chickpea:workspace`. Access tokens last
15 minutes; refresh tokens last 30 days and rotate on use. The real-handler
regression in `tests/management-oauth-refresh.test.ts` verifies renewal after
access-token expiry, resource binding, and opt-out of offline access.

Older deployments advertised the refresh grant but rejected `offline_access`,
so their clients received no refresh token. Update the server before signing
in again. Existing clients registered with only the workspace scope need a
fresh client registration as well as fresh consent; clearing only an expired
access token cannot repair that registration. Use the client's normal controls
to reset only this Chickpea connection, preserving other MCP servers. CLI
`doctor` reports missing refresh support independently of initial sign-in.

The compact tool surface is:

- `inspect_workspace`, `prepare_connector_setup`, `prepare_provider_setup`, `discover_slack_channels`, `test_mcp_connection`, `inspect_memory`, and `inspect_routines`
- `export_workspace_recipe` and `preview_workspace_recipe`
- `import_skill`, `manage_agent_skill`, and the backward-compatible `propose_skill_import`
- `propose_workspace_changes` and `apply_workspace_changes`
- `confirm_workspace_change` and `undo_workspace_change`
- `get_operation` and `revoke_setup_link`

The server advertises contract version `2.9.0`. Its `initialize` result carries `instructions` (under 2,000 bytes, most important facts first because Claude Code truncates after that): what Chickpea is and its three doors, inspect before recommending, read the guide before proposing, immediate `create_agent` versus proposal plus confirmation, never handle secrets (connector and model provider keys go through handoff links), which settings are Admin-only with the deployment's real Admin link, show `presentation.markdown` and the receipt links, and mention the Agent in Slack afterwards. The Admin link comes from the deployment's public base URL, so it is exact for the deployment a client connected to. The typed operation inventory remains backward-compatible at `chickpea://schema/operations/v2`; Agent-authoring guidance is an additive resource at `chickpea://guide/agent-authoring/v1`. Read the guide before translating conversational intent into configuration. The resource includes both the main guide and its packaged `skill-creation.md` procedure. A proposal result repeats its guide version, URI, and digest so a client can prove which guidance produced the preview.

The server also publishes six MCP prompts (`prompts/list`, `prompts/get`) from `src/management/prompts.ts`: `new-agent [purpose]`, `edit-agent <handle> [change]`, `connect <service> [handle]`, `schedule <handle> [what]`, `import-skill <url> [handle]`, and `status`. Claude Code renders them as slash commands in the form `/mcp__chickpea__new-agent`, where `chickpea` is whatever the person named the server. MCP prompts are not local skills and do not populate the Codex `$` picker; Codex can use the same tools and live guidance from a plain-language request. Neither client needs a separate skills installation. Argument names are single lowercase tokens because Claude Code splits a prompt's arguments on whitespace, and an argument value is quoted into the brief as the person's words, never as directions to the agent. Each `prompts/get` returns exactly one `user` message: a short scripted brief that inspects first, asks at most three questions, drafts in the conversation, then applies or proposes the way the guide says, and ends with the receipt's `links.admin` and `links.slack` plus one line on how to try the result. `new-agent` opens with the question "What should this teammate do for your team?" and, when the person has not answered it, offers the curated starters from `src/management/first-teammate.ts` and nothing it invented. The operation inventory at `chickpea://schema/operations/v2` lists the prompt names under `prompts`, so a client can read the prompt surface from the same contract as the tools. `tests/management-mcp-prompts.test.ts` covers the rendered briefs, and `tests/management-client-compatibility.test.ts` exercises `prompts/list` and `prompts/get` over both protocol versions for the Claude Code, Codex, and MCP Inspector profiles.

The MCP door is written for a coding agent, not for Chickpea inside Slack. Tool descriptions come from one table in `src/management/tool-adapter.ts` with an MCP overlay selected by the adapter (`workspaceManagementToolDescription(name, 'mcp')`): the Slack strings are byte-identical to before and the mutation rules are the same on both doors; only wording about Slack threads, DMs, `presentation.slack`, and Slack-only tools differs. The guide resource serves a `coding-agent` variant (`src/management/agent-authoring/mcp-guide.ts`): a short preamble plus exact paragraph substitutions over the canonical guide, so the version literal stays the same, `guideVersion` checks are unchanged, and the resource reports both the canonical `digest` that proposals repeat and a `variantDigest` for the served text. A substitution that no longer matches the canonical guide fails at module load and in `tests/management-mcp-surface.test.ts`, so a guide edit cannot silently strand the variant. Every result that carries `presentation.slack` also carries `presentation.markdown` (no Slack escaping, no Slack approval wording, no Slack block-length truncation); coding agents show the Markdown and Chickpea in Slack keeps showing the Slack text. Mutation receipts from `apply_workspace_changes`, `confirm_workspace_change`, and `undo_workspace_change` add `links` on each outcome that changed an Agent and at the top level for the first such outcome: `links.admin` is the Agent's Admin page (`/admin/agents/<id>`) and `links.slack` opens Chickpea in the workspace (Slack `app_redirect`) so the person can mention the new @handle. Links are computed at return time from the deployment base URL and the workspace installation, never persisted, and never contain a secret; `get_operation` returns the stored receipt without them. There is no Slack welcome for an MCP creation; the coding agent hands the person the links instead. The additive `import_skill` tool resolves and installs one exact public GitHub-hosted `SKILL.md` when the requester supplied the source. The older `propose_skill_import` tool remains available for clients that deliberately need the frozen review flow.

`prepare_connector_setup` is the credential-safe connector entry point for MCP and Slack. Give it an editable Agent plus a connector catalog id or display name (for example `gmail` or `Gmail`). It returns an authenticated Admin handoff URL locked to that Agent and requires a human to complete consent. The resulting connection belongs only to that Agent; another Agent must start a separate setup even when it will authorize the same external account. In a Slack conversation routed through a specific Agent handle, the adapter supplies that current Agent as the default target; credentials must never be requested in Slack or model context.

`prepare_provider_setup` is the same shape for a workspace model provider API key (`anthropic`, `openai`, or `openrouter`), exposed on the MCP door only; Chickpea in Slack keeps using a `request_setup` operation with a `provider_credential` target, which goes through the normal proposal when it replaces a stored key. The direct tool issues the identical 24-hour setup record (`src/management/service.ts` `prepareProviderSetup` → `issueSetupRecord`, the record `request_setup` would create) without a proposal round trip: an authenticated MCP call is already the typed command, and the handoff page is where the person acts. Gating is the same as Admin Settings → Model providers: Owners and Admins only; a member receives `forbidden` with `links.admin` pointing at that section so they can ask an Owner. A deployment-provided key (`env` source) is read-only and returns `invalid_request`; a stored key is replaced only when the call passes `replaceExisting: true`, otherwise the tool refuses and says a key exists. Unlike a connector link, the page is bound to the requester: exchange and completion require the same signed-in person (`principalMatchesSetup`) with live `admin.configure`, so a colleague cannot finish it. The result carries `provider`, `replacement`, `handoffUrl`, `setupOperationId`, `expiresAt`, and `links.admin`; the key itself is typed on the setup page, validated against the provider, and stored by `src/management/setup-routes.ts` `completeFormAction`, so it never appears in a tool argument, tool result, receipt, or `get_operation` replay. `revoke_setup_link` works on these links like any other. GitHub App setup, the coding sandbox, outbound access, the Composio key, and Agent avatars have no MCP handoff: GitHub is a GitHub-hosted App manifest flow with a CSRF state minted by an Admin session, not a paste-a-secret form, and the others are Admin-only settings. `tests/management-provider-handoff.test.ts` covers the tool end to end, including the browser completion and the no-secret-in-any-result assertion.

Receipts and errors that name something only Admin can change carry `links.admin` to the exact Settings section (`src/management/admin-links.ts`): every `request_setup` outcome for a provider key and every `remove_provider_credential` outcome, whatever its disposition (`setup_required`, `confirmation_required` when a stored key is replaced, a member's `operational_access_required` denial, skipped, failed), plus the `invalid_request` errors for a deployment-provided or missing provider key, point at `/admin/settings/providers`; every `update_member` outcome points at `/admin/team`. The top-level `links` on a receipt stay the first changed Agent's; a Settings link is the top-level fallback only when no Agent changed. Like the Agent links, these are added at return time, need a usable deployment origin (no bare paths), and are stripped before persistence, so `get_operation` returns the stored receipt without them.

`import_skill` accepts a public GitHub repository, direct GitHub tree URL, skills.sh link, or `owner/repo` reference that appears in the authenticated current Slack request. A direct skill-directory URL is preferred because the service inspects one directory and pins its commit before fetching `SKILL.md`. A source with multiple candidates returns bounded names, descriptions, and immutable source URLs without changing configuration; the requester posts the chosen `sourceUrl` in a new message before the next call. A new bounded scriptless skill installs immediately and returns a Slack-ready receipt plus an undoable operation ID. Different same-name content returns `replacement_confirmation_required` with the exact clarification text required before a new-message retry with `replaceExisting: true`. Packaged scripts are rejected because Chickpea inline skills cannot execute imported files. The external MCP surface requires `agentId`; immediate import currently requires the trusted Slack request binding, so over MCP `import_skill` returns `invalid_request` and its MCP description says to use `propose_skill_import` (a proposal the person approves, then `confirm_workspace_change`).

`manage_agent_skill` changes one named installed skill with `enable`, `disable`, or `remove`. The service reads the current Agent, verifies the requester, preserves every other skill, and writes an idempotent reversible change. Slack calls must match the exact authenticated current command; an authenticated MCP invocation is already the exact typed command. Chickpea connectors are trusted integrations, so connector identity never adds an approval gate. A clear single-skill command applies immediately and returns a Slack-ready receipt plus undo. Questions, negated commands, ambiguous targets, generated content, and compound edits do not qualify for this path. The generic proposal tool rejects an exact qualifying single-skill command so a model cannot turn it into an unnecessary approval round trip.

`propose_workspace_changes` accepts exact typed consequential edits and writes no configuration. It rejects Agent creation. Each call must include a requester-chosen `idempotencyKey`, the current guide version, and an `authoringReason` (`agent_creation`, `agent_edit`, `skill_creation`, `skill_edit`, or `onboarding`). Retrying the same bound key and exact operation digest returns the original proposal; reusing it for different content fails closed. `apply_workspace_changes` creates one sufficiently understood base Agent immediately when the request contains exactly one `create_agent` operation. It routes other confirmation-required operations into the existing proposal lifecycle instead of bypassing review. Apply requests accept at most 25 ordered operations. `dependsOn` gives a progressive batch explicit prerequisites; a failed prerequisite skips only its dependents. A progressive apply batch is not globally atomic, and every item returns its own durable disposition.

## Connect a coding agent

Every deployment serves two public, unauthenticated connect routes from `src/management/connect-routes.ts`: `GET /connect.md` is a guide written for the coding agent with this deployment's real URLs substituted in (detect the client, write its configuration from a table covering Claude Code, Codex, Cursor, VS Code, Windsurf, Gemini CLI, and a generic JSON block, run the client's sign-in, restart if the client loads servers at startup, prove the connection with one `inspect_workspace` call reported as three separate lines, then offer the first teammate), and `GET /connect` is the page a person opens to copy the one-line prompt `Connect my coding agent to my Chickpea using https://<origin>/connect.md` plus the direct Claude Code and Codex commands. Both work before Slack setup is finished and say that `/mcp` answers 404 until then. They contain nothing secret and no internal identifiers, so they are cacheable for a few minutes. `tests/connect-routes.test.ts` covers headers, origin substitution, and the client list; `scripts/verify-cf-smoke.mjs` fetches both routes on the Worker. Signed-in people get the same table inside the product: Admin Settings → Coding agents (`/admin/settings/agents-clients`) renders it from `GET /admin/api/mcp-clients`, which every authenticated principal including a member may read, and which serves the identical snippets from `src/management/mcp-client-config.ts` plus the hosted claude.ai and ChatGPT entries and the Cursor and VS Code one-click install links.

The agent-run install guides make this a required step: `INSTALL_CHICKPEA_CLOUDFLARE.md` step 8 and the `INSTALL_CHICKPEA_NODE.md` section "Connect this coding agent" have the installing agent add the new deployment's `/mcp` server to its own client, start that client's sign-in, call `inspect_workspace`, and report configured, signed in, and tested as three separate lines before it hands over. They fetch `/connect.md` and follow its steps 1 to 5 (the install guide owns the first teammate), and carry an inline client table for releases that predate the connect route (up to and including v0.1.22), which `tests/install-guides-connect.test.ts` keeps byte-aligned with `CONNECT_CLIENTS`.

Add a remote/custom MCP server in the client and use the exact Chickpea deployment URL ending in `/mcp`. Do not create or paste a bearer token. A compatible client discovers OAuth metadata, registers as a public PKCE client when needed, opens Slack sign-in and Chickpea consent, then reconnects with a resource-bound access token.

Use one authorization tab and keep the initiating command running until it
reports a result. `codex mcp add` can start OAuth itself; run `codex mcp login`
only if sign-in is still needed after `add` finishes. Use the tab the client
opens. Open its printed URL once only if no tab opened.

The MCP client owns its loopback callback page. Codex 0.154.0 responds to the
first callback with a completion message and then closes the listener after
the login finishes. See its [callback handler](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/rmcp-client/src/perform_oauth_login.rs#L262-L310)
and [automatic login during add](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/cli/src/mcp_cmd.rs#L490-L523).
A later consent click in a duplicate tab or a callback revisit can therefore
show connection refused at `127.0.0.1` or `localhost`. This is distinct from a
404 at Chickpea's `/mcp` endpoint before Slack setup finishes.

Check the client's result before retrying. If it reports success, close the
leftover tab and verify with `inspect_workspace`. If login failed or timed
out, preserve the first error and retry once using a fresh login URL. Keep
working credentials. If the first callback fails while the command is still
waiting, investigate the client's listener and browser restrictions separately;
the duplicate-tab explanation is not established in that case. Chickpea must
return the exact registered callback, and cannot replace it with a success page
before the client exchanges the authorization code.

`ERR_BLOCKED_BY_CLIENT` is a separate browser-side failure. It can appear even
when the client receives the callback and completes authentication. Check the
client's result and the read-only MCP call before treating the connection as
failed. Compare with a direct callback in an isolated local fixture before
attributing the block to Chickpea's consent handoff; do not relax OAuth or
browser protections to hide the error.

Authorization should show one permission: manage this Chickpea workspace. Slack OIDC proves the person, while Chickpea independently requires the exact active workspace binding and membership on every MCP request. Disconnect or revoke the MCP connection from the client when it should no longer hold a refresh token. Suspending or removing the Chickpea member immediately blocks live MCP requests without waiting for client cleanup.

Dynamic Client Registration is an intentionally bounded compatibility window for current clients. It accepts public clients only, validates exact loopback or HTTPS redirects, rate-limits registrations, caps stored clients, and prunes unused clients. Do not enable confidential client metadata or widen redirect rules. Replacing DCR with client-ID metadata is a follow-up gate: the Worker implementation must safely resolve DNS, reject special addresses, pin the resolved address through TLS, and refuse redirects before remote metadata is trusted.

## CLI

`chickpea-cli` (npm, source at `packages/cli`) is a scripted client for this surface. `npx chickpea-cli doctor <origin>` runs the unauthenticated half of `scripts/verify-management-mcp.mjs` against a public origin: protected-resource metadata, authorization-server metadata, JWKS, and the 401 challenge, and explains a 404 as unfinished setup. `chickpea-cli mcp config <origin>` prints the client snippets for Claude Code, Codex, and Cursor. `chickpea-cli login <origin>` performs the public PKCE flow described above through the `@modelcontextprotocol/client` SDK and stores the tokens under `~/.config/chickpea` (mode 0600), keyed by origin; `logout` revokes at `/api/auth/oauth2/revoke`. `workspace inspect`, `tools list`, `call <tool>`, and `recipe export|preview` wrap the tools directly and print the `{ ok, result | error }` envelope.

The CLI follows this runbook's confirmation model: a result carrying a proposal is printed with the exact `confirm_workspace_change` command and is never confirmed automatically, and a setup link is printed with the 24-hour, anyone-who-holds-it warning. It never accepts a token, provider key, or Slack credential as an argument or environment variable. Package README: `packages/cli/README.md`.

## Roles and confirmation

| Actor | Inspect workspace | Operational changes | Members | Normal Channel work |
|---|---:|---:|---:|---:|
| Owner | Yes | Yes | Yes | Yes, when a Channel allows it |
| Admin | Yes | Yes | No | Yes, when a Channel allows it |
| Member | Editable Agents only | Create and edit permitted Agents | No | Yes, with live Slack membership proof |
| Unbound Slack participant | No | No | No | Only ordinary assigned-Channel interaction |

Slack workspace roles are not Chickpea roles. Every call re-resolves the live Chickpea membership and access overlay. Tool arguments cannot select a user, organization, membership, Slack requester, or credential scope.

The adapter also supplies the acting scope; model-authored arguments cannot forge it:

| Surface | Authoring scope |
|---|---|
| User Agent in Slack | Its own complete configuration only, when the requester may edit it |
| Base Chickpea Agent in Slack | Create Agents and edit requester-permitted Agents |
| External MCP client | Requester-permitted Agents, with no implied acting Agent |

A user Agent may self-manage instructions, skills, model, presence, edit policy, connections, repositories, memory, reach, setup, routines, and lifecycle. Existing setup, membership, revision, Channel, destructive-confirmation, and audit gates still apply. Cross-Agent or workspace-authority work returns a bounded Chickpea handoff or a permission-safe denial without exposing the target configuration. An archived Agent cannot process another Slack turn; restoration must enter through an active authorized surface.

The request itself is approval only when the trusted service derives the exact command from the authenticated current message and proves it authorized, reversible, local-only, and free of authority, reach, credential, capability, or third-party effects. Today that includes one explicit enable, disable, or removal of a named existing skill, plus purpose-built exact GitHub import and undo tools. New or generated skill content, inferred changes, compound changes, destructive actions, external consequential writes, capability expansion, and reach or authority changes use `propose_workspace_changes`. Ambiguous targets or replacements need clarification, not a generic approval prompt. The returned preview is the single approval boundary when confirmation is required: never ask for permission before proposing and never ask for another approval after the requester accepts that preview. The apply tool still returns a bound proposal for any operation whose policy requires confirmation, including:

- deleting an Agent, routine, or durable memory entry;
- changing member authority;
- removing or replacing credentials;
- expanding capability scope;
- disabling an Agent that is published to a Channel; or
- archiving or restoring an Agent, or granting or revoking Channel reach; or
- overwriting an existing Agent from a recipe.

The same live requester must confirm from the same MCP client or Slack thread. Proposals do not expire, and a newer proposal from that same requester and origin supersedes the older pending one. `confirm_workspace_change` accepts only the proposal handle and applies the frozen operations; it cannot reinterpret them. A changed target revision, digest, permission, requester, acting Agent, or origin makes the whole change set stale or denied before its first write. Inspect again and present a newly calculated diff instead of retrying the old handle.

## Clean Agent creation

During exploration, keep the Agent design in the conversation and create no record. Once the base identity and purpose are sufficiently understood and the request reaches commit posture, call `apply_workspace_changes` immediately with that base creation by itself. Do not propose it and do not ask for a second confirmation:

```json
{
  "idempotencyKey": "agent-research-v1",
  "operations": [
    {
      "itemId": "agent",
      "kind": "create_agent",
      "clientRef": "research",
      "agent": {
        "id": "agent_research",
        "name": "Research",
        "description": "Synthesizes research for the team.",
        "requestedHandle": "research",
        "editPolicy": "all_workspace_members",
        "instructions": "Synthesize evidence and cite sources.",
        "enabled": true,
        "model": "openai/gpt-5.6-terra",
        "skills": [],
        "mcpServers": [],
        "apiConnections": [],
        "repositories": []
      }
    }
  ]
}
```

The base Agent is active immediately. A trusted Slack Channel request derives only that exact source-Channel grant; a DM and MCP request derive no Channel reach. It must not silently add a connector, repository grant, other Channel grant, or routine. In Slack, explicitly requested connector names can become up to three independently authorized `Connect X` actions in the welcome; they never ride inside the create operation or grant access. If Slack-handle or source-Channel publication fails, the Agent remains created and Chickpea reports the incomplete portion once. Handle a compound request by creating the base first, then sending each follow-on operation through its existing policy and confirmation boundary.

The adapter, not the model, supplies requester authority. The acting membership is recorded as the Agent creator; tool arguments cannot forge it. Use current IDs and revisions returned by inspection rather than guessing them. Channel publication remains a separate, confirmation-gated operation: `put_channel` records the Slack Channel and `grant_agent_channel` performs live Slack membership, bot-membership, and Agent-presence reconciliation before activating the additive grant. `revoke_agent_channel` also rechecks the acting Slack member before removing reach.

Successful configuration is active on the next newly admitted Slack event, including a reply in an existing thread. An already admitted response and all of its retries keep their frozen runtime plan.

## Connectors, repositories, and model credentials

Declare non-secret policy in the Agent operation: display name, approved MCP tools, allowed API hosts/paths/methods, OAuth scopes, or exact repository name. Never place an API key, OAuth code, bearer value, private key, authorization header value, repository installation credential, or secret-bearing URL in a tool argument.

When access is missing, add `request_setup` for the exact Agent connection, repository grant, or model provider. Chickpea returns a URL whose fragment contains a one-use capability. It expires after 24 hours and may be revoked or reissued with `revoke_setup_link`; reissue invalidates the prior link.

Anyone who can see the link can complete its exact frozen action without signing into Chickpea. Share it as a credential-bearing capability. The page shows the connector, target, requested scopes, and replacement warning. It cannot change those values. OAuth connections redirect to the provider; multi-field credentials use a Chickpea form. Validation clears submitted fields, activates the connection once, and creates a non-secret receipt such as:

```text
alex@northstar.example has been connected to Gmail connector.
```

The receipt may include the target, scopes, initiator, operation ID, and a provider-returned non-secret account label. It never includes a token, code, key, client secret, header value, or repository installation credential.

## Memory, routines, and team

Agent memory uses the Agent owner scope and expected version. Inspection returns active entry bodies only to a member who can edit that Agent; forgetting is irreversible and confirmation-gated. Channels do not own instructions or memory. Routine inspection and mutation are filtered through the same Agent edit policy and preserve content authority, while routine save/control/delete retain the existing schedule and version contracts.

Eligible full Slack members are provisioned automatically the first time they interact with an Agent. Guests and Slack Connect users are not provisioned. A full member can create an Agent and inspect or mutate only Agents allowed by that Agent's edit policy. Only Owners can inspect team authority or change an existing membership's role/status. Provider inspection and provider mutations remain Admin/Owner-only; provider results expose availability and affected Agents, never a key or environment-secret value. Deployment-provided credentials are visibly read-only.

## Portable recipes

`export_workspace_recipe` returns a schema-versioned, immutable result for selected Agents. It contains instructions, model choice, inline skills, connection requirements, and exact repository names. It deliberately excludes:

- workspace and Channel IDs;
- members and member mutations;
- Slack identity and provider account identifiers;
- credentials, OAuth codes/tokens, and secret-bearing URLs;
- repository installation IDs and account logins; and
- Agent memory and Channel publication grants.

`preview_workspace_recipe` compares the recipe with current state. Name conflicts return `clone`, `update`, and `skip`; duplicate matches return `ambiguous`. Missing connectors, repositories, and model-provider credentials become setup-required operations. Unsupported versions, malformed requirements, duplicate symbols, unsafe URLs, unsupported model providers, and batches over 25 operations fail before any write.

Apply the returned `operations` with the ordinary `apply_workspace_changes` tool. There is no separate recipe authority or background reconciliation. Creates can proceed progressively; updates carry `recipe_overwrite` confirmation. Expected revisions ensure a live edit made after preview wins and forces a new preview.

## Operation polling, receipts, and revocation

Every mutation has a durable operation ID. `get_operation` returns only records owned by the same requester and organization. Setup URLs are returned once when issued and are not stored in pollable operation results. Polling reveals lifecycle and non-secret receipts, not raw capabilities.

Exact proposals return a bounded preview, missing-setup list, target revisions, and canonical guide metadata. Confirmation results report `applied`, `setup_required`, `stale`, `denied`, `failed`, or `partial` outcomes without returning authored bodies in telemetry. A `partial` result means the admitted change set encountered a downstream per-item failure after an earlier item applied; dependents are skipped and the receipt identifies item and operation classes. It is not permission to replay the whole set.

`undo_workspace_change` is available only for an eligible single safe mutation at its exact resulting revision. Slack requires an explicit undo request. A trusted connector may immediately undo the exact receipt from `manage_agent_skill`; other inverses still use consequence-based policy. If an inverse has become risky, undo returns a proposal instead of bypassing confirmation.

## Client acceptance matrix

| Client profile | Local protocol/DCR fixture | Live OAuth + reconnect | Setup completion | Status |
|---|---:|---:|---:|---|
| Codex CLI/Desktop | Automated | Requires disposable deployment | Requires disposable connector | Local contract verified; live pending authorization |
| Claude Code | Automated | Requires disposable deployment | Requires disposable connector | Local contract verified; live pending authorization |
| MCP Inspector | Automated for 2026 and 2025-era stateless requests | Requires disposable deployment | Requires disposable connector | Local contract verified; live pending authorization |

`tests/management-client-compatibility.test.ts` covers public-client metadata and stateless tool discovery for these profiles. `tests/management-oauth.test.ts` covers discovery, DCR, PKCE/resource binding, live membership denial, continuation safety, registration limits, and revocation behavior. These fixtures do not claim that a particular installed desktop build completed a real browser authorization.

Run `npm run verify:management-mcp` against a disposable deployment for read-only live acceptance. Supply a bearer token only through the environment; the verifier never prints it or response bodies. The authenticated default path reads the guide, creates one unconfirmed base-Agent proposal, and proves the effective revision and Agent inventory did not change. A live mutation or third-party connector canary requires separate explicit authorization, `MANAGEMENT_MCP_ALLOW_MUTATION=1`, and a supplied canary payload.

## Diagnostics and telemetry

Content-free log envelopes use the `[chickpea:management]` prefix. Events cover OAuth discovery/DCR/token/request outcomes, tool calls, operation kind and disposition, Agent-authoring guide version, posture, artifact class, proposal outcome, stale reason, handoff class, setup lifecycle, receipt delivery, live-versus-snapshot admission, and recipe preview counts. Dimensions are fixed machine tokens and counts; unknown values become `other`. Actor IDs, Slack coordinates, object IDs, names, prompts, instructions, memory bodies, recipes, repository names, URLs, account labels, credentials, setup capabilities, and error text are not accepted.

For support:

1. Confirm `/.well-known/oauth-protected-resource/mcp` names the exact `/mcp` resource and `/api/auth` authorization server.
2. A `401` without a token must include a protected-resource challenge. A `403` after authorization usually means the live Chickpea membership, role, or scope no longer permits access.
3. Inspect the operation by ID. `confirmation_required`, `setup_required`, `skipped`, and `failed` are item dispositions, not transport failures.
4. For a setup problem, check whether the link is expired, revoked, exchanged, completed, or stale. Reissue rather than sharing browser cookies or credentials.
5. Use content-free event/reason tokens from logs. Do not add response bodies, OAuth queries, setup URLs, recipe JSON, or Slack messages to diagnostics.

## Canary and rollback

Live deployment and third-party mutation require explicit authorization. In a disposable workspace:

1. Record the deployment revision and keep `CHICKPEA_LIVE_CHANNEL_CONFIG` unset.
2. Connect one supported client, inspect the workspace, and make one reversible instruction edit on a canary Agent.
3. Hold one Slack response in flight, apply a second edit, and prove the held response finishes with its admitted revision while the next message in the same thread reports the new effective revision.
4. Reassign the canary Channel and prove bounded Slack history is rehydrated without a fresh-context notice.
5. Exercise one delegated setup against a disposable provider account, verify the original thread/DM receipt, then revoke the connection.
6. Set `CHICKPEA_LIVE_CHANNEL_CONFIG=false`, redeploy, and prove a new Channel root uses a write-once snapshot while already admitted TurnJobs remain unchanged. Unset it and redeploy to restore next-turn live resolution.
7. Disconnect and reconnect the MCP client; confirm the same live Slack membership is required and stale tokens cannot bypass suspension or removal.

The public management surface can be disabled operationally by removing its route at deployment or rolling back the artifact. Do not delete OAuth or management state during rollback: already admitted TurnJobs, durable operations, proposals, setup revocation, and receipts must remain explainable.
