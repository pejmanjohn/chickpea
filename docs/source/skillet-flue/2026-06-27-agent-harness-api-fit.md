# Agent Harness API Fit Record

Date: 2026-06-27

Plan: `docs/plans/2026-06-27-001-feat-standard-agent-harness-migration-plan.md`

## Summary

Unit 0 is complete enough to set the next execution order. The current Skillet Cloudflare Office Hours runtime remains a custom `base-agent-manual-sse` harness on top of the Cloudflare Agents SDK. The standard-harness candidates are viable enough to continue researching, but none should be wired into `runtime_route` yet.

The first execution slice upgraded the existing Cloudflare Agents packages to `agents 0.17.0`, added `@cloudflare/think 0.11.0` to `apps/agent-runtime`, and added isolated Think stream-callback and Office Hours compatibility preflight seams. No Think product route, runtime route, or Durable Object migration exists yet.

## Initial Repo Baseline

Before this unit, `apps/agent-runtime/package.json` depended on:

| Package | Repo range |
| --- | --- |
| `agents` | `^0.16.2` |
| `ai` | `^6.0.208` |
| `zod` | `^4.4.1` |
| `@cloudflare/workers-types` | `4.20260617.1` |
| `wrangler` | `4.103.0` |

`apps/agent-runtime/wrangler.toml` currently has:

- `compatibility_flags = ["nodejs_compat"]`
- one production Durable Object binding: `OfficeHoursAgent`
- one migration: `v1` with `new_sqlite_classes = ["OfficeHoursAgent"]`

That means every candidate must either use a separate DO class/binding/migration or prove a namespaced state strategy before any route wiring.

## Package Metadata Checked

Commands used:

```bash
pnpm view @cloudflare/think version description dependencies peerDependencies --json
pnpm view @earendil-works/pi-agent-core version description dependencies peerDependencies --json
pnpm view @earendil-works/pi-ai version description dependencies peerDependencies --json
pnpm view @flue/runtime version description dependencies peerDependencies --json
pnpm view agents version description dependencies peerDependencies --json
pnpm search --json "@flue"
```

Observed current package versions:

| Candidate area | Package | Version | Fit signal |
| --- | --- | ---: | --- |
| Cloudflare Agents SDK | `agents` | `0.17.0` | Current latest package. Required by Think peer range. |
| Think | `@cloudflare/think` | `0.11.0` | Peer requires `agents >=0.17.0 <1.0.0`, `ai ^6.0.182`, `zod ^4.0.0`. |
| Pi direct | `@earendil-works/pi-agent-core` | `0.80.2` | Exposes `Agent`, `agentLoop`, session repos, tool hooks, and `./node` export. |
| Pi model API | `@earendil-works/pi-ai` | `0.80.2` | Pulls broad provider SDKs including Anthropic, Bedrock, Google, Mistral, OpenAI. |
| Flue runtime | `@flue/runtime` | `1.0.0-beta.7` | Exposes `./cloudflare` and `./cloudflare/internal` targets. |
| Flue CLI | `@flue/cli` | `1.0.0-beta.7` | Relevant generated-target tool, not added to repo yet. |
| Flue SDK | `@flue/sdk` | `1.0.0-beta.7` | Same beta train as runtime. |
| Bare `flue` | `flue` | `0.2.6` | Unrelated Firebase search package; do not use. |

## Compile Probe

The probe installed candidate packages in `/tmp/skillet-harness-fit-compile` only. No repo dependency or lockfile was changed.

Installed probe packages:

```bash
npm install typescript@6.0.3 @cloudflare/workers-types@4.20260617.1 \
  agents@0.17.0 ai@6.0.208 zod@4.4.1 \
  @cloudflare/think@0.11.0 \
  @earendil-works/pi-agent-core@0.80.2 \
  @flue/runtime@1.0.0-beta.7
```

Using repo-style TypeScript settings (`moduleResolution: "Bundler"`, Workers types, `skipLibCheck: true`), minimal imports for Think, Pi, and Flue typechecked successfully:

```bash
./node_modules/.bin/tsc -p tsconfig.json
```

The first strict probe without `skipLibCheck` failed due upstream declaration conflicts between candidate dependencies, Node/web globals, Workers types, and missing transitive `undici-types` paths from `@anthropic-ai/sdk`. This is not surprising because Skillet's base config already uses `skipLibCheck: true`. It does mean the first real repo integration must run the full package typecheck after any dependency changes.

## Think Fit

Exports inspected:

- `@cloudflare/think`
- `@cloudflare/think/server-entry`
- `@cloudflare/think/framework`
- `@cloudflare/think/react`
- `@cloudflare/think/workflows`
- `@cloudflare/think/extensions`

Fit findings:

- `Think` exposes `runTurn()` with `wait`, `submit`, and `stream` modes.
- `RunTurnStream` uses a `StreamCallback` object: `onStart`, `onEvent`, `onDone`, `onError`, optional `onInterrupted`.
- Think can therefore be bridged server-side in principle without adopting its browser hook first.
- `runTurn()` is marked experimental.
- Think owns message/session persistence, tool execution, stream resumption, and recovery behavior backed by Durable Object SQLite.
- Think has an implicit `web` channel over WebSocket and additional custom/messenger channel concepts.
- Think peer requirements force an `agents` upgrade before a repo-local Think candidate can typecheck honestly.

Decision:

Think remains the first harness candidate only after an isolated `agents` 0.17 upgrade proof. Its strongest value is server-side `runTurn({ mode: "stream" })`; its strongest risk is that it owns more session/stream/tool state than Skillet can safely delegate without a bridge and redaction/state-inspection tests.

Follow-up upstream research:

- Think has a native delayed client-tool-result path under `cf_agent_tool_result` / `addToolOutput`. Skillet still needs an adapter from its current `user.custom_tool_result` and per-turn SSE shape.
- Think has server-side action/tool hooks suitable for an `emit_section` bridge. Skillet still needs to call the existing validation + D1/R2 artifact persistence path and prove idempotency under Think retry/recovery.
- Think forwards AI SDK telemetry and exposes full step usage through `onStepFinish`. Skillet still needs to write its own `session_usage_event` rows, cost nanos, accounting status, and spend-gate evidence.
- Think persists broad framework state. Product canary still requires seeded-secret inspection across Think-owned tables/state before any route is enabled beyond staff/local eval.

## Pi-Direct Fit

Exports inspected:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-agent-core/node`
- `@earendil-works/pi-ai`

Fit findings:

- `Agent` exposes `prompt()`, `continue()`, `subscribe()`, tool hooks, and queue controls.
- `InMemorySessionRepo` is available for non-file-backed session storage.
- JSONL session repos require a provided `FileSystem`; the `./node` export provides `NodeExecutionEnv`.
- The harness types include filesystem and shell abstractions (`FileSystem`, `Shell`, `ExecutionEnv`), including shell unavailable/spawn error codes.
- The coding-agent package is not an appropriate Worker dependency for Skillet Office Hours because it brings CLI/file/process-oriented dependencies.
- Direct Pi can likely be evaluated with an in-memory or custom Skillet-owned storage adapter, but it is not Cloudflare-native and does not remove the need for Skillet to define tool permissions and model-call observability.

Decision:

Pi-direct is viable only as a later candidate after a Worker-specific storage/permission probe. It should not be wired to product routes until it proves it can run without Node filesystem/process assumptions and without forcing Skillet to invent a broad sandbox layer.

## Pi-Direct Worker Probe

Unit 4 added a machine-readable preflight gate:

- `apps/agent-runtime/src/harness-candidates/pi-office-hours-preflight.ts`
- `apps/agent-runtime/src/harness-candidates/pi-office-hours-preflight.test.ts`

The repo still does not depend on Pi. The actual Pi package probe ran in `/tmp/skillet-pi-direct-probe` with:

```bash
npm install --prefix /tmp/skillet-pi-direct-probe \
  typescript@6.0.3 \
  @cloudflare/workers-types@4.20260617.1 \
  @earendil-works/pi-agent-core@0.80.2

/tmp/skillet-pi-direct-probe/node_modules/.bin/tsc \
  -p /tmp/skillet-pi-direct-probe/tsconfig.json

node -e "import('/tmp/skillet-pi-direct-probe/src/pi-worker-probe.js').then(async (m)=>{ const res = await m.default.fetch(new Request('https://pi.test/'), {}, {}); console.log(res.status); console.log(await res.text()); })"

/Users/pejman/.codex/worktrees/14aa/skillet/apps/agent-runtime/node_modules/.bin/wrangler \
  deploy --dry-run \
  --outdir=/tmp/skillet-pi-direct-probe/dist \
  --config=/tmp/skillet-pi-direct-probe/wrangler.toml
```

Probe result:

- Root `@earendil-works/pi-agent-core` plus `@earendil-works/pi-ai/providers/faux` typechecked under Worker types with repo-style `moduleResolution: "Bundler"` and `skipLibCheck: true`.
- A no-network faux provider run produced a basic Skillet-shaped event pair: `agent.message_delta` and `session.status_idle.end_turn`.
- Wrangler dry-run bundling passed with `nodejs_compat`, uploading 5362.81 KiB / gzip 698.46 KiB.
- The temp install footprint was 163 MiB across 169 node_modules directories.
- `@earendil-works/pi-ai` transitively installed broad provider SDKs including Anthropic, AWS Bedrock, Google, Mistral, OpenAI, proxy agents, and Smithy Node handlers.
- The `@earendil-works/pi-agent-core/node` export is Node-specific and imports `node:child_process`, `node:fs`, `node:os`, `node:path`, and `node:readline`. Skillet must not use that export in Workers.
- The first Wrangler dry-run attempt through pnpm failed before bundling because transitive Pi dependencies (`@google/genai`, `protobufjs`) have install scripts that hit the local ignored-builds policy. Direct use of the package-local Wrangler binary avoided that package-manager mismatch and completed the bundle dry run.

Promotion gate result:

Pi-direct is more Worker-viable than the initial topology risk suggested, but it is not a product-path candidate yet. It still leaves Skillet owning:

- blocking `ask_user_question` later-answer resume semantics,
- `emit_section` persistence and exact tool-result behavior,
- a permission boundary for any tool execution exposed through Pi,
- provider/gateway telemetry equivalence and usage/cost accounting,
- dependency-surface control if Pi is added to `apps/agent-runtime`.

Decision:

Keep Pi-direct as a possible harness candidate, but do not add it to the repo dependency graph or route table until it proves the product-contract bridges with less custom code than the current custom Cloudflare harness. For now, its strongest value is an agent loop/event model with hooks; its strongest cost is that Skillet still owns the safety, product state, and Cloudflare transport integration.

## Flue Fit

Exports and docs inspected:

- `@flue/runtime`
- `@flue/runtime/cloudflare`
- `@flue/runtime/cloudflare/internal`
- bundled `docs/guide/targets/cloudflare.md`

Fit findings:

- `@flue/runtime` exposes Cloudflare-specific helpers and internal Cloudflare runtime pieces.
- The Cloudflare target generates a Durable Object class and Wrangler binding for each discovered agent/workflow.
- Generated agent session state, accepted submissions, and workflow run history live in the owning DO SQLite storage.
- Flue requires `nodejs_compat`, which `apps/agent-runtime` already has.
- Flue requires explicit Wrangler migrations for generated classes, including `FlueRegistry`.
- Flue states that the Cloudflare target does not use `db.ts`; source-root `db.ts` is rejected at build time.
- Flue owns generated DO lifecycle and extension points; this is useful for durable execution but risky for Skillet product authority.

Decision:

Flue should get a read-only generated-target audit before any integration, but full Flue adoption should remain after Think/Pi evidence. Flue's value is highest if Skillet wants generated DOs, Durable Streams, and built-in recovery. Its risk is highest around product authority, generated migration history, and fitting its event protocol behind Skillet's per-turn SSE.

## Flue Generated-Target Audit

Unit 5 added a machine-readable generated-target preflight gate:

- `apps/agent-runtime/src/harness-candidates/flue-office-hours-preflight.ts`
- `apps/agent-runtime/src/harness-candidates/flue-office-hours-preflight.test.ts`

The repo still does not depend on Flue. The generated-target audit ran in `/tmp/skillet-flue-cloudflare-audit` with `@flue/runtime 1.0.0-beta.7`, `@flue/cli 1.0.0-beta.7`, `valibot`, `agents@^0.14.1`, and `wrangler 4.103.0`.

Probe commands:

```bash
npm install --prefix /tmp/skillet-flue-cloudflare-audit \
  @flue/runtime@1.0.0-beta.7 \
  @flue/cli@1.0.0-beta.7 \
  valibot \
  'agents@^0.14.1' \
  wrangler@4.103.0

/tmp/skillet-flue-cloudflare-audit/node_modules/.bin/flue \
  build --target cloudflare --root /tmp/skillet-flue-cloudflare-audit

/tmp/skillet-flue-cloudflare-audit/node_modules/.bin/wrangler \
  deploy --dry-run \
  --config /tmp/skillet-flue-cloudflare-audit/dist/skillet_flue_cloudflare_audit/wrangler.json
```

Generated target result:

- `flue build --target cloudflare` passed for a minimal `.flue/agents/office-hours-probe.ts`.
- The generated Wrangler config added two Durable Object bindings:
  - `FLUE_OFFICE_HOURS_PROBE_AGENT` -> `FlueOfficeHoursProbeAgent`
  - `FLUE_REGISTRY` -> `FlueRegistry`
- The required initial migration is `new_sqlite_classes: ["FlueRegistry", "FlueOfficeHoursProbeAgent"]`.
- Wrangler dry-run passed against the generated `dist/skillet_flue_cloudflare_audit/wrangler.json`.
- Dry-run attached 45 modules and uploaded 8393.99 KiB / gzip 1499.94 KiB.
- The temp install footprint was 670 MiB.
- Installing according to the current Cloudflare guide resolved `agents 0.14.5`, while Skillet/Think now use `agents 0.17.0`. This may be resolvable, but it is an explicit compatibility gate before any repo integration.
- Local Flue docs state Cloudflare uses generated DO SQLite for agent sessions, accepted submissions, and workflow records, plus `FlueRegistry` for run indexing. That state must remain harness state; Skillet D1/R2 must remain product authority.
- Local Flue docs also state deploys should use the generated Wrangler config under `dist`, not the source-root config. That means a Skillet Flue integration is also a deploy-pipeline integration, not only an adapter import.

Decision:

Flue is viable as a framework target, but it is too invasive to be the next product-path step. It should remain a later slice until Skillet decides it wants generated DO topology and deploy output as part of the runtime package. It may still be the right long-term destination if the generated event stream can be mapped to Skillet SSE and if D1/R2 product authority stays outside Flue state.

## Agents SDK Upgrade Proof

After the initial Unit 0 fit record, the repo dependency proof upgraded the two existing Cloudflare agent packages from `agents ^0.16.2` to `agents ^0.17.0`:

- `apps/agent-runtime/package.json`
- `apps/cf-agents-office-hours/package.json`
- `pnpm-lock.yaml`

The proof also added `@cloudflare/think 0.11.0` to `apps/agent-runtime/package.json` so the Think preflight can typecheck against the same dependency graph the runtime proxy uses.

Compatibility finding:

- `apps/cf-agents-office-hours` can keep using `getAgentByName` when calls are typed as `getAgentByName<Env, OfficeHoursAgent>(...)`.
- `apps/agent-runtime` imports `OfficeHoursAgent` source from the sibling package, which can expose a different physical `agents` declaration instance under pnpm peer resolution. With `agents 0.17.0`, `getAgentByName` then rejects the imported class because the SDK `Agent` class has private state declarations.
- The runtime proxy now uses the Cloudflare Durable Object namespace directly: `namespace.get(namespace.idFromName(name))`. This avoids the cross-package SDK helper type boundary while preserving the same named Durable Object lookup behavior.
- `apps/cf-agents-office-hours/src/index.ts` updates `SDK_VERSIONS.agents` to `0.17.0` so manifests report the actual dependency version.

Focused verification passed:

```bash
pnpm -C apps/agent-runtime typecheck
pnpm -C apps/agent-runtime test
pnpm -C apps/cf-agents-office-hours typecheck
pnpm -C apps/cf-agents-office-hours test
```

Results:

- `@skillet/agent-runtime`: 6 tests passed.
- `@skillet/cf-agents-office-hours`: 36 tests passed.
- Both packages now resolve `agents 0.17.0`.
- Workspace verification also passed:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm -C apps/agent-runtime build
pnpm -C apps/cf-agents-office-hours build
```

`pnpm test` completed with 91 web test files passing plus all other package tests. The web package emitted localhost `ECONNREFUSED` noise because no dev server was listening on port 3000, but Vitest still reported the suite as passed.

`pnpm lint` completed with the existing CSS warnings in `apps/web/styles/chat.css` and `apps/web/styles/print.css`. The two touched Workers also passed Wrangler dry-run builds.

Open note:

- `pnpm add` reported a peer warning from `agents 0.17.0` through `@babel/plugin-proposal-decorators 8.0.2`, which expects `@babel/core@^8.0.0` while the workspace currently resolves Babel 7. This did not break focused or workspace typecheck/tests, but it should be watched during build/deploy checks.

## Think Stream Callback Preflight

Added:

- `apps/agent-runtime/src/harness-candidates/think-office-hours-preflight.ts`
- `apps/agent-runtime/src/harness-candidates/think-office-hours-preflight.test.ts`
- `apps/agent-runtime/src/harness-candidates/think-office-hours.ts`
- `apps/agent-runtime/src/harness-candidates/think-office-hours.test.ts`

This is intentionally not imported by `apps/agent-runtime/src/index.ts`. It records:

- `harnessId = "think"`
- `harnessPackage = "@cloudflare/think"`
- `harnessVersion = "0.11.0"`
- `runtimeContractVersion = "cloudflare-think-office-hours-v0"`
- `routed = false`
- `productPathEnabled = false`
- `transportProbe = "server-runTurn-stream-callback"`

The helper maps Think's `StreamCallback` shape into ordered preflight events: start, event, done, error, and interrupted. This proves the callback API can be represented locally, but it does not yet prove `Think.runTurn()` behavior, model telemetry, state redaction, blocking questions, or Skillet SSE bridging.

## Think Office Hours Compatibility Spike

Unit 3 added a non-routed compatibility adapter for Think's `runTurn({ mode: "stream" })` server-side API. The adapter is not imported by `apps/agent-runtime/src/index.ts` and does not create a Durable Object class, binding, migration, route handler, or runtime route.

What the spike proves:

- Think `RunTurnStream` can be represented as server-side run options with a Skillet-owned `StreamCallback`.
- `text-delta` and wrapped `{ chunk: ... }` stream shapes can be buffered into Skillet-compatible `agent.message` plus `session.status_idle.end_turn` events.
- `tool-call` stream chunks can be classified for `emit_section` and `ask_user_question` using the real Skillet tool schemas from `@skillet/core`.
- `ask_user_question` can be surfaced as `agent.custom_tool_use`, `skillet.question_requested`, and `session.status_idle.requires_action` in the adapter layer.
- Think interruption and error callbacks can be surfaced without finalizing a partial stream as a successful turn.

What remains unresolved:

- `emit_section` still needs a real side-effect bridge that persists sections, emits `skillet.section_drafted` / `skillet.artifact_drafted`, and returns tool results in the same semantics as the current custom harness.
- `ask_user_question` still needs a real blocking-question continuation bridge. The adapter deliberately refuses `custom_tool_result` input with `think_blocking_question_bridge_required` because the current stream callback path has no inbound tool-result channel. Think's local docs indicate `onClientToolCall` can resolve client tools inline, but that does not yet prove Skillet's later browser answer can resume the same product turn without duplicate effects.
- Think-owned state, raw token redaction, provider telemetry, and usage/cost equivalence remain unproven.
- No product-path route should be enabled until this bridge is proven through local create/turn/question/section/resume tests, not just unit-level callback mapping.

Focused verification:

```bash
pnpm -C apps/agent-runtime typecheck
pnpm -C apps/agent-runtime test
```

Result:

- `@skillet/agent-runtime`: 16 tests passed across the runtime proxy, disabled candidate route stubs, Think raw callback preflight, and Think Office Hours compatibility adapter.

## Contract Registry Gate

Unit 1 added explicit metadata for the current production Cloudflare contract and the three experimental Office Hours candidate contracts:

| Contract | Harness | Framework | Status | Product path |
| --- | --- | --- | --- | --- |
| `cloudflare-agent-office-hours-v1` | `base-agent-manual-sse` | `none` | `production` | enabled |
| `cloudflare-think-office-hours-v0` | `think` | `project-think` | `experimental` | disabled |
| `cloudflare-pi-office-hours-v0` | `pi-direct` | `pi` | `experimental` | disabled |
| `cloudflare-flue-office-hours-v0` | `flue` | `flue` | `experimental` | disabled |

Important guardrails now covered by tests:

- Experimental candidate contracts are not registered in the hosted runtime adapter by default.
- Explicitly registered candidate routes map to internal-only prefixes such as `/internal/office-hours/think/*`.
- `runtime_route` policy can select a candidate only with an explicit `runtimeContractVersion` and a `staff_eval` or `local_eval` policy bucket.
- Public-default assignment stays on `cloudflare-agent-office-hours-v1`.
- Candidate selection does not fall back silently to `cloudflare-agent-office-hours-v1` when the candidate deployment is missing.
- Office Hours candidate deployments do not apply to CE Plan or Teach.
- Persisted route fields remain free of token/secret/api-key field names; no `runtime_route` schema change was made.

## Disabled Internal Candidate Endpoints

Unit 2 added internal-only disabled endpoint stubs in `apps/agent-runtime` for:

- `/internal/office-hours/think/*`
- `/internal/office-hours/pi/*`
- `/internal/office-hours/flue/*`

Supported shapes are `POST .../create`, `POST .../turn/:sessionId`, `GET .../stream/:sessionId`, and `GET .../state/:sessionId`. These stubs are deliberately not candidate implementations. They only establish the topology and safety behavior before a real Think/Pi/Flue bridge exists.

Current behavior:

- Missing or invalid internal RPC secret is rejected before candidate route handling.
- Authorized candidate calls return `503 runtime_candidate_disabled`.
- Disabled responses include the contract, harness, framework, action, and `product_path_enabled: false`.
- Disabled responses do not parse or echo the request body, so raw runtime tokens are not reflected.
- Current `/internal/office-hours/*` production endpoints still route to `OfficeHoursAgent`.
- No new Durable Object binding, class, or migration was added.

## Runtime Comparison Descriptor Matrix

Unit 6 added candidate-aware runtime descriptors to the Office Hours runtime eval package:

- `packages/core/src/evals/office-hours-runtime/descriptors.ts`
- `packages/core/src/evals/office-hours-runtime/descriptors.test.ts`
- `packages/core/src/evals/office-hours-runtime/report.ts`

The descriptor matrix has four runtimes:

| Runtime id | Role | Harness | Framework | Readiness | Browser parity |
| --- | --- | --- | --- | --- | --- |
| `cloudflare` | control | `base-agent-manual-sse` | `none` | runnable | allowed |
| `cloudflare-think` | treatment | `think` | `project-think` | preflight_only | skipped |
| `cloudflare-pi` | treatment | `pi-direct` | `pi` | preflight_only | skipped |
| `cloudflare-flue` | treatment | `flue` | `flue` | preflight_only | skipped |

Comparison reports can now include descriptor-level blockers even when a treatment has no runnable product-path artifact yet. This prevents a false "missing browser evidence" interpretation from being confused with a deliberate promotion-gate skip.

Focused verification:

```bash
pnpm -C packages/core typecheck
pnpm -C packages/core test
```

Result:

- `@skillet/core`: 60 test files / 745 tests passed.

## Candidate Order After Unit 0

1. **Think preflight**: separate DO class/binding or namespaced-state proof, server-side `runTurn({ mode: "stream" })` bridge, redaction inspection, and model telemetry proof.
2. **Pi-direct viability gate**: Worker-compatible root import and faux runtime execution passed, but product wiring remains blocked until permission, structured-question resume, section side effects, and telemetry bridges are proven.
3. **Flue generated-target audit**: generated build and Wrangler dry-run passed, but product wiring remains blocked on generated DO migrations, deploy-pipeline integration, Agents SDK version reconciliation, Skillet SSE mapping, structured-question resume, section side effects, and product-state authority proof.

## Blockers Before Product Route Wiring

- No candidate DO topology has been added or migrated.
- No candidate has framework-owned state redaction tests.
- Think cannot yet accept Skillet `custom_tool_result` continuation for blocking questions without a deeper bridge.
- Think cannot yet prove `emit_section` side effects and tool results match the current custom harness.
- Pi-direct cannot yet prove Skillet `custom_tool_result` continuation, `emit_section` side effects, permission boundaries, or provider telemetry with less custom code than the current harness.
- Flue cannot yet mount behind Skillet without generated DO migrations, generated Wrangler deploy integration, Agents SDK version reconciliation, and explicit proof that Flue DO SQLite remains secondary harness state.
- No candidate has proven model-request telemetry compatible with Skillet usage/cost reporting.
- Browser parity and fault-matrix runs are intentionally skipped for Think, Pi, and Flue until their descriptors move from `preflight_only` to runnable.

## Verification Completed

- Package metadata queried from npm on 2026-06-27.
- Published tarballs for Think, Pi core, and Flue runtime unpacked under `/tmp/skillet-harness-fit.fnE9bd` for type/doc inspection.
- Minimal Worker-shaped TypeScript import probe passed with repo-style `skipLibCheck: true` using `agents@0.17.0`.
- Existing custom Cloudflare harness focused tests and typechecks passed after the `agents@0.17.0` upgrade.
- Think stream-callback preflight tests passed in `apps/agent-runtime`.
- Workspace `pnpm typecheck`, `pnpm test`, `pnpm lint`, and dry-run builds for both touched Workers passed.
- Contract registry and route-policy tests passed for production default, explicit candidate selection, public-default rejection, candidate-missing failure, and CE Plan/Teach isolation.
- Disabled candidate endpoint tests passed for auth rejection, token redaction, disabled response shape, and unchanged production Office Hours create routing.
- Think Office Hours compatibility adapter tests passed for server-side runTurn stream options, text-to-Skillet-event mapping, `emit_section` tool-call detection, `ask_user_question` requires-action mapping, explicit `custom_tool_result` refusal, invalid stream JSON, ignored chunks, errors, and interruption handling.
- Pi-direct temp Worker probe passed TypeScript, no-network faux runtime execution, and Wrangler dry-run bundling; repo preflight gate tests passed and keep Pi blocked from product promotion.
- Flue generated-target temp audit passed `flue build --target cloudflare` and generated Wrangler dry-run; repo preflight gate tests passed and keep Flue blocked from product promotion.
- Runtime comparison descriptor tests passed and reports now preserve candidate promotion blockers before browser parity is allowed.

No enabled candidate implementation route, runtime routing row, public product selector, or Durable Object migration was added by this record. The only product-path code adaptation is the runtime proxy's named Durable Object lookup replacement for SDK helper compatibility under `agents 0.17.0`.
