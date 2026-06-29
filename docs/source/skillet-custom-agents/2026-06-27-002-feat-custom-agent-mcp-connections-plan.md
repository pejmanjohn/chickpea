---
title: "Custom Agent MCP Connections - Plan"
type: feat
date: 2026-06-27
topic: custom-agent-mcp-connections
execution: code
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-in-progress
product_contract_source: ce-brainstorm
---

# Custom Agent MCP Connections - Plan

## Goal Capsule

- **Objective:** Let a signed-in Skillet user attach generic remote MCP servers to a custom agent, test public/no-auth connections, preview discovered tools, approve a narrow allowlist, and have new Cloudflare-backed custom-agent sessions use only those approved tools.
- **Product authority:** Skillet D1 owns agent-level connection definitions, ownership, enablement, tool exposure policy, and session snapshots. The Cloudflare Agent runtime owns live MCP client connections. Shared OAuth credential persistence remains a later milestone. Nango is introduced only when a connection mode explicitly needs provider credential brokering or hosted action functions.
- **Current implementation boundary:** Phase 0.5 ships public/no-auth MCP execution in chats. MCP OAuth rows can be saved and tested into an `auth_required` lifecycle state, but cannot be enabled for chats until shared OAuth credential storage/custom provider work lands.
- **Open blockers:** Confirm shared OAuth storage for chat/runtime instances, confirm callback routing that does not leak user or session identifiers, and decide whether raw bearer/custom-header secrets wait for encrypted connection-secret storage or ship as an admin-only path.

---

## Product Contract

### Summary

Skillet should add a Phase 0.5 custom-agent Connections surface for generic remote MCP servers. The first executable version supports public MCP servers cleanly, exposes discovered tools only after owner review, and passes approved MCP tools into the Cloudflare Agent turn loop for new custom-agent sessions. MCP OAuth remains part of the connection model, but chat execution is blocked until Skillet has shared credential storage that works across admin/test/runtime Agent instances.

### Approved UX Direction

The approved settings direction is a Connections section inside the custom-agent editor, not a separate global MCP product area. It should read like an MCP client configuration surface while staying consistent with the existing Skillet custom-agent settings UI.

The first visible version should include:

- A server list with display name, endpoint, transport, auth mode, lifecycle state, enabled state, and secondary actions such as Refresh or Connect.
- An Add server form with display name, stable server id, server URL, transport mode, authorization mode, and a trust acknowledgement before connecting.
- A tool exposure review section that lists discovered tools with name, description, risk/access label, and owner-controlled enablement.
- A compact summary rail showing runtime owner, connection/tool counts, secrets posture, and the intended setup flow.

The UX intentionally separates three concepts:

- **Connection:** the remote MCP server definition and auth state.
- **Trust:** the owner's acknowledgement that a remote server can expose tools that take action.
- **Exposure:** the specific server or tool allowlist included in new custom-agent sessions.

The fixture used to approve this direction lives at `apps/web/app/browser-fixtures/custom-agent-mcp-connections/` and is a reference for the live editor implementation.

### Execution Slices

**Slice 0.5A - Configuration Surface and Persistence**

- Add first-class D1 records for custom-agent MCP connection definitions.
- Add user-owned API handlers to list, create, update, and disable/remove an agent's MCP connections.
- Fold the approved MCP form into the live custom-agent editor.
- Store only non-secret connection policy: display name, server id, URL, transport, auth mode, trusted flag, enabled flag, lifecycle status, last checked timestamp, and safe error/status text.
- Do not execute MCP tools yet; tool discovery may be represented as an empty/pending state until the runtime connection slice lands.

**Slice 0.5B - Runtime Connect and Discovery**

- Add runtime calls to Cloudflare Agent MCP client APIs for `addMcpServer()` and `getMcpServers()`.
- Mirror safe lifecycle state and discovered tool metadata back to the Skillet connection records.
- Enable the owner to approve specific discovered tools.

**Status 2026-06-27:** Runtime-backed connection testing and discovery is implemented for saved
connections. The custom-agent editor now has a per-connection **Test connection** action; the web
API calls the Cloudflare Agent runtime through the hosted-runtime adapter; the runtime uses
Cloudflare Agents' MCP client to connect and discover tools; Skillet mirrors `ready`,
`auth_required`, or `failed` plus sanitized tool metadata back to D1. Tool allowlist editing is
implemented with server-side validation against discovered tools.

Session snapshots now include only MCP connections that are public, enabled, trusted, ready, and
have approved tools. The Cloudflare custom-agent runtime registers only those public snapshot
connections, filters `mcp.getAITools()` down to approved tool keys, and builds the system prompt
from the tools actually passed into `streamText`. OAuth-mode MCP connections are intentionally
excluded from chat exposure in the API, snapshot builder, editor summary, and runtime guard.

Local proof on 2026-06-27 used Context7's public MCP endpoint (`https://mcp.context7.com/mcp`):
connection testing discovered two tools, the owner approved only `resolve-library-id`, a new test
chat snapshot persisted exactly one public connection (`context7-live`) and one approved tool
(`tool_context7live_resolve-library-id`), and a live GLM 5.2 chat resolved React to
`/reactjs/react.dev`. The older OAuth-mode Browser QA row remained saved but showed `Not in chats`
and was absent from the new session snapshot.

The create path now defaults to `Public server` in both the editor and API fallback, because public
MCP is the only chat-executable mode in the current slice. OAuth remains selectable for saved
auth-required lifecycle testing.

**Status 2026-06-28:** Local closeout added an explicit local runtime URL seam for custom-agent
smokes: `AGENT_RUNTIME_LOCAL_URL` can be set on both `apps/web` and `apps/sse` to point at a
separately running local `apps/agent-runtime`, avoiding stale or cross-worktree service-binding
bleed. The Tools route now saves MCP tool approvals optimistically with rollback on failure, which
keeps the approval control responsive while still posting the server-validated allowlist.

**Slice 0.5C - Session Snapshot and Tool Execution**

- Snapshot enabled, trusted MCP connections and tool exposure policy into new custom-agent sessions.
- Pass approved ready tools into the AI SDK model turn through the Cloudflare Agent runtime.
- Emit bounded tool status/error events through the existing custom-agent chat contract.

### Problem Frame

Phase 0 custom agents intentionally shipped with an empty tool policy and no MCP execution. That was the right boundary for proving web-first custom agents, but it now leaves the most important agent extension point unbuilt.

The goal is not to build a native connector catalog yet. The goal is a generic connection primitive that lets power users paste an MCP server URL, complete auth when the server supports MCP OAuth, inspect what tools will become available, and then decide whether a custom agent can use those tools.

Nango is useful for the adjacent problem of OAuth-heavy provider APIs, especially when the API does not already expose a suitable MCP server or when Skillet wants a stable action-function surface. It should not be a mandatory hop for every standards-compliant MCP server, because Cloudflare Agents already provide the MCP client, discovery, OAuth flow, persistent token storage, and AI SDK tool adapter.

### Approaches Considered

- **A. Direct Cloudflare MCP client first:** Skillet stores connection definitions and policy; the Cloudflare Agent calls `addMcpServer()`, tracks connection state with `getMcpServers()`, and passes approved tools through `this.mcp.getAITools()`. This is the recommended V1 because it maps directly to the Cloudflare Agents SDK and keeps the build narrow.
- **B. Skillet MCP gateway first:** Skillet would proxy every MCP server through its own gateway for governance and policy. This adds carrying cost before we know what policy surface users need, and it duplicates MCP client behavior Cloudflare already provides.
- **C. Nango-first tool gateway:** Skillet would route all external tools through Nango action functions or Nango's hosted MCP endpoint. This is strong for user-scoped provider auth, token refresh, logs, and action functions, but it is heavier than necessary for generic MCP servers that already implement MCP auth and discovery.

### Key Decisions

- **Custom-agent level, not Slack level:** MCP connections attach to custom agents. Slack Workspaces later assign those agents to channels instead of owning a separate connection model.
- **Remote MCP first:** V1 supports HTTP-based remote MCP servers using Cloudflare's `auto`, `streamable-http`, and `sse` transport options. STDIO servers, local process launch, and package installation are out of scope.
- **Public execution first, OAuth as a saved lifecycle:** V1 executes public servers in chats. MCP OAuth servers can be saved and tested into `auth_required`, but chat enablement waits for shared credential storage. Raw bearer/custom-header support should wait for an encrypted secret store unless it is deliberately scoped to an internal/admin-only path.
- **Tool preview before exposure:** Adding a server is not enough to expose it to the model. The owner must see discovered tools and enable the connection or allowed tool set for the agent.
- **Snapshot into sessions:** A custom-agent session snapshots the enabled MCP connection refs and tool exposure policy at session start. Agent edits affect new sessions only unless a deliberate reconnect/restart action is added later.
- **Cloudflare owns live MCP state:** The Cloudflare Agent runtime should persist OAuth tokens and connection state in its Agent storage. Skillet mirrors status and tool metadata for UI, audit, and snapshot purposes, but does not duplicate OAuth token storage for standards-compliant MCP OAuth.
- **Nango is a credential-backed mode, not the generic default:** Nango should be introduced as a later connection type for provider APIs and hosted action functions, especially when Skillet wants Slack/GitHub/Google-style OAuth without building token refresh and scope handling itself.

### Actors

- A1. **Agent owner:** A signed-in Skillet user who creates and configures a custom agent.
- A2. **Custom agent runtime:** The Cloudflare Agent instance that runs chats and owns live MCP client state.
- A3. **Remote MCP server:** A public or OAuth-protected MCP endpoint that exposes tools, prompts, resources, or resource templates.
- A4. **Nango:** Optional future credential broker and hosted MCP/action-function layer for provider APIs with complex OAuth.

### Key Flows

- F1. **Add a generic MCP server**
  - **Trigger:** The owner opens a custom agent and adds a connection.
  - **Steps:** The owner enters display name, MCP URL, transport mode, and optional notes. Skillet validates the shape, asks the runtime to connect, and records the resulting server id and state.
  - **Outcome:** The connection is `ready`, `authenticating`, or `failed`, with a readable status in the custom-agent UI.

- F2. **Authorize an OAuth MCP server (deferred beyond current implementation)**
  - **Trigger:** `addMcpServer()` returns an auth URL.
  - **Steps:** Skillet shows a Connect action, the owner authorizes in the provider flow, and the callback routes back to the right Agent instance without exposing private identifiers in the URL path.
  - **Outcome:** The runtime stores tokens, Skillet refreshes connection status, and discovered tools become reviewable.

- F3. **Approve tools for an agent**
  - **Trigger:** A connection has discovered tools.
  - **Steps:** The owner reviews tool names and descriptions, then enables the connection or a narrower allowlist.
  - **Outcome:** New sessions include only approved MCP tool policy in their custom-agent snapshot.

- F4. **Run a tool-enabled custom-agent session**
  - **Trigger:** A user starts a test chat for an agent with approved MCP connections.
  - **Steps:** The runtime reconciles snapshot connection refs, waits for ready MCP tools where needed, passes approved tools to the AI SDK turn call, and streams text plus any tool status events through the existing chat surface.
  - **Outcome:** The agent can use approved external tools without changing the user-facing chat contract.

- F5. **Handle broken or removed connections**
  - **Trigger:** A connection fails, OAuth is revoked, or the owner disables a connection.
  - **Steps:** Skillet shows the failed state and reconnect affordance. Disabled connections stop appearing in new session snapshots.
  - **Outcome:** Broken connections are visible and bounded; they do not create hanging turns or silent broad tool access.

### Requirements

**Connection Definition and UI**

- R1. The custom-agent editor includes a Connections section that lists MCP connections with name, URL origin, transport, state, last checked time, and enabled state.
- R2. The owner can add a generic remote MCP server with a display name, HTTPS URL, stable server id derived from the name, and transport mode defaulting to `auto`.
- R3. The UI shows OAuth-required connections as auth-required and blocked from chat exposure until shared OAuth credential storage and callback routing ship.
- R4. The UI shows connection failures with a safe external-error message and a retry or reconnect action.
- R5. The owner can remove or disable a connection for future sessions.

**Tool Discovery and Exposure**

- R6. Skillet displays discovered tools with server name, tool name, title when present, and description before exposing them to the agent.
- R7. The owner must explicitly enable a connection or tool allowlist before those tools are included in new session snapshots.
- R8. If tool discovery has not completed or has failed, the connection cannot be enabled for model execution.
- R9. Skillet stores tool metadata and exposure policy without storing provider OAuth tokens or raw bearer secrets in custom-agent records.

**Runtime Behavior**

- R10. Starting a custom-agent session snapshots enabled MCP connection refs, stable server ids, URL fingerprints, transport mode, and approved tool policy.
- R11. Editing, disabling, or removing a connection affects new sessions only unless a later explicit reconnect operation is added.
- R12. The Cloudflare Agent runtime calls `addMcpServer()` idempotently for snapshot connections and uses stable ids so tool names and storage keys remain readable.
- R13. The runtime passes only approved, ready MCP tools into model calls and keeps no-tools behavior unchanged for agents without MCP connections.
- R14. Tool-call progress, tool errors, and final assistant text must fit the existing custom-agent SSE/chat event contract without hanging the session.
- R15. If a required MCP connection is unavailable at turn time, the runtime emits a bounded, user-visible failure instead of silently dropping the tool or spinning indefinitely.

**Auth, Security, and Governance**

- R16. Standards-compliant MCP OAuth should be handled through Cloudflare Agent MCP client behavior where possible, but chat execution requires a shared credential strategy because admin/test connection checks and chat sessions may run in different Agent instances.
- R17. OAuth callbacks use a custom callback path or equivalent routing so Skillet does not expose private agent, user, or session identifiers in callback URLs.
- R18. Normal user-facing V1 does not accept arbitrary raw bearer tokens or custom authorization headers until Skillet has encrypted connection-secret storage and deletion semantics.
- R19. Skillet validates MCP URLs before runtime calls and relies on Cloudflare's MCP URL protections as a second line of defense against SSRF.
- R20. Non-owners cannot view, edit, authorize, test, or use another user's MCP connections.
- R21. Connection add, auth-required, ready, failed, disabled, removed, and tool-executed events are observable without storing secrets or raw external payloads.

**Nango Compatibility**

- R22. The design leaves room for a future Nango-backed connection type that maps a Nango integration id plus connection id to a hosted MCP endpoint or Skillet-owned MCP proxy.
- R23. Nango-backed connections keep provider credentials out of the agent runtime and pass only scoped connection identifiers or short-lived execution context to tool calls.

### Acceptance Examples

- AE1. Given a public remote MCP server, when the owner adds the URL, then Skillet can show `ready` status and a list of discovered tools. Implemented and browser-verified with Context7.
- AE2. Given an OAuth-protected MCP server, when the owner adds the URL, then Skillet shows auth-required status but does not allow chat exposure until shared credential storage ships.
- AE3. Given a ready MCP server with multiple tools, when the owner enables only approved tools, then a new test chat exposes only those tools to the model. Implemented and browser-verified with a one-tool Context7 allowlist.
- AE4. Given an existing session snapshot, when the owner disables a connection afterward, then that edit affects new sessions and does not mutate the old session's snapshot.
- AE5. Given a failed MCP connection, when the owner starts a chat, then the chat reports the connection problem rather than staying in a long-running thinking state.
- AE6. Given a user attempts to add raw bearer headers through the normal V1 form, then Skillet rejects or hides that path until encrypted secret storage exists.

### Success Criteria

- A non-engineer can add a public or MCP OAuth server without understanding Cloudflare Agent internals.
- A power user can verify exactly which MCP tools an agent will see before starting a test chat.
- Existing custom agents without MCP connections keep their current no-tool behavior.
- The first implementation can be planned without native connector UX, Git-backed skills, Slack channel assignment, or MCP gateway governance.
- The architecture can later add Nango-backed provider auth without redesigning custom-agent sessions or snapshots.

### Scope Boundaries

**In scope for current Phase 0.5**

- Generic remote MCP server form and connection list.
- Public MCP connection testing, discovery, approval, snapshotting, and chat execution.
- MCP OAuth connection records and auth-required test status, without chat execution.
- Runtime connection, discovery, status, and AI SDK tool execution.
- Tool preview and explicit owner enablement.
- Snapshotting MCP policy into new custom-agent sessions.

**Deferred**

- Native provider connector catalog for Slack, GitHub, Google, Notion, and similar services.
- Shared OAuth credential storage/custom provider wiring for MCP OAuth chat execution.
- Nango-backed provider connections and action-function templates.
- Arbitrary user-entered bearer tokens, custom headers, Cloudflare Access credentials, and encrypted secret storage.
- Org-level shared connections, admin-managed bundles, and per-member connection permissions.
- Slack workspace/channel assignment of tool-enabled agents.
- STDIO MCP servers, package installation, local process launch, and user-supplied server hosting.
- MCP gateway governance for internal IT-style policy controls.

### Dependencies and Assumptions

- Cloudflare Agents MCP client APIs remain available for remote MCP connections, OAuth, status, discovery, and AI SDK tool conversion.
- The current custom-agent empty tool policy is the intended Phase 0.5 expansion point.
- Skillet continues to use Cloudflare Agents for custom-agent runtime execution.
- Existing custom-agent ownership remains user-scoped for now, with optional org id captured only for later sharing.
- Planning can verify whether the current `streamText()` loop needs a different stream API to surface tool-call lifecycle events cleanly.
- Local development can route web API runtime calls to a separately running local agent runtime with `AGENT_RUNTIME_LOCAL_URL`, preserving production service binding behavior while making browser smokes reliable.

### Outstanding Questions

**Deferred to Planning**

- How should the runtime filter individual tools after `this.mcp.getAITools()` if Cloudflare's built-in filter only scopes by server and state?
- Should a failed optional MCP connection block a turn, or should the model proceed with a visible degraded-tool notice?
- Should connection status be mirrored synchronously from the runtime on every editor load, or cached with an explicit Refresh/Test action?
- What is the smallest telemetry shape that proves tool execution without storing external payloads?

### Sources and Research

- Cloudflare Agents MCP tool docs: https://developers.cloudflare.com/agents/tools/mcp/
- Cloudflare Agents MCP client API: https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/
- Cloudflare MCP client guide: https://developers.cloudflare.com/agents/model-context-protocol/guides/connect-mcp-client/
- MCP authorization specification: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- Nango tool calling overview: https://nango.dev/docs/getting-started/use-cases/tool-calling
- Nango tool calling and MCP guide: https://nango.dev/docs/guides/functions/tool-calling
- Nango token refresh guide: https://nango.dev/docs/guides/auth/token-refreshing
- Current custom-agent core plan: `docs/plans/2026-06-26-002-feat-custom-agent-core-plan.md`
- Current custom-agent policy seam: `packages/core/src/custom-agents/types.ts`, `packages/core/src/custom-agents/snapshot.ts`, `apps/agent-runtime/src/custom-agent.ts`
