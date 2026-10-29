# Workspace management MCP

This runbook covers Chickpea's requester-bound workspace control plane: the public MCP used by coding agents and the matching Flue tools available to Chickpea in Slack. Both are adapters over `WorkspaceManagementService`; neither owns separate permissions or mutation rules.

## What is exposed

The deployment publishes an OAuth-protected MCP at `https://<chickpea-origin>/mcp`, protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`, and authorization-server metadata through Better Auth under `/api/auth`. The product scope is `chickpea:workspace`.

The 401 challenge, the protected-resource metadata, and the MCP permission
check name only `chickpea:workspace`. MCP 2026-07-28 asks resources to keep
`offline_access` out of the challenge and metadata, and leaves renewal to the
authorization server. Chickpea's authorization server issues a refresh token to
every client registered for the `refresh_token` grant. A client that follows
the challenge asks for `chickpea:workspace` alone; the server adds
`offline_access` to that authorization request, and consent shows that the
agent stays signed in. A client can also request
`chickpea:workspace offline_access` itself, as `chickpea-cli` does. A client
registered without the `refresh_token` grant gets no refresh token. Access
tokens last 15 minutes; refresh tokens last 30 days and rotate on use. The
real-handler regressions in `tests/management-oauth-refresh.test.ts` verify
renewal after access-token expiry, renewal for a client that requests only the
challenge scope, resource binding, and clients without renewal.

Older deployments advertised the refresh grant but rejected `offline_access`,
so their clients received no refresh token. Update the server before signing
in again. Existing clients registered with only the workspace scope need a
fresh client registration as well as fresh consent; clearing only an expired
access token cannot repair that registration. Use the client's normal controls
to reset only this Chickpea connection, preserving other MCP servers. Codex
registers again with `codex mcp login chickpea`. In Claude Code, use `/mcp` →
`chickpea` → Clear authentication, then authenticate again. Claude versions with
the terminal commands can use `claude mcp logout chickpea` followed by
`claude mcp login chickpea`. Merely re-authenticating can preserve the old client
registration. CLI `doctor` reports missing refresh support independently of
initial sign-in. A connection approved before the server added renewal to
workspace-only requests asks for consent once more on its next sign-in.

The MCP tool surface (`WORKSPACE_MANAGEMENT_MCP_TOOL_NAMES` in `src/management/mcp.ts`) is:

- `inspect_workspace`, `prepare_connector_setup`, `prepare_provider_setup`, `discover_slack_channels`, `test_connection`, `inspect_memory`, and `inspect_routines`
- `export_workspace_recipe` and `preview_workspace_recipe`
- `import_skill` and `manage_agent_skill`
- `apply_workspace_changes`
- `confirm_workspace_change` and `undo_workspace_change`
- `get_operation` and `revoke_setup_link`
- `list_mcp_clients` and `revoke_mcp_client`

The MCP door has no `propose_workspace_changes` or `propose_skill_import`. Chickpea in Slack keeps both. Tool annotations mark reads with `readOnlyHint: true`. Every write sets `destructiveHint: false`, except `confirm_workspace_change`, the only tool that carries out a change the person must confirm.

The server advertises contract version `4.0.0`. Version 3 removed the propose tools and made MCP act with the person's Admin authority. Version 4 replaced `test_mcp_connection` with `test_connection`, which also checks API connections. Its `initialize` result carries `instructions` (under 2,000 bytes, most important facts first because Claude Code truncates after that): what Chickpea is and its three doors, inspect before recommending, read the guide before designing, Admin authority with a confirmation only for a destructive change, never handle secrets (connector and model provider keys go through handoff links), which settings are Admin-only with the deployment's real Admin link, show `presentation.markdown` and the receipt links, and mention the Agent in Slack afterwards. The Admin link comes from the deployment's public base URL, so it is exact for the deployment a client connected to. The typed operation inventory is at `chickpea://schema/operations/v2`; its JSON shape is unchanged, and its `tools` list is the MCP inventory above. Agent-authoring guidance is an additive resource at `chickpea://guide/agent-authoring/v1`. Read the guide before translating conversational intent into configuration. The resource includes both the main guide and its packaged `skill-creation.md` procedure. A Slack proposal result repeats its guide version, URI, and digest so a client can prove which guidance produced the preview.

The server also publishes six MCP prompts (`prompts/list`, `prompts/get`) from `src/management/prompts.ts`: `new-agent [purpose]`, `edit-agent <handle> [change]`, `connect <service> [handle]`, `schedule <handle> [what]`, `import-skill <url> [handle]`, and `status`. Claude Code renders them as slash commands in the form `/mcp__chickpea__new-agent`, where `chickpea` is whatever the person named the server. MCP prompts are not local skills and do not populate the Codex `$` picker; Codex can use the same tools and live guidance from a plain-language request. Neither client needs a separate skills installation. Argument names are single lowercase tokens because Claude Code splits a prompt's arguments on whitespace, and an argument value is quoted into the brief as the person's words, never as directions to the agent. Each `prompts/get` returns exactly one `user` message: a short scripted brief that inspects first, asks at most three questions, drafts in the conversation, then applies the way the guide says, and ends with the receipt's `links.admin` and `links.slack` plus one line on how to try the result. `new-agent` opens with the question "What should this teammate do for your team?" and, when the person has not answered it, offers the curated starters from `src/management/first-teammate.ts` and nothing it invented. The operation inventory at `chickpea://schema/operations/v2` lists the prompt names under `prompts`, so a client can read the prompt surface from the same contract as the tools. `tests/management-mcp-prompts.test.ts` covers the rendered briefs, and `tests/management-client-compatibility.test.ts` exercises `prompts/list` and `prompts/get` over both protocol versions for the Claude Code, Codex, and MCP Inspector profiles.

The MCP door is written for a coding agent, not for Chickpea inside Slack. Tool descriptions come from one table in `src/management/tool-adapter.ts` with an MCP overlay selected by the adapter (`workspaceManagementToolDescription(name, 'mcp')`). The overlay drops wording about Slack threads, DMs, `presentation.slack`, and Slack-only tools, and describes MCP's confirmation posture. Permissions are the same on both doors; only the confirmation posture differs, as described under [Confirmation over MCP](#confirmation-over-mcp). The guide resource serves a `coding-agent` variant (`src/management/agent-authoring/mcp-guide.ts`): a short preamble plus exact paragraph substitutions over the canonical guide that replace its Slack mechanics and its proposal flow with direct apply. The version literal stays the same, `guideVersion` checks are unchanged, and the resource reports both the canonical `digest` that Slack proposals repeat and a `variantDigest` for the served text. A substitution that no longer matches the canonical guide fails at module load and in `tests/management-mcp-surface.test.ts`, so a guide edit cannot silently strand the variant. Every result that carries `presentation.slack` also carries `presentation.markdown` (no Slack escaping, no Slack approval wording, no Slack block-length truncation); coding agents show the Markdown and Chickpea in Slack keeps showing the Slack text. Mutation receipts from `apply_workspace_changes`, `confirm_workspace_change`, and `undo_workspace_change` add `links` on each outcome that changed an Agent, except one the call deleted, and at the top level for the first such outcome: `links.admin` is the Agent's Admin page (`/admin/agents/<id>`) and `links.slack` opens Chickpea in the workspace (Slack `app_redirect`) so the person can mention the new @handle. Links are computed at return time from the deployment base URL and the workspace installation, never persisted, and never contain a secret; `get_operation` returns the stored receipt without them. There is no Slack welcome for an MCP creation; the coding agent hands the person the links instead. `import_skill` resolves and installs one exact public GitHub-hosted `SKILL.md` from the source the person supplied.

`prepare_connector_setup` is the credential-safe connector entry point for MCP and Slack. Give it an editable Agent plus a connector catalog id or display name (for example `gmail` or `Gmail`). It returns an authenticated Admin handoff URL locked to that Agent and requires a human to complete consent. The resulting connection belongs only to that Agent; another Agent must start a separate setup even when it will authorize the same external account. In a Slack conversation routed through a specific Agent handle, the adapter supplies that current Agent as the default target; credentials must never be requested in Slack or model context.

`prepare_provider_setup` is the same shape for a workspace model provider API key (`anthropic`, `openai`, or `openrouter`), exposed on the MCP door only; Chickpea in Slack keeps using a `request_setup` operation with a `provider_credential` target, which goes through the normal proposal when it replaces a stored key. Over MCP that `request_setup` issues its link directly too, as Admin replaces a key without asking. The direct tool issues the identical 24-hour setup record (`src/management/service.ts` `prepareProviderSetup` → `issueSetupRecord`, the record `request_setup` would create) without a proposal round trip: an authenticated MCP call is already the typed command, and the handoff page is where the person acts. Gating is the same as Admin Settings → Model providers: Owners and Admins only; a member receives `forbidden` with `links.admin` pointing at that section so they can ask an Owner. A deployment-provided key (`env` source) is read-only and returns `invalid_request`; a stored key is replaced only when the call passes `replaceExisting: true`, otherwise the tool refuses and says a key exists. Unlike a connector link, the page is bound to the requester: exchange and completion require the same signed-in person (`principalMatchesSetup`) with live `admin.configure`, so a colleague cannot finish it. The result carries `provider`, `replacement`, `handoffUrl`, `setupOperationId`, `expiresAt`, and `links.admin`; the key itself is typed on the setup page, validated against the provider, and stored by `src/management/setup-routes.ts` `completeFormAction`, so it never appears in a tool argument, tool result, receipt, or `get_operation` replay. `revoke_setup_link` works on these links like any other. GitHub App setup, the coding sandbox, the Composio key, and Agent avatars have no MCP handoff: GitHub is a GitHub-hosted App manifest flow with a CSRF state minted by an Admin session, not a paste-a-secret form, and the others are Admin-only settings. `tests/management-provider-handoff.test.ts` covers the tool end to end, including the browser completion and the no-secret-in-any-result assertion.

Receipts and errors that name something only Admin can change carry `links.admin` to the exact Settings section (`src/management/admin-links.ts`): every `request_setup` outcome for a provider key and every `remove_provider_credential` outcome, whatever its disposition (`setup_required`, `confirmation_required` when a removal waits for confirmation or Slack holds a stored-key replacement for approval, a member's `operational_access_required` denial, skipped, failed), plus the `invalid_request` errors for a deployment-provided or missing provider key, point at `/admin/settings/providers`, as does every `set_workspace_model` outcome; every `update_member` outcome points at `/admin/team`. The top-level `links` on a receipt stay the first changed Agent's; a Settings link is the top-level fallback only when no Agent changed. Like the Agent links, these are added at return time, need a usable deployment origin (no bare paths), and are stripped before persistence, so `get_operation` returns the stored receipt without them.

`import_skill` accepts a public GitHub repository, direct GitHub tree URL, skills.sh link, or `owner/repo` reference that appears in the authenticated current Slack request. A direct skill-directory URL is preferred because the service inspects one directory and pins its commit before fetching `SKILL.md`. A source with multiple candidates returns bounded names, descriptions, and immutable source URLs without changing configuration; the requester posts the chosen `sourceUrl` in a new message before the next call. A new bounded scriptless skill installs immediately and returns a Slack-ready receipt plus an undoable operation ID. Different same-name content returns `replacement_confirmation_required` with the exact clarification text required before a new-message retry with `replaceExisting: true`. Packaged scripts are rejected because Chickpea inline skills cannot execute imported files. The external MCP surface requires `agentId`. An authenticated MCP call is already the person's typed command, so over MCP `import_skill` installs immediately. A same-name skill with different content returns `replacement_confirmation_required`, and the client calls again with `replaceExisting: true` only if the person wants it replaced; the Slack replacement phrase does not apply.

`manage_agent_skill` changes one named installed skill with `enable`, `disable`, or `remove`. The service reads the current Agent, verifies the requester, preserves every other skill, and writes an idempotent reversible change. Slack calls must match the exact authenticated current command; an authenticated MCP invocation is already the exact typed command. Chickpea connectors are trusted integrations, so connector identity never adds an approval gate. A clear single-skill command applies immediately and returns a Slack-ready receipt plus undo. Questions, negated commands, ambiguous targets, generated content, and compound edits do not qualify for this path. The generic proposal tool rejects an exact qualifying single-skill command so a model cannot turn it into an unnecessary approval round trip.

On the Slack door, `propose_workspace_changes` accepts exact typed consequential edits and writes no configuration. It rejects Agent creation. Each call must include a requester-chosen `idempotencyKey`, the current guide version, and an `authoringReason` (`agent_creation`, `agent_edit`, `skill_creation`, `skill_edit`, or `onboarding`). Retrying the same bound key and exact operation digest returns the original proposal; reusing it for different content fails closed. `apply_workspace_changes` creates one sufficiently understood base Agent immediately when the request contains exactly one `create_agent` operation. A call that creates Agents may also hold `update_agent` and `request_setup` items, which is how a recipe configures the Agents it creates; Channel reach, schedules, and other changes wait for a later call. An `update_agent` with `expectedRevision: 0` targets the Agent that a `create_agent` earlier in the same call creates, at the revision the call left it, and must list that creation in `dependsOn`. It routes every operation whose door posture is confirmation into a frozen change set instead of bypassing review: in Slack that follows Slack's approval policy, and over MCP only the destructive set. Apply requests accept at most 25 ordered operations. `dependsOn` gives a progressive batch explicit prerequisites; a failed prerequisite skips only its dependents. A progressive apply batch is not globally atomic, and every item returns its own durable disposition.

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

Authorization should show one permission: manage this Chickpea workspace. For a client registered for renewal, it also says the agent stays signed in. Slack OIDC proves the person, while Chickpea independently requires the exact active workspace binding and membership on every MCP request. Disconnect or revoke the MCP connection from the client when it should no longer hold a refresh token, or revoke it from any connected coding agent, as described under [Connected MCP clients](#connected-mcp-clients). Suspending or removing the Chickpea member immediately blocks live MCP requests without waiting for client cleanup, and it revokes their MCP grants and Admin sessions, whether the change came from Admin, Slack, or MCP. A role change ends only their sessions, because every MCP request rereads the role. A suspension or removal revokes before the membership changes and again after it, because a client can refresh its token in between. A revoke that fails before the write leaves the membership unchanged; one that fails after it reports the change failed, and asking again finishes the sign-out.

### Connected MCP clients

`list_mcp_clients` lists the signed-in person's own MCP clients: each one's `clientId`, the `name` it registered with, `connectedAt` (when the person first allowed it), `lastUsedAt` (when it last signed in or renewed its access, which an active client does every 15 minutes; null when it holds no token), and `current` for the client making the call. Times are ISO 8601. The list comes from the person's Better Auth consents and tokens (`listOAuthClientsForUser` in each backend), so it never shows anyone else's client and never returns a token. `revoke_mcp_client` takes one `clientId` from that list and applies at once, as there is no Admin control to confirm in: it deletes the person's consent, refresh tokens, and stored access tokens for that client together (`revokeOAuthClientForUser`), and leaves the client's registration and other people's grants alone. The client can no longer renew; an access token it already holds keeps working until it expires, up to 15 minutes. Revoking the current client is allowed, and the reply says it must sign in to Chickpea again. A `clientId` the person has no grant for, another person's included, fails with `mcp_client_not_found` and the same message as one that does not exist. Both tools are MCP-only and have no Admin UI. `tests/management-snapshot-access.test.ts` covers the tools, and the backend contract (`tests/helpers/better-auth-backend-contract.ts`) proves on SQLite, D1, and PostgreSQL that the revoked client's refresh fails while the person's other clients and other people's still refresh.

Dynamic Client Registration is an intentionally bounded compatibility window for current clients. It accepts public clients only and validates exact loopback or HTTPS redirects. The deployment's durable limiter allows 20 registrations per source and 1,000 in total per 15 minutes; a hosted host supplies its own per-source limit, which Core calls before every registration. About 1,000 registrations that no one has consented to are kept. The cap is approximate under a concurrent burst: requests that arrive together each count before the others register, so more than 1,000 can briefly remain, and refusal applies once a request sees the count at the cap. Past the cap, the oldest one older than 15 minutes makes room for the new one. A registration younger than 15 minutes is never evicted, so a flood cannot cancel a sign-in in progress; when the cap is full of registrations that young, registration answers 429 `registration_quota_exceeded` until the oldest turns 15 minutes old. A registration that no one consents to within 30 days is pruned. A client someone consented to is never pruned. A client that kept a pruned registration cannot sign in. Better Auth redirects its browser to `/api/auth/error?error=invalid_client`, which is not a public route, so the person sees a bare "Not Found" page. To recover, clear this server's stored authentication in the client, then connect again so it registers anew. Do not enable confidential client metadata or widen redirect rules. Replacing DCR with client-ID metadata is a follow-up gate: the Worker implementation must safely resolve DNS, reject special addresses, pin the resolved address through TLS, and refuse redirects before remote metadata is trusted.

## CLI

`chickpea-cli` (npm, source at `packages/cli`) is a scripted client for this surface. `npx chickpea-cli doctor <origin>` runs the unauthenticated half of `scripts/verify-management-mcp.mjs` against a public origin: protected-resource metadata, authorization-server metadata, JWKS, and the 401 challenge, and explains a 404 as unfinished setup. `chickpea-cli mcp config <origin>` prints the client snippets for Claude Code, Codex, and Cursor. `chickpea-cli login <origin>` performs the public PKCE flow described above through the `@modelcontextprotocol/client` SDK and stores the tokens under `~/.config/chickpea` (mode 0600), keyed by origin. `logout` revokes the refresh token at `/api/auth/oauth2/revoke`. The resource server verifies an access token by signature and expiry, so the one already issued keeps working against `/mcp` until it expires, up to 15 minutes. Suspending or removing the member blocks the session at once. `workspace inspect`, `tools list`, `call <tool>`, and `recipe export|preview` wrap the tools directly and print the `{ ok, result | error }` envelope.

The CLI follows this runbook's confirmation model: a destructive change waiting for confirmation is printed with the exact `confirm_workspace_change` command and is never confirmed automatically, and a setup link is printed with the 24-hour, anyone-who-holds-it warning. It never accepts a token, provider key, or Slack credential as an argument or environment variable. Package README: `packages/cli/README.md`.

## Roles and confirmation

| Actor | Inspect workspace | Operational changes | Members | Normal Channel work |
|---|---:|---:|---:|---:|
| Owner | Yes | Yes | Yes | Yes, when a Channel allows it |
| Admin | Yes, with the team list | Yes | No | Yes, when a Channel allows it |
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

The request itself is approval only when the trusted service derives the exact command from the authenticated current message and proves it authorized, reversible, local-only, and free of authority, reach, credential, capability, or third-party effects. Today that includes one explicit enable, disable, or removal of a named existing skill, the purpose-built exact GitHub import and undo tools, and a change to one Agent field on its own: instructions, model, effort, image model, name, description, requested Slack handle, or turning the Agent on. Saving or forgetting Agent memory also applies at once and can be undone. New or generated skill content, inferred changes, compound changes, destructive actions, external consequential writes, capability expansion, and reach or authority changes use `propose_workspace_changes`. Ambiguous targets or replacements need clarification, not a generic approval prompt. The returned preview is the single approval boundary when confirmation is required: never ask for permission before proposing and never ask for another approval after the requester accepts that preview. The apply tool still returns a bound proposal for any operation whose policy requires confirmation, including:

- deleting an Agent or a routine;
- changing member authority;
- removing or replacing credentials;
- expanding capability scope;
- disabling an Agent that is published to a Channel; or
- archiving or restoring an Agent, or granting or revoking Channel reach;
- changing a Workspace model (Slack only; Admin and MCP apply it directly); or
- overwriting an existing Agent from a recipe.

### Approval in Slack

In Slack, only the person approves. The host applies a change set when the requester presses its Approve button or replies that they approve it, and the Agent has no tool that applies one. An exact approval such as `approve` applies at once. Other wording is judged only when it answers the set: the turn that proposed it is still the Agent's latest in that thread or DM, so the Agent has asked nothing since. Then one side call on the Agent's model reads the requester's message and a summary the host builds from fixed labels (`approvalChangeSummary`), never the set's content, and answers approve, decline, or other (`classifySlackManagementApproval` in `src/slack/interaction-intent.ts`). Approve applies the set as `approve` does. Decline retires it, as the Cancel button does. Other, a failed call, or a timeout applies nothing, and the message reaches the Agent as conversation. After the Agent takes another turn, only the button or an exact approval applies the set. When the person asks about the waiting change, the Agent answers and proposes the same operations again in that reply. The host keeps the pending set, with its card, and records the answering turn as the one that proposed it, so a plain "ok, go ahead" after the answer is judged. The same holds when a replayed call shows the set again. The host cannot see a question the Agent asks in the same message as the preview, so the Agent is told to end that message with the approval request and ask nothing else until the person answers, and the judge answers other for a reply that also answers anything else. Nobody else's message is judged, and neither is an Agent's ask, a click, a reaction, or a stop phrase or check-in such as "cancel that", which keeps its steering meaning. On a turn another Agent's ask started, every change waits for that approval, including a change that would otherwise apply at once. A setup request after a held change in the same call waits too: the approval issues its one-time link and the receipt carries it. A setup request that would replace saved credentials cannot wait for approval in Slack, so the Agent refuses it and sends the person to Admin.

`npm run evaluate:slack-approval-intent` checks the judge offline: it validates `evals/slack-approval-intent/cases.json` and sends every case through the production side call to a stubbed provider. It does not measure judgment. `npm run evaluate:slack-approval-intent:live -- --model <provider/model>` judges the corpus with a real model and fails on any false approval, more than one false decline, approve recall under 0.9, decline recall under 0.75, or a failed call; its private report goes under `~/.chickpea/evals/slack-approval-intent/`.

### Confirmation over MCP

An MCP client acts with the signed-in person's Admin authority. Every operation the policy allows for that person applies in `apply_workspace_changes`. The exceptions are the changes the Admin UI asks "Are you sure?" about (`assets/admin-ui/admin.js`), plus Agent deletion, which the Admin UI has no button for:

| Change | Admin UI confirmation |
|---|---|
| `delete_agent` | No Admin UI; treated as destructive |
| `delete_routine` | Routine delete modal ("cannot be undone") |
| `update_member` that suspends or removes a member, or promotes or demotes an Owner | Team confirm modal; a Member and Admin role swap and a reactivation apply directly in both |
| `remove_provider_credential` | `prov-remove` then `prov-remove-confirm` |
| `update_agent` that removes an existing `mcpServers` or `apiConnections` entry, or `disconnect_connection` | "Disconnect account" confirm |
| `remove_website_login` | Website login "Remove" confirm |
| `update_agent` that disables an Agent with Channel grants | "Disable everywhere" callout |

Such an item returns `confirmation_required` with a change-set `presentation.markdown` preview, and the rest of the call waits in the same change set. The coding agent shows the preview, asks the person, and calls `confirm_workspace_change` after they agree. A destructive item that cannot share a change set with the rest of its call (a later `request_setup`, or a second change to the same object) fails with `confirmation_needs_own_call`; the rest of the call is handled without it, and the agent resends that item alone. Each MCP client keeps one pending change set per person. Another destructive change makes the earlier one stale, and confirming the earlier one returns `proposal_stale`. Removing a repository grant or a skill applies directly, as in Admin. `undo_workspace_change` applies directly unless its inverse is in this set, for example undoing an added MCP server. The posture comes from one table, `POSTURE` in `src/management/policy.ts`, keyed by policy reason and door; the Admin door's column is all immediate because the browser asks first.

An `idempotencyKey` is unique within one conversation of one requester: one MCP client, one Admin session, or one Slack DM or Channel thread, under the acting Agent (`managementIdempotencyScope` in `src/management/contracts.ts`). Retrying a key with the same operations in that conversation returns the first result, even when the workspace changed since; reusing it with different operations fails with `idempotency_conflict`. The same key from another client, door, or thread is a separate request. A key is a retry token, so send a new key for each new change: an MCP client that reuses `agent-research-v1` after deleting that Agent gets the first creation's receipt back and creates nothing. In Slack, `manage_agent_skill` and `import_skill` also scope the key to the requester's message, because models reuse keys such as `disable-unslop` in later turns.

Deleting an Agent needs it out of Slack first, on every door. An Agent with Channel grants, its own Slack app, or a Slack user group fails `delete_agent` with `invalid_request` and "Archive <name> first", until it is archived. Admin's `DELETE /admin/api/agents/:id` gives the same message with a 409 `agent_still_in_slack` (a Channel grant keeps its older `agent_still_referenced`). Archive ends the grants, retires the app, and completes only after Slack turns the user group off. Slack cannot delete a user group, so the archived Agent keeps the group's id for restore, and delete leaves that group off in Slack. Creation over MCP publishes the handle at once on a Slack plan with user groups, so such an Agent is archived before it is deleted. As in Admin, delete also waits while a Slack thread from the last 30 days still uses the Agent, and it removes the secrets of the Agent's own connections behind a cleanup marker a retry finishes.

A disabled Agent keeps its Channel grants and does not answer in them; enabling it again brings it back to the same Channels. A confirmed disable carries an undo, like any other one-change call: `undo_workspace_change` with the call's `operationId` or the confirmation's turns the Agent back on.

The same live requester must confirm from the same MCP client or Slack conversation. Proposals do not expire, and a newer proposal from that same requester and origin supersedes the older pending one; in Slack, the same operations proposed again keep the pending one. `confirm_workspace_change` accepts only the proposal handle and applies the frozen operations; it cannot reinterpret them. A changed target revision, digest, permission, requester, acting Agent, or origin makes the whole change set stale or denied before its first write. Inspect again and present a newly calculated diff instead of retrying the old handle.

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

Over MCP this example applies in one call. In Slack, `editPolicy: all_workspace_members` waits for approval.

The adapter, not the model, supplies requester authority. The acting membership is recorded as the Agent creator; tool arguments cannot forge it. Use current IDs and revisions returned by inspection rather than guessing them. Channel publication remains a separate operation, which Slack holds for approval and MCP applies directly: `put_channel` records the Slack Channel and `grant_agent_channel` performs live Slack membership, bot-membership, and Agent-presence reconciliation before activating the additive grant. In Slack, `revoke_agent_channel` also rechecks that the acting member is in the Channel before removing reach. Over MCP, as in Admin, editor rights are enough.

Successful configuration is active on the next newly admitted Slack event, including a reply in an existing thread. An already admitted response and all of its retries keep their frozen runtime plan.

## Connectors, repositories, and model credentials

Declare non-secret policy in the Agent operation: display name, approved MCP tools, allowed API hosts/paths/methods, OAuth scopes, or exact repository name. Never place an API key, OAuth code, bearer value, private key, authorization header value, repository installation credential, or secret-bearing URL in a tool argument.

An Agent's `mcpServers` and `apiConnections` are the connection accounts Admin lists under "In this Agent": team accounts and the requester's own. A management write creates, updates, and disconnects those accounts through Admin's connection account service, so Admin shows and removes them and the runtime uses them once they are ready. An Admin or Owner adds a team connection; a Member adds a personal one only they can use, as in Admin. A connection's `id` is its provider id, or its account id when two connections share a provider id; a new connection takes a short id (lowercase letters, digits, `-` or `_`) that becomes its provider id. A connection stores one credential: a bearer token, an OAuth sign-in, or, with `authMode: "none"`, the value of at most one header. Admin has no off switch for a connection, so `enabled: false` is refused; remove the connection or use `disconnect_connection` to stop the Agent using it. A reviewed connector (Meta Ads, Bugsnag) can be renamed, but its tools change only through Admin's review. Every write also passes the rules Admin applies (`src/config/agent-write-rules.ts`): skill names and content, MCP and API URL checks, overlapping or duplicate API connections, the GitHub host, reviewed connectors such as Meta Ads and Bugsnag, which are added in Admin, and the hosted repository-grant mapping.

`inspect_workspace` also says who is asking and where. `slackTeamId` is the Slack workspace's team ID, which `inspect_routines` takes as `workspaceId`. `caller` gives the signed-in person's `membershipId`, `role`, and `displayName`. `team` lists the members with their role and status for everyone Admin shows the Team page, Owners and Admins, and is absent for a Member; it carries no email. For each Agent, `groupDms` is `eligible` when the Agent answers in Slack group DMs, which only an Agent every workspace member may use does (at least one active grant in a public Channel its bot is in, the rule in `resolveTurnAgentAccess`); `not_eligible` otherwise, including a disabled or archived Agent; and `unknown` when Slack could not confirm its Channels. Inspection reads each granted Channel from Slack once; an Agent with its own Slack app is read with that app's bot, as Admin does. `ownSlackApp` is present, with the app's `handle`, while the Agent answers as its own Slack app. These fields are read-only.

`inspect_workspace` returns each Agent's `skills`, `mcpServers`, `apiConnections`, and `repositories` in the exact shape `update_agent` accepts, so a client can read them, change a field, and send the arrays back unchanged. A connection carries only the fields a client sets (`MCP_CLIENT_FIELDS` and `API_CLIENT_FIELDS` in `src/management/agent-connections.ts`). The server owns the rest: the credential namespace and header policy, status, discovered tools and their schema fingerprints, review mode, and the provider-reported account. The write schemas refuse those fields, and the service ignores them from any other caller. Each Agent's read-only `connectionStatus` reports the state: `lifecycleStatus`, `statusText`, discovered tool names, the provider account, and the last check.

On every write the service matches each connection by `id` and keeps the stored review mode and header policy. While the credential policy is unchanged (URL, transport, auth mode, header names, OAuth scope, preset, and header policy), it also keeps the secret, the status, and the discovered tools, so renaming a connection or changing its approved tools never drops a credential. A new connection, or one whose credential policy changed, starts unconfigured: an MCP server with no credential is `ready` once the check below passes, every other connection is `pending` until its setup link completes or a person enters its key in Admin, and its discovered tools start as its approved tools, so discovery can only narrow a non-empty approved list. An empty `allowedTools` counts as never discovered: outside review mode, the first discovery grants every tool the server offers.

An MCP server that needs no credential is checked when a management write adds it or changes its credential policy, as Admin's Test connection checks one before saving: the service lists the server's tools (`discoverMcpServer`, `src/management/discovery.ts`) and saves them as its discovered tools. A server that cannot be reached is not saved, and an `allowedTools` entry the server does not offer is refused with the tools it does offer. An empty `allowedTools` then allows every tool it offers. A tool choice on a ready MCP server names only its discovered tools, within the binding's ceiling, as Admin's tool editor requires; the change applies directly on both doors. `test_connection` stays read-only: it checks one saved API or MCP connection with its saved credential, sending an API connection one GET inside its own hosts and paths and listing an MCP connection's tools.

`disconnect_connection` disconnects one connection from an Agent through Admin's connection account service (`disconnectForAgent`): the account is revoked, its credential retired, and schedules that use it pause. It names a connection by its id from the Agent's `connections`, `mcpServers` or `apiConnections`, so it also reaches the managed connections that only `connections` lists. It confirms on both doors, as Admin's "Disconnect account" does. It needs the right to edit the Agent, as the Agent page's Disconnect does. A team connection needs an Admin or Owner and a Member disconnects only their own; an Admin or Owner can also disconnect another member's personal connection when they name its account id (inspection never lists it).

A connection whose `lifecycle` is `needs_attention` carries a `reconnect` field in inspection when the requester may reconnect it: either a `prepare_connector_setup` call for a catalog connector, or a `request_setup` operation for the connection. Both reconnect the same account, as Admin's Reconnect does, so its bindings and Agent grants stay. In Slack, `prepare_connector_setup` issues a setup link fenced to that account (`replacement: true`); over MCP it returns the Agent's Admin page, whose Reconnect button does the same. Its result names the account in `reconnect`.

Each Agent's `websiteLogins` lists the website logins granted to it, in Admin's shape (`src/browser/agent-website-logins.ts`): site, label, owner, sign-in method, username, level, whether it is on, and when it was last used. It never includes a password or TOTP seed, and another member's personal login stays hidden. `remove_website_login` removes one, confirming as Admin does, and deletes the saved login once no Agent uses it. Capturing a login needs Admin's browser flow, so management cannot add one; `websiteLoginSetup` says where to add it.

When access is missing, add `request_setup` for the exact Agent connection, repository grant, or model provider. Chickpea returns a URL whose fragment contains a one-use capability. It expires after 24 hours and may be revoked or reissued with `revoke_setup_link`; reissue invalidates the prior link.

Anyone who can see the link can complete its exact frozen action without signing into Chickpea. Share it as a credential-bearing capability. The page shows the connector, target, requested scopes, and replacement warning. It cannot change those values. OAuth connections redirect to the provider; multi-field credentials use a Chickpea form. Validation clears submitted fields, activates the connection once, and creates a non-secret receipt such as:

```text
alex@northstar.example has been connected to Gmail connector.
```

The receipt may include the target, scopes, initiator, operation ID, and a provider-returned non-secret account label. It never includes a token, code, key, client secret, header value, or repository installation credential.

## Models

`inspect_workspace` reports models the way Admin shows them. Its sources are Admin's own model pickers and checks (`src/config/model-choices.ts`, read through `src/management/model-sources.ts`), so the two cannot disagree.

- `modelCatalog` lists every model a person can pick in Admin now. `chat` holds the chat models of every provider the Workspace can run, whether through an API key, the ChatGPT plan, Workers AI, or Chickpea's models, each with the `efforts` it accepts in order (empty when the model has no effort setting). `image` holds the image models. Every actor gets it, Members included, because Admin shows the model pickers to anyone who can create an Agent. A model Admin's picker suggests but the Workspace cannot run, such as one the active catalog no longer serves, is left out.
- Each Agent carries its own pins (`model`, `modelEffort`, `imageModel`) in the shape the writes accept, and a read-only `effectiveModels`: the model, effort, and image model it runs, and whether each is `pinned` or follows the `workspace_default`. The effort follows the model: an Agent on the Workspace default model runs the Workspace default effort, and `null` is the model's standard effort.
- Owners and Admins also get `workspaceModels` with `chat` (the Workspace default model and effort), `image`, and `coding`, each with its revision (0 when it was never set). Members get neither `workspaceModels` nor `providers`, as Admin shows both only in Settings.
- Each `providers` row (`anthropic`, `openai`, `openrouter`, and `workers-ai` except on a deployment serving many installations, as on Admin's Providers page) says whether that provider's models can run now (`available`) and how (`access`: `api_key`, `chatgpt_plan`, `workers_ai`, or `platform` for Chickpea's models), as Admin's model picker decides it. `source` and `mutable` describe only the API key, so a Workspace on its ChatGPT plan reads `available: true`, `access: "chatgpt_plan"`, `source: "missing"`. Workers AI has no key; its `source` is `env` when the deployment provides it and Admin has it turned on.

Two operations change models with Admin's authority and checks:

- `set_workspace_model` sets the `role` `chat` (the Workspace default), `image`, or `coding` to `model` at the role's `expectedRevision` from `workspaceModels`. `modelEffort` applies to `chat` and `coding`; omitting it runs the model's standard effort. `model: null` clears the image or coding model; the chat default cannot be cleared. Only Owners and Admins may change a Workspace model. Admin asks nothing first, so over MCP it applies at once. In Slack it changes every Agent that follows the Workspace, so it waits for the person's approval (`workspace_model_change` in `POSTURE`). Undo puts back the previous model and effort, except for a chat default that was never chosen.
- `set_agent_image_model` pins an Agent's image model, or with `null` follows the Workspace image model, at the Agent's `expectedRevision`. Anyone who may edit the Agent can change it, Members included, and it applies at once on both doors with an undo, like any one Agent field.

A refused choice fails with Admin's own words in `instruction`, for example "openai/gpt-6.1-sol is not an image model.", "Add an OpenAI API key before choosing openai/gpt-image-2.5-flare.", or an effort the model lacks (`effort_not_supported`). A change set previews each as a before and after, for example **Workspace — Default model** and **Research — Image model**. `tests/management-model-policy.test.ts` covers inspect, both operations on both doors, Members, the Slack approval, and undo.

## Memory, routines, and team

Agent memory uses the Agent owner scope and expected version. Inspection returns active entry bodies only to a member who can edit that Agent; forgetting applies at once and can be undone. Channels do not own instructions or memory. Routine inspection and mutation are filtered through the same Agent edit policy and preserve content authority, while routine save/control/delete retain the existing schedule and version contracts. As in Admin, a member edits, runs, pauses, resumes, or deletes a Channel routine only when they can read it (Slack shows them in its private Channel), and only Owners and Admins disable one. A member creates a Channel routine in a private Channel only while Slack shows them in it. Saving, editing, or reassigning a DM routine needs the private use the person would need to DM its Agent, and every run checks that use again. When Slack cannot answer, a save fails with `slack_unavailable` rather than a refusal, and a run counts the failure toward the three that pause the routine instead of disabling it. A member's inspection lists a private Channel only while Slack shows them in it.

Over MCP, `inspect_routines` also lists the signed-in person's own DM routines and never another person's, an Owner's included. A DM routine's `destination` is `direct_message` with a label such as "your DM with Support", and its `channelId` is null. The person pauses, resumes, edits, runs, or deletes it as they could in that DM; an edit keeps its Agent. Creating a DM routine still needs the trusted Slack DM, and only Chickpea in that DM changes a DM routine's Agent, so `reassign_routine_agent` is not an MCP operation: Admin cannot change a routine's Agent either. A Channel routine whose Runs as authority broke is repaired with `take_over_routine`, Admin's Runs as repair route (`POST /admin/api/agents/:id/schedules/:scheduleId/reassign`): an editor of the routine's Agent becomes its Runs as member, its connection accounts are re-selected or must still be eligible for them, and a pause its authority caused resumes. As for every other routine change, a member must also be able to read the routine. Inspection returns `pausedReason` and `disabledReason`, and a paused or disabled routine has no `nextRunAt`. A routine's name and task follow Admin's content rule: they show when its Channel is public or Slack shows the person in it, and in a Slack Channel conversation only for that Channel's own routines. A member's `inspect_workspace` adds `usableAgents`, the Agents they may DM and so schedule DM work with, with `canEdit` marking the ones `agents` lists.

Eligible full Slack members are provisioned automatically the first time they interact with an Agent. Guests and Slack Connect users are not provisioned. A full member can create an Agent and inspect or mutate only Agents allowed by that Agent's edit policy. Owners and Admins see the team list in `inspect_workspace`, as Admin shows them the Team page; only Owners change an existing membership's role or status. Provider inspection, the Workspace models, and provider mutations remain Admin/Owner-only; provider results expose availability and affected Agents, never a key or environment-secret value. Deployment-provided credentials are visibly read-only.

## Portable recipes

`export_workspace_recipe` returns a schema-versioned, immutable result for selected Agents. Version 2 contains the name, description, edit policy, instructions, enabled state, model and reasoning effort, inline skills with their import or suggestion provenance, connection requirements, and repository requirements. A repository requirement names one repository (`fullName`) or every repository of one GitHub account (`owner` with `allRepos: true`). Preview also accepts version 1 recipes. The export deliberately excludes:

- workspace and Channel IDs;
- members and member mutations;
- Slack identity and provider account identifiers;
- credentials, OAuth codes/tokens, and secret-bearing URLs;
- repository installation IDs;
- connection status and tool policies; and
- Agent memory and Channel publication grants.

`preview_workspace_recipe` compares the recipe with current state. Name conflicts return `clone`, `update`, and `skip`; duplicate matches return `ambiguous`. Unsupported versions, malformed requirements, duplicate symbols, unsafe URLs, unsupported model providers, and batches over 25 operations fail before any write.

Each new or cloned Agent compiles to a base `create_agent` with no connections or repositories, then one `update_agent` with `expectedRevision: 0` that adds them and applies a disabled state, then one `request_setup` per connection, repository, or model provider that still needs a credential. An overwrite compiles to one `update_agent` with `recipe_overwrite`. Setup is decided by the same server-owned rules as the write, so an overwrite issues no link for a connection that keeps its working credential. A recipe never binds a GitHub installation, because recipe data is untrusted. A named repository becomes a grant with no installation plus a setup link. An all-repositories requirement creates no grant; preview lists it under `setupRequired`, and the person grants it in Admin. An overwrite keeps, unchanged, a grant the Agent already holds under the same id for the same repository or account.

Apply the returned `operations` unchanged in one `apply_workspace_changes` call. There is no separate recipe authority or background reconciliation. Each item passes its own policy. Over MCP everything applies in that call, except an overwrite that would be destructive on its own, such as removing a connection or disabling an Agent that has Channel reach, which asks first. In Slack, the call creates each bare Agent at once and holds its capabilities and overwrites in a change set for the person's approval. It issues no setup link; the approval's receipt carries the links. When a recipe creates several Agents, that approval creates the later ones without their capabilities or setup links, which need a new request; the call reports those setup items as `dependency_not_applied`. Expected revisions ensure a live edit made after preview wins and forces a new preview.

## Operation polling, receipts, and revocation

Every mutation has a durable operation ID. `get_operation` returns only records owned by the same requester and organization. Setup URLs are returned once when issued and are not stored in pollable operation results. Polling reveals lifecycle and non-secret receipts, not raw capabilities.

Exact proposals return a bounded preview, missing-setup list, target revisions, and canonical guide metadata. The rendered preview (`presentation.slack` and `presentation.markdown`) comes from `src/management/change-set-presentation.ts`. It shows only the record fields in its `PRESENTATION_FIELDS` allowlist. An operation whose records mean nothing to a person, such as an archive, restore, delete, member change, provider key removal, Channel reach change or routine action, renders as one sentence from the change's `statement`, which the service resolves when it freezes the set: names, the @handle, the Channels an archive leaves, and the Agents and Workspace image and coding models a provider key removal affects. A Channel the Agent gains after the preview makes an archive, delete or disable stale, so the person approves a fresh count. Connection changes name the connection and the Agent, and a routine's destination names its Channel. IDs, Slack presence, avatar seeds, revisions and lifecycle internals never render. Every `failed` or `skipped` outcome carries `instruction`, a short explanation for the model: the message of a `ManagementError` or `AgentPresenceError`, or a fixed line for a code-only outcome. Confirmation results report `applied`, `setup_required`, `stale`, `denied`, `failed`, or `partial` outcomes without returning authored bodies in telemetry. A result whose every item failed or was skipped reports top-level `failed`. A `partial` result means the admitted change set encountered a downstream per-item failure after an earlier item applied; dependents are skipped and the receipt identifies item and operation classes. It is not permission to replay the whole set.

A preview that must be cut to fit Slack or Markdown keeps every part that widens access, and cuts only parts that grant nothing. When the widening parts alone cannot fit in one preview, the service refuses the proposal with `invalid_request` and "The access this proposal grants is too long to show in one preview. Split it into smaller proposals." A reviewed diff over 128 KB is refused the same way. Very large proposals can reach these limits on either door, for example a recipe that updates 20 Agents and their connections in one call. Over MCP this happens when a destructive item holds the rest of its call in one change set. Send such a change as several smaller calls.

`undo_workspace_change` is available only for an eligible single safe mutation while its target still holds what the change left, and for 30 days: retention then deletes the undo record, used or not, because it can hold what the change replaced, such as forgotten memory. An Agent edit's undo puts back exactly the fields the edit set, plus the effort a model change dropped, so its policy classifies the undo by what it changes: a one-field undo applies at once, and an undo that removes a connection asks first. Slack presence sync advances the Agent's revision after a name, description or handle change without changing what people configure, so the undo record keeps a digest of the Agent's configuration and compares that instead of the revision; anyone else's edit to the Agent still makes the undo `proposal_stale`. Other undos compare exact revisions. A call whose one change waited for confirmation over MCP or approval in Slack gets the same undo once that change applies (`offerUndo` in `src/management/service.ts`); `undo_workspace_change` accepts the call's `operationId` or the confirmation's. Slack requires an explicit undo request, and other inverses still use Slack's consequence-based policy. Over MCP the inverse applies directly unless it is destructive, in which case undo returns `confirmation_required` instead of bypassing confirmation.

## Client acceptance matrix

| Client profile | Local protocol/DCR fixture | Live OAuth + reconnect | Setup completion | Status |
|---|---:|---:|---:|---|
| Codex CLI/Desktop | Automated | Requires disposable deployment | Requires disposable connector | Local contract verified; live pending authorization |
| Claude Code | Automated | Requires disposable deployment | Requires disposable connector | Local contract verified; live pending authorization |
| MCP Inspector | Automated for 2026 and 2025-era stateless requests | Requires disposable deployment | Requires disposable connector | Local contract verified; live pending authorization |

`tests/management-client-compatibility.test.ts` covers public-client metadata and stateless tool discovery for these profiles. `tests/management-oauth.test.ts` covers discovery, DCR, PKCE/resource binding, live membership denial, continuation safety, and revocation behavior; `tests/management-oauth-refresh.test.ts` covers registration pruning. These fixtures do not claim that a particular installed desktop build completed a real browser authorization.

Run `npm run verify:management-mcp` against a disposable deployment for read-only live acceptance. Supply a bearer token only through the environment; the verifier never prints it or response bodies. The authenticated default path checks the exact 4.0.0 tool inventory, reads the guide, inspects the workspace twice, and proves the effective revision did not change. It writes nothing. A live mutation or third-party connector canary requires separate explicit authorization, `MANAGEMENT_MCP_ALLOW_MUTATION=1`, and a supplied canary payload.

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
