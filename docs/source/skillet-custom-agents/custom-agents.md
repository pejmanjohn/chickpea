# Custom Agents

Last updated: 2026-06-28

Custom Agents are the reusable agent-definition layer that the future Slack
Workspace product will assign to Slack channels. Phase 0 ships the smallest
useful version in the Skillet web app: a signed-in user can create a chat-only
agent, give it custom instructions, optionally paste a no-script `SKILL.md`,
attach public MCP servers, approve discovered MCP tools, and test it in a
normal Skillet chat session.

## Phase 0 Contract

Supported:

- Signed-in user-owned agents only. Org ids are captured for future sharing,
  but user ownership is the current enforcement boundary.
- Name, description, instructions, enabled/disabled state, model policy, and
  one primary skill source.
- Instruction-only agents and pasted text `SKILL.md` sources.
- Public/no-auth remote MCP server records, connection testing, discovered
  tool review, and explicit owner allowlists.
- Chat-only sessions with no document pane, course pane, publish/download
  action, artifact tab, section progress, or section-derived working labels.
- Stable per-session snapshots in D1 so edits affect new sessions only.
- Cloudflare Agents runtime execution through the hosted-runtime adapter.
- Existing Skillet stream tokens, spend gates, billing gates, transcript mirror,
  usage accounting, `runtime_route`, and hosted-agent observability ledgers.

Explicitly deferred:

- Slack OAuth, Slack events, workspace/channel assignment, and Slack thread
  mirrors.
- MCP OAuth chat execution, bearer tokens, custom headers, provider connector
  catalogs, and encrypted connection-secret storage.
- Git-backed skill sources, visible version history, compare, and rollback.
- File/resource uploads, script runners, Sandbox, Browser, Code Mode, and
  arbitrary code execution.
- Multi-skill routing and built-in skill templates such as Office Hours, Teach,
  or CE Plan.
- Anonymous custom-agent create or execution.
- Claude Managed Agents fallback. Custom-agent sessions fail closed when the
  Cloudflare custom-agent runtime is unavailable.

## User Flow

1. Open `/custom_agents`.
2. Create an agent with a name, intro text, behavior, model policy, and
   optional pasted `SKILL.md`.
3. Open the nested settings pages for the agent:
   `/custom_agents/:agentId`, `/custom_agents/:agentId/skill`,
   `/custom_agents/:agentId/mcp`, and `/custom_agents/:agentId/tools`.
4. Optionally paste a `SKILL.md` source. Phase 0 validation rejects scripts,
   executable filenames, MCP/tool declarations, shell commands, credential
   fields, binary content, and oversized bodies.
5. Optionally add a public MCP server on the MCP servers page, test the
   connection, review discovered tools on the MCP tools page, and approve only
   the tools this agent should see.
6. Click `Start test chat`.
7. The app creates a custom-agent session, stores the stream token in
   `sessionStorage`, and opens `/custom_agents/:agentId/chat?session=:sessionId`.
8. The chat page resumes the transcript from Skillet D1 and streams turns
   through `apps/sse`.

## Runtime Shape

New custom-agent sessions use `skill_id = custom-agent` and
`capability_profile = chat_only`. The create route builds an immutable
`agent_session_snapshot` containing:

- agent id, name, description, instructions, and instructions hash;
- current skill source id, revision id, content hash, and normalized body;
- model id and model policy;
- Phase 0.5 public MCP tool policy containing only public, trusted, ready,
  enabled connections with approved discovered tools;
- prompt assembly order;
- runtime contract version and snapshot hash.

`apps/web` writes the normal `session_audit`, `chat_session`,
`agent_session_snapshot`, and `runtime_route` rows before returning the browser
stream URL. The hosted-runtime adapter sends the snapshot to
`apps/agent-runtime` at `/internal/custom-agent/create`. The custom-agent
Durable Object stores only runtime state needed for streaming and resume; D1
remains product authority for agent definitions, snapshots, transcripts, usage,
and retention.

The MCP connection model separates:

- **connection definition:** display name, stable server id, HTTPS URL,
  transport mode, auth mode, lifecycle state, safe status text, and discovered
  tool metadata;
- **trust:** the owner acknowledgement that a remote server can expose tools
  that may take actions;
- **exposure:** the per-tool allowlist included in new session snapshots.

OAuth-mode MCP records can be saved and tested into `auth_required`, but they
are excluded from chat snapshots until shared credential storage and callback
routing exist.

## Model Support

Skillet's global model catalog is GLM 5.2, Claude Sonnet 4.6, and Claude Opus
4.8. Custom agents are surface-scoped inside that catalog and now expose all
three models:

- GLM 5.2 is the default custom-agent model and runs through Workers AI
  (`@cf/zai-org/glm-5.2`) in `apps/agent-runtime/src/custom-agent.ts`.
- Sonnet 4.6 and Opus 4.8 run through the Anthropic Messages API from the same
  Cloudflare Agents runtime. Opus remains behind the custom-agent Opus policy
  and normal Pro entitlement checks.

Historic Claude Managed Agent sessions remain Anthropic-only. Defaults affect
new sessions only; existing sessions continue to route from their persisted
runtime metadata.

## Env And Rollout

Required on `apps/web`:

- `CUSTOM_AGENT_RUNTIME_ID=cloudflare_agent`
- `CUSTOM_AGENT_ACCESS_MODE=staff` for staff canary deploys, with
  `CUSTOM_AGENT_ALLOWED_USER_IDS` set to the allowed Clerk user ids. Use
  `public` only when intentionally opening custom agents to all signed-in users.
- `AGENT_RUNTIME_RPC_SECRET`
- service binding `AGENT_RUNTIME -> skillet-agent-runtime`
- for local `next dev` smokes only,
  `AGENT_RUNTIME_LOCAL_URL=http://localhost:<agent-runtime-port>` can override
  the production service binding and point web API runtime calls at a separately
  running local `apps/agent-runtime`.
- normal Skillet auth, spend, D1, and billing env

Required on `apps/sse`:

- `AGENT_RUNTIME_RPC_SECRET`
- service binding `AGENT_RUNTIME -> skillet-agent-runtime`
- for local `wrangler dev` smokes only,
  `AGENT_RUNTIME_LOCAL_URL=http://localhost:<agent-runtime-port>` can override
  the production service binding for turn/stream forwarding.
- normal stream-token, spend, D1, and R2 env

Required on `apps/agent-runtime`:

- `ANTHROPIC_API_KEY`
- `AGENT_RUNTIME_RPC_SECRET`
- Durable Object binding `CustomAgentRuntime`

For local worktree smokes, prefer `pnpm dev:ports` followed by
`pnpm dev:stack`. The port-profile script writes the local
`AGENT_RUNTIME_LOCAL_URL` values, sets `CUSTOM_AGENT_ACCESS_MODE=public` in the
gitignored local web env, and creates `apps/agent-runtime/.dev.vars` from the
existing web local secrets without printing secret values.

Pause controls:

- `HOSTED_RUNTIME_DISABLE_CLOUDFLARE=1` pauses all Cloudflare-hosted creates
  and turns.
- `CUSTOM_AGENT_RUNTIME_DISABLE_CLOUDFLARE=1` on `apps/web` pauses new
  custom-agent creates.
- `CUSTOM_AGENT_RUNTIME_DISABLE_CLOUDFLARE=1` on `apps/sse` pauses existing
  custom-agent turns.
- `CLOUDFLARE_RUNTIME_DISABLE_ANTHROPIC_SONNET=1` and
  `CLOUDFLARE_RUNTIME_DISABLE_ANTHROPIC_OPUS=1` still block matching models for
  Cloudflare custom-agent sessions.

## Persistence And Retention

Custom-agent product state is in:

- `custom_agent`
- `agent_skill_source`
- `agent_skill_source_revision`
- `agent_mcp_connection`
- `agent_session_snapshot`
- `session_audit`
- `runtime_route`
- `chat_session`
- `chat_message`
- usage and hosted-agent observability ledgers

Phase 0 stores immutable internal source revisions but does not expose version
history. Deleting a custom agent later must enumerate the agent row, sources,
source revisions, session snapshots, transcripts, runtime routes, and any
Cloudflare Agent state associated with owned sessions. The helper in
`packages/core/src/custom-agents/retention.ts` defines the first enumeration
contract; do not add new custom-agent storage without extending it.

## Verification

Automated checks:

```bash
pnpm -C packages/core test -- custom-agents runtime/canary-controls.test.ts runtime/route-policy.test.ts runtime/cloudflare-agent.test.ts db/schema.test.ts
pnpm -C apps/web test -- 'app/agents/[agentId]/AgentEditor.test.tsx' app/api/agents/__tests__/handlers.test.ts app/api/agents/__tests__/sessions-handler.test.ts
pnpm -C apps/sse test -- src/runtime/local-runtime-binding.test.ts src/handlers/stream-runtime.test.ts
pnpm -C apps/agent-runtime test
pnpm -C packages/core typecheck
pnpm -C apps/web typecheck
pnpm -C apps/sse typecheck
pnpm -C apps/agent-runtime typecheck
pnpm lint
```

Browser checks:

- `/browser-fixtures/chat-only` shows the chat-only layout with no artifact UI.
- Existing `/browser-fixtures/sectioned` and `/browser-fixtures/teach` still
  render, proving chat-only changes did not regress artifact surfaces.
- A real signed-in `/custom_agents -> agent settings -> Start test chat` run is
  required before private beta. Fixtures are layout checks, not hosted-runtime
  proof.

Runtime smoke:

1. Apply migration `0015_custom_agent_core.sql`.
2. Run `pnpm dev:ports` and `pnpm dev:stack` to start `apps/agent-runtime`,
   `apps/sse`, and `apps/web` with matching local runtime URLs, side-port-safe
   CSP, and shared local D1 state.
3. Sign in locally.
4. Create a custom agent.
5. Add a public Context7 MCP connection, run `Test connection`, approve one
   discovered tool, and enable it for chats.
6. Start test chat.
7. Send a turn and confirm streamed assistant text, idle state, transcript
   mirror rows, one `runtime_route` row with `skill_id=custom-agent`, and one
   `agent_session_snapshot` row whose tool policy contains only the approved
   public MCP tool.
8. Confirm the Cloudflare runtime state endpoint returns only redacted state:
   no stream token, no token hash value, no full instructions, and no raw
   transcript.
