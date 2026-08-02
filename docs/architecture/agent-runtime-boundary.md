# Agent runtime boundary

This document defines Chickpea's execution contract with Flue 2.0.0. The
executable source of truth is `scripts/verify-run-foundation.mjs` plus the
Flue 2 migration contract tests.

Chickpea is the product authority. Flue is a durable model and tool execution
runtime. Slack is a client adapter. None of Flue's instance, submission, or
conversation identifiers becomes a product identity or an authorization fact.

## Ownership

| Owner | Authoritative facts |
| --- | --- |
| Chickpea | Admission, membership and visibility policy, Work and Run lifecycle, runtime-plan revisions, idempotency envelopes, receipt and settlement checkpoints, usage attribution, retention, rendering, delivery, and audit state. |
| Flue 2 | Agent conversation state, submission ordering, model and tool execution, compaction, durable keyed admission, reattachable reads, and raw execution failures. |
| Slack | Workspace/channel/message coordinates, current membership truth, presentation behavior, and delivery receipts. |

Flue context is never authority. A tool, MCP connection, skill, repository, or
sandbox is exposed only when the app-owned runtime plan declares it and the
live trusted seam still authorizes it.

## Submission protocol

Slack turns and routine occurrences use the same four checkpoints:

1. Chickpea resolves current access and capabilities, compiles a strict,
   secret-free `RuntimePlanV2`, and persists an immutable dispatch envelope.
2. Chickpea calls `dispatch()` with the envelope's stable `idempotencyKey`.
   An ambiguous acknowledgment repeats the exact target, key, message, and
   initial data; a different payload for the same key fails closed.
3. Chickpea persists the bounded `DispatchReceipt` before calling `read()`.
   A process or isolate restart reattaches with that receipt and does not
   dispatch again. A local read cancellation is resumable and does not abort
   durable work.
4. Chickpea reduces `AgentReply` to an app-owned settlement before rendering or
   delivery. Recovery after settlement retries delivery only; it never reruns
   the model.

`abort()` is a control operation, not proof that a model or external action did
not run. It is used only when Chickpea's cancellation or deadline policy owns
that decision.

## Runtime plans and continuity

`RuntimePlanV2` is complete before first dispatch and contains only immutable,
model-safe execution facts: normalized turn coordinates, assignment, governed
instructions, resource bindings, sandbox mode, and a memory epoch. Credentials,
OAuth material, Slack tokens, internal row IDs, and per-turn correlation never
enter creation data or model context.

Channel threads may adopt a newer compatible runtime-plan revision without
resetting their Flue conversation. DM and App Home surfaces checkpoint the old
generation, start a fresh Flue instance, and post one continuity notice before
the first reply. Credential rotation alone resolves through live provider and
MCP seams and does not reset conversation state.

## Providers, MCP, tools, and sandboxes

The frozen plan declares resource names and policy, while trusted closures
resolve current credentials at execution time. Required MCP connections fail
closed; optional connections may be unavailable without widening capability.
SSRF, hostname, redirect, OAuth ownership, and method/path guards remain
app-owned.

Tool availability is deterministic at a submission boundary. Chickpea keeps
side-effect receipts and Work/Run state above Flue. Flue 2 durable tools are not
adopted in this migration; they require a separate replay, authorization, and
external-effect governance contract.

Sandbox instances are attempt-scoped. Preparation happens after policy and
usage admission, and cleanup runs on success, failure, timeout, or resumable
local interruption. Sandboxes receive no host credentials or host filesystem.

## Routines

Flue workflows no longer exist. The one-minute Cloudflare scheduled handler,
routine definitions, admission leases, attempt identity, deadline, retries,
delivery policy, and audit history remain in Chickpea.

Each occurrence uses two fresh Flue 2 agents:

- `chickpea-routine-intent-v2` returns exactly one named `routineIntent` value.
- `chickpea-routine-execution-v2` returns exactly one named `routineResult`
  value through a schema-validated terminal tool.

Free-form JSON assistant text is never treated as a routine result. The
historical `flue_run_id` field is retained only for old rows; new occurrences
persist a separate envelope, receipt, and settlement.

## Usage and observability

One bounded response-metadata record carries aggregate input/output/total token
counts plus requested and returned model evidence. It contains no prompt,
completion, tool argument/output, credential, Slack body, internal correlation
ID, or billing guess. Observation replay cannot create a second measurement.

Flue tracing is disabled in the Vite configuration. Cloudflare platform traces
are explicitly disabled, while Workers Logs remain enabled for sanitized
operational warnings. App instrumentation emits only bounded status, route,
usage, and policy facts.

## Cloudflare object boundary

The prelaunch v6 reset creates exactly these SQLite-backed Flue classes:

- `FlueChickpeaSlackV2Agent`
- `FlueChickpeaRoutineIntentV2Agent`
- `FlueChickpeaRoutineExecutionV2Agent`

It permanently deletes only the beta `FlueRegistry`, `FlueSlackThreadAgent`,
`FlueRoutineIntentAgent`, and `FlueRoutineWorkflow` namespaces. Beta transcripts
and workflow history do not survive. `TagStateStore`, `Sandbox`,
`ContainerProxy`, Work/Run state, routine definitions, configuration, memory,
and other app-owned state are outside that deletion set.

The generated Wrangler artifact, not the source config passed through a custom
`--config`, is the deploy input. `npm run deploy -- --preflight-only` proves the
class allowlist, protected bindings, tracing policy, and compatibility-date
floor without deploying.

## Capability roadmap

| Flue 2 capability | Current decision | Future product opportunity | Required guardrail |
| --- | --- | --- | --- |
| Keyed dispatch and durable receipts | Adopted | Strong duplicate-execution prevention | Exact payload replay; conflicts enter recovery. |
| Reattachable `read()` | Adopted | Isolate/process-loss recovery | Persist receipt first; local cancellation never implies abort. |
| Hook-authored resources | Deterministic declarations adopted | Per-turn least privilege | Apply changes only at submission boundaries with parity tests. |
| `useInitialData()` | Adopted | Correct first-turn policy | Secret-free, immutable, and model-invisible. |
| `useDataWriter()` | Adopted for routines | Typed cards and structured progress | Unconditional writer names, schema validation, authorization. |
| Response metadata | Adopted | Better route and execution diagnostics | Bounded schema and one measurement per submission. |
| Request-time MCP auth | Adopted | Safer credential rotation | Keep SSRF, OAuth ownership, and required/optional policy. |
| Durable tools | Deferred | Checkpointed bounded action sequences | Separate action receipts, replay semantics, and side-effect policy. |

Model-visible delivery signals may describe user-facing progress, but they may
never carry private runtime policy, credentials, internal correlation, or
authorization state.
