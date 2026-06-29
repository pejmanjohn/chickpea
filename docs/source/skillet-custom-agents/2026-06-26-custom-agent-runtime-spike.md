# Custom Agent Runtime Spike

Date: 2026-06-26
Status: proceed with generic custom-agent runtime contract

## Context

Phase 0 custom agents need to prove reusable agent definitions before Slack
Workspaces attach agents to channels. The runtime question was whether Skillet
can add a generic Cloudflare Agent lane without making `apps/web` call a
Cloudflare Agent instance directly, without letting custom agents fall back to
Claude Managed Agents, and without forcing the runtime to read mutable
`custom_agent` rows.

Relevant current seams:

- `apps/web` owns session admission, spend/billing gates, stream-token minting,
  audit rows, snapshots, and runtime-route creation.
- `apps/sse` remains the public runtime gateway for `/turn`.
- `packages/core/src/runtime/hosted-runtime.ts` is the adapter boundary.
- `packages/core/src/runtime/cloudflare-agent.ts` already dispatches Office
  Hours create/turn/resume calls to an internal runtime Worker by contract
  version.
- `runtime_route` is sticky once created. Missing route rows remain a legacy
  CMA compatibility shape for historical non-custom sessions only.

## Spike Findings

A generic custom-agent runtime can fit the current Cloudflare Agent substrate
with a small additive contract:

- Add `cloudflare-agent-custom-agent-v1` beside the Office Hours contract.
- Route it to `/internal/custom-agent/*` in `apps/agent-runtime`.
- Add a first-class `chat_only` runtime capability profile.
- Pass a resolved `customAgentSnapshot` through
  `HostedRuntimeCreateSessionInput`.
- Initialize runtime state from that immutable snapshot, not by fetching
  product-owned mutable rows.
- Keep stream tokens browser-to-SSE only. Runtime create receives a derived
  runtime token and never receives the raw stream token, provider secrets, or
  Authorization headers.

The generic runtime class can serve arbitrary custom-agent sessions because
the runtime identity is the session id plus immutable snapshot. Agent-specific
product state stays in D1/R2; the Cloudflare Agent Durable Object only needs
runtime conversation state, cursors, and provider metadata.

## Decision

Proceed with a generic custom-agent class in `apps/agent-runtime`.

The Phase 0 contract is:

```ts
interface CustomAgentRuntimeCreateInput {
  session_id: string;
  runtime_token: string;
  model: "claude-sonnet-4-6" | "claude-opus-4-8";
  custom_agent_snapshot: CustomAgentRuntimeSnapshot;
}
```

`CustomAgentRuntimeSnapshot` includes:

- surface skill id `custom-agent`,
- capability profile `chat_only`,
- agent id, name, description, instructions, and instructions hash,
- optional source id/revision/content hash/body,
- model id and model policy,
- empty Phase 0 tool/MCP policy,
- prompt assembly order,
- runtime contract version.

Custom-agent session create must use
`resolveCustomAgentRuntimeRouteTarget(...)`. That resolver requires an
explicit Cloudflare runtime override and throws when absent. It intentionally
does not call the default route resolver, because the default route resolver
still maps missing overrides to legacy CMA for existing registry-backed skills.

## Consequences

- Custom agents are Cloudflare-only in Phase 0.
- Missing custom-agent runtime configuration returns a bounded unavailable
  error during session create rather than creating a CMA session.
- Editing an agent or source affects only new sessions because runtime create
  receives a session-start snapshot.
- Slack Workspaces can later assign the same custom-agent definitions without
  redefining skill source, snapshot, MCP policy, or runtime semantics inside
  Slack-specific tables.
- GLM is not registered for Phase 0 custom agents. Generic-chat quality and
  governance need a separate gate before non-Anthropic models are enabled.

## Verification To Preserve

- Unit tests cover custom-agent snapshot payload dispatch in the hosted
  Cloudflare adapter.
- Runtime policy tests cover `chat_only`, custom-agent contract selection,
  and no-CMA-fallback behavior.
- Future `apps/agent-runtime` tests must prove malformed or missing snapshots
  fail before any model call and that runtime state inspection contains no
  stream token, provider key, or raw authorization header.
