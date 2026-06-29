---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
title: "feat: Add model runtime support registry"
created: 2026-06-26
updated: 2026-06-27
---

# feat: Add model runtime support registry

## Goal Capsule

Create a typed Skillet-owned model/runtime support registry so the app explicitly whitelists supported models, keeps model availability scoped by runtime surface, and preserves historic Claude Managed Agent compatibility while Cloudflare Agents become the default path for new custom-agent work.

Product Contract preservation: direct bootstrap from the parent thread; no upstream Product Contract IDs.

---

## Problem Frame

Skillet already has a partial model catalog in `packages/core/src/models.ts`, but custom-agent UI, API validation, policy, and route policy still hardcode Claude-only assumptions. That makes it easy for the dropdown, API, billing policy, and runtime route support to drift. The registry must make these concepts explicit:

- Skillet globally supports exactly GLM 5.2, Claude Sonnet 4.6, and Claude Opus 4.8.
- A model can be globally supported but unavailable for a specific runtime surface.
- Historic Claude Managed Agent sessions remain Anthropic-only and should not be reinterpreted as Cloudflare sessions.
- New custom-agent sessions default to Cloudflare Agents. GLM appears for custom
  agents only because the custom-agent runtime now has a Workers AI GLM branch.

---

## Requirements

- R1. The global model catalog remains exactly GLM 5.2, Sonnet 4.6, and Opus 4.8.
- R2. Model availability is validated against provider/runtime surface, not a single global `isSupportedModel` check.
- R3. CMA/Anthropic Managed Agent surfaces allow only Sonnet 4.6 and Opus 4.8.
- R4. Custom-agent model options come from the central support registry, not local hardcoded `<option>` elements or API string checks.
- R5. GLM remains globally whitelisted; custom agents expose and accept it only
  with matching Workers AI runtime execution and route-policy support.
- R6. Existing custom-agent model policy semantics remain backward compatible enough for current rows, but should stop being the source of runtime support truth.
- R7. Tests prevent UI/API/policy/route drift and preserve legacy CMA compatibility.

---

## Key Technical Decisions

- KTD1. Keep the model catalog in `packages/core/src/models.ts` and add surface-aware helpers there first. The current model catalog is already stable and imported widely; a separate module can come later if the table grows.
- KTD2. Treat “supported by Skillet” and “supported by this runtime surface” as separate checks. Global helpers continue to validate model identity; surface helpers decide whether a model can appear or run on `office-hours`, `custom-agent`, or `anthropic-managed-agent`.
- KTD3. Superseded 2026-06-27: GLM is enabled for custom agents after adding
  Workers AI execution to `apps/agent-runtime/src/custom-agent.ts` and matching
  route-policy coverage.
- KTD4. Preserve CMA as a first-class legacy runtime. The registry should keep Anthropic Managed Agent options Anthropic-only and route-policy tests should keep GLM rejected for CMA/default managed-agent paths.

---

## Implementation Units

### U1. Add surface-aware model support helpers

**Goal:** Centralize supported model selection and validation in `packages/core/src/models.ts`.

**Requirements:** R1, R2, R3, R5

**Dependencies:** none

**Files:** `packages/core/src/models.ts`, `packages/core/src/models.test.ts`, `packages/core/src/index.ts`

**Approach:** Add typed surface ids for model support, likely including `office-hours`, `custom-agent`, `anthropic-managed-agent`, and a legacy/default skill surface. Add helpers for supported model options, default model per surface, and assertion/boolean checks. Preserve existing exported helper names by delegating them to the new support matrix so current callers keep working.

**Patterns to follow:** Existing immutable `as const` catalog style in `packages/core/src/models.ts`; current tests in `packages/core/src/models.test.ts`.

**Test scenarios:**
- Global catalog contains exactly GLM 5.2, Sonnet 4.6, and Opus 4.8.
- Office Hours surface exposes all three models and defaults to GLM.
- Custom-agent surface exposes only Sonnet and Opus for now, and defaults to Sonnet.
- Anthropic Managed Agent surface exposes only Sonnet and Opus, and rejects GLM.
- Existing `skilletModelOptionsForSkill("office-hours")` and non-Office-Hours behavior remains unchanged.

**Verification:** Core model tests prove catalog exhaustiveness, surface filtering, default selection, and compatibility helpers.

### U2. Replace custom-agent hardcoded model checks with registry helpers

**Goal:** Make custom-agent API and policy consume the registry instead of hardcoded model strings.

**Requirements:** R2, R4, R5, R6

**Dependencies:** U1

**Files:** `apps/web/app/api/agents/handlers.ts`, `apps/web/app/api/agents/__tests__/handlers.test.ts`, `packages/core/src/custom-agents/policy.ts`, `packages/core/src/custom-agents/policy.test.ts`

**Approach:** Replace `readDefaultModelId` string checks and `modelAllowedByCustomAgentPolicy` hardcoding with central custom-agent support helpers. Keep the existing `modelPolicy` field for persisted compatibility, but make runtime support the first gate and policy an additional entitlement-style restriction for Opus if needed.

**Patterns to follow:** Existing `parseAgentMutationRequest` validation path and custom-agent policy tests.

**Test scenarios:**
- Create/update accepts Sonnet and Opus according to existing custom-agent policy behavior.
- Create/update rejects GLM for custom agents while GLM is not runtime-supported for that surface.
- Empty or missing `defaultModelId` still falls back to the custom-agent surface default.
- Unsupported model strings still return the existing validation error shape.
- Policy tests distinguish “runtime unsupported” from “policy disallowed” through helper behavior.

**Verification:** Focused web handler tests and custom-agent policy tests pass.

### U3. Drive custom-agent UI model options from the registry

**Goal:** Remove Claude-only dropdown literals from the custom-agent settings UI.

**Requirements:** R4, R5

**Dependencies:** U1, U2

**Files:** `apps/web/app/agents/[agentId]/AgentEditor.tsx`, `apps/web/app/browser-fixtures/custom-agent-settings/CustomAgentSettingsBrowserFixture.tsx`

**Approach:** Import registry-derived custom-agent model options and label helpers. Render dropdown options from the support matrix. Keep GLM absent for now because the runtime is Anthropic-only. Keep Opus disabled unless `modelPolicy` allows it, preserving current behavior.

**Patterns to follow:** `apps/web/components/chat/Composer.tsx` model picker maps over `skilletModelOptionsForSkill`.

**Test scenarios:**
- The settings page renders Sonnet and Opus from shared metadata.
- GLM is not rendered for custom agents until runtime support is enabled.
- Existing policy interaction still resets Opus to Sonnet when policy is narrowed.

**Verification:** Typecheck catches option typing regressions; browser fixture confirms the dropdown and summary render without layout regressions.

### U4. Tie runtime route policy to the support model and preserve CMA compatibility

**Goal:** Add tests and minimal route-policy integration so runtime support cannot drift from model support.

**Requirements:** R2, R3, R5, R7

**Dependencies:** U1

**Files:** `packages/core/src/runtime/route-policy.ts`, `packages/core/src/runtime/route-policy.test.ts`

**Approach:** Use model-support helpers in custom-agent deployment registration where practical, or add explicit tests proving `DEFAULT_RUNTIME_ROUTE_DEPLOYMENTS` only contains registered model/surface pairs. Keep the current GLM rejection for custom agents and legacy CMA fallback unchanged.

**Patterns to follow:** Current deployment-table validation in `packages/core/src/runtime/route-policy.test.ts`.

**Test scenarios:**
- Every default runtime deployment is supported by the relevant surface helper.
- Custom-agent route policy rejects GLM with the current Phase 0 unsupported-runtime behavior.
- Missing route rows still resolve to legacy CMA, and CMA continues to be Anthropic-only.
- Office Hours GLM routing remains Workers AI through Cloudflare.

**Verification:** Runtime route-policy tests pass.

### U5. Document the compatibility boundary

**Goal:** Leave a short durable note for future GLM custom-agent enablement and CMA compatibility.

**Requirements:** R3, R5, R7

**Dependencies:** U1-U4

**Files:** `docs/custom-agents.md`, `docs/runtime-routing-runbook.md`

**Approach:** Add a concise note that the global catalog includes GLM, Sonnet, and Opus, while custom-agent Phase 0 currently exposes Sonnet/Opus only because the custom-agent runtime uses Anthropic. Also note that historic CMA sessions remain Anthropic-only and route by persisted runtime metadata.

**Test scenarios:** Test expectation: none -- documentation only.

**Verification:** Documentation language matches implemented support matrix and route-policy tests.

---

## Verification Contract

- `pnpm --filter @skillet/core test -- --run src/models.test.ts src/custom-agents/policy.test.ts src/runtime/route-policy.test.ts`
- `pnpm -C apps/web test -- --run app/api/agents/__tests__/handlers.test.ts`
- `pnpm -C apps/web typecheck`
- If UI rendering changes materially, verify the custom-agent settings fixture at desktop and mobile widths and capture screenshot paths.

---

## Scope Boundaries

### In Scope

- Typed code-owned registry helpers for the current model catalog and runtime surfaces.
- Custom-agent API, policy, and UI alignment with the registry.
- Tests that preserve CMA compatibility and prevent custom-agent GLM drift.

### Deferred to Follow-Up Work

- Workers AI GLM execution inside `apps/agent-runtime/src/custom-agent.ts`.
- DB/admin-controlled model enablement.
- Per-organization model availability.
- Renaming or migrating the persisted `modelPolicy` column.

### Out of Scope

- Deploying this change to production.
- Migrating historic CMA sessions.
- Changing Office Hours model-picker behavior beyond compatibility through delegated helpers.

---

## Definition of Done

- The app has one Skillet-owned model catalog and surface-aware support helpers.
- Custom-agent UI/API/policy no longer maintain independent hardcoded Claude model lists.
- GLM remains globally whitelisted but unavailable for custom agents until runtime support exists.
- CMA compatibility is covered by tests and docs.
- Focused tests and web typecheck pass.
