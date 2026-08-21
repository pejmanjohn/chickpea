# Workspace management MCP

This runbook covers Chickpea's requester-bound workspace control plane: the public MCP used by coding agents and the matching Flue tools available to Chickpea in Slack. Both are adapters over `WorkspaceManagementService`; neither owns separate permissions or mutation rules.

## What is exposed

The deployment publishes an OAuth-protected MCP at `https://<chickpea-origin>/mcp`, protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`, and authorization-server metadata through Better Auth under `/api/auth`. The product scope is `chickpea:workspace`.

The compact tool surface is:

- `inspect_workspace`, `discover_slack_channels`, `test_mcp_connection`, `inspect_memory`, and `inspect_routines`
- `export_workspace_recipe` and `preview_workspace_recipe`
- `apply_workspace_changes`
- `confirm_workspace_change` and `undo_workspace_change`
- `get_operation` and `revoke_setup_link`

The server advertises contract version `2.0.0`; the versioned operation inventory is available at `chickpea://schema/operations/v2`.

`apply_workspace_changes` accepts at most 25 ordered typed operations. `dependsOn` gives a progressive batch explicit prerequisites; a failed prerequisite skips only its dependents. `clientRef` lets later operations address an Agent created earlier in the same request. A batch is not globally atomic, and every item returns its own durable disposition.

## Connect a coding agent

Add a remote/custom MCP server in the client and use the exact Chickpea deployment URL ending in `/mcp`. Do not create or paste a bearer token. A compatible client discovers OAuth metadata, registers as a public PKCE client when needed, opens Slack sign-in and Chickpea consent, then reconnects with a resource-bound access token.

Authorization should show one permission: manage this Chickpea workspace. Slack OIDC proves the person, while Chickpea independently requires the exact active workspace binding and membership on every MCP request. Disconnect or revoke the MCP connection from the client when it should no longer hold a refresh token. Suspending or removing the Chickpea member immediately blocks live MCP requests without waiting for client cleanup.

Dynamic Client Registration is an intentionally bounded compatibility window for current clients. It accepts public clients only, validates exact loopback or HTTPS redirects, rate-limits registrations, caps stored clients, and prunes unused clients. Do not enable confidential client metadata or widen redirect rules. Replacing DCR with client-ID metadata is a follow-up gate: the Worker implementation must safely resolve DNS, reject special addresses, pin the resolved address through TLS, and refuse redirects before remote metadata is trusted.

## Roles and confirmation

| Actor | Inspect workspace | Operational changes | Members | Normal Channel work |
|---|---:|---:|---:|---:|
| Owner | Yes | Yes | Yes | Yes, when a Channel allows it |
| Admin | Yes | Yes | No | Yes, when a Channel allows it |
| Member | Editable Agents only | Create and edit permitted Agents | No | Yes, with live Slack membership proof |
| Unbound Slack participant | No | No | No | Only ordinary assigned-Channel interaction |

Slack workspace roles are not Chickpea roles. Every call re-resolves the live Chickpea membership and access overlay. Tool arguments cannot select a user, organization, membership, Slack requester, or credential scope.

Safe creation and ordinary reversible edits apply immediately. Chickpea returns a bound proposal before:

- deleting an Agent, routine, or durable memory entry;
- changing member authority;
- removing or replacing credentials;
- expanding capability scope;
- disabling an Agent that is published to a Channel; or
- archiving or restoring an Agent, or granting or revoking Channel reach; or
- overwriting an existing Agent from a recipe.

The same live requester must confirm from the same MCP client or Slack thread before the proposal expires. A target revision change invalidates it. Preview again instead of retrying a stale proposal.

## Clean Agent creation

A coding agent or the Chickpea Slack agent can translate a short request such as “Create a research Agent and give it our synthesis skill and Notion” into one progressive batch:

```json
{
  "idempotencyKey": "create-research-v1",
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
        "editPolicy": "creator_and_admins",
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

The adapter, not the model, supplies requester authority. The acting membership is always recorded as the Agent creator; tool arguments cannot forge it. Use IDs and current revisions returned by `inspect_workspace`; do not guess them. Reuse the idempotency key only for byte-equivalent intent. If the same key is sent with a different digest, Chickpea rejects it. Channel publication remains a separate, confirmation-gated operation: `put_channel` records the Slack Channel and `grant_agent_channel` performs live Slack membership, bot-membership, and Agent-presence reconciliation before activating the additive grant. `revoke_agent_channel` also rechecks the acting Slack member before removing reach.

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

`undo_workspace_change` is available only for an eligible single safe mutation at its exact resulting revision. If the inverse has become risky, undo returns a proposal instead of bypassing confirmation.

## Client acceptance matrix

| Client profile | Local protocol/DCR fixture | Live OAuth + reconnect | Setup completion | Status |
|---|---:|---:|---:|---|
| Codex CLI/Desktop | Automated | Requires disposable deployment | Requires disposable connector | Local contract verified; live pending authorization |
| Claude Code | Automated | Requires disposable deployment | Requires disposable connector | Local contract verified; live pending authorization |
| MCP Inspector | Automated for 2026 and 2025-era stateless requests | Requires disposable deployment | Requires disposable connector | Local contract verified; live pending authorization |

`tests/management-client-compatibility.test.ts` covers public-client metadata and stateless tool discovery for these profiles. `tests/management-oauth.test.ts` covers discovery, DCR, PKCE/resource binding, live membership denial, continuation safety, registration limits, and revocation behavior. These fixtures do not claim that a particular installed desktop build completed a real browser authorization.

Run `npm run verify:management-mcp` against a disposable deployment for read-only live acceptance. Supply a bearer token only through the environment; the verifier never prints it or response bodies. A live mutation or third-party connector canary requires separate explicit authorization and the manual evidence procedure below.

## Diagnostics and telemetry

Content-free log envelopes use the `[chickpea:management]` prefix. Events cover OAuth discovery/DCR/token/request outcomes, tool calls, operation kind and disposition, policy/stale outcomes, setup lifecycle, receipt delivery, live-versus-snapshot admission, and recipe preview counts. Dimensions are fixed machine tokens and counts; unknown values become `other`. Actor IDs, Slack coordinates, object IDs, names, prompts, instructions, recipes, URLs, account labels, credentials, and error text are not accepted.

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
