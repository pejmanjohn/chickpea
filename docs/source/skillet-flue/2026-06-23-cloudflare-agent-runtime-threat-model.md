# Cloudflare Agent Runtime Threat Model

Date: 2026-06-23
Status: accepted baseline for Office Hours vertical slice

## Scope

This document covers the first Cloudflare runtime lane for Skillet Office
Hours:

- `apps/web` admits sessions and mints stream tokens.
- `apps/sse` remains the public Runtime Gateway.
- an internal Cloudflare Agent runtime Worker is called only by `apps/sse`.
- a base Cloudflare `Agent` Durable Object holds runtime state.
- direct Anthropic Sonnet 4.6 is used for the parity lane.
- Skillet D1/R2 remain authoritative for product state.

It does not approve non-Anthropic real-user traffic, AI Gateway payload
logging, Teach private workspace routing, CE Plan research routing, or public
Cloudflare Agent URLs.

## Trust Boundaries

Browser to `apps/web`:

- untrusted anonymous or authenticated user input,
- public rate limits and entitlement checks apply,
- browser receives only the existing session response shape.

Browser to `apps/sse`:

- bearer stream token authenticates a session,
- token must stay in sessionStorage only,
- token is never sent to the Cloudflare runtime Worker.

`apps/sse` to internal runtime Worker:

- private service binding is the intended path,
- internal calls must include route metadata and an internal authorization
  check,
- runtime Worker must reject public or malformed calls.

Runtime Worker to Agent Durable Object:

- Agent state is runtime state, not product authority,
- Agent SQL may store model history, cursors, pending runtime state, and
  provider metadata,
- Agent state must not store stream tokens, raw provider keys, or product
  secrets.

Runtime Worker to model provider:

- first lane uses direct Anthropic Sonnet 4.6,
- prompt-cache and usage metadata may be recorded,
- raw provider errors must be classified and redacted before public events.

Tool Host to Skillet stores:

- D1/R2 writes remain the source of truth,
- side effects must be idempotent on logical product keys, not provider tool
  IDs alone,
- duplicate runtime computation may not duplicate accepted product effects.

## Threats and Controls

### Public Runtime Exposure

Threat: a public Cloudflare Agent endpoint becomes an unsupported alternate
product API or leaks runtime internals.

Controls:

- production runtime Worker has no public demo UI,
- browser talks only to `apps/web` and `apps/sse`,
- service-binding calls are the production path,
- public requests to runtime Worker are rejected with uniform errors.

### Route Override Abuse

Threat: a user forces cheaper or experimental routing through query params or
crafted requests.

Controls:

- runtime assignment is server-side,
- no public runtime query parameter is honored,
- signed internal overrides include skill, model, runtime, provider/protocol,
  prompt profile, actor/source, and expiration,
- route assignment is immutable after create response.

### Stream Token Leakage

Threat: stream tokens leak into Agent state, logs, eval artifacts, URLs, or
provider prompts.

Controls:

- stream tokens remain browser-to-`apps/sse` credentials only,
- runtime Worker never receives stream tokens,
- only token hashes are stored in D1,
- redaction scans check artifacts, screenshots metadata, traces, and logs,
- URLs never carry user messages or stream tokens.

### Provider Secret Leakage

Threat: Anthropic or Cloudflare credentials are exposed in Worker logs, Agent
state, errors, or artifacts.

Controls:

- provider keys are Worker secrets only,
- secrets are not written to D1, R2, Agent SQL, or eval files,
- provider errors are classified to bounded public error classes,
- raw error payload retention is short-lived and redacted where diagnostics are
  needed.

### Raw Provider Error Disclosure

Threat: model/provider errors reveal implementation details, provider request
payloads, or secrets to the browser.

Controls:

- runtime adapters map errors into stable classes,
- public SSE uses user-safe text only,
- raw traces are separate from public SSE traces and subject to redaction and
  retention limits.

### Eval Artifact PII Exposure

Threat: browser videos, screenshots, raw traces, and blind-review packets store
private user content or secrets.

Controls:

- release-candidate evidence uses synthetic or explicitly approved prompts,
- artifacts are gitignored unless deliberately summarized,
- redaction scan rejects bearer tokens, API keys, stream tokens, raw secrets,
  and unbounded provider payloads,
- screenshots/videos are treated as PII-bearing and not published casually.

### Agent Durable Object Retention

Threat: Agent SQL becomes a long-lived second transcript/product database.

Controls:

- Agent SQL stores runtime history and cursors only as needed for execution,
- Skillet D1/R2 remain authoritative for artifacts, Teach state, saved
  transcripts, and audit,
- retention/purge paths must cover Agent state before real user traffic,
- account deletion must eventually include runtime state purge.

### Account Deletion and Retention Gaps

Threat: user deletion or retention cleanup removes Skillet product rows but
leaves runtime traces behind.

Controls:

- route records must identify runtime session IDs,
- deletion/purge jobs need a runtime cleanup hook before public canary,
- until that exists, Cloudflare assignment is staff/eval-only.

### Non-Anthropic Governance

Threat: real user content is sent to GLM 5.2 or another non-Anthropic model
before data-governance approval.

Controls:

- GLM is disabled for real traffic by default,
- candidate runs require synthetic or explicitly approved data,
- route policy rejects non-Anthropic real-user traffic unless a governance flag
  and skill/model certification exist,
- reports label model quality separately from runtime parity.

### AI Gateway Payload Logging

Threat: AI Gateway persists prompt/response payloads for sensitive sessions.

Controls:

- AI Gateway is excluded from the first runtime-isolation lane,
- if introduced later, requests must use metadata-only posture where acceptable,
  including `cf-aig-collect-log-payload: false`,
- gateway configuration and per-request headers must be verified before real
  traffic.

### Durable Object Eviction and Duplicate Effects

Threat: DO eviction or deploy restart interrupts a model turn after a tool
effect commits, causing duplicated artifacts or stale question state.

Controls:

- first lane may use `keepAliveWhile` for long provider calls,
- durable ledgers must record accepted turns, tool effects, pending questions,
  and event cursors,
- fibers are excluded until per-step checkpoints and recovery semantics are
  designed,
- retries may repeat computation but must not repeat accepted product effects.

## Release Gates

Before staff canary:

- route lookup and kill switches are implemented,
- duplicate turn/effect/question tests pass,
- public runtime exposure tests pass,
- redaction scan covers candidate evidence,
- browser proof shows real ChatSurface, structured question, and section pane,
- rollback can force new sessions back to CMA.

Before public traffic:

- retention and deletion handling covers runtime state,
- route metrics and alerts exist,
- cost/accounting degradation fails closed,
- Office Hours Cloudflare Sonnet strict lane has real `/o` evidence,
- CMA-vs-CMA variance and blind review exist for quality interpretation,
- non-Anthropic traffic remains disabled unless separately approved.
