# Agent Runtime Boundary

This document freezes the U1 execution contracts for the channel-neutral Run
foundation. It is verified against `@flue/runtime` and `@flue/sdk`
`1.0.0-beta.8`, including Chickpea's compiled-runtime patch. The executable
source of truth is `scripts/verify-run-foundation.mjs`.

## Capability decisions

| Capability | Result | Release decision |
|---|---|---|
| Direct submission receipt | Proven | Persist Flue's server-generated `submissionId` and offset when returned. |
| Caller-owned direct idempotency | Absent | Never resubmit after ambiguous admission. Move the Run to `recovery_required`. |
| Same-instance ordering | Proven | Keep Binding ordering in Chickpea; Flue additionally serializes each instance session. |
| Post-admission lookup | Unstable | A known receipt can be found through history/observe. A receipt lost before the response cannot be discovered safely. |
| Safe detailed history | Absent | Do not ship detailed Flue activity in Sessions. Flue history includes reasoning and tool bodies. |
| Instance abort | Proven, instance-wide | Treat abort as a control request, not evidence that an external effect did or did not happen. |
| Instance list/delete | Absent | Keep continuity generations opaque. Do not make cleanup or enumeration a release dependency. |
| Interactive execution descriptor | Proven | Carry an opaque RunExecution lookup key in the persisted trace carrier and resolve a durable Chickpea mapping inside the outer execution interceptor. |
| Workflow execution descriptor | Proven | Carry an opaque coordinator descriptor in Workflow input. Create RunExecution only after prepared input is durable. |
| Tool/action interception | Proven | Use a Chickpea interceptor around Flue tool execution for policy checks and durable pre/post receipts. |
| Finite action-attempt ceiling | Absent | Side-effectful release capabilities stay disabled until Chickpea enforces and tests a finite per-RunExecution ceiling. |
| Node foreign keys | Proven on Node 24 | Check every WorkStore connection and run `foreign_key_check` in integrity verification. |
| Durable Object foreign keys | Proven in workerd | Keep the exact-artifact orphan-rejection and `foreign_key_check` probe in the release verifier. |
| Provider route snapshot | Proven derivable | Compose one safe immutable snapshot before the first model call; never persist Flue's internal provider alias. |

## Submission and recovery

The public direct-agent request accepts only message, images, and cancellation.
Flue generates the direct `submissionId`; the application cannot supply its Run
identity as an idempotency key. A successful admission response is therefore
valuable evidence, but a connection loss before that response is inherently
ambiguous. Chickpea must not attempt the same direct submission again.

The outer Flue agent interceptor receives the durable `traceCarrier`,
`submissionId`, instance ID, and agent name. Interactive execution will put only
an opaque, bounded RunExecution lookup key in `tracestate`; the full immutable
descriptor remains in Chickpea state. The interceptor resolves that mapping and
keeps it in execution-local context across agent initialization, model calls,
tools, retries, and compaction. A missing, expired, or digest-mismatched mapping
fails before model or tool execution.

Flue's instance abort covers the active submission and every queued submission
for that instance. It is useful for operator control, but it is not a
per-submission recovery primitive and cannot settle an unknown external effect.
Only authoritative reconciliation or Chickpea's authenticated, same-origin,
idempotent quarantine operation may leave `recovery_required`.

## Action evidence and policy

The exact runtime routes model, MCP, action, framework, adapter, and shell tool
execution through `FlueExecutionInterceptor`. The interceptor receives stable
tool call/name correlation and surrounds the underlying call, so Chickpea can:

1. map the allowlisted tool name to a safe action class;
2. reject the call before an external effect when the immutable source/actor
   policy does not allow that class;
3. commit a body-free action-start receipt before calling `next()`; and
4. commit `succeeded`, `failed`, or `unknown` evidence afterward.

Flue bounds submission attempts and wall-clock duration but does not bound the
number of tool/action calls. V1 must add a finite Chickpea-owned counter at this
interceptor before any side-effectful release profile is enabled. Until that
counter and paired receipts work on both agent and Workflow paths,
side-effectful capabilities are unavailable by design. Read-only tools remain
eligible under their existing policy.

## Provider route evidence

`resolveRuntimeModel` remains the only live provider/auth resolver. The active
catalog route already supplies the canonical model, auth lane, catalog source,
revision, digest, and compiled profile. RunExecution will compose those fields
with the non-secret credential reference/version resolved for that actual
attempt. The safe record excludes the internal model specifier/provider alias,
transport marker, token, account identifier, and catalog body.

The snapshot is created once immediately before the first external model call
and governs main turns, structured output, retries, and compaction for the
attempt. A catalog or credential change affects only a later RunExecution. A
selected subscription failure is terminal to that route and never consults the
Platform API-key lane. `RoutineRun.providerAuthRoute` remains a rollback
projection; provider-auth observation remains corroborating telemetry.

## Routine, Usage, and lifecycle authority

Routine coordinator admission is not a RunExecution. The compatibility mapping
is:

| Routine fact | Canonical meaning |
|---|---|
| `queued` or coordinator `admitting` | Run is queued; coordinator admission is separate evidence; zero RunExecutions. |
| Workflow preparing immutable input | Run is `preparing_input`; zero RunExecutions. |
| Model/tool work after prepared input | Run is `executing`; exactly one active RunExecution attempt. |
| Persisted approved output awaiting delivery | Run is `response_ready`. |
| `succeeded`, `no_op`, `skipped`, `cancelled`, `superseded` | Run is `settled` with the matching disposition. Deterministic control/no-op work may have zero RunExecutions. |
| Conclusive failure | Run is `settled/failed`. |
| Ambiguous admission, action outcome, execution settlement, or delivery | Run is `recovery_required`; it is never replayed automatically. |

Usage remains fail-open observation. A UsageOperation references the canonical
Run and each UsageMeasurement references the intended RunExecution. Timeout,
missing measurement, or attribution failure cannot change Run lifecycle,
delivery, or recovery state.

Flue owns its canonical conversation, raw model/tool facts, compaction, and raw
settlement. Chickpea owns the product Run/RunExecution classification. A raw
Flue fact may drive a guarded Chickpea transition; neither record rewrites the
other system's history or becomes a competing lifecycle authority.

## Work ledger storage and retention

The canonical product ledger is application SQLite in the isolated Node
process or singleton realm Durable Object. `works`, `bindings`, `runs`,
`run_executions`, `effective_config_revisions`, and `ledger_content` are
additive application tables; there is deliberately no persisted Session model.
Session is a safe projection over this ledger. Work identity contains no queue
lease or executor identity, and adapter coordinates live only on Binding.

Known-public and known-private execution/delivery bodies may be stored behind a
fresh random `ledger_content` reference. Unknown visibility stores no body.
Ordinary Session queries receive no content-body operation, so private content
is structurally unavailable there rather than conditionally redacted after a
read. Equivalent bodies do not share a ref or body-derived digest.

`TAG_RUN_BODY_RETENTION_DAYS` is validated at each content write and accepts an
integer from 1 through 365, defaulting to 30. The resulting exact expiry is
immutable for that row. Reads fail closed at expiry; bounded idempotent purge
then nulls the body and byte size while retaining body-free referential and
audit evidence. A later retention change or identical body cannot revive a
purged row.

This is a retention boundary, not application-layer encryption. The isolated
runtime/operator and underlying provider storage controls are trusted for
known-private bodies. Chickpea purge does not delete Flue transcripts; Flue
conversation retention must be operated as a separate policy. Deployments that
cannot accept this at-rest trust boundary must add reviewed envelope encryption
before release rather than treating it as implied by the ledger.
